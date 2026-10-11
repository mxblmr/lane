import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimJob,
  claimNextJob,
  completeJob,
  deferQueuedJob,
  failJob,
  jobFence,
  queueJob,
  reclaimStaleJobs,
  renewJobClaim,
  runClaimedJob,
  runDueJobs,
} from "../src/jobs";
import { DEFAULT_SETTINGS, JOB_RECLAIM_MS, updateSettings } from "../src/config";
import { manualClock } from "../src/clock";
import { collections } from "../src/schema/collections";
import { startReplSet, type TestMongo } from "../src/testing/mongo";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});

const T0 = new Date("2026-10-11T20:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe("job queue (KTD20)", () => {
  it("queues one job per kind and dedup key", async () => {
    const db = await mongo.freshDb();
    const a = await queueJob(db, { kind: "learning", dedup_key: "prf_1", payload: { proof_id: "prf_1" } }, { now: T0 });
    const b = await queueJob(db, { kind: "learning", dedup_key: "prf_1", payload: { proof_id: "prf_1" } }, { now: T0 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => queueJob(db, { kind: "settlement", dedup_key: "chl_1" }, { now: T0 })),
    );
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job._id).toBe(a.job._id);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await collections(db).jobs.countDocuments()).toBe(2);
  });

  it("gives one claim when two claims of the same job race", async () => {
    const db = await mongo.freshDb();
    const { job } = await queueJob(db, { kind: "referee_verdict", dedup_key: "prf_9" }, { now: T0 });
    const settings = DEFAULT_SETTINGS;
    const claims = await Promise.all([
      claimJob(db, job._id, { now: T0, settings }),
      claimJob(db, job._id, { now: T0, settings }),
      claimNextJob(db, { now: T0, settings }),
    ]);
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]?.attempt).toBe(1);
    const stored = await collections(db).jobs.findOne({ _id: job._id });
    expect(stored?.status).toBe("running");
    expect(stored?.attempt).toBe(1);
  });

  it("does not claim a job before it is due", async () => {
    const db = await mongo.freshDb();
    const { job } = await queueJob(db, { kind: "settlement", dedup_key: "chl_1", due_at: plus(60_000) }, { now: T0 });
    expect(await claimJob(db, job._id, { now: plus(59_000) })).toBeNull();
    expect(await claimJob(db, job._id, { now: plus(60_000) })).not.toBeNull();
  });

  it("defers a queued job's due time but never moves it earlier", async () => {
    const db = await mongo.freshDb();
    const key = { kind: "settlement" as const, dedup_key: "chl_7" };
    await queueJob(db, { ...key, due_at: plus(10_000) }, { now: T0 });
    expect(await deferQueuedJob(db, key, plus(5_000))).toBe(false);
    expect(await deferQueuedJob(db, key, plus(90_000))).toBe(true);
    expect((await collections(db).jobs.findOne(key))?.due_at.getTime()).toBe(plus(90_000).getTime());
  });

  it("reclaims a job whose renewal is older than 45 seconds, fences the old runner, and leaves a renewing job alone", async () => {
    const db = await mongo.freshDb();
    const dead = await queueJob(db, { kind: "learning", dedup_key: "prf_dead" }, { now: T0 });
    const alive = await queueJob(db, { kind: "learning", dedup_key: "prf_alive" }, { now: T0 });
    const deadClaim = await claimJob(db, dead.job._id, { now: T0 });
    const aliveClaim = await claimJob(db, alive.job._id, { now: T0 });
    expect(deadClaim && aliveClaim).toBeTruthy();
    if (!deadClaim || !aliveClaim) return;

    // The live runner renews every 15 seconds for 90 seconds; the dead one never does.
    for (let t = 15_000; t <= 90_000; t += 15_000) {
      expect(await renewJobClaim(db, aliveClaim, plus(t))).toBe(true);
    }
    expect(await reclaimStaleJobs(db, plus(JOB_RECLAIM_MS - 1_000))).toBe(0);
    expect(await reclaimStaleJobs(db, plus(90_000))).toBe(1);

    const aliveStored = await collections(db).jobs.findOne({ _id: alive.job._id });
    expect(aliveStored?.status).toBe("running");
    const deadStored = await collections(db).jobs.findOne({ _id: dead.job._id });
    expect(deadStored?.status).toBe("queued");

    // The next claim bumps the attempt; the dead runner's late writes no longer match.
    const second = await claimJob(db, dead.job._id, { now: plus(91_000) });
    expect(second?.attempt).toBe(2);
    expect(await completeJob(db, deadClaim, { from: "dead runner" })).toBe(false);
    expect(await renewJobClaim(db, deadClaim, plus(92_000))).toBe(false);
    expect(await collections(db).jobs.countDocuments(jobFence(deadClaim))).toBe(0);
    if (!second) return;
    expect(await completeJob(db, second, { from: "second runner" })).toBe(true);
    expect((await collections(db).jobs.findOne({ _id: dead.job._id }))?.result).toEqual({ from: "second runner" });
  });

  it("does not claim learning jobs while learning is paused, and claims other kinds", async () => {
    const db = await mongo.freshDb();
    await updateSettings(db, { learning_paused: true }, T0);
    const learning = await queueJob(db, { kind: "learning", dedup_key: "prf_1" }, { now: T0 });
    await queueJob(db, { kind: "settlement", dedup_key: "chl_1" }, { now: plus(1) });
    expect(await claimJob(db, learning.job._id, { now: plus(10) })).toBeNull();
    const next = await claimNextJob(db, { now: plus(10) });
    expect(next?.job.kind).toBe("settlement");
    expect(await claimNextJob(db, { now: plus(10), kinds: ["learning"] })).toBeNull();

    await updateSettings(db, { learning_paused: false }, plus(20));
    expect((await claimJob(db, learning.job._id, { now: plus(30) }))?.job.kind).toBe("learning");
  });

  it("retries a failed job until it runs out of attempts", async () => {
    const db = await mongo.freshDb();
    const { job } = await queueJob(db, { kind: "red_team", dedup_key: "run_1", max_attempts: 2 }, { now: T0 });
    const first = await claimJob(db, job._id, { now: T0 });
    if (!first) throw new Error("expected a claim");
    expect(await failJob(db, first, new Error("agent timed out"), { now: plus(1), retryAt: plus(2) })).toBe(true);
    expect((await collections(db).jobs.findOne({ _id: job._id }))?.status).toBe("queued");
    const second = await claimJob(db, job._id, { now: plus(2) });
    if (!second) throw new Error("expected a second claim");
    expect(await failJob(db, second, new Error("agent timed out again"), { now: plus(3) })).toBe(true);
    const stored = await collections(db).jobs.findOne({ _id: job._id });
    expect(stored?.status).toBe("failed");
    expect(stored?.last_error).toBe("agent timed out again");
  });

  it("runs a claimed job, renewing while it works, and completes it", async () => {
    const db = await mongo.freshDb();
    const { job } = await queueJob(db, { kind: "learning", dedup_key: "prf_run" });
    const claim = await claimJob(db, job._id);
    if (!claim) throw new Error("expected a claim");
    const result = await runClaimedJob(
      db,
      claim,
      async (ctx) => {
        await new Promise((r) => setTimeout(r, 60));
        expect(ctx.isLost()).toBe(false);
        return { kind: "done", result: { candidate_id: "rul_1" } };
      },
      { renewEveryMs: 10 },
    );
    expect(result.status).toBe("done");
    const stored = await collections(db).jobs.findOne({ _id: job._id });
    expect(stored?.status).toBe("done");
    expect(stored?.result).toEqual({ candidate_id: "rul_1" });
    expect(stored?.renewed_at && stored.claimed_at && stored.renewed_at > stored.claimed_at).toBe(true);
  });

  it("recovers a job whose post-response run died, on the next tick", async () => {
    const db = await mongo.freshDb();
    const clock = manualClock(T0);
    const { job } = await queueJob(db, { kind: "learning", dedup_key: "prf_died" }, { now: T0 });
    // The post-response run claims the job and then the function instance dies.
    await claimJob(db, job._id, { now: clock.now() });
    clock.advance(JOB_RECLAIM_MS + 5_000);
    const ran: string[] = [];
    const tick = await runDueJobs(
      db,
      {
        learning: async (ctx) => {
          ran.push(ctx.job.dedup_key);
          return { kind: "done" };
        },
      },
      { clock },
    );
    expect(tick.reclaimed).toBe(1);
    expect(ran).toEqual(["prf_died"]);
    const stored = await collections(db).jobs.findOne({ _id: job._id });
    expect(stored?.status).toBe("done");
    expect(stored?.attempt).toBe(2);
  });
});
