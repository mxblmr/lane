import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { provideServices, resetServices } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema/collections";
import { CHALLENGE_TYPES, newId } from "@lane/core/schema/common";
import { ledgerBalanceOf } from "@lane/core/ledger";
import { hashLaneKey, MissingEnvError, seedPlayerInputs, readPlayerGithub } from "../roster";
import { seed } from "../seed";
import { resetStage, resetStageDetailed } from "../reset";
import { stageChallengeId, type Db } from "../stage";
import { platformsFor, parseCliArgs } from "../cli";
import { insertPendingApproval, insertRule, seedEnv, upstreamDoubles } from "./doubles";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
}, 60_000);
afterEach(() => {
  resetServices();
});

const ALL = [...CHALLENGE_TYPES];

async function seeded(): Promise<Db> {
  const db = await mongo.freshDb();
  upstreamDoubles();
  await seed(db, { players: seedPlayerInputs(seedEnv(), platformsFor(ALL)), types: ALL });
  return db;
}

describe("seed", () => {
  it("seeding twice leaves one copy of each challenge and player", async () => {
    const db = await mongo.freshDb();
    upstreamDoubles();
    const players = seedPlayerInputs(seedEnv(), platformsFor(ALL));
    const first = await seed(db, { players, types: ALL });
    const second = await seed(db, { players, types: ALL });
    const col = collections(db);

    expect(first.players.every((p) => p.created)).toBe(true);
    expect(second.players.every((p) => !p.created)).toBe(true);
    expect(await col.players.countDocuments({ scripted: true })).toBe(3);
    expect(await col.ledger.countDocuments({ kind: "grant" })).toBe(3);
    for (const type of ALL) {
      expect(await col.challenges.countDocuments({ stage: true, type })).toBe(1);
      expect(await col.challenges.countDocuments({ stage: true, type, status: "active" })).toBe(1);
    }
    expect(second.stage.map((s) => s.challenge_id)).toEqual(first.stage.map((s) => s.challenge_id));
    // Each stage challenge has the three scripted players joined, staked once each.
    for (const s of first.stage) {
      expect(await col.memberships.countDocuments({ challenge_id: s.challenge_id })).toBe(3);
      expect(await col.ledger.countDocuments({ challenge_id: s.challenge_id, kind: "stake" })).toBe(3);
    }
  });

  it("seeds the scripted players with verified handles and only the key hash", async () => {
    const db = await seeded();
    const sam = await collections(db).players.findOne({ scripted: true, display_name: "Sam" });
    expect(sam?.key_hash).toBe(hashLaneKey(seedEnv().SAM_LANE_KEY!));
    expect(JSON.stringify(sam)).not.toContain(seedEnv().SAM_LANE_KEY);
    expect(sam?.handles.github).toMatchObject({ handle: "sam-lane-demo", status: "verified" });
    expect(sam?.handles.threads).toMatchObject({ handle: "sam.builds", status: "verified" });
  });

  it("puts every stage challenge on a demo clock starting at seed time", async () => {
    const now = new Date("2026-10-11T22:00:00Z");
    const db = await mongo.freshDb();
    upstreamDoubles();
    await seed(db, { players: seedPlayerInputs(seedEnv(), platformsFor(["ship_week"])), types: ["ship_week"], now });
    const c = await collections(db).challenges.findOne({ _id: stageChallengeId("ship_week", 1) });
    expect(c?.status).toBe("active");
    expect(c?.clock?.mode).toBe("demo");
    expect(c?.clock?.start_at.toISOString()).toBe(now.toISOString());
  });

  it("fails with every missing variable named", () => {
    expect(() => seedPlayerInputs({}, ["github"])).toThrow(MissingEnvError);
    try {
      seedPlayerInputs({ SAM_LANE_KEY: "x".repeat(20) }, ["github"]);
    } catch (err) {
      expect((err as MissingEnvError).missing).toEqual([
        "GARY_LANE_KEY",
        "GARY_GITHUB_LOGIN",
        "PRIYA_LANE_KEY",
        "PRIYA_GITHUB_LOGIN",
        "SAM_GITHUB_LOGIN",
      ]);
    }
    expect(() => readPlayerGithub({}, "Sam")).toThrow(/SAM_GITHUB_LOGIN, SAM_GITHUB_TOKEN, SAM_GITHUB_REPO/);
  });

  it("parses the CLI commands", () => {
    expect(parseCliArgs(["seed"])).toEqual({ command: "seed", types: ALL });
    expect(parseCliArgs(["seed", "--types", "ship_week"])).toEqual({ command: "seed", types: ["ship_week"] });
    expect(parseCliArgs(["reset", "--type=ship_week"])).toEqual({ command: "reset", type: "ship_week" });
    expect(() => parseCliArgs(["reset"])).toThrow(/--type/);
    expect(() => parseCliArgs(["seed", "--types", "fitness"])).toThrow(/Unknown challenge type/);
  });
});

