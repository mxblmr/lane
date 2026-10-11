import type { Db } from "mongodb";
import { collections, isDuplicateKeyError } from "./schema/collections";
import type { Challenge } from "./schema/challenges";
import { ACTION_KINDS, type InboxItem } from "./schema/inbox";
import { TICK_LEASE_ID } from "./schema/ops";
import type { Proof, ProofHistoryEntry } from "./schema/proofs";
import type { AnyPack, FinalCheckResult, PackContext } from "./schema/pack";
import type { TickInput, TickResult } from "./interfaces";
import { TICK_LEASE_MS } from "./config";
import { finalGraceEnd, isWindowClosed, systemClock, type Clock } from "./clock";
import { deferQueuedJob, queueJob, reclaimStaleJobs, runDueJobs, type JobHandlers, type RunJobResult } from "./jobs";
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
}

function emptyDetails(): TickDetails {
  return { released: [], cancelled: [], expired: [], proofs_changed: 0, closed: [], settlement_jobs: [] };
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

// ---------------------------------------------------------------- the tick

export async function runTick(db: Db, input: TickInput = {}, opts: TickOptions = {}): Promise<TickRunResult> {
  const now = input.now ?? new Date();
  const details = emptyDetails();
  const holder = `${(input.holder ?? "tick").slice(0, 40)}:${globalThis.crypto.randomUUID()}`;
  if (!(await takeTickLease(db, holder, now))) {
    return { ran: false, transitions: 0, jobs_reclaimed: 0, details };
  }
  try {
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
};
