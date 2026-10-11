import { MongoClient, type CommandStartedEvent, type Db } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  engineService,
  evaluate,
  evaluateRules,
  matchesCondition,
  verdictForDecision,
  type EvaluableRule,
} from "../../src/rules/engine";
import { provideServices, resetServices, services } from "../../src/interfaces";
import { collections, COLLECTIONS } from "../../src/schema/collections";
import { ALL_INDEXES } from "../../src/schema/indexes";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import { ruleDocument, SHIP_WEEK } from "./fixtures";

const renameOnlyProof = { rename_only: true, whitespace_only: false, docs_only: false, code_lines_changed: 4 };

function rule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  const { rule_key, version, action, when } = ruleDocument(overrides);
  return { rule_key, version, action, when };
}

describe("evaluateRules", () => {
  it("covers AE1: rejects a rename-only proof with the deciding rule's key and version", () => {
    const result = evaluateRules([rule({ rule_key: "rename_only", version: 3 })], renameOnlyProof);

    expect(result.decision).toBe("reject");
    expect(result.rule).toEqual({ rule_key: "rename_only", version: 3 });
    expect(result.matched).toEqual([{ rule_key: "rename_only", version: 3, action: "reject" }]);
    expect(result.evaluated).toEqual([{ rule_key: "rename_only", version: 3 }]);
    expect(verdictForDecision(result.decision)).toEqual({ outcome: "reject", payout_hold: false });
  });

  it("returns no decision when there are no active rules", () => {
    const result = evaluateRules([], renameOnlyProof);
    expect(result).toEqual({ decision: "none", rule: null, matched: [], evaluated: [] });
    expect(verdictForDecision(result.decision)).toBeNull();
  });

  it("returns no decision but still lists evaluated rules when nothing matches", () => {
    const result = evaluateRules([rule()], { ...renameOnlyProof, rename_only: false });

    expect(result.decision).toBe("none");
    expect(result.rule).toBeNull();
    expect(result.matched).toEqual([]);
    expect(result.evaluated).toEqual([{ rule_key: "rename_only", version: 1 }]);
  });

  it("rejects when a flag rule and a reject rule both match, recording both matches", () => {
    const flag = rule({
      rule_key: "small_change",
      version: 2,
      action: "flag",
      when: { all: [{ feature: "code_lines_changed", op: "lte", value: 5 }] },
    });
    const reject = rule({ rule_key: "rename_only", version: 1, action: "reject" });

    // Flag first in storage order, to prove the engine's own order decides.
    const result = evaluateRules([flag, reject], renameOnlyProof);

    expect(result.decision).toBe("reject");
    expect(result.rule).toEqual({ rule_key: "rename_only", version: 1 });
    expect(result.matched).toEqual([
      { rule_key: "rename_only", version: 1, action: "reject" },
      { rule_key: "small_change", version: 2, action: "flag" },
    ]);
    expect(result.evaluated).toEqual([
      { rule_key: "rename_only", version: 1 },
      { rule_key: "small_change", version: 2 },
    ]);
  });

  it("accepts with a payout hold when a hold_payout rule matches", () => {
    const result = evaluateRules([rule({ rule_key: "hold_rename", action: "hold_payout" })], renameOnlyProof);

    expect(result.decision).toBe("hold_payout");
    expect(result.rule).toEqual({ rule_key: "hold_rename", version: 1 });
    expect(verdictForDecision(result.decision)).toEqual({ outcome: "accept", payout_hold: true });
  });

  it("asks for more when an ask_more rule matches, and flags when only a flag rule matches", () => {
    const ask = evaluateRules([rule({ action: "ask_more" })], renameOnlyProof);
    const flag = evaluateRules([rule({ action: "flag" })], renameOnlyProof);
    expect(ask.decision).toBe("ask_more");
    expect(verdictForDecision(ask.decision)).toEqual({ outcome: "ask_more", payout_hold: false });
    expect(flag.decision).toBe("flag");
    expect(verdictForDecision(flag.decision)).toEqual({ outcome: "flag", payout_hold: false });
  });

  it("evaluates in the fixed order reject, hold_payout, ask_more, flag", () => {
    const all = [
      rule({ rule_key: "a_flag", action: "flag" }),
      rule({ rule_key: "b_ask", action: "ask_more" }),
      rule({ rule_key: "c_hold", action: "hold_payout" }),
      rule({ rule_key: "d_reject", action: "reject" }),
    ];
    expect(evaluateRules(all, renameOnlyProof).matched.map((match) => match.action)).toEqual([
      "reject",
      "hold_payout",
      "ask_more",
      "flag",
    ]);

    const withoutReject = all.filter((r) => r.action !== "reject");
    expect(evaluateRules(withoutReject, renameOnlyProof).decision).toBe("hold_payout");
    expect(evaluateRules(withoutReject.filter((r) => r.action !== "hold_payout"), renameOnlyProof).decision).toBe(
      "ask_more",
    );
  });

  it("applies all and any combinators", () => {
    const allRule = rule({
      when: {
        all: [
          { feature: "rename_only", op: "eq", value: true },
          { feature: "code_lines_changed", op: "gt", value: 10 },
        ],
      },
    });
    const anyRule = rule({
      when: {
        any: [
          { feature: "docs_only", op: "eq", value: true },
          { feature: "code_lines_changed", op: "in", value: [3, 4, 5] },
        ],
      },
    });
    expect(evaluateRules([allRule], renameOnlyProof).decision).toBe("none");
    expect(evaluateRules([anyRule], renameOnlyProof).decision).toBe("reject");
  });

  it("skips a stored rule with an unknown action or a malformed when, without throwing", () => {
    const badAction = { ...rule({ rule_key: "x_bad_action" }), action: "delete" } as unknown as EvaluableRule;
    const badWhen = { ...rule({ rule_key: "x_bad_when" }), when: {} } as unknown as EvaluableRule;

    const result = evaluateRules([badAction, badWhen], renameOnlyProof);

    expect(result.decision).toBe("none");
    expect(result.evaluated.map((ref) => ref.rule_key).sort()).toEqual(["x_bad_action", "x_bad_when"]);
  });

  it("evaluates a proof against 50 rules in under 5 ms", () => {
    const rules = Array.from({ length: 50 }, (_, i) =>
      rule({
        rule_key: `rule_${String(i).padStart(2, "0")}`,
        action: (["flag", "ask_more", "hold_payout", "reject"] as const)[i % 4],
        when: {
          all: [
            { feature: "code_lines_changed", op: "gte", value: i % 20 },
            { feature: "message_matches", op: "matches", value: `marker ${i}` },
            { feature: "docs_only", op: "eq", value: false },
          ],
        },
      }),
    );
    const features = { ...renameOnlyProof, message_matches: "Rename variable, marker 49 included" };

    evaluateRules(rules, features); // warm up the JIT
    const runs = 20;
    let worst = 0;
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      const result = evaluateRules(rules, features);
      worst = Math.max(worst, performance.now() - start);
      expect(result.evaluated).toHaveLength(50);
    }

    expect(worst).toBeLessThan(5);
  });
});

