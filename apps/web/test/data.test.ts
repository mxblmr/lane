import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { closeMongoClient } from "@lane/core/db";
import { provideServices, resetServices } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema";
import { demoClockSettings } from "@lane/core/clock";
import { PLAY_CREDIT_LABEL } from "@lane/core/config";
import * as overviewRoute from "../app/api/data/overview/route";
import * as challengeRoute from "../app/api/data/challenges/[id]/route";
import * as rulesRoute from "../app/api/data/rules/route";
import type { ChallengeData } from "../lib/dashboard-data";
import type { Serialized } from "../app/(dashboard)/_components/wire";
import {
  at,
  challenge,
  getReq,
  inboxItem,
  membership,
  payoutApproval,
  player,
  proof,
  rule,
  ruleApproval,
  stakeEntry,
  verdict,
} from "./fixtures/dashboard";

let mongo: TestMongo;
let db: Db;

beforeAll(async () => {
  mongo = await startReplSet();
  process.env.MONGODB_URI = mongo.replSet.getUri();
}, 120_000);

beforeEach(async () => {
  db = await mongo.freshDb();
  process.env.MONGODB_DB = db.databaseName;
  resetServices();
});

afterEach(() => {
  resetServices();
});

afterAll(async () => {
  await closeMongoClient();
  await mongo?.stop();
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB;
});

async function getChallenge(id: string): Promise<Response> {
  return challengeRoute.GET(getReq(`/api/data/challenges/${id}`), { params: Promise.resolve({ id }) });
}

// Values that must never appear in dashboard JSON (KTD15).
const SECRETS = {
  joinCode: "QZXJ42",
  customersJoinCode: "WVK7M3",
  keyHash: "9f".repeat(32),
  routine: "ROUTINE-TEXT-every-27-minutes-call-lane_check_in",
  inbox: "INBOX-INSTRUCTION-put-code-ZX81",
  inboxCode: "ZX81",
  domain: "secret-client.example",
  note: "NOTE-TEXT-the-customer-said-pricing-hurts",
  aiReasonCustomers: "AI-REASON-mentions-the-call-notes",
  ruleWriterReason: "RULE-WRITER-REASON-never-shown",
  suspend: "SUSPEND-CONTEXT-internal",
};

async function seedStage() {
  const col = collections(db);
  const sam = player({ display_name: "Sam", key_hash: SECRETS.keyHash, routine_text: SECRETS.routine });
  const gary = player({ display_name: "Gary", key_hash: "1e".repeat(32), routine_text: SECRETS.routine });
  const runStart = new Date(Date.now() - 120_000);
  const ship = challenge({
    join_code: SECRETS.joinCode,
    clock: demoClockSettings(new Date(Date.now() - 60_000), { days: 7 }),
    created_at: runStart,
    activated_at: runStart,
  });
  const customers = challenge({
    type: "customers",
    title: "Talk to Customers",
    join_code: SECRETS.customersJoinCode,
    stage: false,
    clock: demoClockSettings(new Date(Date.now() - 60_000), { days: 7 }),
  });
  await col.players.insertMany([sam, gary]);
  await col.challenges.insertMany([ship, customers]);
  await col.memberships.insertMany([membership(ship, sam), membership(ship, gary), membership(customers, sam)]);
  await stakeEntry(db, ship, sam, 100);
  await stakeEntry(db, ship, gary, 100);

  // Sam's first rename-only commit: an AI judgment.
  const aiReject = proof(ship, sam, {
    source_key: "1".repeat(40),
    received_at: at(20),
    verdict: verdict({ decided_by: "ai", ai_calls: 1, ai_judgment: true }),
  });
  // Sam's second rename-only commit: caught by the learned rule, no AI call.
  const ruleReject = proof(ship, sam, {
    source_key: "2".repeat(40),
    received_at: at(200),
    verdict: verdict({
      decided_by: "rule",
      rule: { rule_key: "no-rename-only", version: 2 },
      matched_rules: [{ rule_key: "no-rename-only", version: 2, action: "reject" }],
      ai_calls: 0,
      ai_judgment: false,
      reason: "A proof where the commit only renames identifiers does not count.",
    }),
  });
  const honest = proof(ship, gary, {
    source_key: "3".repeat(40),
    status: "accepted",
    features: { rename_only: false, code_lines_changed: 42, files_changed: 3, lines_added: 30, lines_removed: 12 },
    received_at: at(100),
    verdict: verdict({ outcome: "accept", decided_by: "ai", ai_judgment: true, cheat_class: null, reason: "Real change." }),
  });
  // A Talk to Customers proof with third-party data in payload, features and the AI reason.
  const call = proof(customers, sam, {
    source_key: "evt_123",
    payload: { event_id: "evt_123", attendee_domains: [SECRETS.domain], notes_summary: SECRETS.note },
    features: { duration_min: 30, attendee_count: 2, attendee_domains: [SECRETS.domain], all_personal_email: false },
    status: "rejected",
    verdict: verdict({ reason: SECRETS.aiReasonCustomers, fix: SECRETS.note, cheat_class: "personal_email" }),
  });
  await col.proofs.insertMany([aiReject, ruleReject, honest, call]);

  await col.inbox.insertOne(inboxItem(ship, sam, { instruction: SECRETS.inbox, code: SECRETS.inboxCode }));

  const seedRule = rule({ version: 1, rule_key: "no-empty-commit", source: "seed", status: "active", test_results: null, reason: SECRETS.ruleWriterReason, when: { all: [{ feature: "empty_commit", op: "eq", value: true }] }, created_at: at(-1000) });
  const learned = rule({
    version: 2,
    parent_version: 1,
    rule_key: "no-rename-only",
    status: "pending_approval",
    reason: SECRETS.ruleWriterReason,
    evidence: { proof_ids: [aiReject._id], example_keys: [], dispute_ids: [] },
    created_at: new Date(Date.now() - 10_000),
  });
  const customersRule = rule({
    challenge_type: "customers",
    rule_key: "no-listed-domains",
    when: { all: [{ feature: "attendee_domains", op: "in", value: [SECRETS.domain] }] },
    cheat_class: "personal_email",
    reason: SECRETS.ruleWriterReason,
    status: "pending_approval",
  });
  await col.rules.insertMany([seedRule, learned, customersRule]);
  const approval = ruleApproval(learned, { suspend_context: { secret: SECRETS.suspend } });
  const customersApproval = ruleApproval(customersRule, { suspend_context: { domain: SECRETS.domain } });
  const payout = payoutApproval(ship, [
    { player_id: sam._id, amount: 200 },
    { player_id: gary._id, amount: 200 },
  ]);
  await col.approvals.insertMany([approval, customersApproval, payout]);
  return { sam, gary, ship, customers, aiReject, ruleReject, honest, call, seedRule, learned, approval, payout };
}

