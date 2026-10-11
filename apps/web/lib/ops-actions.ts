import type { Db } from "mongodb";
import { z } from "zod";
import { services } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema/collections";
import { ChallengeTypeSchema, IdSchema, type LaneError } from "@lane/core/schema/common";
import { ApprovalDecisionSchema } from "@lane/core/schema/approvals";
import { RuleKeySchema } from "@lane/core/schema/rule";
import { SettingsPatchSchema } from "@lane/core/schema/settings";
import { projectApproval, projectSettings } from "@lane/core/schema/projections";
import { updateSettings } from "@lane/core/config";
import { dayIndexAt } from "@lane/core/clock";
import { writeEvent } from "@lane/core/events";
import { wireServices } from "./services";
import { isNotImplemented } from "./dashboard-data";

// Wire every merged owner unit's service once (lib/services.ts). Idempotent; tests that
// need doubles call provideServices or resetServices after import.
wireServices();

/**
 * Operator actions behind the passcode cookie (U12, KTD16). Each returns a status and a JSON
 * body; the routes only parse the request, check the cookie and call these. Cross-unit work
 * goes through `services()`. A call that is not wired yet answers 501 "not available yet".
 */

export interface OpsResult {
  status: number;
  body: Record<string, unknown>;
}

/** Who decided, as stored on approvals and passed to lifecycle calls. */
export const OPERATOR = "operator";

function ok(body: Record<string, unknown> = {}): OpsResult {
  return { status: 200, body: { ok: true, ...body } };
}

function refuse(status: number, code: string, message: string, extra: Record<string, unknown> = {}): OpsResult {
  return { status, body: { ok: false, code, message, ...extra } };
}

function fromLaneError(error: LaneError): OpsResult {
  const status = error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : 409;
  return refuse(status, error.code, error.message, { recovery: error.recovery });
}

function fromThrown(err: unknown): OpsResult {
  if (isNotImplemented(err)) {
    return refuse(501, "not_available", "Not available yet: this control waits on another unit.", { owner: err.owner });
  }
  console.error("ops action failed", err instanceof Error ? err.name : "Error");
  return refuse(500, "internal", "The action failed. Try again.");
}

/** Parse a JSON body with a schema, or answer 400. */
export function parseBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; result: OpsResult } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, result: refuse(400, "invalid_input", "The request is missing a field or has a bad value.") };
}

/**
 * One in-flight run per key in this process, so a double click that reaches the same function
 * instance joins the first request instead of starting a second one. Across instances the
 * owner's conditional update from the current state is the guard.
 */
const inflight = new Map<string, Promise<OpsResult>>();

export function singleFlight(key: string, run: () => Promise<OpsResult>): Promise<OpsResult> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = run().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

const CONFIRM = z.literal(true);

// ---------------------------------------------------------------- approve, decline, retry (U9)

export const DecideBodySchema = z.object({
  approval_id: IdSchema,
  decision: ApprovalDecisionSchema,
  /** True re-sends the same decision after a failed resume or pay step. */
  retry: z.boolean().optional(),
});
export type DecideBody = z.infer<typeof DecideBodySchema>;

/**
 * Approve or decline through U9's approvals, once. A first decision needs a pending approval.
 * A retry needs an approval already decided the same way whose follow-up failed, and re-sends
 * that same decision so U9 re-runs the resume (or U11's pay step for payouts).
 */
export function decideApproval(db: Db, input: DecideBody, now: Date = new Date()): Promise<OpsResult> {
  return singleFlight(`approval:${input.approval_id}`, async () => {
    const approval = await collections(db).approvals.findOne({ _id: input.approval_id });
    if (!approval) return refuse(404, "not_found", "No approval with that id.");
    const decidedAs = input.decision === "approve" ? "approved" : "declined";
    if (input.retry) {
      if (approval.status !== decidedAs || approval.follow_up.status !== "failed") {
        return refuse(409, "nothing_to_retry", "This approval has no failed step to retry.", {
          approval: projectApproval(approval),
        });
      }
    } else if (approval.status !== "pending") {
      return refuse(409, "already_decided", "This approval was already decided.", { approval: projectApproval(approval) });
    }
    try {
      const result = await services().approvals.decide(db, {
        approval_id: input.approval_id,
        decision: input.decision,
        decided_by: OPERATOR,
        now,
      });
      if (!result.ok) return fromLaneError(result.error);
      return ok({
        decided: result.decided,
        follow_up: result.follow_up,
        rule_status: result.rule_status,
        approval: projectApproval(result.approval),
      });
    } catch (err) {
      return fromThrown(err);
    }
  });
}

// ---------------------------------------------------------------- clock controls (R32, KTD13)

export const AdvanceDayBodySchema = z.object({
  challenge_id: IdSchema,
  /** The day index the operator saw; the advance applies only if it is still current. */
  expected_day_index: z.int(),
});

/** Moves an active challenge forward one day, once per expected day. */
export async function advanceDay(db: Db, input: z.infer<typeof AdvanceDayBodySchema>, now: Date = new Date()): Promise<OpsResult> {
  const col = collections(db).challenges;
  const challenge = await col.findOne({ _id: input.challenge_id });
  if (!challenge) return refuse(404, "not_found", "No challenge with that id.");
  if (challenge.status !== "active" || !challenge.clock) {
    return refuse(409, "not_active", "Only an active challenge can advance a day.", { status: challenge.status });
  }
  const clock = challenge.clock;
  const current = dayIndexAt(clock, now);
  if (current !== input.expected_day_index) {
    return refuse(409, "stale", "The day already changed. The screen will refresh.", { day_index: current });
  }
  if (current >= clock.days) {
    return refuse(409, "window_over", "The window has no days left to advance into.", { day_index: current });
  }
  const res = await col.updateOne(
    { _id: challenge._id, status: "active", "clock.offset_days": clock.offset_days },
    { $inc: { "clock.offset_days": 1 }, $set: { updated_at: now } },
  );
  if (res.modifiedCount !== 1) {
    return refuse(409, "stale", "Another request already advanced the day.", { day_index: current });
  }
  await writeEvent(db, {
    kind: "challenge.day_advanced",
    summary: `Operator advanced the clock to day ${current + 2} of ${clock.days}.`,
    challenge_id: challenge._id,
    challenge_type: challenge.type,
    data: { from_day_index: current, to_day_index: current + 1 },
    at: now,
  });
  return ok({ day_index: current + 1 });
}

