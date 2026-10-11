import type { ClientSession, Db, Filter } from "mongodb";
import { newId } from "./schema/common";
import { collections, isDuplicateKeyError } from "./schema/collections";
import type { Job, JobKind } from "./schema/jobs";
import type { Settings } from "./schema/settings";
import { JOB_MAX_ATTEMPTS, JOB_RECLAIM_MS, JOB_RENEW_MS, readSettings } from "./config";
import { systemClock, type Clock } from "./clock";

/**
 * The job queue (KTD20). Work that outlives a request is a `jobs` record, run after the
 * response (Next.js `after()`) and recovered by the tick.
 *
 * - A claim moves a due, queued job to running and bumps `attempt`.
 * - The runner renews its claim every 15 seconds.
 * - The tick reclaims only running jobs whose last renewal is older than 45 seconds.
 * - Every runner write must match the claim's `attempt` (fencing), so a runner that lost its
 *   claim cannot overwrite the next attempt's work. Use `jobFence(claim)` in your own updates.
 * - The learning pause switch (KTD23) is checked when a learning job is claimed.
 */

export interface QueueJobInput {
  kind: JobKind;
  /** Learning: evidence proof id or example key. Settlement: challenge id. Referee: proof id. */
  dedup_key: string;
  payload?: Record<string, unknown>;
  /** Defaults to now. */
  due_at?: Date;
  max_attempts?: number;
}

export interface QueueJobResult {
  job: Job;
  /** False when a job with the same kind and dedup key already existed (KTD6). */
  created: boolean;
}

export async function queueJob(
  db: Db,
  input: QueueJobInput,
  opts: { now?: Date; session?: ClientSession } = {},
): Promise<QueueJobResult> {
  const now = opts.now ?? new Date();
  const job: Job = {
    _id: newId("job"),
    kind: input.kind,
    dedup_key: input.dedup_key,
    payload: input.payload ?? {},
    status: "queued",
    due_at: input.due_at ?? now,
    claimed_at: null,
    renewed_at: null,
    attempt: 0,
    max_attempts: input.max_attempts ?? JOB_MAX_ATTEMPTS,
    last_error: null,
    result: null,
    created_at: now,
    updated_at: now,
    finished_at: null,
  };
  const col = collections(db).jobs;
  // Check first so a repeat inside an outer transaction never raises a duplicate-key error.
  const existing = await col.findOne({ kind: input.kind, dedup_key: input.dedup_key }, { session: opts.session });
  if (existing) return { job: existing, created: false };
  try {
    await col.insertOne(job, { session: opts.session });
    return { job, created: true };
  } catch (err) {
    if (!isDuplicateKeyError(err) || opts.session?.inTransaction()) throw err;
    const raced = await col.findOne({ kind: input.kind, dedup_key: input.dedup_key });
    if (!raced) throw err;
    return { job: raced, created: false };
  }
}

/**
 * Push a queued job's due time later, for example when the final check opens new requests and
 * settlement must wait for their grace (KTD12). Never moves a due time earlier.
 */
export async function deferQueuedJob(
  db: Db,
  key: { kind: JobKind; dedup_key: string },
  dueAt: Date,
  now: Date = new Date(),
): Promise<boolean> {
  const res = await collections(db).jobs.updateOne(
    { kind: key.kind, dedup_key: key.dedup_key, status: "queued", due_at: { $lt: dueAt } },
    { $set: { due_at: dueAt, updated_at: now } },
  );
  return res.modifiedCount === 1;
}

/** A successful claim. Pass it to every later call; its attempt fences the runner's writes. */
export interface JobClaim {
  job: Job;
  attempt: number;
}

/** Filter that matches the job only while this claim still holds it. */
export function jobFence(claim: JobClaim): Filter<Job> {
  return { _id: claim.job._id, status: "running", attempt: claim.attempt };
}

export interface ClaimOptions {
  now?: Date;
  /** Fresh settings; read from the database when omitted (KTD23). */
  settings?: Settings;
}

