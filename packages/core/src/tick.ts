import type { Db } from "mongodb";
import { collections, isDuplicateKeyError } from "./schema/collections";
import type { Challenge } from "./schema/challenges";
import { ACTION_KINDS, type InboxItem } from "./schema/inbox";
import { TICK_LEASE_ID } from "./schema/ops";
import type { Proof, ProofHistoryEntry } from "./schema/proofs";
import type { AnyPack, FinalCheckResult, PackContext } from "./schema/pack";
import { NotImplementedError, services, type LaneServices, type TickInput, type TickResult } from "./interfaces";
import { readSettings, SURPRISE_CHECKS_PER_DAY, TICK_LEASE_MS } from "./config";
import {
  canScheduleSurpriseCheck,
  currentDayIndex,
  dayEnd,
  dayStart,
  finalGraceEnd,
  isWindowClosed,
  systemClock,
  type Clock,
} from "./clock";
import {
  deferQueuedJob,
  queueJob,
  reclaimStaleJobs,
  runDueJobs,
  type JobHandler,
  type JobHandlers,
  type RunJobResult,
} from "./jobs";
import { writeEvent } from "./events";
import { getPack } from "./packs/index";
import { addInboxItem, expireInboxItems, releaseDueInboxItems } from "./inbox";

/**
 * The tick (U18, KTD13, KTD20). Safe to run concurrently: it takes a 15-second lease on the ops
 * document and returns at once if it loses, and every transition is a conditional update on the
 * current status or due time. Order:
 *   1. lease
 *   2. release due scheduled items (surprise checks) and hold the day's proofs
 *   3. expire open action items past their grace, voiding held proofs and days
 *   4. close windows: active to settling once, run the pack's final check, queue the settlement job
 *   5. job recovery: requeue running jobs whose claim went 45 s without renewal
 * Running due jobs happens in `runTickJobs`, which the route calls inside `after()`.
 */

export interface TickDetails {
  /** Surprise checks drawn by this tick. */
  drawn: number;
  released: string[];
  cancelled: string[];
  expired: string[];
  /** Proofs moved to held or not counted by surprise checks and grace expiry. */
  proofs_changed: number;
  /** Challenges this tick moved from active to settling. */
  closed: string[];
  /** Settlement jobs this tick queued (window close or recovery of a settling challenge). */
  settlement_jobs: string[];
}

export interface TickRunResult extends TickResult {
  details: TickDetails;
}

export interface TickOptions {
  /** Test seam: resolve a pack other than the registry's. */
  packFor?: (type: Challenge["type"]) => AnyPack;
  /** Network context for the final check. Defaults to global fetch and no GitHub token. */
  packContext?: Partial<Omit<PackContext, "now">>;
  /** Test seam: replace the deterministic surprise-check draw. */
  surpriseDraw?: SurpriseDrawFn;
}

function emptyDetails(): TickDetails {
  return { drawn: 0, released: [], cancelled: [], expired: [], proofs_changed: 0, closed: [], settlement_jobs: [] };
}

// ---------------------------------------------------------------- lease

