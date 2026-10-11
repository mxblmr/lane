import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runTick, runTickJobs, provideJobHandlers, resetJobHandlers, takeTickLease } from "../src/tick";
import { addInboxItem, resolveInboxItem } from "../src/inbox";
import { dayGraceEnd, demoClockSettings, finalGraceEnd, manualClock, windowEnd } from "../src/clock";
import { loadDayStatuses } from "../src/days";
import { queueJob, claimJob } from "../src/jobs";
import { JOB_RECLAIM_MS, TICK_LEASE_MS } from "../src/config";
import { collections } from "../src/schema/collections";
import { getPack } from "../src/packs/index";
import type { AnyPack } from "../src/schema/pack";
import { startReplSet, type TestMongo } from "../src/testing/mongo";
import {
  extraProofItem,
  seedChallenge,
  seedContract,
  seedMembership,
  seedPlayer,
  seedProof,
  surpriseCheckItem,
} from "./helpers/u18-seed";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});
afterEach(() => {
  resetJobHandlers();
});

const START = new Date("2026-10-11T20:00:00.000Z");
const at = (sec: number) => new Date(START.getTime() + sec * 1000);
// Demo clock: 300-second days, 90-second grace, three days.
const DEMO = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });

async function world() {
  const db = await mongo.freshDb();
  const maya = await seedPlayer(db, "Maya");
  const challenge = await seedChallenge(db, { creator: maya, clock: DEMO });
  await seedContract(db, challenge, 1);
  await seedMembership(db, challenge, maya);
  return { db, maya, challenge };
}

describe("tick lease (KTD13)", () => {
  it("returns at once when another holder has the lease, and runs once it lapses", async () => {
    const { db } = await world();
    expect(await takeTickLease(db, "someone-else", at(0))).toBe(true);
    const lost = await runTick(db, { now: at(1) });
    expect(lost.ran).toBe(false);
    const won = await runTick(db, { now: new Date(at(0).getTime() + TICK_LEASE_MS) });
    expect(won.ran).toBe(true);
  });

  it("releases its lease so the next poll can tick at once", async () => {
    const { db } = await world();
    expect((await runTick(db, { now: at(1) })).ran).toBe(true);
    expect((await runTick(db, { now: at(2) })).ran).toBe(true);
  });
});

