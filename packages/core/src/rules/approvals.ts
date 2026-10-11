import type { Db } from "mongodb";
import { fail, type Id } from "../schema/common";
import { collections, isDuplicateKeyError } from "../schema/collections";
import {
  ApprovalSchema,
  type Approval,
  type ApprovalDecision,
  type ApprovalStatus,
  type FollowUp,
  type PayoutApproval,
  type RuleApproval,
} from "../schema/approvals";
import type { RuleStatus } from "../schema/rule";
import type { PromoterOutput } from "../schema/agents";
import { writeEvent } from "../events";
import {
  services,
  type CreateApprovalInput,
  type CreateApprovalResult,
  type DecideApprovalInput,
  type DecideApprovalResult,
  type LaneServices,
} from "../interfaces";
import { activateRule, getRule, rejectCandidate } from "./lifecycle";

/**
 * Approvals (U9 approach step 5, R22, R28, KTD10, KTD12).
 *
 * - One approval per rule candidate and one per settlement snapshot: the id is derived from the
 *   rule id or snapshot id, so a repeated create returns the existing record.
 * - A decision is one conditional update from pending, so only the matching caller acts and
 *   only that caller runs the follow-up.
 * - A rule approval's follow-up resumes the promoter through the agent client (U8), waits for
 *   the run to finish, applies the promoter's returned decision through the lifecycle (which
 *   still requires the approved record), and records the rule's resulting status. Declining
 *   rejects the candidate first, because a human decline is final (R22).
 * - A payout approval's follow-up calls U11's pay step.
 * - A failed follow-up is recorded on the approval, and calling decide again with the same
 *   decision retries it, so the dashboard can retry the same decision.
 */

/** Approval id for a rule candidate. */
export function ruleApprovalId(ruleId: Id): Id {
  return `apr_${ruleId}`.slice(0, 64);
}

/** Approval id for a settlement snapshot. */
export function payoutApprovalId(snapshotId: Id): Id {
  return `apr_${snapshotId}`.slice(0, 64);
}

const NOT_STARTED: FollowUp = { status: "not_started", attempts: 0, error: null };

export async function createApproval(
  db: Db,
  input: CreateApprovalInput,
  opts: { now?: Date } = {},
): Promise<CreateApprovalResult> {
  const now = opts.now ?? new Date();
  const base = { status: "pending" as const, decided_by: null, decided_at: null, created_at: now, updated_at: now, follow_up: NOT_STARTED };
  let approval: Approval;
  if (input.kind === "rule") {
    const { kind: _kind, ...rest } = input;
    approval = ApprovalSchema.parse({ ...rest, ...base, _id: ruleApprovalId(input.rule_id), kind: "rule", rule_status: null });
  } else {
    const { kind: _kind, ...rest } = input;
    approval = ApprovalSchema.parse({ ...rest, ...base, _id: payoutApprovalId(input.snapshot_id), kind: "payout" });
  }
  const col = collections(db).approvals;
  try {
    await col.insertOne(approval);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await col.findOne({ _id: approval._id });
    if (!existing) throw err;
    return { approval: existing, created: false };
  }
  return { approval, created: true };
}

export async function getApproval(db: Db, approvalId: Id): Promise<Approval | null> {
  return collections(db).approvals.findOne({ _id: approvalId });
}

export interface DecideOptions {
  /**
   * "agent" resumes the promoter (default). "direct" applies the decision through the
   * lifecycle without a resume, for the local-agent fallback where no local resume exists
   * (Risks & Dependencies). Defaults to "direct" when AGENT_ENGINE_MODE is "local".
   */
  resumeMode?: "agent" | "direct";
}

function defaultResumeMode(): "agent" | "direct" {
  return process.env.AGENT_ENGINE_MODE === "local" ? "direct" : "agent";
}

function statusFor(decision: ApprovalDecision): ApprovalStatus {
  return decision === "approve" ? "approved" : "declined";
}

function ruleStatusOf(approval: Approval): RuleStatus | null {
  return approval.kind === "rule" ? approval.rule_status : null;
}

export async function decideApproval(
  db: Db,
  input: DecideApprovalInput,
  opts: DecideOptions = {},
): Promise<DecideApprovalResult> {
  const now = input.now ?? new Date();
  const col = collections(db).approvals;
  const status = statusFor(input.decision);
  const decidedBy = input.decided_by.slice(0, 64);

  const decided = await col.findOneAndUpdate(
    { _id: input.approval_id, status: "pending" },
    {
      $set: {
        status,
        decided_by: decidedBy,
        decided_at: now,
        updated_at: now,
        follow_up: { status: "running", attempts: 1, error: null },
      },
    },
    { returnDocument: "after" },
  );

  if (decided) {
    await writeEvent(db, {
      kind: "approval.decided",
      summary:
        decided.kind === "rule"
          ? `Rule ${decided.rule_key} v${decided.rule_version} was ${status} on the dashboard.`
          : `Payout for challenge ${decided.challenge_id} was ${status} on the dashboard.`,
      challenge_id: decided.kind === "payout" ? decided.challenge_id : null,
      challenge_type: decided.kind === "rule" ? decided.challenge_type : null,
      rule_key: decided.kind === "rule" ? decided.rule_key : null,
      rule_version: decided.kind === "rule" ? decided.rule_version : null,
      data: { approval_id: decided._id, kind: decided.kind, decision: input.decision },
      at: now,
    });
    const after = await runFollowUp(db, decided, input.decision, decidedBy, 1, now, opts);
    return { ok: true, approval: after, decided: true, follow_up: after.follow_up, rule_status: ruleStatusOf(after) };
  }

  const existing = await col.findOne({ _id: input.approval_id });
  if (!existing) {
    return fail("not_found", `Approval ${input.approval_id} does not exist.`, "Refresh the approval queue.");
  }

  // Retry the same decision after a failed follow-up. Only the caller that moves the
  // follow-up from failed to running retries it.
  if (existing.status === status && existing.follow_up.status === "failed") {
    const attempts = existing.follow_up.attempts + 1;
    const retry = await col.findOneAndUpdate(
      { _id: existing._id, status, "follow_up.status": "failed", "follow_up.attempts": existing.follow_up.attempts },
      { $set: { follow_up: { status: "running", attempts, error: null }, updated_at: now } },
      { returnDocument: "after" },
    );
    if (retry) {
      const after = await runFollowUp(db, retry, input.decision, existing.decided_by ?? decidedBy, attempts, now, opts);
      return { ok: true, approval: after, decided: false, follow_up: after.follow_up, rule_status: ruleStatusOf(after) };
    }
  }

  return { ok: true, approval: existing, decided: false, follow_up: existing.follow_up, rule_status: ruleStatusOf(existing) };
}