/** Take the tick lease for 15 seconds. False when another holder has it. */
export async function takeTickLease(db: Db, holder: string, now: Date): Promise<boolean> {
  try {
    const lease = await collections(db).ops.findOneAndUpdate(
      { _id: TICK_LEASE_ID, lease_until: { $lte: now } },
      { $set: { holder, lease_until: new Date(now.getTime() + TICK_LEASE_MS), updated_at: now } },
      { upsert: true, returnDocument: "after" },
    );
    return lease?.holder === holder;
  } catch (err) {
    // The lease document exists and is held: the upsert collided on _id.
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** Release the lease if this holder still has it, so the next poll can tick at once. */
export async function releaseTickLease(db: Db, holder: string, now: Date): Promise<void> {
  await collections(db).ops.updateOne(
    { _id: TICK_LEASE_ID, holder },
    { $set: { holder: null, lease_until: new Date(0), updated_at: now } },
  );
}

// ---------------------------------------------------------------- proof transitions

function history(from: Proof["status"], to: Proof["status"], at: Date, note: string): ProofHistoryEntry {
  return { at, from, to, by: "system", note };
}

/** A released surprise check holds that player-day's counting proofs (R18, KTD7). */
async function holdDayForCheck(db: Db, check: InboxItem, now: Date): Promise<number> {
  if (check.kind !== "surprise_check" || !check.challenge_id || check.day_index === null) return 0;
  let changed = 0;
  for (const from of ["accepted", "flagged_accept"] as const) {
    const res = await collections(db).proofs.updateMany(
      { challenge_id: check.challenge_id, player_id: check.player_id, day_index: check.day_index, status: from },
      {
        $set: { status: "held", held_reason: "surprise_check", updated_at: now },
        $push: { history: history(from, "held", now, "surprise check released") },
      },
    );
    changed += res.modifiedCount;
  }
  await writeEvent(db, {
    kind: "inbox.surprise_check",
    summary: `Surprise check released for day ${check.day_index + 1}; that day is held until it is answered.`,
    challenge_id: check.challenge_id,
    player_id: check.player_id,
    data: { day_index: check.day_index, slot: check.slot ?? 0, held_proofs: changed },
    at: now,
  });
  return changed;
}

/**
 * Grace expiry. An expired surprise check voids its day: every counting or held proof for that
 * player-day stops counting (AE4). An expired extra-proof request leaves its held proof
 * "not counted (unanswered)" (KTD7).
 */
async function applyExpiry(db: Db, item: InboxItem, now: Date): Promise<number> {
  const proofs = collections(db).proofs;
  if (item.kind === "surprise_check" && item.challenge_id && item.day_index !== null) {
    let changed = 0;
    for (const from of ["held", "accepted", "flagged_accept"] as const) {
      const res = await proofs.updateMany(
        { challenge_id: item.challenge_id, player_id: item.player_id, day_index: item.day_index, status: from },
        {
          $set: { status: "not_counted", held_reason: null, not_counted_reason: "surprise_check_expired", updated_at: now },
          $push: { history: history(from, "not_counted", now, "surprise check unanswered") },
        },
      );
      changed += res.modifiedCount;
    }
    await writeEvent(db, {
      kind: "proof.not_counted",
      summary: `Surprise check unanswered: day ${item.day_index + 1} no longer counts.`,
      challenge_id: item.challenge_id,
      player_id: item.player_id,
      data: { day_index: item.day_index, reason: "surprise_check_expired", proofs: changed },
      at: now,
    });
    return changed;
  }
  if (item.kind === "extra_proof" && item.subject_proof_id) {
    const res = await proofs.updateOne(
      { _id: item.subject_proof_id, status: "held" },
      {
        $set: { status: "not_counted", held_reason: null, not_counted_reason: "unanswered", updated_at: now },
        $push: { history: history("held", "not_counted", now, "extra-proof request unanswered") },
      },
    );
    if (res.modifiedCount === 1) {
      await writeEvent(db, {
        kind: "proof.not_counted",
        summary: "Extra-proof request unanswered: the proof is not counted (unanswered).",
        challenge_id: item.challenge_id,
        player_id: item.player_id,
        proof_id: item.subject_proof_id,
        data: { reason: "unanswered" },
        at: now,
      });
    }
    return res.modifiedCount;
  }
  return 0;
}

// ---------------------------------------------------------------- window close and settlement hand-off

/** Latest due time among the challenge's open action items, for the settlement job's due time (KTD12). */
async function longestOpenGrace(db: Db, challengeId: string): Promise<Date | null> {
  const [latest] = await collections(db)
    .inbox.find({ challenge_id: challengeId, kind: { $in: [...ACTION_KINDS] }, status: { $in: ["open", "scheduled"] }, due_at: { $ne: null } })
    .sort({ due_at: -1 })
    .limit(1)
    .toArray();
  return latest?.due_at ?? null;
}

/**
 * Run the pack's final check (R27) and queue the compute-and-pay job, due when the longest open
 * grace ends (KTD12). Idempotent: proof changes are conditional and the job is unique per challenge.
 */
async function finalizeWindow(db: Db, challenge: Challenge, now: Date, opts: TickOptions): Promise<{ jobId: string; created: boolean }> {
  const pack = (opts.packFor ?? getPack)(challenge.type);
  const proofs = await collections(db).proofs.find({ challenge_id: challenge._id }).toArray();
  let final: FinalCheckResult = { not_counted: [], requests: [] };
  try {
    final = await pack.finalCheck(challenge, proofs, {
      now,
      fetch: opts.packContext?.fetch ?? globalThis.fetch,
      githubToken: opts.packContext?.githubToken ?? null,
    });
  } catch (err) {
    await writeEvent(db, {
      kind: "challenge.final_check_failed",
      summary: "The final check failed; settlement goes ahead with the proofs as they stand.",
      challenge_id: challenge._id,
      challenge_type: challenge.type,
      data: { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) },
      at: now,
    });
  }
  for (const nc of final.not_counted) {
    for (const from of ["accepted", "flagged_accept"] as const) {
      await collections(db).proofs.updateOne(
        { _id: nc.proof_id, challenge_id: challenge._id, status: from },
        {
          $set: { status: "not_counted", not_counted_reason: nc.reason, held_reason: null, updated_at: now },
          $push: { history: { at: now, from, to: "not_counted", by: "final_check", note: "final check" } },
        },
      );
    }
  }
  for (const request of final.requests) {
    await addInboxItem(db, { ...request, challenge_id: challenge._id }, { now });
  }
  const graceEnd = challenge.clock ? finalGraceEnd(challenge.clock) : now;
  const openGrace = await longestOpenGrace(db, challenge._id);
  const dueMs = Math.max(now.getTime(), graceEnd.getTime(), openGrace?.getTime() ?? 0);
  const due = new Date(dueMs);
  const queued = await queueJob(
    db,
    { kind: "settlement", dedup_key: challenge._id, payload: { challenge_id: challenge._id }, due_at: due },
    { now },
  );
  if (!queued.created) await deferQueuedJob(db, { kind: "settlement", dedup_key: challenge._id }, due, now);
  return { jobId: queued.job._id, created: queued.created };
}

async function closeWindows(db: Db, now: Date, opts: TickOptions, details: TickDetails): Promise<void> {
  const col = collections(db).challenges;
  const active = await col.find({ status: "active", clock: { $ne: null } }).toArray();
  for (const challenge of active) {
    if (!challenge.clock || !isWindowClosed(challenge.clock, now)) continue;
    // KTD13: one conditional move from active to settling, so only one tick wins it.
    const moved = await col.findOneAndUpdate(
      { _id: challenge._id, status: "active" },
      { $set: { status: "settling", closed_at: now, updated_at: now } },
      { returnDocument: "after" },
    );
    if (!moved) continue;
    details.closed.push(moved._id);
    await writeEvent(db, {
      kind: "challenge.window_closed",
      summary: `${moved.title}: the window closed and settlement started.`,
      challenge_id: moved._id,
      challenge_type: moved.type,
      at: now,
    });
    const job = await finalizeWindow(db, moved, now, opts);
    if (job.created) details.settlement_jobs.push(job.jobId);
  }

  // Recovery: a settling challenge whose tick died before queueing its job gets one now.
  const settling = await col.find({ status: "settling" }, { projection: { _id: 1 } }).toArray();
  if (settling.length === 0) return;
  const withJobs = new Set(
    (
      await collections(db)
        .jobs.find({ kind: "settlement", dedup_key: { $in: settling.map((c) => c._id) } }, { projection: { dedup_key: 1 } })
        .toArray()
    ).map((j) => j.dedup_key),
  );
  for (const { _id } of settling) {
    if (withJobs.has(_id)) continue;
    const challenge = await col.findOne({ _id, status: "settling" });
    if (!challenge) continue;
    const job = await finalizeWindow(db, challenge, now, opts);
    if (job.created) details.settlement_jobs.push(job.jobId);
  }
}

// ---------------------------------------------------------------- surprise-check drawing (R10, KTD13)

/** One player-day's draw: how many checks (clamped to the 3 slots) and where each falls in the day (0 to 1). */
export interface SurpriseDraw {
  count: number;
  fractions: number[];
  codes: string[];
}

export type SurpriseDrawFn = (key: { challenge_id: string; player_id: string; day_index: number }) => SurpriseDraw;

/** 32-bit FNV-1a, so a player-day always draws the same checks however many ticks run. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Default draw: 0 to 3 checks a day, at deterministic points in the day, with 4-digit codes. */
export const defaultSurpriseDraw: SurpriseDrawFn = ({ challenge_id, player_id, day_index }) => {
  const seed = `${challenge_id}:${player_id}:${day_index}`;
  const count = fnv1a(`${seed}:count`) % (SURPRISE_CHECKS_PER_DAY + 1);
  const fractions: number[] = [];
  const codes: string[] = [];
  for (let slot = 0; slot < SURPRISE_CHECKS_PER_DAY; slot++) {
    fractions.push((fnv1a(`${seed}:at:${slot}`) % 10_000) / 10_000);
    codes.push(String(1000 + (fnv1a(`${seed}:code:${slot}`) % 9000)));
  }
  return { count, fractions, codes };
};

/**
 * Draw the current day's surprise checks for every member of every active challenge, once per
 * player-day: each check is a scheduled inbox item with a unique slot 0 to 2, so overlapping ticks
 * cannot exceed 3 a day. The draw is deterministic, so later ticks in the same day add nothing.
 * No check is drawn whose grace would touch the player's quiet hours or end after the window.
 * A slot whose grace has already ended when first drawn is skipped.
 */
async function drawSurpriseChecks(db: Db, now: Date, opts: TickOptions, details: TickDetails): Promise<void> {
  const settings = await readSettings(db);
  if (!settings.surprise_checks_enabled) return;
  const draw = opts.surpriseDraw ?? defaultSurpriseDraw;
  const col = collections(db);
  const active = await col.challenges.find({ status: "active", clock: { $ne: null } }).toArray();
  for (const challenge of active) {
    const clock = challenge.clock!;
    const day = currentDayIndex(clock, now);
    if (day === null) continue;
    const members = await col.memberships
      .find({ challenge_id: challenge._id, joined_day_index: { $lte: day } }, { projection: { player_id: 1 } })
      .toArray();
    if (members.length === 0) continue;
    const players = await col.players
      .find({ _id: { $in: members.map((m) => m.player_id) } }, { projection: { _id: 1, time_zone: 1 } })
      .toArray();
    const start = dayStart(clock, day).getTime();
    const length = dayEnd(clock, day).getTime() - start;
    const notAfter = finalGraceEnd(clock);
    for (const player of players) {
      const { count, fractions, codes } = draw({ challenge_id: challenge._id, player_id: player._id, day_index: day });
      const slots = Math.min(Math.max(0, Math.floor(count)), SURPRISE_CHECKS_PER_DAY);
      for (let slot = 0; slot < slots; slot++) {
        const fraction = Math.min(Math.max(fractions[slot] ?? 0, 0), 0.999);
        const releaseAt = new Date(start + Math.floor(fraction * length));
        const dueAt = new Date(releaseAt.getTime() + clock.grace_sec * 1000);
        if (dueAt.getTime() <= now.getTime()) continue;
        const allowed = canScheduleSurpriseCheck({ releaseAt, graceSec: clock.grace_sec, timeZone: player.time_zone, notAfter });
        if (!allowed.ok) continue;
        const code = codes[slot] ?? "0000";
        const { created } = await addInboxItem(
          db,
          {
            player_id: player._id,
            challenge_id: challenge._id,
            kind: "surprise_check",
            actor: "player",
            instruction:
              `Surprise check for day ${day + 1}: ask the player for fresh proof for today that contains the code ${code}, ` +
              `then send it with lane_submit_proof and this request id before it is due.`,
            answer_tool: "lane_submit_proof",
            answer_args: { challenge_id: challenge._id },
            day_index: day,
            subject_proof_id: null,
            slot,
            code,
            release_at: releaseAt,
            due_at: dueAt,
          },
          { now },
        );
        if (created) details.drawn += 1;
      }
    }
  }
}

// ---------------------------------------------------------------- the tick

export async function runTick(db: Db, input: TickInput = {}, opts: TickOptions = {}): Promise<TickRunResult> {
  const now = input.now ?? new Date();
  const details = emptyDetails();
  const holder = `${(input.holder ?? "tick").slice(0, 40)}:${globalThis.crypto.randomUUID()}`;
  if (!(await takeTickLease(db, holder, now))) {
    return { ran: false, transitions: 0, jobs_reclaimed: 0, details };
  }
  try {
    // Draw today's surprise checks once per player-day.
    await drawSurpriseChecks(db, now, opts, details);

    // Due surprise checks: scheduled to open, and the day's proofs held.
    const { released, cancelled } = await releaseDueInboxItems(db, now);
    details.released = released.map((i) => i._id);
    details.cancelled = cancelled.map((i) => i._id);
    for (const item of released) details.proofs_changed += await holdDayForCheck(db, item, now);

    // Grace expiry and held days.
    const { expired } = await expireInboxItems(db, { now });
    details.expired = expired.map((i) => i._id);
    for (const item of expired) details.proofs_changed += await applyExpiry(db, item, now);

    // Window close and the settlement hand-off.
    await closeWindows(db, now, opts, details);

    // Job recovery (KTD20).
    const jobs_reclaimed = await reclaimStaleJobs(db, now);

    const transitions =
      details.released.length + details.cancelled.length + details.expired.length + details.closed.length;
    return { ran: true, transitions, jobs_reclaimed, details };
  } finally {
    await releaseTickLease(db, holder, now);
  }
}

// ---------------------------------------------------------------- job handlers and running due jobs

/**
 * Handlers the tick uses to run due jobs. Each owner registers its own kind (U5 referee_verdict,
 * U9 learning and red_team, U11 settlement) from the composition root. U3's services table has no
 * job-handler slot, so the registry lives here.
 */
let handlers: JobHandlers = {};

/** How long a settlement job waits before trying again while U11 is not wired or not ready. */
export const SETTLEMENT_RETRY_MS = 60_000;

/**
 * The settlement hand-off (KTD12): the job the tick queues at window close calls U11's `settle`.
 * While U11 is not wired the job waits rather than burning its attempts. When `settle` says it
 * must wait (new requests opened by the final check), the job goes back in the queue until the
 * longest open grace ends.
 */
export const settlementJobHandler: JobHandler = async (ctx) => {
  const challengeId = typeof ctx.job.payload.challenge_id === "string" ? ctx.job.payload.challenge_id : ctx.job.dedup_key;
  const now = ctx.now();
  const retry = new Date(now.getTime() + SETTLEMENT_RETRY_MS);
  let result;
  try {
    result = await services().settlement.settle(ctx.db, { challenge_id: challengeId, now });
  } catch (err) {
    if (err instanceof NotImplementedError) return { kind: "requeue", due_at: retry };
    throw err;
  }
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  if (result.status === "requeued") {
    const grace = await longestOpenGrace(ctx.db, challengeId);
    return { kind: "requeue", due_at: grace && grace.getTime() > now.getTime() ? grace : retry };
  }
  return { kind: "done", result: { status: result.status, approval_id: result.approval_id } };
};

export function provideJobHandlers(next: JobHandlers): void {
  handlers = { ...handlers, ...next };
}

export function resetJobHandlers(): void {
  handlers = {};
}

export function jobHandlers(): JobHandlers {
  return handlers;
}

/**
 * Reclaim stale jobs, then claim and run due jobs that have a handler. The tick route calls this
 * inside `after()`, so a poll's response never waits for a job (KTD20).
 */
export async function runTickJobs(
  db: Db,
  opts: { clock?: Clock; limit?: number; handlers?: JobHandlers } = {},
): Promise<{ reclaimed: number; runs: RunJobResult[] }> {
  return runDueJobs(db, opts.handlers ?? handlers, { clock: opts.clock ?? systemClock, limit: opts.limit });
}

/** The U18 tick service, in the shape of `LaneServices["tick"]`. */
export const tickService = {
  run: (db: Db, input: TickInput) => runTick(db, input),
} satisfies LaneServices["tick"];