describe("matchesCondition", () => {
  it("treats matches as a literal, case-insensitive substring test", () => {
    const cond = { feature: "message_matches", op: "matches", value: "fix typo" } as const;
    expect(matchesCondition(cond, { message_matches: "FIX TYPO in readme" })).toBe(true);
    expect(matchesCondition(cond, { message_matches: "fixed a typo" })).toBe(false);
    // A regex-looking stored value never runs as a regex.
    expect(matchesCondition({ ...cond, value: "a.c" }, { message_matches: "abc" })).toBe(false);
    expect(matchesCondition({ ...cond, value: "a.c" }, { message_matches: "xa.cx" })).toBe(true);
  });

  it("does not match a missing feature, an inherited key or a type mismatch", () => {
    expect(matchesCondition({ feature: "rename_only", op: "eq", value: true }, {})).toBe(false);
    expect(matchesCondition({ feature: "toString", op: "eq", value: true }, {})).toBe(false);
    expect(matchesCondition({ feature: "code_lines_changed", op: "lt", value: 5 }, { code_lines_changed: "3" })).toBe(
      false,
    );
    expect(matchesCondition({ feature: "rename_only", op: "eq", value: "true" }, { rename_only: true })).toBe(false);
  });

  it("compares numbers with lt, lte, gt and gte", () => {
    const features = { code_lines_changed: 5 };
    expect(matchesCondition({ feature: "code_lines_changed", op: "lt", value: 5 }, features)).toBe(false);
    expect(matchesCondition({ feature: "code_lines_changed", op: "lte", value: 5 }, features)).toBe(true);
    expect(matchesCondition({ feature: "code_lines_changed", op: "gt", value: 4 }, features)).toBe(true);
    expect(matchesCondition({ feature: "code_lines_changed", op: "gte", value: 6 }, features)).toBe(false);
  });

  it("matches a string_list feature when any item passes the test", () => {
    const domains = { attendee_domains: ["gmail.com", "Acme.io"] };
    expect(matchesCondition({ feature: "attendee_domains", op: "in", value: ["gmail.com", "yahoo.com"] }, domains)).toBe(
      true,
    );
    expect(matchesCondition({ feature: "attendee_domains", op: "in", value: ["yahoo.com"] }, domains)).toBe(false);
    expect(matchesCondition({ feature: "attendee_domains", op: "matches", value: "acme" }, domains)).toBe(true);
    expect(matchesCondition({ feature: "attendee_domains", op: "in", value: ["x"] }, { attendee_domains: [] })).toBe(
      false,
    );
    expect(matchesCondition({ feature: "attendee_domains", op: "gt", value: 1 }, domains)).toBe(false);
  });
});

