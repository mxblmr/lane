import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayStatus, loadDayStatuses, playerDayStatuses, type DayProof, type DaySurpriseCheck } from "../src/days";
import { demoClockSettings } from "../src/clock";
import { collections } from "../src/schema/collections";
import type { Proof } from "../src/schema/proofs";
import type { InboxItem } from "../src/schema/inbox";
import type { Challenge } from "../src/schema/challenges";
import { startReplSet, type TestMongo } from "../src/testing/mongo";

const START = new Date("2026-10-11T20:00:00.000Z");
const clock = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });
const at = (s: number) => new Date(START.getTime() + s * 1000);

const accepted = (day: number): DayProof => ({ status: "accepted", day_index: day });
const check = (day: number, status: InboxItem["status"], dueSec: number, releaseSec = 0): DaySurpriseCheck => ({
  kind: "surprise_check",
  status,
  day_index: day,
  due_at: at(dueSec),
  release_at: at(releaseSec),
});

describe("day status (KTD13)", () => {
  it("covers AE4: an accepted proof and an expired unanswered surprise check leave the day not counted, and a later proof cannot revive it", () => {
    const checks = [check(1, "expired", 450, 360)];
    const now = at(500);
    expect(dayStatus({ clock, dayIndex: 1, proofs: [accepted(1)], surpriseChecks: checks, now })).toBe("voided");
    // A later proof for the same day arrives and is accepted.
    const later = [accepted(1), accepted(1)];
    expect(dayStatus({ clock, dayIndex: 1, proofs: later, surpriseChecks: checks, now: at(560) })).toBe("voided");
  });

  it("covers AE4: other verified days are unaffected by the voided day", () => {
    const result = playerDayStatuses({
      player_id: "plr_maya",
      clock,
      proofs: [accepted(0), accepted(1), accepted(2)],
      surpriseChecks: [check(1, "expired", 450, 360)],
      now: at(1000),
    });
    expect(result.days).toEqual(["counted", "voided", "counted"]);
    expect(result.counted).toBe(2);
    expect(result.counted_day_indexes).toEqual([0, 2]);
  });

  it("holds the day while a released surprise check is still inside its grace (R18)", () => {
    const checks = [check(1, "open", 450, 360)];
    expect(dayStatus({ clock, dayIndex: 1, proofs: [accepted(1)], surpriseChecks: checks, now: at(400) })).toBe("held");
  });

  it("treats an open surprise check past its due time as expired even before the tick runs", () => {
    const checks = [check(1, "open", 450, 360)];
    expect(dayStatus({ clock, dayIndex: 1, proofs: [accepted(1)], surpriseChecks: checks, now: at(451) })).toBe("voided");
  });

  it("counts the day once the surprise check is answered", () => {
    const checks = [check(1, "resolved", 450, 360)];
    expect(dayStatus({ clock, dayIndex: 1, proofs: [accepted(1)], surpriseChecks: checks, now: at(500) })).toBe("counted");
  });

  it("ignores scheduled checks that have not been released", () => {
    const checks = [check(1, "scheduled", 700, 610)];
    expect(dayStatus({ clock, dayIndex: 1, proofs: [accepted(1)], surpriseChecks: checks, now: at(400) })).toBe("counted");
  });

  it("counts flagged-accepted proofs, and reports pending, open, missed and future days", () => {
    const flagged: DayProof = { status: "flagged_accept", day_index: 0 };
    expect(dayStatus({ clock, dayIndex: 0, proofs: [flagged], surpriseChecks: [], now: at(100) })).toBe("counted");
    const review: DayProof = { status: "ai_review", day_index: 0 };
    expect(dayStatus({ clock, dayIndex: 0, proofs: [review], surpriseChecks: [], now: at(100) })).toBe("pending");
    const rejected: DayProof = { status: "rejected", day_index: 0 };
    expect(dayStatus({ clock, dayIndex: 0, proofs: [rejected], surpriseChecks: [], now: at(100) })).toBe("open");
    // Day 0's grace ends at 300 + 90 seconds.
    expect(dayStatus({ clock, dayIndex: 0, proofs: [rejected], surpriseChecks: [], now: at(389) })).toBe("open");
    expect(dayStatus({ clock, dayIndex: 0, proofs: [rejected], surpriseChecks: [], now: at(390) })).toBe("missed");
    expect(dayStatus({ clock, dayIndex: 2, proofs: [], surpriseChecks: [], now: at(100) })).toBe("future");
    const notCounted: DayProof = { status: "not_counted", day_index: 0 };
    expect(dayStatus({ clock, dayIndex: 0, proofs: [notCounted], surpriseChecks: [], now: at(400) })).toBe("missed");
  });
});

describe("loadDayStatuses", () => {
  let mongo: TestMongo;
  beforeAll(async () => {
    mongo = await startReplSet();
  });
  afterAll(async () => {
    await mongo?.stop();
  });

  it("computes every member's days from stored proofs and surprise checks", async () => {
    const db = await mongo.freshDb();
    const col = collections(db);
    const challenge = { _id: "chl_1", clock } as Pick<Challenge, "_id" | "clock">;
    const now = at(1000);
    await col.memberships.insertMany([
      { _id: "mem_1", challenge_id: "chl_1", player_id: "plr_maya", accepted_terms_version: "t1", handle_platform: null, joined_at: START, joined_day_index: 0, last_check_in_at: null, last_seen_contract_version: 1 },
      { _id: "mem_2", challenge_id: "chl_1", player_id: "plr_sam", accepted_terms_version: "t1", handle_platform: null, joined_at: START, joined_day_index: 0, last_check_in_at: null, last_seen_contract_version: 1 },
    ]);
    const proof = (id: string, player: string, day: number): Proof => ({
      _id: id,
      challenge_id: "chl_1",
      player_id: player,
      challenge_type: "ship_week",
      source_key: id,
      claimed: true,
      payload: {},
      features: null,
      source_time: at(day * 300 + 10),
      day_index: day,
      status: "accepted",
      held_reason: null,
      not_counted_reason: null,
      verdict: null,
      answers_request_id: null,
      history: [],
      received_at: now,
      updated_at: now,
    });
    await col.proofs.insertMany([proof("p1", "plr_maya", 0), proof("p2", "plr_maya", 1), proof("p3", "plr_sam", 0)]);
    await col.inbox.insertOne({
      _id: "inb_1",
      player_id: "plr_maya",
      challenge_id: "chl_1",
      kind: "surprise_check",
      actor: "player",
      instruction: "Put code 4821 in your next commit message.",
      answer_tool: "lane_submit_proof",
      answer_args: { challenge_id: "chl_1" },
      day_index: 1,
      subject_proof_id: null,
      slot: 0,
      code: "4821",
      release_at: at(360),
      due_at: at(450),
      status: "open",
      notify_player_ids: [],
      answer_proof_id: null,
      created_at: START,
      updated_at: START,
      resolved_at: null,
      delivered_at: null,
    });
    const result = await loadDayStatuses(db, challenge, now);
    expect(result.get("plr_maya")?.days).toEqual(["counted", "voided", "missed"]);
    expect(result.get("plr_sam")?.days).toEqual(["counted", "missed", "missed"]);
  });
});