async function claimWhere(db: Db, filter: Filter<Job>, opts: ClaimOptions): Promise<JobClaim | null> {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? (await readSettings(db));
  const where: Filter<Job> = {
    ...filter,
    status: "queued",
    due_at: { $lte: now },
    $expr: { $lt: ["$attempt", "$max_attempts"] },
  };
  // KTD23: the learning pause switch is checked at claim time.
  if (settings.learning_paused) where.$and = [{ kind: { $ne: "learning" } }];
  const job = await collections(db).jobs.findOneAndUpdate(
    where,
    { $set: { status: "running", claimed_at: now, renewed_at: now, updated_at: now }, $inc: { attempt: 1 } },
    { returnDocument: "after", sort: { due_at: 1 } },
  );
  return job ? { job, attempt: job.attempt } : null;
}

/** Claim one job by id. Returns null if it is not queued and due, or learning is paused for it. */
export async function claimJob(db: Db, jobId: string, opts: ClaimOptions = {}): Promise<JobClaim | null> {
  return claimWhere(db, { _id: jobId }, opts);
}

/** Claim the earliest due queued job, optionally of some kinds. */
export async function claimNextJob(
  db: Db,
  opts: ClaimOptions & { kinds?: JobKind[] } = {},
): Promise<JobClaim | null> {
  return claimWhere(db, opts.kinds ? { kind: { $in: opts.kinds } } : {}, opts);
}

/** Renew the claim. False means the claim was lost (reclaimed or finished); stop working. */
export async function renewJobClaim(db: Db, claim: JobClaim, now: Date = new Date()): Promise<boolean> {
  const res = await collections(db).jobs.updateOne(jobFence(claim), { $set: { renewed_at: now, updated_at: now } });
  return res.matchedCount === 1;
}

export async function completeJob(
  db: Db,
  claim: JobClaim,
  result: Record<string, unknown> = {},
  opts: { now?: Date; session?: ClientSession } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const res = await collections(db).jobs.updateOne(
    jobFence(claim),
    { $set: { status: "done", result, finished_at: now, updated_at: now } },
    { session: opts.session },
  );
  return res.matchedCount === 1;
}

/** Mark the job skipped, for example while an open candidate exists for the same cheat class (KTD20). */
export async function skipJob(
  db: Db,
  claim: JobClaim,
  reason: string,
  opts: { now?: Date; session?: ClientSession } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const res = await collections(db).jobs.updateOne(
    jobFence(claim),
    { $set: { status: "skipped", result: { skipped: reason }, finished_at: now, updated_at: now } },
    { session: opts.session },
  );
  return res.matchedCount === 1;
}

/** Put the job back in the queue for later, keeping its attempt count. */
export async function requeueJob(
  db: Db,
  claim: JobClaim,
  dueAt: Date,
  opts: { now?: Date; session?: ClientSession } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const res = await collections(db).jobs.updateOne(
    jobFence(claim),
    { $set: { status: "queued", due_at: dueAt, updated_at: now }, $inc: { max_attempts: 1 } },
    { session: opts.session },
  );
  return res.matchedCount === 1;
}

