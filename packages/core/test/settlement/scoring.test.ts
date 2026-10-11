import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareReachedFirst, computeResults, computeScores, rankStandings, type ResultsInput } from "../../src/settlement/scoring";
import { demoClockSettings, finalGraceEnd } from "../../src/clock";
import { appendLedgerEntry } from "../../src/ledger";
import { addInboxItem } from "../../src/inbox";
import { collections } from "../../src/schema/collections";
import type { PlayerScore } from "../../src/schema/challenges";
import type { ChallengeType } from "../../src/schema/common";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import { seedChallenge, seedMembership, seedPlayer, seedProof, surpriseCheckItem } from "../helpers/u18-seed";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});

const START = new Date("2026-10-11T20:00:00.000Z");
const at = (sec: number) => new Date(START.getTime() + sec * 1000);
// Demo clock: 300-second days, 90-second grace, three days.
const DEMO = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });
const AFTER_GRACE = new Date(finalGraceEnd(DEMO).getTime() + 1000);

function score(player_id: string, s: number, opts: { goal?: number; at?: number | null } = {}): PlayerScore {
  const t = opts.at === undefined ? s * 10 : opts.at;
  return {
    player_id,
    score: s,
    reached_goal: s >= (opts.goal ?? 5),
    final_counted_at: s > 0 && t !== null ? at(t) : null,
  };
}

function stakes(ids: string[], amount = 100): ResultsInput["stakes"] {
  return ids.map((player_id) => ({ player_id, amount }));
}

const amounts = (shares: { player_id: string; amount: number }[]) => Object.fromEntries(shares.map((s) => [s.player_id, s.amount]));

describe("winner and refund rules (KTD12)", () => {
  it("a three-way top-score tie on a 400-credit pot pays 134, 133 and 133, with 134 to the earliest goal-reacher", () => {
    const results = computeResults({
      winner_rule: "top_score",
      pot: 400,
      scores: [score("maya", 5, { at: 300 }), score("priya", 5, { at: 100 }), score("sam", 5, { at: 200 }), score("gary", 2)],
      stakes: stakes(["maya", "priya", "sam", "gary"]),
    });
    expect(results.refund_all).toBe(false);
    expect(amounts(results.shares)).toEqual({ priya: 134, sam: 133, maya: 133 });
    expect(results.winners[0]).toBe("priya");
    expect(results.shares.reduce((sum, s) => sum + s.amount, 0)).toBe(400);
  });

  it("under the finishers-split rule with three finishers of four on a 400-credit pot, the finishers get 134, 133 and 133", () => {
    const results = computeResults({
      winner_rule: "finishers_split",
      pot: 400,
      scores: [
        score("maya", 7, { goal: 5, at: 700 }),
        score("priya", 5, { goal: 5, at: 400 }),
        score("sam", 6, { goal: 5, at: 650 }),
        score("gary", 4, { goal: 5, at: 100 }),
      ],
      stakes: stakes(["maya", "priya", "sam", "gary"]),
    });
    // Priya reached her final counted score first, so the remainder is hers; Gary did not finish.
    expect(amounts(results.shares)).toEqual({ priya: 134, sam: 133, maya: 133 });
    expect(results.refunds).toEqual([]);
  });

  it("under the top-score rule, leaders who finish below the goal still split the pot", () => {
    const results = computeResults({
      winner_rule: "top_score",
      pot: 300,
      scores: [score("maya", 3, { goal: 5 }), score("priya", 3, { goal: 5 }), score("sam", 1, { goal: 5 })],
      stakes: stakes(["maya", "priya", "sam"]),
    });
    expect(results.refund_all).toBe(false);
    expect(amounts(results.shares)).toEqual({ maya: 150, priya: 150 });
  });

  it("under the top-score rule, when every score is zero, every stake is refunded", () => {
    const results = computeResults({
      winner_rule: "top_score",
      pot: 250,
      scores: [score("maya", 0), score("priya", 0)],
      stakes: [
        { player_id: "maya", amount: 100 },
        { player_id: "priya", amount: 150 },
      ],
    });
    expect(results.refund_all).toBe(true);
    expect(results.shares).toEqual([]);
    expect(amounts(results.refunds)).toEqual({ maya: 100, priya: 150 });
  });

  it("under the finishers-split rule, when nobody reaches the goal, every stake is refunded", () => {
    const results = computeResults({
      winner_rule: "finishers_split",
      pot: 300,
      scores: [score("maya", 4, { goal: 5 }), score("priya", 2, { goal: 5 }), score("sam", 0, { goal: 5 })],
      stakes: stakes(["maya", "priya", "sam"]),
    });
    expect(results.refund_all).toBe(true);
    expect(amounts(results.refunds)).toEqual({ maya: 100, priya: 100, sam: 100 });
  });

  it("gives the whole remainder to the earliest player, and breaks equal times by player id", () => {
    const split = computeResults({
      winner_rule: "top_score",
      pot: 401,
      scores: [score("b", 2, { at: 50 }), score("a", 2, { at: 50 }), score("c", 2, { at: 10 })],
      stakes: stakes(["a", "b", "c"]),
    });
    expect(split.winners).toEqual(["c", "a", "b"]);
    expect(amounts(split.shares)).toEqual({ c: 135, a: 133, b: 133 });
    expect([score("x", 1, { at: null }), score("y", 1, { at: 5 })].sort(compareReachedFirst).map((s) => s.player_id)).toEqual(["y", "x"]);
  });

  it("writes no zero shares when the pot is smaller than the number of winners", () => {
    const results = computeResults({
      winner_rule: "top_score",
      pot: 2,
      scores: [score("a", 1, { at: 1 }), score("b", 1, { at: 2 }), score("c", 1, { at: 3 })],
      stakes: stakes(["a", "b"], 1),
    });
    expect(results.shares).toEqual([{ player_id: "a", amount: 2 }]);
  });

  it("ranks equal scores together and orders them by who reached the score first", () => {
    const standings = rankStandings(
      [score("sam", 1, { at: 5 }), score("maya", 3), score("priya", 3, { at: 1 }), score("gary", 0)],
      "days",
      new Map([
        ["maya", "Maya"],
        ["priya", "Priya"],
        ["sam", "Sam"],
        ["gary", "Gary <script>"],
      ]),
    );
    expect(standings.map((s) => [s.player_id, s.rank])).toEqual([
      ["priya", 1],
      ["maya", 1],
      ["sam", 3],
      ["gary", 4],
    ]);
    // KTD15: a name that is not 1 to 24 letters, digits and spaces is never shown.
    expect(standings[3]?.display_name).toBe("Player");
  });
});