describe("surprise checks and held days (R18)", () => {
  it("covers AE4: an unanswered surprise check holds the day at its due time and voids it after grace, while other days stay verified", async () => {
    const { db, maya, challenge } = await world();
    const clock = manualClock(at(0));
    await seedProof(db, { challenge, player: maya, day_index: 0, received_at: at(30) });
    const day1 = await seedProof(db, { challenge, player: maya, day_index: 1, received_at: at(320) });
    // A check on day 1 asks for a commit containing 4821, released at 360 s with a 90-second grace.
    await addInboxItem(
      db,
      surpriseCheckItem({ player_id: maya._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450), code: "4821" }),
      { now: at(10) },
    );
    const days = async () => (await loadDayStatuses(db, challenge, clock.now())).get(maya._id)!.days;

    clock.set(at(359));
    await runTick(db, { now: clock.now() });
    expect((await days()).slice(0, 2)).toEqual(["counted", "counted"]);

    clock.set(at(361));
    const release = await runTick(db, { now: clock.now() });
    expect(release.details.released).toHaveLength(1);
    expect((await days()).slice(0, 2)).toEqual(["counted", "held"]);
    expect((await collections(db).proofs.findOne({ _id: day1._id }))?.status).toBe("held");

    clock.set(at(451));
    const expiry = await runTick(db, { now: clock.now() });
    expect(expiry.details.expired).toHaveLength(1);
    expect((await days()).slice(0, 2)).toEqual(["counted", "voided"]);
    const voided = await collections(db).proofs.findOne({ _id: day1._id });
    expect(voided).toMatchObject({ status: "not_counted", not_counted_reason: "surprise_check_expired" });

    // A later proof for day 1 cannot revive it; day 0 stays verified.
    await seedProof(db, { challenge, player: maya, day_index: 1, received_at: at(460) });
    clock.set(at(470));
    await runTick(db, { now: clock.now() });
    const after = await days();
    expect(after[0]).toBe("counted");
    expect(after[1]).toBe("voided");
  });

  it("an answered surprise check returns the held day to counted", async () => {
    const { db, maya, challenge } = await world();
    const day1 = await seedProof(db, { challenge, player: maya, day_index: 1, received_at: at(320) });
    const { item } = await addInboxItem(
      db,
      surpriseCheckItem({ player_id: maya._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) }),
      { now: at(10) },
    );
    await runTick(db, { now: at(361) });
    expect((await collections(db).proofs.findOne({ _id: day1._id }))?.status).toBe("held");
    const answered = await resolveInboxItem(db, { item_id: item._id, by_player_id: maya._id, answer_proof_id: "prf_code", now: at(400) });
    expect(answered.ok).toBe(true);
    expect((await collections(db).proofs.findOne({ _id: day1._id }))?.status).toBe("accepted");
    await runTick(db, { now: at(460) });
    expect((await loadDayStatuses(db, challenge, at(460))).get(maya._id)!.days[1]).toBe("counted");
  });

  it("a late tick never releases a check whose grace is already over", async () => {
    const { db, maya, challenge } = await world();
    await seedProof(db, { challenge, player: maya, day_index: 1, received_at: at(320) });
    await addInboxItem(
      db,
      surpriseCheckItem({ player_id: maya._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) }),
      { now: at(10) },
    );
    const late = await runTick(db, { now: at(500) });
    expect(late.details.cancelled).toHaveLength(1);
    expect(late.details.released).toHaveLength(0);
    expect((await loadDayStatuses(db, challenge, at(500))).get(maya._id)!.days[1]).toBe("counted");
  });

  it("an unanswered extra-proof request leaves its proof not counted (unanswered)", async () => {
    const { db, maya, challenge } = await world();
    const thin = await seedProof(db, { challenge, player: maya, day_index: 0, status: "held", held_reason: "extra_proof" });
    await addInboxItem(db, extraProofItem({ player_id: maya._id, challenge_id: challenge._id, proof_id: thin._id, due_at: at(200) }), { now: at(10) });
    await runTick(db, { now: at(199) });
    expect((await collections(db).proofs.findOne({ _id: thin._id }))?.status).toBe("held");
    await runTick(db, { now: at(201) });
    expect(await collections(db).proofs.findOne({ _id: thin._id })).toMatchObject({ status: "not_counted", not_counted_reason: "unanswered" });
  });
});