describe("reset (KTD22)", () => {
  it("ten consecutive resets leave each scripted player's balance unchanged, and only the newest stage challenge per type is active", async () => {
    const db = await seeded();
    const col = collections(db);
    const players = await col.players.find({ scripted: true }).toArray();
    const before = new Map(players.map((p) => [p._id, p.credits]));
    const earlierLedger = await col.ledger.find({}).sort({ _id: 1 }).toArray();

    for (let i = 0; i < 10; i++) {
      for (const type of ALL) {
        const r = await resetStage(db, { challenge_type: type, by: "test" });
        expect(r.ok).toBe(true);
      }
    }

    for (const p of await col.players.find({ scripted: true }).toArray()) {
      expect(p.credits).toBe(before.get(p._id));
      expect(await ledgerBalanceOf(db, p._id)).toBe(p.credits);
    }
    for (const type of ALL) {
      const live = await col.challenges.find({ stage: true, type, status: { $ne: "cancelled" } }).toArray();
      expect(live.map((c) => c._id)).toEqual([stageChallengeId(type, 11)]);
      expect(live[0]!.status).toBe("active");
      expect(await col.challenges.countDocuments({ stage: true, type, status: "cancelled" })).toBe(10);
    }
    // Earlier ledger entries stay untouched; refunds are new entries.
    for (const entry of earlierLedger) {
      expect(await col.ledger.findOne({ _id: entry._id })).toEqual(entry);
    }
    expect(await col.ledger.countDocuments({ kind: "refund" })).toBe(10 * 3 * ALL.length);
  });

  it("cancels the previous stage challenge, refunds its stakes and expires its open inbox items", async () => {
    const db = await seeded();
    const col = collections(db);
    const old = stageChallengeId("ship_week", 1);
    const sam = (await col.players.findOne({ display_name: "Sam", scripted: true }))!;
    const now = new Date();
    await col.inbox.insertOne({
      _id: newId("inbox"),
      player_id: sam._id,
      challenge_id: old,
      kind: "extra_proof",
      actor: "player",
      instruction: "Put code 4821 in your next commit message.",
      answer_tool: "lane_submit_proof",
      answer_args: {},
      day_index: 0,
      subject_proof_id: "prf_x",
      slot: null,
      code: "4821",
      release_at: null,
      due_at: null,
      status: "open",
      notify_player_ids: [],
      answer_proof_id: null,
      created_at: now,
      updated_at: now,
      resolved_at: null,
      delivered_at: null,
    });

    const r = await resetStageDetailed(db, { challenge_type: "ship_week", by: "test" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cancelled_challenge_id).toBe(old);
    expect(r.new_challenge_id).toBe(stageChallengeId("ship_week", 2));
    expect(r.report.refunds).toBe(3);
    expect(r.report.expired_items).toBe(1);
    expect((await col.challenges.findOne({ _id: old }))?.status).toBe("cancelled");
    expect(await col.inbox.countDocuments({ challenge_id: old, status: "open" })).toBe(0);
    expect(await col.events.countDocuments({ kind: "stage.reset" })).toBe(1);
    // Other types are untouched.
    expect((await col.challenges.findOne({ _id: stageChallengeId("customers", 1) }))?.status).toBe("active");
  });

  it("rolls rules back to seed versions, removes non-seed examples and declines open rule approvals", async () => {
    const db = await seeded();
    const col = collections(db);
    // Seed rule tightened by a learned child, a brand-new learned rule, a pending candidate, and a customers rule.
    await insertRule(db, { rule_key: "whitespace", version: 1, challenge_type: "ship_week", status: "retired", source: "seed", cheat_class: "whitespace_only", when: { all: [{ feature: "whitespace_only", op: "eq", value: true }] } });
    await insertRule(db, { rule_key: "whitespace", version: 2, parent_version: 1, challenge_type: "ship_week", status: "active", source: "red_team", cheat_class: "whitespace_only", when: { all: [{ feature: "whitespace_only", op: "eq", value: true }] } });
    await insertRule(db, { rule_key: "rename-only", version: 1, challenge_type: "ship_week", status: "active", source: "ai_judgment" });
    const candidate = await insertRule(db, { rule_key: "docs-only", version: 1, challenge_type: "ship_week", status: "pending_approval", source: "ai_judgment", cheat_class: "docs_only", when: { all: [{ feature: "docs_only", op: "eq", value: true }] } });
    const pending = await insertPendingApproval(db, candidate);
    await insertRule(db, { rule_key: "friends-call", version: 1, challenge_type: "customers", status: "active", source: "dispute", cheat_class: "all_personal_email", when: { all: [{ feature: "all_personal_email", op: "eq", value: true }] }, action: "ask_more" });
    const ex = (key: string, source: "seed" | "red_team" | "live", type: "ship_week" | "customers" = "ship_week") => ({
      _id: newId("example"),
      challenge_type: type,
      example_key: key,
      label: "cheat" as const,
      cheat_class: "rename_only",
      features: { rename_only: true },
      source,
      summary: null,
      proof_id: null,
      created_at: new Date(),
    });
    await col.examples.insertMany([ex("seed-1", "seed"), ex("red-1", "red_team"), ex("live-1", "live"), ex("cust-red", "red_team", "customers")]);

    const r = await resetStageDetailed(db, { challenge_type: "ship_week", by: "test" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.declined_approvals).toBe(1);
    expect(r.report.rolled_back.sort()).toEqual(["rename-only v1", "whitespace v2"]);
    expect(r.report.removed_examples).toBe(2);

    const active = await col.rules.find({ challenge_type: "ship_week", status: "active" }).toArray();
    expect(active.map((x) => `${x.rule_key} v${x.version} ${x.source}`)).toEqual(["whitespace v1 seed"]);
    expect((await col.approvals.findOne({ _id: pending._id }))?.status).toBe("declined");
    expect((await col.rules.findOne({ _id: candidate._id }))?.status).toBe("rejected");
    expect((await col.examples.find({ challenge_type: "ship_week" }).toArray()).map((e) => e.example_key)).toEqual(["seed-1"]);
    // The customers type keeps its learned rule and examples.
    expect(await col.rules.countDocuments({ challenge_type: "customers", status: "active" })).toBe(1);
    expect(await col.examples.countDocuments({ challenge_type: "customers" })).toBe(1);
  });

  it("two concurrent resets leave one new active stage challenge and refund each stake once", async () => {
    const db = await seeded();
    const col = collections(db);
    const [a, b] = await Promise.all([
      resetStage(db, { challenge_type: "ship_week", by: "a" }),
      resetStage(db, { challenge_type: "ship_week", by: "b" }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    const live = await col.challenges.find({ stage: true, type: "ship_week", status: "active" }).toArray();
    expect(live).toHaveLength(1);
    expect(await col.ledger.countDocuments({ challenge_id: stageChallengeId("ship_week", 1), kind: "refund" })).toBe(3);
    expect(await col.memberships.countDocuments({ challenge_id: live[0]!._id })).toBe(3);
  });

  it("leaves a settled stage challenge's payout alone", async () => {
    const db = await seeded();
    const col = collections(db);
    const old = stageChallengeId("ship_week", 1);
    await col.challenges.updateOne({ _id: old }, { $set: { status: "settled" } });
    const r = await resetStage(db, { challenge_type: "ship_week", by: "test" });
    expect(r.ok).toBe(true);
    expect((await col.challenges.findOne({ _id: old }))?.status).toBe("settled");
    expect(await col.ledger.countDocuments({ challenge_id: old, kind: "refund" })).toBe(0);
  });

  it("returns a recovery instruction when an upstream step fails, and a second reset completes", async () => {
    const db = await seeded();
    const col = collections(db);
    await insertRule(db, { rule_key: "rename-only", version: 1, challenge_type: "ship_week", status: "active", source: "ai_judgment" });
    provideServices({
      lifecycle: {
        rollback: async () => {
          throw new Error("U9 lifecycle unavailable");
        },
      },
    });
    const failed = await resetStage(db, { challenge_type: "ship_week", by: "test" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.message).toMatch(/roll rules back to seed/);
      expect(failed.error.recovery).toMatch(/again/);
    }
    upstreamDoubles();
    const ok = await resetStage(db, { challenge_type: "ship_week", by: "test" });
    expect(ok.ok).toBe(true);
    expect(await col.challenges.countDocuments({ stage: true, type: "ship_week", status: "active" })).toBe(1);
    expect(await col.ledger.countDocuments({ challenge_id: stageChallengeId("ship_week", 1), kind: "refund" })).toBe(3);
  });
});
