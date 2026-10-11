import { MongoClient, type CommandStartedEvent, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RULES_ACTIVE_INDEX, RULES_COLLECTION, type RuleDocument } from "../../src/rules/_u3-shim";
import { evaluateRules, matchesCondition, RuleEngine, type EvaluableRule } from "../../src/rules/engine";
import { ruleDocument, SHIP_WEEK } from "./fixtures";

const renameOnlyProof = { rename_only: true, whitespace_only: false, docs_only: false, code_lines_changed: 4 };

function rule(overrides: Partial<EvaluableRule> = {}): EvaluableRule {
  const { rule_key, version, action, when } = ruleDocument(overrides);
  return { rule_key, version, action, when };
}

describe("evaluateRules", () => {
  it("covers AE1: rejects a rename-only proof with the deciding rule's key and version", () => {
    const decision = evaluateRules([rule({ rule_key: "ship_week.rename_only", version: 3 })], renameOnlyProof);

    expect(decision.outcome).toBe("rejected");
    expect(decision.decided_by).toEqual({ rule_key: "ship_week.rename_only", version: 3, action: "reject" });
    expect(decision.payout_hold).toBe(false);
    expect(decision.evaluated).toEqual([{ rule_key: "ship_week.rename_only", version: 3 }]);
  });

  it("returns no decision when there are no active rules", () => {
    expect(evaluateRules([], renameOnlyProof)).toEqual({
      outcome: "no_decision",
      decided_by: null,
      payout_hold: false,
      matches: [],
      evaluated: [],
    });
  });

  it("returns no decision but still lists evaluated rules when nothing matches", () => {
    const decision = evaluateRules([rule()], { ...renameOnlyProof, rename_only: false });

    expect(decision.outcome).toBe("no_decision");
    expect(decision.decided_by).toBeNull();
    expect(decision.matches).toEqual([]);
    expect(decision.evaluated).toEqual([{ rule_key: "ship_week.rename_only", version: 1 }]);
  });

  it("rejects when a flag rule and a reject rule both match, recording both matches", () => {
    const flag = rule({
      rule_key: "ship_week.small_change",
      version: 2,
      action: "flag",
      when: { all: [{ feature: "code_lines_changed", op: "lte", value: 5 }] },
    });
    const reject = rule({ rule_key: "ship_week.rename_only", version: 1, action: "reject" });

    // Flag first in storage order, to prove the engine's own order decides.
    const decision = evaluateRules([flag, reject], renameOnlyProof);

    expect(decision.outcome).toBe("rejected");
    expect(decision.decided_by).toEqual({ rule_key: "ship_week.rename_only", version: 1, action: "reject" });
    expect(decision.matches).toEqual([
      { rule_key: "ship_week.rename_only", version: 1, action: "reject" },
      { rule_key: "ship_week.small_change", version: 2, action: "flag" },
    ]);
    expect(decision.evaluated).toEqual([
      { rule_key: "ship_week.rename_only", version: 1 },
      { rule_key: "ship_week.small_change", version: 2 },
    ]);
  });

  it("accepts with a payout hold when a hold_payout rule matches", () => {
    const decision = evaluateRules([rule({ rule_key: "ship_week.hold_rename", action: "hold_payout" })], renameOnlyProof);

    expect(decision.outcome).toBe("accepted");
    expect(decision.payout_hold).toBe(true);
    expect(decision.decided_by).toEqual({ rule_key: "ship_week.hold_rename", version: 1, action: "hold_payout" });
  });

  it("holds the proof when an ask_more rule matches, and flags-and-accepts when only a flag rule matches", () => {
    expect(evaluateRules([rule({ action: "ask_more" })], renameOnlyProof).outcome).toBe("held");
    expect(evaluateRules([rule({ action: "flag" })], renameOnlyProof).outcome).toBe("flagged_accept");
  });

  it("evaluates in the fixed order reject, hold_payout, ask_more, flag", () => {
    const all = [
      rule({ rule_key: "d.flag", action: "flag" }),
      rule({ rule_key: "c.ask", action: "ask_more" }),
      rule({ rule_key: "b.hold", action: "hold_payout" }),
      rule({ rule_key: "a.reject", action: "reject" }),
    ];
    expect(evaluateRules(all, renameOnlyProof).matches.map((match) => match.action)).toEqual([
      "reject",
      "hold_payout",
      "ask_more",
      "flag",
    ]);

    const withoutReject = all.filter((r) => r.action !== "reject");
    const holdWins = evaluateRules(withoutReject, renameOnlyProof);
    expect(holdWins.outcome).toBe("accepted");
    expect(holdWins.payout_hold).toBe(true);

    const askWins = evaluateRules(
      withoutReject.filter((r) => r.action !== "hold_payout"),
      renameOnlyProof,
    );
    expect(askWins.outcome).toBe("held");
    expect(askWins.payout_hold).toBe(false);
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
    expect(evaluateRules([allRule], renameOnlyProof).outcome).toBe("no_decision");
    expect(evaluateRules([anyRule], renameOnlyProof).outcome).toBe("rejected");
  });

  it("skips a stored rule with an unknown action or a malformed when, without throwing", () => {
    const badAction = { ...rule({ rule_key: "x.bad_action" }), action: "delete" } as unknown as EvaluableRule;
    const badWhen = { ...rule({ rule_key: "x.bad_when" }), when: {} } as unknown as EvaluableRule;

    const decision = evaluateRules([badAction, badWhen], renameOnlyProof);

    expect(decision.outcome).toBe("no_decision");
    expect(decision.evaluated.map((ref) => ref.rule_key).sort()).toEqual(["x.bad_action", "x.bad_when"]);
  });

  it("evaluates a proof against 50 rules in under 5 ms", () => {
    const rules = Array.from({ length: 50 }, (_, i) =>
      rule({
        rule_key: `ship_week.rule_${String(i).padStart(2, "0")}`,
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
      const decision = evaluateRules(rules, features);
      worst = Math.max(worst, performance.now() - start);
      expect(decision.evaluated).toHaveLength(50);
    }

    expect(worst).toBeLessThan(5);
  });
});

describe("matchesCondition", () => {
  it("treats matches as a literal, case-insensitive substring test", () => {
    const condition = { feature: "message_matches", op: "matches", value: "fix typo" } as const;
    expect(matchesCondition(condition, { message_matches: "FIX TYPO in readme" })).toBe(true);
    expect(matchesCondition(condition, { message_matches: "fixed a typo" })).toBe(false);
    // A regex-looking stored value never runs as a regex.
    expect(matchesCondition({ ...condition, value: "a.c" }, { message_matches: "abc" })).toBe(false);
    expect(matchesCondition({ ...condition, value: "a.c" }, { message_matches: "xa.cx" })).toBe(true);
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
});

describe("RuleEngine with MongoDB", () => {
  let server: MongoMemoryServer;
  let clientA: MongoClient;
  let clientB: MongoClient;
  let dbA: Db;
  let dbB: Db;
  const commandsB: CommandStartedEvent[] = [];
  const dbName = "lane_rules_test";

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    const uri = server.getUri();
    clientA = await new MongoClient(uri).connect();
    clientB = new MongoClient(uri, { monitorCommands: true });
    clientB.on("commandStarted", (event) => commandsB.push(event));
    await clientB.connect();
    dbA = clientA.db(dbName);
    dbB = clientB.db(dbName);
    // U3 creates this index at startup; recreate it here with the same spec.
    await dbA.collection(RULES_COLLECTION).createIndex(RULES_ACTIVE_INDEX.key, RULES_ACTIVE_INDEX.options);
    // The first run downloads a mongod binary (about 77 MB), so allow for a slow link.
  }, 600_000);

  afterEach(async () => {
    await dbA.collection(RULES_COLLECTION).deleteMany({});
    commandsB.length = 0;
  });

  afterAll(async () => {
    await clientA?.close();
    await clientB?.close();
    await server?.stop();
  });

  it("returns no decision when the challenge type has no active rules", async () => {
    const result = await new RuleEngine(dbB).evaluate(SHIP_WEEK, renameOnlyProof);
    expect(result.outcome).toBe("no_decision");
    expect(result.evaluated).toEqual([]);
    expect(result.challenge_type).toBe(SHIP_WEEK);
  });

  it("evaluates only active rules for the requested challenge type", async () => {
    await dbA.collection<RuleDocument>(RULES_COLLECTION).insertMany([
      ruleDocument({ rule_key: "ship_week.rename_only", version: 2, status: "active" }),
      ruleDocument({ rule_key: "ship_week.rename_only", version: 1, status: "retired" }),
      ruleDocument({ rule_key: "ship_week.candidate", status: "candidate" }),
      ruleDocument({ rule_key: "ship_week.pending", status: "pending_approval" }),
      ruleDocument({ rule_key: "bip.rename_only", challenge_type: "build_in_public", status: "active" }),
    ]);

    const result = await new RuleEngine(dbB).evaluate(SHIP_WEEK, renameOnlyProof);

    expect(result.outcome).toBe("rejected");
    expect(result.decided_by).toEqual({ rule_key: "ship_week.rename_only", version: 2, action: "reject" });
    expect(result.evaluated).toEqual([{ rule_key: "ship_week.rename_only", version: 2 }]);
  });

  it("loads active rules with one find that uses the active-rules index", async () => {
    await dbA.collection<RuleDocument>(RULES_COLLECTION).insertMany([
      ruleDocument({ rule_key: "ship_week.rename_only" }),
      ruleDocument({ rule_key: "ship_week.docs_only", when: { all: [{ feature: "docs_only", op: "eq", value: true }] } }),
    ]);

    const engine = new RuleEngine(dbB);
    await engine.evaluate(SHIP_WEEK, renameOnlyProof);

    const ruleCommands = commandsB.filter((event) => event.command[event.commandName] === RULES_COLLECTION);
    expect(ruleCommands.map((event) => event.commandName)).toEqual(["find"]);
    expect(ruleCommands[0]?.command.filter).toEqual({ challenge_type: SHIP_WEEK, status: "active" });

    const explain = await dbB
      .collection(RULES_COLLECTION)
      .find({ challenge_type: SHIP_WEEK, status: "active" })
      .explain("queryPlanner");
    const indexNames = collectIndexScans(explain.queryPlanner?.winningPlan);
    expect(indexNames).toContain(RULES_ACTIVE_INDEX.options.name);
  });

  it("accepts the rules collection directly instead of the database", async () => {
    await dbA.collection<RuleDocument>(RULES_COLLECTION).insertOne(ruleDocument({ action: "hold_payout" }));

    const result = await new RuleEngine(dbB.collection<RuleDocument>(RULES_COLLECTION)).evaluate(
      SHIP_WEEK,
      renameOnlyProof,
    );

    expect(result.outcome).toBe("accepted");
    expect(result.payout_hold).toBe(true);
  });

  it("covers AE1: a rule activated through one connection applies to another engine's next evaluation", async () => {
    const engineA = new RuleEngine(dbA);
    const engineB = new RuleEngine(dbB);
    const rulesA = dbA.collection<RuleDocument>(RULES_COLLECTION);

    // Before activation: the candidate waits for approval and neither engine applies it.
    await rulesA.insertOne(ruleDocument({ rule_key: "ship_week.rename_only", version: 1, status: "pending_approval" }));
    expect((await engineA.evaluate(SHIP_WEEK, renameOnlyProof)).outcome).toBe("no_decision");
    expect((await engineB.evaluate(SHIP_WEEK, renameOnlyProof)).outcome).toBe("no_decision");

    // Activate through connection A.
    await rulesA.updateOne({ rule_key: "ship_week.rename_only", version: 1 }, { $set: { status: "active" } });

    // Engine B, on its own connection, applies it on its very next evaluation.
    const result = await engineB.evaluate(SHIP_WEEK, renameOnlyProof);
    expect(result.outcome).toBe("rejected");
    expect(result.decided_by).toEqual({ rule_key: "ship_week.rename_only", version: 1, action: "reject" });
    expect(result.evaluated).toEqual([{ rule_key: "ship_week.rename_only", version: 1 }]);

    // Rolling it back through A is just as immediate for B.
    await rulesA.updateOne({ rule_key: "ship_week.rename_only", version: 1 }, { $set: { status: "rolled_back" } });
    expect((await engineB.evaluate(SHIP_WEEK, renameOnlyProof)).outcome).toBe("no_decision");
  });
});

function collectIndexScans(plan: unknown, found: string[] = []): string[] {
  if (Array.isArray(plan)) {
    for (const item of plan) collectIndexScans(item, found);
  } else if (plan && typeof plan === "object") {
    const node = plan as Record<string, unknown>;
    if (node.stage === "IXSCAN" && typeof node.indexName === "string") found.push(node.indexName);
    for (const value of Object.values(node)) collectIndexScans(value, found);
  }
  return found;
}