async function world(type: ChallengeType = "ship_week", goal = 3) {
  const db = await mongo.freshDb();
  const maya = await seedPlayer(db, "Maya");
  const priya = await seedPlayer(db, "Priya");
  const sam = await seedPlayer(db, "Sam");
  const gary = await seedPlayer(db, "Gary");
  const challenge = await seedChallenge(db, { creator: maya, clock: DEMO, type, goal });
  for (const p of [maya, priya, sam, gary]) {
    await seedMembership(db, challenge, p);
    await appendLedgerEntry(db, { player_id: p._id, challenge_id: challenge._id, kind: "stake", amount: 100 }, { now: at(1) });
  }
  return { db, challenge, maya, priya, sam, gary };
}

describe("computeScores (U3 day-status function)", () => {
  it("scores days with the day-status function: voided, held, pending and pre-join days do not count", async () => {
    const { db, challenge, maya, priya, sam, gary } = await world();
    // Maya: three counted days.
    await seedProof(db, { challenge, player: maya, day_index: 0, received_at: at(30) });
    await seedProof(db, { challenge, player: maya, day_index: 1, received_at: at(320) });
    await seedProof(db, { challenge, player: maya, day_index: 2, received_at: at(620) });
    await seedProof(db, { challenge, player: maya, day_index: 2, received_at: at(640) });
    // Priya: day 1 is voided by an unanswered surprise check; day 2 is still in AI review.
    await seedProof(db, { challenge, player: priya, day_index: 0, received_at: at(40) });
    await seedProof(db, { challenge, player: priya, day_index: 1, received_at: at(330) });
    await addInboxItem(
      db,
      {
        ...surpriseCheckItem({ player_id: priya._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) }),
        status: "open",
      },
      { now: at(360) },
    );
    await seedProof(db, { challenge, player: priya, day_index: 2, status: "ai_review", received_at: at(610) });
    // Sam: a held proof and a rejected one.
    await seedProof(db, { challenge, player: sam, day_index: 0, status: "held", held_reason: "extra_proof", received_at: at(50) });
    await seedProof(db, { challenge, player: sam, day_index: 1, status: "rejected", received_at: at(350) });
    // Gary joined on day 2: his day-1 proof does not count.
    await collections(db).memberships.updateOne({ challenge_id: challenge._id, player_id: gary._id }, { $set: { joined_day_index: 2 } });
    await seedProof(db, { challenge, player: gary, day_index: 1, received_at: at(340) });
    await seedProof(db, { challenge, player: gary, day_index: 2, status: "flagged_accept", received_at: at(615) });

    const result = await computeScores(db, { challenge_id: challenge._id, now: AFTER_GRACE });
    expect(result).toMatchObject({ challenge_id: challenge._id, unit: "days", goal: 3, winner_rule: "top_score", pot: 400 });
    const byId = new Map(result.scores.map((s) => [s.player_id, s]));
    expect(byId.get(maya._id)).toEqual({ player_id: maya._id, score: 3, reached_goal: true, final_counted_at: at(620) });
    expect(byId.get(priya._id)).toEqual({ player_id: priya._id, score: 1, reached_goal: false, final_counted_at: at(40) });
    expect(byId.get(gary._id)).toEqual({ player_id: gary._id, score: 1, reached_goal: false, final_counted_at: at(615) });
    expect(byId.get(sam._id)).toEqual({ player_id: sam._id, score: 0, reached_goal: false, final_counted_at: null });
    expect(result.standings.map((s) => [s.display_name, s.score, s.rank])).toEqual([
      ["Maya", 3, 1],
      ["Priya", 1, 2],
      ["Gary", 1, 2],
      ["Sam", 0, 4],
    ]);
    expect(result.scores.map((s) => s.player_id)).toEqual(result.standings.map((s) => s.player_id));
    expect(result.standings.every((s) => s.unit === "days" && s.is_you === false)).toBe(true);
  });

  it("counts conversations as counting proofs on counted days", async () => {
    const { db, challenge, maya, priya } = await world("customers", 3);
    for (const sec of [10, 20, 30]) await seedProof(db, { challenge, player: maya, day_index: 0, received_at: at(sec) });
    await seedProof(db, { challenge, player: maya, day_index: 1, status: "flagged_accept", received_at: at(330) });
    await seedProof(db, { challenge, player: maya, day_index: 1, status: "rejected", received_at: at(340) });
    await seedProof(db, { challenge, player: maya, day_index: 2, status: "not_counted", received_at: at(620) });
    for (const sec of [15, 25]) await seedProof(db, { challenge, player: priya, day_index: 0, received_at: at(sec) });
    for (const sec of [310, 320]) await seedProof(db, { challenge, player: priya, day_index: 1, received_at: at(sec) });
    await addInboxItem(
      db,
      {
        ...surpriseCheckItem({ player_id: priya._id, challenge_id: challenge._id, day_index: 1, slot: 0, release_at: at(360), due_at: at(450) }),
        status: "open",
      },
      { now: at(360) },
    );

    const result = await computeScores(db, { challenge_id: challenge._id, now: AFTER_GRACE });
    expect(result.unit).toBe("conversations");
    const byId = new Map(result.scores.map((s) => [s.player_id, s]));
    expect(byId.get(maya._id)).toMatchObject({ score: 4, reached_goal: true, final_counted_at: at(330) });
    // Priya's day 1 is voided, so its two conversations do not count.
    expect(byId.get(priya._id)).toMatchObject({ score: 2, reached_goal: false, final_counted_at: at(25) });
    expect(result.standings[0]).toMatchObject({ player_id: maya._id, unit: "conversations", rank: 1 });
  });

  it("refuses a draft challenge or a missing one", async () => {
    const { db, challenge } = await world();
    await expect(computeScores(db, { challenge_id: "chl_missing", now: AFTER_GRACE })).rejects.toThrow(/does not exist/);
    await collections(db).challenges.updateOne({ _id: challenge._id }, { $set: { status: "draft", clock: null } });
    await expect(computeScores(db, { challenge_id: challenge._id, now: AFTER_GRACE })).rejects.toThrow(/draft/);
  });
});