describe("rule engine with MongoDB", () => {
  let mongo: TestMongo;
  let clientB: MongoClient;
  let dbA: Db;
  let dbB: Db;
  const commandsB: CommandStartedEvent[] = [];

  beforeAll(async () => {
    mongo = await startReplSet();
    // A second connection to U3's replica set, as a separate function instance would have.
    clientB = new MongoClient(mongo.replSet.getUri(), { monitorCommands: true });
    clientB.on("commandStarted", (event) => commandsB.push(event));
    await clientB.connect();
  });

  afterEach(() => {
    resetServices();
    commandsB.length = 0;
  });

  afterAll(async () => {
    await clientB?.close();
    await mongo?.stop();
  });

  /** An empty database with every U3 index (ensureIndexes), opened on both connections. */
  async function freshPair(): Promise<void> {
    dbA = await mongo.freshDb();
    dbB = clientB.db(dbA.databaseName);
    commandsB.length = 0;
  }

  it("returns no decision when the challenge type has no active rules", async () => {
    await freshPair();
    const result = await evaluate(dbB, { challenge_type: SHIP_WEEK, features: renameOnlyProof });
    expect(result).toEqual({ decision: "none", rule: null, matched: [], evaluated: [] });
  });

  it("evaluates only active rules for the requested challenge type", async () => {
    await freshPair();
    await collections(dbA).rules.insertMany([
      ruleDocument({ rule_key: "rename_only", version: 2, status: "active" }),
      ruleDocument({ rule_key: "rename_only", version: 1, status: "retired" }),
      ruleDocument({ rule_key: "candidate", status: "candidate" }),
      ruleDocument({ rule_key: "pending", status: "pending_approval" }),
      ruleDocument({ rule_key: "rename_only", challenge_type: "build_in_public", status: "active" }),
    ]);

    const result = await evaluate(dbB, { challenge_type: SHIP_WEEK, features: renameOnlyProof });

    expect(result.decision).toBe("reject");
    expect(result.rule).toEqual({ rule_key: "rename_only", version: 2 });
    expect(result.evaluated).toEqual([{ rule_key: "rename_only", version: 2 }]);
  });

  it("loads active rules with one find that uses U3's rules index", async () => {
    await freshPair();
    await collections(dbA).rules.insertMany([
      ruleDocument({ rule_key: "rename_only" }),
      ruleDocument({ rule_key: "docs_only", when: { all: [{ feature: "docs_only", op: "eq", value: true }] } }),
    ]);

    await evaluate(dbB, { challenge_type: SHIP_WEEK, features: renameOnlyProof });

    const ruleCommands = commandsB.filter((event) => event.command[event.commandName] === COLLECTIONS.rules);
    expect(ruleCommands.map((event) => event.commandName)).toEqual(["find"]);
    expect(ruleCommands[0]?.command.filter).toEqual({ challenge_type: SHIP_WEEK, status: "active" });

    // The index U3 creates for KTD7's one indexed read, and the partial unique index on active rules.
    const rulesIndexNames = ALL_INDEXES.filter((def) => def.collection === "rules").map((def) => def.name);
    expect(rulesIndexNames).toContain("by_type_status");

    const explain = await collections(dbB)
      .rules.find({ challenge_type: SHIP_WEEK, status: "active" })
      .explain("queryPlanner");
    const winningPlan = explain.queryPlanner?.winningPlan;
    const scans = collectStages(winningPlan);
    expect(scans.collscan).toBe(false);
    expect(scans.ixscans.length).toBeGreaterThan(0);
    for (const name of scans.ixscans) expect(rulesIndexNames).toContain(name);
  });

  it("reads inside the caller's transaction when a session is passed", async () => {
    await freshPair();
    const session = mongo.client.startSession();
    try {
      await session.withTransaction(async () => {
        await collections(dbA).rules.insertOne(ruleDocument({ rule_key: "rename_only" }), { session });
        const inside = await evaluate(dbA, { challenge_type: SHIP_WEEK, features: renameOnlyProof, session });
        expect(inside.decision).toBe("reject");
        // Outside the transaction the insert is not visible yet.
        const outside = await evaluate(dbB, { challenge_type: SHIP_WEEK, features: renameOnlyProof });
        expect(outside.decision).toBe("none");
      });
    } finally {
      await session.endSession();
    }
  });

  it("is wired as U4's engine service through interfaces.ts", async () => {
    await freshPair();
    await collections(dbA).rules.insertOne(ruleDocument({ action: "hold_payout" }));

    provideServices({ engine: engineService });
    const result = await services().engine.evaluate(dbB, { challenge_type: SHIP_WEEK, features: renameOnlyProof });

    expect(result.decision).toBe("hold_payout");
    expect(verdictForDecision(result.decision)).toEqual({ outcome: "accept", payout_hold: true });
  });

  it("covers AE1: a rule activated through one connection applies to another engine's next evaluation", async () => {
    await freshPair();
    const rulesA = collections(dbA).rules;
    const input = { challenge_type: SHIP_WEEK, features: renameOnlyProof } as const;

    // Before activation: the candidate waits for approval and neither connection applies it.
    await rulesA.insertOne(ruleDocument({ rule_key: "rename_only", version: 1, status: "pending_approval" }));
    expect((await evaluate(dbA, input)).decision).toBe("none");
    expect((await evaluate(dbB, input)).decision).toBe("none");

    // Activate through connection A.
    await rulesA.updateOne({ rule_key: "rename_only", version: 1 }, { $set: { status: "active" } });

    // Connection B applies it on its very next evaluation.
    const result = await evaluate(dbB, input);
    expect(result.decision).toBe("reject");
    expect(result.rule).toEqual({ rule_key: "rename_only", version: 1 });
    expect(result.evaluated).toEqual([{ rule_key: "rename_only", version: 1 }]);

    // Rolling it back through A is just as immediate for B.
    await rulesA.updateOne({ rule_key: "rename_only", version: 1 }, { $set: { status: "rolled_back" } });
    expect((await evaluate(dbB, input)).decision).toBe("none");
  });
});

function collectStages(plan: unknown, found = { ixscans: [] as string[], collscan: false }) {
  if (Array.isArray(plan)) {
    for (const item of plan) collectStages(item, found);
  } else if (plan && typeof plan === "object") {
    const node = plan as Record<string, unknown>;
    if (node.stage === "IXSCAN" && typeof node.indexName === "string") found.ixscans.push(node.indexName);
    if (node.stage === "COLLSCAN") found.collscan = true;
    for (const value of Object.values(node)) collectStages(value, found);
  }
  return found;
}