describe("data routes (KTD15, KTD16)", () => {
  it("returns JSON with no join code, key hash, routine text, inbox item, attendee domain or note text", async () => {
    const { ship, customers } = await seedStage();
    const bodies = [
      await overviewRoute.GET(),
      await getChallenge(ship._id),
      await getChallenge(customers._id),
      await rulesRoute.GET(getReq("/api/data/rules")),
      await rulesRoute.GET(getReq("/api/data/rules?type=customers")),
    ];
    for (const res of bodies) {
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      for (const secret of Object.values(SECRETS)) {
        expect(text).not.toContain(secret);
      }
      // Field names of non-public data. (The feature name attendee_domains may appear in a
      // redacted rule predicate; its values never do, which the secrets loop checks.)
      expect(text).not.toMatch(/key_hash|routine_text|join_code|notes_summary|suspend_context|"payload"|"features"|"instruction"/);
    }
  });

  it("runs the tick once on each poll, and a missing tick does not break the poll", async () => {
    const { ship } = await seedStage();
    const unwired = await getChallenge(ship._id);
    expect(unwired.status).toBe(200);
    expect(((await unwired.json()) as Serialized<ChallengeData>).tick).toMatchObject({ available: false, owner: "U18" });

    let ticks = 0;
    provideServices({
      tick: {
        run: async () => {
          ticks += 1;
          return { ran: true, transitions: 0, jobs_reclaimed: 0 };
        },
      },
    });
    await overviewRoute.GET();
    await getChallenge(ship._id);
    await rulesRoute.GET(getReq("/api/data/rules"));
    expect(ticks).toBe(3);
  });

  it("gives the stage screen verdicts, decided-by, trust level, reason, the rule strip and approval details", async () => {
    const s = await seedStage();
    const res = await getChallenge(s.ship._id);
    const data = (await res.json()) as Serialized<ChallengeData>;

    expect(data.credit_label).toBe(PLAY_CREDIT_LABEL);
    expect(data.pot).toBe(200);
    expect(data.clock).toMatchObject({ current_day: 0, days: 7, day_index: 0 });

    // Feed: newest first, with the rule rejection showing no AI call.
    expect(data.feed.map((p) => p.id)).toEqual([s.ruleReject._id, s.honest._id, s.aiReject._id]);
    const [byRule, accepted, byAi] = data.feed;
    expect(byRule).toMatchObject({ display_name: "Sam", status: "rejected", summary: "commit, 1 file, +1/-1" });
    expect(byRule!.verdict).toMatchObject({ decided_by: "rule", ai_calls: 0, rule: { rule_key: "no-rename-only", version: 2 }, trust_level: "rechecked" });
    expect(byAi!.verdict).toMatchObject({ decided_by: "ai", ai_judgment: true });
    expect(byAi!.verdict?.reason).toContain("only renames a variable");
    expect(accepted).toMatchObject({ display_name: "Gary", status: "accepted", summary: "commit, 3 files, +30/-12" });

    // Rule strip: the learned candidate is awaiting approval, with its pack-rendered line.
    expect(data.rules.activity).toMatchObject({ step: "awaiting_approval", gate_passed: true });
    expect(data.rules.activity?.rule.line).toBe("A proof where the commit only renames identifiers does not count.");
    expect(data.rules.active.map((r) => r.rule_key)).toEqual(["no-empty-commit"]);
    expect(data.rules.versions.map((v) => `${v.rule_key}@${v.version}`)).toEqual(["no-empty-commit@1", "no-rename-only@2"]);
    expect(data.rules.versions[1]).toMatchObject({ catch_rate_before: 0, catch_rate_after: 0.95, false_alarm_set: 0, passed: true });

    // Approvals: the rule entry and the payout entry for this challenge, pending first.
    const ruleEntry = data.approvals.find((a) => a.kind === "rule");
    expect(ruleEntry).toMatchObject({
      id: s.approval._id,
      status: "pending",
      action: "reject",
      parent_version: 1,
      line: "A proof where the commit only renames identifiers does not count.",
      evidence_summary: "commit, 1 file, +1/-1",
      gate: { passed: true, catch_rate_after: 0.95 },
    });
    const payoutEntry = data.approvals.find((a) => a.kind === "payout");
    expect(payoutEntry).toMatchObject({ id: s.payout._id, pot: 400, shares: [{ amount: 200 }, { amount: 200 }] });
    expect(payoutEntry && payoutEntry.kind === "payout" && payoutEntry.names[s.sam._id]).toBe("Sam");
    // The customers rule approval belongs to the other challenge type.
    expect(data.approvals).toHaveLength(2);
  });

  it("replaces Talk to Customers reason text with the cheat class", async () => {
    const s = await seedStage();
    const data = (await (await getChallenge(s.customers._id)).json()) as Serialized<ChallengeData>;
    expect(data.feed).toHaveLength(1);
    expect(data.feed[0]).toMatchObject({ summary: "call, 30 min, 2 outside domains" });
    expect(data.feed[0]!.verdict).toMatchObject({ reason: null, fix: null, cheat_class: "personal_email" });
    const entry = data.approvals[0];
    expect(entry?.kind === "rule" && entry.line).toBe("A proof where an attendee's email domain is one of a set of listed values does not count.");
  });

  it("takes standings from U11 when wired and says not available yet otherwise", async () => {
    const s = await seedStage();
    const unwired = (await (await getChallenge(s.ship._id)).json()) as Serialized<ChallengeData>;
    expect(unwired.standings).toMatchObject({ available: false, owner: "U11" });
    // Fallback rows, most counted days first (KTD13's day-status function).
    expect(unwired.players.map((p) => [p.player.display_name, p.counted_days])).toEqual([
      ["Gary", 1],
      ["Sam", 0],
    ]);

    provideServices({
      settlement: {
        computeScores: async (_db, input) => ({
          challenge_id: input.challenge_id,
          unit: "days",
          goal: 5,
          winner_rule: "top_score",
          pot: 200,
          scores: [],
          standings: [
            { player_id: s.gary._id, display_name: "Gary", score: 1, unit: "days", rank: 1, reached_goal: false, is_you: false },
            { player_id: s.sam._id, display_name: "Sam", score: 0, unit: "days", rank: 2, reached_goal: false, is_you: false },
          ],
        }),
      },
    });
    const wired = (await (await getChallenge(s.ship._id)).json()) as Serialized<ChallengeData>;
    expect(wired.standings.available).toBe(true);
    expect(wired.standings.available && wired.standings.standings.map((x) => x.display_name)).toEqual(["Gary", "Sam"]);
  });

  it("lists the three challenge types with pots, counts and pending approvals", async () => {
    const s = await seedStage();
    const data = (await (await overviewRoute.GET()).json()) as {
      types: { type: string; challenges: { challenge: { id: string }; players: number; proofs: number; pot: number; pending_approvals: number }[] }[];
      pending_approvals: number;
      credit_label: string;
    };
    expect(data.types.map((t) => t.type)).toEqual(["ship_week", "customers", "build_in_public"]);
    expect(data.types[0]!.challenges[0]).toMatchObject({ challenge: { id: s.ship._id }, players: 2, proofs: 3, pot: 200, pending_approvals: 2 });
    expect(data.types[1]!.challenges[0]).toMatchObject({ challenge: { id: s.customers._id }, players: 1, proofs: 1, pending_approvals: 1 });
    expect(data.pending_approvals).toBe(3);
    expect(data.credit_label).toBe(PLAY_CREDIT_LABEL);
  });

  it("answers 404 for an unknown challenge or a bad type, and 503 without a database", async () => {
    expect((await getChallenge("chl_missing")).status).toBe(404);
    expect((await rulesRoute.GET(getReq("/api/data/rules?type=poker"))).status).toBe(400);

    const uri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      expect((await overviewRoute.GET()).status).toBe(503);
    } finally {
      process.env.MONGODB_URI = uri;
    }
  });
});