export const CloseWindowBodySchema = z.object({
  challenge_id: IdSchema,
  expected_status: z.literal("active"),
  confirm: CONFIRM,
});

/** Moves an active challenge to settling, once, and queues its settlement job (U11 runs it). */
export async function closeWindow(db: Db, input: z.infer<typeof CloseWindowBodySchema>, now: Date = new Date()): Promise<OpsResult> {
  const col = collections(db).challenges;
  const closed = await col.findOneAndUpdate(
    { _id: input.challenge_id, status: input.expected_status },
    { $set: { status: "settling", closed_at: now, updated_at: now } },
    { returnDocument: "after" },
  );
  if (!closed) {
    const current = await col.findOne({ _id: input.challenge_id }, { projection: { status: 1 } });
    if (!current) return refuse(404, "not_found", "No challenge with that id.");
    return refuse(409, "not_active", "The window is already closed.", { status: current.status });
  }
  const job = await services().jobs.queue(
    db,
    { kind: "settlement", dedup_key: closed._id, payload: { challenge_id: closed._id } },
    { now },
  );
  await writeEvent(db, {
    kind: "challenge.window_closed",
    summary: "Operator closed the window. Settlement is next.",
    challenge_id: closed._id,
    challenge_type: closed.type,
    data: { by: OPERATOR },
    at: now,
  });
  return ok({ status: closed.status, settlement_job_queued: job.created });
}

// ---------------------------------------------------------------- stage, rules, proofs

export const ResetBodySchema = z.object({ challenge_type: ChallengeTypeSchema, confirm: CONFIRM });

/** KTD22 reset through U13. */
export function resetStage(db: Db, input: z.infer<typeof ResetBodySchema>, now: Date = new Date()): Promise<OpsResult> {
  return singleFlight(`reset:${input.challenge_type}`, async () => {
    try {
      const result = await services().stage.reset(db, { challenge_type: input.challenge_type, by: OPERATOR, now });
      if (!result.ok) return fromLaneError(result.error);
      return ok({ cancelled_challenge_id: result.cancelled_challenge_id, new_challenge_id: result.new_challenge_id });
    } catch (err) {
      return fromThrown(err);
    }
  });
}

export const RollbackBodySchema = z.object({
  challenge_type: ChallengeTypeSchema,
  rule_key: RuleKeySchema,
  confirm: CONFIRM,
});

/** Restores an active non-seed rule's parent version through U9's lifecycle. */
export function rollbackRule(db: Db, input: z.infer<typeof RollbackBodySchema>, now: Date = new Date()): Promise<OpsResult> {
  return singleFlight(`rollback:${input.challenge_type}:${input.rule_key}`, async () => {
    const active = await collections(db).rules.findOne({
      challenge_type: input.challenge_type,
      rule_key: input.rule_key,
      status: "active",
    });
    if (!active) return refuse(404, "not_found", "No active version of that rule.");
    if (active.source === "seed" || active.parent_version === null) {
      return refuse(409, "not_allowed", "A seed rule has no parent version to roll back to.");
    }
    try {
      const result = await services().lifecycle.rollback(db, {
        challenge_type: input.challenge_type,
        rule_key: input.rule_key,
        by: OPERATOR,
        now,
      });
      if (!result.ok) return fromLaneError(result.error);
      return ok({ restored: result.restored, contracts: result.contracts });
    } catch (err) {
      return fromThrown(err);
    }
  });
}

export const LiveCheatBodySchema = z.object({ proof_id: IdSchema });

/** Sends a proof to U9's live-cheat learning entry point. */
export async function markLiveCheat(db: Db, input: z.infer<typeof LiveCheatBodySchema>, now: Date = new Date()): Promise<OpsResult> {
  const proof = await collections(db).proofs.findOne({ _id: input.proof_id }, { projection: { _id: 1 } });
  if (!proof) return refuse(404, "not_found", "No proof with that id.");
  try {
    const result = await services().learning.markLiveCheat(db, { proof_id: input.proof_id, by: OPERATOR, now });
    return ok({ queued: result.queued, skipped_reason: result.skipped_reason });
  } catch (err) {
    return fromThrown(err);
  }
}

// ---------------------------------------------------------------- settings switches (KTD23)

export const SettingsBodySchema = z.object({ patch: SettingsPatchSchema });

export async function changeSettings(db: Db, input: z.infer<typeof SettingsBodySchema>, now: Date = new Date()): Promise<OpsResult> {
  const settings = await updateSettings(db, input.patch, now);
  return ok({ settings: projectSettings(settings) });
}

// ---------------------------------------------------------------- controls with no interface yet

/**
 * The surprise-check trigger (U18) and the red-team run (U9, U10) have no entry point in
 * `interfaces.ts` yet, so these controls answer "not available yet" until one is added.
 */
export function notWiredYet(owner: string, what: string): OpsResult {
  return refuse(501, "not_available", `Not available yet: ${what} waits on ${owner}.`, { owner });
}