async function runFollowUp(
  db: Db,
  approval: Approval,
  decision: ApprovalDecision,
  decidedBy: string,
  attempts: number,
  now: Date,
  opts: DecideOptions,
): Promise<Approval> {
  let result: { ok: boolean; error: string | null; rule_status: RuleStatus | null };
  try {
    result =
      approval.kind === "rule"
        ? await ruleFollowUp(db, approval, decision, decidedBy, now, opts.resumeMode ?? defaultResumeMode())
        : await payoutFollowUp(db, approval, decision, now);
  } catch (err) {
    const rule = approval.kind === "rule" ? await getRule(db, approval.rule_id) : null;
    result = { ok: false, error: errorText(err), rule_status: rule?.status ?? null };
  }

  const followUp: FollowUp = { status: result.ok ? "ok" : "failed", attempts, error: result.error?.slice(0, 500) ?? null };
  const set: Record<string, unknown> = { follow_up: followUp, updated_at: new Date(now.getTime()) };
  if (approval.kind === "rule") set.rule_status = result.rule_status;
  const updated = await collections(db).approvals.findOneAndUpdate(
    { _id: approval._id, "follow_up.status": "running", "follow_up.attempts": attempts },
    { $set: set },
    { returnDocument: "after" },
  );
  if (!result.ok) {
    await writeEvent(db, {
      kind: "approval.follow_up_failed",
      summary: `The follow-up for approval ${approval._id} failed; the same decision can be retried.`,
      rule_key: approval.kind === "rule" ? approval.rule_key : null,
      rule_version: approval.kind === "rule" ? approval.rule_version : null,
      challenge_id: approval.kind === "payout" ? approval.challenge_id : null,
      data: { approval_id: approval._id, attempts },
      at: now,
    });
  }
  return updated ?? (await getApproval(db, approval._id)) ?? approval;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function ruleFollowUp(
  db: Db,
  approval: RuleApproval,
  decision: ApprovalDecision,
  decidedBy: string,
  now: Date,
  mode: "agent" | "direct",
): Promise<{ ok: boolean; error: string | null; rule_status: RuleStatus | null }> {
  const by = `approval:${decidedBy}`.slice(0, 64);
  if (decision === "decline") {
    await rejectCandidate(db, { candidate_id: approval.rule_id, by }, { now });
  }

  let error: string | null = null;
  if (mode === "direct") {
    if (decision === "approve") {
      const res = await activateRule(db, { candidate_id: approval.rule_id, by }, { now });
      if (!res.ok) error = res.error.message;
    }
  } else {
    const res = await services().agents.resume({
      workspace: "promoter",
      execution_id: approval.execution_id,
      decision,
      meta: { event_id: approval._id },
    });
    if (!res.ok) {
      error = `promoter resume failed: ${res.error}`;
    } else if (res.status === "suspended") {
      error = "the promoter suspended again instead of finishing";
    } else {
      error = await applyPromoterDecision(db, res.output, approval.rule_id, by, now);
    }
  }

  const rule = await getRule(db, approval.rule_id);
  return { ok: error === null, error, rule_status: rule?.status ?? null };
}

/**
 * Apply the promoter's returned decision through the lifecycle. With egress the promoter has
 * already called the activate or reject endpoint and this is an idempotent no-op; in no-egress
 * mode it is how the decision lands. Activation still requires the approved record.
 * Returns an error message, or null.
 */
export async function applyPromoterDecision(
  db: Db,
  output: PromoterOutput,
  ruleId: Id,
  by: string,
  now: Date,
): Promise<string | null> {
  if (output.candidate_id !== ruleId) return `the promoter answered for candidate ${output.candidate_id}, not ${ruleId}`;
  if (output.decision === "activated") {
    const res = await activateRule(db, { candidate_id: ruleId, by }, { now });
    return res.ok ? null : res.error.message;
  }
  const rule = await getRule(db, ruleId);
  if (rule?.status === "active") return null;
  const res = await rejectCandidate(db, { candidate_id: ruleId, by }, { now });
  return res.ok ? null : res.error.message;
}

async function payoutFollowUp(
  db: Db,
  approval: PayoutApproval,
  decision: ApprovalDecision,
  now: Date,
): Promise<{ ok: boolean; error: string | null; rule_status: null }> {
  const res = await services().settlement.pay(db, {
    challenge_id: approval.challenge_id,
    snapshot_id: approval.snapshot_id,
    decision,
    now,
  });
  return res.ok ? { ok: true, error: null, rule_status: null } : { ok: false, error: res.error.message, rule_status: null };
}

/** U9's `approvals` service, for the composition root's `provideServices`. */
export const approvalsService: LaneServices["approvals"] = {
  create: (db, input) => createApproval(db, input),
  decide: (db, input) => decideApproval(db, input),
};