describe("window close (KTD12, KTD13)", () => {
  it("three concurrent ticks past the window end give one settling transition and one settlement job", async () => {
    const { db, challenge } = await world();
    const now = new Date(windowEnd(DEMO).getTime() + 1000);
    const runs = await Promise.all([1, 2, 3].map((n) => runTick(db, { now, holder: `poll-${n}` })));
    expect(runs.flatMap((r) => r.details.closed)).toEqual([challenge._id]);
    const jobs = await collections(db).jobs.find({ kind: "settlement" }).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedup_key: challenge._id, status: "queued" });
    expect(jobs[0]!.due_at).toEqual(finalGraceEnd(DEMO));
    expect((await collections(db).challenges.findOne({ _id: challenge._id }))?.status).toBe("settling");
    expect(await collections(db).events.countDocuments({ kind: "challenge.window_closed" })).toBe(1);

    // Later ticks change nothing.
    const later = await runTick(db, { now: new Date(now.getTime() + 5000) });
    expect(later.details.closed).toHaveLength(0);
    expect(await collections(db).jobs.countDocuments({ kind: "settlement" })).toBe(1);
  });

  it("the same three ticks with no lease contention still close the window once", async () => {
    const { db, challenge } = await world();
    const base = windowEnd(DEMO).getTime();
    for (const offset of [1000, 2000, 3000]) await runTick(db, { now: new Date(base + offset) });
    expect(await collections(db).events.countDocuments({ kind: "challenge.window_closed", challenge_id: challenge._id })).toBe(1);
    expect(await collections(db).jobs.countDocuments({ kind: "settlement" })).toBe(1);
  });

  it("queues settlement after the longest open grace when the final check opens requests", async () => {
    const { db, maya, challenge } = await world();
    const proof = await seedProof(db, { challenge, player: maya, day_index: 2 });
    const now = new Date(windowEnd(DEMO).getTime() + 1000);
    const refetchDue = new Date(now.getTime() + 600_000);
    const pack: AnyPack = {
      ...getPack("ship_week"),
      finalCheck: async () => ({
        not_counted: [],
        requests: [
          {
            ...extraProofItem({ player_id: maya._id, challenge_id: challenge._id, proof_id: proof._id, due_at: refetchDue }),
            kind: "refetch",
            actor: "agent",
            subject_proof_id: proof._id,
            instruction: "Fetch this proof again and send it.",
          },
        ],
      }),
    };
    await runTick(db, { now }, { packFor: () => pack });
    const job = await collections(db).jobs.findOne({ kind: "settlement" });
    expect(job?.due_at).toEqual(refetchDue);
    expect(await collections(db).inbox.countDocuments({ kind: "refetch", player_id: maya._id })).toBe(1);
  });

  it("the final check's not-counted proofs stop counting", async () => {
    const { db, maya, challenge } = await world();
    const gone = await seedProof(db, { challenge, player: maya, day_index: 2 });
    const pack: AnyPack = {
      ...getPack("ship_week"),
      finalCheck: async () => ({ not_counted: [{ proof_id: gone._id, reason: "removed" }], requests: [] }),
    };
    await runTick(db, { now: new Date(windowEnd(DEMO).getTime() + 1000) }, { packFor: () => pack });
    expect(await collections(db).proofs.findOne({ _id: gone._id })).toMatchObject({ status: "not_counted", not_counted_reason: "removed" });
  });

  it("recovers a settling challenge whose settlement job was never queued", async () => {
    const { db, challenge } = await world();
    await collections(db).challenges.updateOne({ _id: challenge._id }, { $set: { status: "settling" } });
    const result = await runTick(db, { now: new Date(windowEnd(DEMO).getTime() + 1000) });
    expect(result.details.settlement_jobs).toHaveLength(1);
    expect(await collections(db).jobs.countDocuments({ kind: "settlement", dedup_key: challenge._id })).toBe(1);
  });

  it("leaves active challenges alone before the window ends", async () => {
    const { db, challenge } = await world();
    await runTick(db, { now: new Date(windowEnd(DEMO).getTime() - 1000) });
    expect((await collections(db).challenges.findOne({ _id: challenge._id }))?.status).toBe("active");
    expect(dayGraceEnd(DEMO, 2).getTime()).toBeGreaterThan(windowEnd(DEMO).getTime());
  });
});

describe("job recovery (KTD20)", () => {
  it("requeues a run whose claim went 45 seconds without renewal, leaves a slow live run alone, and runs it on the next poll", async () => {
    const { db } = await world();
    const t0 = at(0);
    const dead = await queueJob(db, { kind: "learning", dedup_key: "prf_dead" }, { now: t0 });
    const slow = await queueJob(db, { kind: "learning", dedup_key: "prf_slow" }, { now: t0 });
    await claimJob(db, dead.job._id, { now: t0 });
    const slowClaim = await claimJob(db, slow.job._id, { now: t0 });
    const now = new Date(t0.getTime() + JOB_RECLAIM_MS + 1000);
    // The slow run renewed 10 seconds ago.
    await collections(db).jobs.updateOne({ _id: slowClaim!.job._id }, { $set: { renewed_at: new Date(now.getTime() - 10_000) } });

    const tick = await runTick(db, { now });
    expect(tick.jobs_reclaimed).toBe(1);
    expect((await collections(db).jobs.findOne({ _id: dead.job._id }))?.status).toBe("queued");
    expect((await collections(db).jobs.findOne({ _id: slow.job._id }))?.status).toBe("running");

    const ran: string[] = [];
    provideJobHandlers({ learning: async (ctx) => void ran.push(ctx.job.dedup_key) });
    const { runs } = await runTickJobs(db, { clock: manualClock(now) });
    expect(ran).toEqual(["prf_dead"]);
    expect(runs.map((r) => r.status)).toEqual(["done"]);
    expect((await collections(db).jobs.findOne({ _id: dead.job._id }))?.attempt).toBe(2);
  });

  it("with no handler registered, due jobs stay queued", async () => {
    const { db } = await world();
    await queueJob(db, { kind: "settlement", dedup_key: "chl_x" }, { now: at(0) });
    const { runs } = await runTickJobs(db, { clock: manualClock(at(10)) });
    expect(runs).toHaveLength(0);
    expect((await collections(db).jobs.findOne({ dedup_key: "chl_x" }))?.status).toBe("queued");
  });
});