/** Record a failure. Retries after `retryAt` (default 30 s) until `max_attempts`, then fails. */
export async function failJob(
  db: Db,
  claim: JobClaim,
  error: unknown,
  opts: { now?: Date; retryAt?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const exhausted = claim.attempt >= claim.job.max_attempts;
  const res = await collections(db).jobs.updateOne(
    jobFence(claim),
    exhausted
      ? { $set: { status: "failed", last_error: message, finished_at: now, updated_at: now } }
      : {
          $set: {
            status: "queued",
            last_error: message,
            due_at: opts.retryAt ?? new Date(now.getTime() + 30_000),
            updated_at: now,
          },
        },
  );
  return res.matchedCount === 1;
}

/**
 * Tick recovery (KTD20): running jobs whose last renewal is older than 45 seconds go back to
 * the queue (or fail when out of attempts). Returns how many were reclaimed.
 */
export async function reclaimStaleJobs(db: Db, now: Date = new Date()): Promise<number> {
  const col = collections(db).jobs;
  const stale = new Date(now.getTime() - JOB_RECLAIM_MS);
  const base: Filter<Job> = { status: "running", renewed_at: { $lt: stale } };
  const failed = await col.updateMany(
    { ...base, $expr: { $gte: ["$attempt", "$max_attempts"] } },
    { $set: { status: "failed", last_error: "claim expired without renewal", finished_at: now, updated_at: now } },
  );
  const requeued = await col.updateMany(
    { ...base, $expr: { $lt: ["$attempt", "$max_attempts"] } },
    { $set: { status: "queued", due_at: now, updated_at: now } },
  );
  return requeued.modifiedCount + failed.modifiedCount;
}

export interface JobContext {
  db: Db;
  claim: JobClaim;
  job: Job;
  /** Filter to use in the runner's own conditional writes. */
  fence: Filter<Job>;
  /** True once a renewal found the claim gone. Stop and write nothing. */
  isLost(): boolean;
  now(): Date;
}

export type JobOutcome =
  | { kind: "done"; result?: Record<string, unknown> }
  | { kind: "requeue"; due_at: Date }
  | { kind: "skip"; reason: string };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome | void>;
export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

export interface RunJobResult {
  job_id: string;
  status: "done" | "requeued" | "skipped" | "failed" | "lost";
  error?: string;
}

/**
 * Run a claimed job: renew every 15 seconds while the handler works, then complete, requeue,
 * skip or fail it under the claim's fence.
 */
export async function runClaimedJob(
  db: Db,
  claim: JobClaim,
  handler: JobHandler,
  opts: { clock?: Clock; renewEveryMs?: number } = {},
): Promise<RunJobResult> {
  const clock = opts.clock ?? systemClock;
  let lost = false;
  const timer = setInterval(() => {
    renewJobClaim(db, claim, clock.now())
      .then((held) => {
        if (!held) lost = true;
      })
      .catch(() => undefined);
  }, opts.renewEveryMs ?? JOB_RENEW_MS);
  timer.unref?.();
  const ctx: JobContext = {
    db,
    claim,
    job: claim.job,
    fence: jobFence(claim),
    isLost: () => lost,
    now: () => clock.now(),
  };
  try {
    const outcome = (await handler(ctx)) ?? { kind: "done" as const };
    if (lost) return { job_id: claim.job._id, status: "lost" };
    let held: boolean;
    let status: RunJobResult["status"];
    if (outcome.kind === "requeue") {
      held = await requeueJob(db, claim, outcome.due_at, { now: clock.now() });
      status = "requeued";
    } else if (outcome.kind === "skip") {
      held = await skipJob(db, claim, outcome.reason, { now: clock.now() });
      status = "skipped";
    } else {
      held = await completeJob(db, claim, outcome.result ?? {}, { now: clock.now() });
      status = "done";
    }
    return { job_id: claim.job._id, status: held ? status : "lost" };
  } catch (err) {
    const held = await failJob(db, claim, err, { now: clock.now() });
    return {
      job_id: claim.job._id,
      status: held ? "failed" : "lost",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearInterval(timer);
  }
}

/**
 * Tick helper (U18): reclaim stale jobs, then claim and run due jobs that have a handler,
 * up to `limit`. Call it inside `after()` so the response is not delayed.
 */
export async function runDueJobs(
  db: Db,
  handlers: JobHandlers,
  opts: { clock?: Clock; limit?: number; settings?: Settings } = {},
): Promise<{ reclaimed: number; runs: RunJobResult[] }> {
  const clock = opts.clock ?? systemClock;
  const reclaimed = await reclaimStaleJobs(db, clock.now());
  const kinds = Object.keys(handlers) as JobKind[];
  const runs: RunJobResult[] = [];
  if (kinds.length === 0) return { reclaimed, runs };
  const settings = opts.settings ?? (await readSettings(db));
  const limit = opts.limit ?? 5;
  for (let i = 0; i < limit; i++) {
    const claim = await claimNextJob(db, { kinds, now: clock.now(), settings });
    if (!claim) break;
    const handler = handlers[claim.job.kind];
    if (!handler) break;
    runs.push(await runClaimedJob(db, claim, handler, { clock }));
  }
  return { reclaimed, runs };
}
