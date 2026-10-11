import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { askLane } from "../src/ask";
import { addInboxItem } from "../src/inbox";
import { demoClockSettings } from "../src/clock";
import { collections } from "../src/schema/collections";
import { QUOTED_NOTE, type OrchestratorAnswerInput } from "../src/schema/agents";
import type { Verdict } from "../src/schema/proofs";
import { provideServices, resetServices, type AgentInvokeInput, type LaneServices } from "../src/interfaces";
import { startReplSet, type TestMongo } from "../src/testing/mongo";
import { infoItem, seedChallenge, seedContract, seedMembership, seedPlayer, seedProof } from "./helpers/u18-seed";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});
afterEach(() => {
  resetServices();
});

const START = new Date("2026-10-11T20:00:00.000Z");
const at = (sec: number) => new Date(START.getTime() + sec * 1000);
const DEMO = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });
const GARY_NOTES = "Discussed the ACME renewal budget with Dana";
const AI_REASON = "The notes mention a renewal budget, so this is a real customer call";

/** Orchestrator double that answers by echoing the whole context it was given: the worst case for a leak. */
function echoingOrchestrator() {
  const calls: OrchestratorAnswerInput[] = [];
  const invoke = (async (req: AgentInvokeInput<"orchestrator">) => {
    const input = req.input as OrchestratorAnswerInput;
    calls.push(input);
    return { ok: true, status: "completed", output: { answer: JSON.stringify(input.context).slice(0, 1000) }, execution_id: "exe_ask", latency_ms: 30 };
  }) as LaneServices["agents"]["invoke"];
  provideServices({ agents: { invoke } });
  return calls;
}

function verdict(reason: string): Verdict {
  return {
    outcome: "accept",
    decided_by: "ai",
    rule: null,
    matched_rules: [],
    evaluated_rules: [],
    contract_version: 1,
    ai_calls: 1,
    ai_judgment: true,
    latency_ms: 900,
    trust_level: "agent_attested",
    payout_hold: false,
    reason,
    fix: "",
    cheat_class: null,
    confidence: 0.9,
    push_event_time: null,
    decided_at: at(40),
  };
}

async function customers() {
  const db = await mongo.freshDb();
  const gary = await seedPlayer(db, "Gary");
  const priya = await seedPlayer(db, "Priya");
  const challenge = await seedChallenge(db, { creator: priya, clock: DEMO, type: "customers", title: "Talk to Customers" });
  await seedContract(db, challenge, 1);
  await seedMembership(db, challenge, gary);
  await seedMembership(db, challenge, priya);
  const garyCall = await seedProof(db, {
    challenge,
    player: gary,
    day_index: 0,
    features: { duration_min: 25, attendee_count: 2, attendee_domains: ["acme.com"], has_notes: true },
    payload: { event_id: "evt_gary", attendees: ["acme.com"], notes: GARY_NOTES },
    received_at: at(30),
  });
  await collections(db).proofs.updateOne({ _id: garyCall._id }, { $set: { verdict: verdict(AI_REASON) } });
  return { db, gary, priya, challenge, garyCall };
}

describe("lane_ask (R25, F5)", () => {
  it("from Priya about Gary's proof returns only the redacted summary and verdict", async () => {
    const { db, priya, garyCall } = await customers();
    const calls = echoingOrchestrator();
    const res = await askLane(db, { player_id: priya._id, question: `Why was Gary's call ${garyCall._id} accepted?`, now: at(60) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The answer carries Gary's proof only as the redacted feed line: summary, status and what decided it.
    expect(res.answer).toContain(garyCall._id);
    expect(res.answer).toContain("call, 25 min, 2 attendees");
    expect(res.answer).toContain('"status":"accepted"');
    expect(res.answer).toContain('"decided_by":"ai"');
    for (const secret of [GARY_NOTES, "acme.com", AI_REASON, "evt_gary"]) expect(res.answer).not.toContain(secret);
    // The orchestrator never received them either.
    const sent = JSON.stringify(calls[0]);
    for (const secret of [GARY_NOTES, "acme.com", AI_REASON, "evt_gary"]) expect(sent).not.toContain(secret);
    expect(calls[0]!.question.note).toBe(QUOTED_NOTE);
    expect(calls[0]!.context.player.player_id).toBe(priya._id);
  });

  it("gives the asking player their own verdict reasons", async () => {
    const { db, gary, garyCall } = await customers();
    const calls = echoingOrchestrator();
    await askLane(db, { player_id: gary._id, question: "Why did my call count?", now: at(60) });
    const mine = calls[0]!.context.challenges[0]!.my_proofs;
    expect(mine).toEqual([{ proof_id: garyCall._id, day_index: 0, status: "accepted", reason: AI_REASON, fix: "" }]);
    expect(calls[0]!.context.challenges[0]!.feed.map((f) => f.player_id)).not.toContain(gary._id);
  });

  it("asks about one challenge only when the player is in it", async () => {
    const { db, priya } = await customers();
    echoingOrchestrator();
    const other = await seedChallenge(db, { creator: priya, clock: DEMO });
    const res = await askLane(db, { player_id: priya._id, question: "How am I doing?", challenge_id: other._id, now: at(60) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_member");
  });

  it("answers from Lane's own data when the orchestrator is unavailable", async () => {
    const { db, gary } = await customers();
    const res = await askLane(db, { player_id: gary._id, question: "What is my standing?", now: at(60) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.answer).toMatch(/Talk to Customers: you are ranked 1 with 1 conversations/);
  });

  it("writes nothing, and leaves undelivered info items for the next check-in", async () => {
    const { db, priya, challenge } = await customers();
    echoingOrchestrator();
    await addInboxItem(db, infoItem(priya._id, challenge._id, "message", "Your call was accepted."), { now: at(50) });
    const col = collections(db);
    const before = JSON.stringify({
      inbox: await col.inbox.find().toArray(),
      memberships: await col.memberships.find().toArray(),
      proofs: await col.proofs.find().toArray(),
      events: await col.events.countDocuments(),
    });
    await askLane(db, { player_id: priya._id, question: "Anything new?", now: at(60) });
    const after = JSON.stringify({
      inbox: await col.inbox.find().toArray(),
      memberships: await col.memberships.find().toArray(),
      proofs: await col.proofs.find().toArray(),
      events: await col.events.countDocuments(),
    });
    expect(after).toBe(before);
  });
});
