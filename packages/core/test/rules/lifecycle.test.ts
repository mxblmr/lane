import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import { collections } from "../../src/schema/collections";
import { provideServices, resetServices } from "../../src/interfaces";
import { activateRule, proposeRule, rejectCandidate, rollbackRule, testCandidate } from "../../src/rules/lifecycle";
import { createApproval, ruleApprovalId } from "../../src/rules/approvals";
import type { When } from "../../src/schema/rule";
import {
  ae1Examples,
  ae2Examples,
  cheat,
  contractsDouble,
  honest,
  insertActiveRule,
  insertExamples,
  PERSONAL_NO_NOTES_WHEN,
  proposal,
  RENAME_WHEN,
  shipFeatures,
  T0,
} from "./u9-fixtures";

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

async function passedRenameCandidate(db: Db, parent: { rule_key: string; version: number } | null = null) {
  const proposed = await proposeRule(
    db,
    proposal({ challenge_type: "ship_week", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only", parent, rule_key: parent ? undefined : "rename-only" }),
    { now: T0 },
  );
  if (!proposed.ok) throw new Error(proposed.error.message);
  const tested = await testCandidate(db, proposed.rule._id, { now: T0 });
  if (!tested.ok) throw new Error(tested.error.message);
  return tested;
}

async function approve(db: Db, ruleId: string): Promise<void> {
  const rule = await collections(db).rules.findOne({ _id: ruleId });
  if (!rule) throw new Error("rule missing");
  await createApproval(
    db,
    {
      kind: "rule",
      rule_id: rule._id,
      rule_key: rule.rule_key,
      rule_version: rule.version,
      challenge_type: rule.challenge_type,
      action: rule.action,
      execution_id: "exec_1",
      workspace_id: "ws_1",
      suspend_context: {},
      allowed_decisions: ["approve", "decline"],
    },
    { now: T0 },
  );
  await collections(db).approvals.updateOne({ _id: ruleApprovalId(rule._id) }, { $set: { status: "approved", decided_by: "presenter", decided_at: T0 } });
}

describe("rule lifecycle (KTD10, R21 to R23)", () => {
  it("AE1: a passing rename-only reject candidate stays a candidate with its gate results stored", async () => {
    const db = await mongo.freshDb();
    await insertExamples(db, "ship_week", ae1Examples());
    const tested = await passedRenameCandidate(db);
    expect(tested.gate.passed).toBe(true);
    expect(tested.rule.status).toBe("candidate");
    const stored = await collections(db).rules.findOne({ _id: tested.rule._id });
    expect(stored?.test_results?.catch_rate_after).toBeCloseTo(0.95, 10);
    expect(stored?.version).toBe(1);
    expect(stored?.parent_version).toBeNull();
  });

  it("AE5: a candidate that flags 3 of 100 honest examples is rejected and the active version stays", async () => {
    const db = await mongo.freshDb();
    const examples = [
      ...Array.from({ length: 10 }, (_, i) => cheat(`typo-${i}`, "typo_only", shipFeatures({ typo_only: true, code_lines_changed: 1 }))),
      ...Array.from({ length: 100 }, (_, i) => honest(`honest-${i}`, shipFeatures({ code_lines_changed: i < 3 ? 2 : 30 }))),
    ];
    await insertExamples(db, "ship_week", examples);
    const activeId = await insertActiveRule(db, {
      challenge_type: "ship_week",
      rule_key: "typo-check",
      when: { all: [{ feature: "empty_commit", op: "eq", value: true }] },
      action: "flag",
      cheat_class: "typo_only",
    });
    const when: When = { any: [{ feature: "typo_only", op: "eq", value: true }, { feature: "code_lines_changed", op: "lte", value: 3 }] };
    const proposed = await proposeRule(db, proposal({ challenge_type: "ship_week", when, action: "reject", cheat_class: "typo_only", parent: { rule_key: "typo-check", version: 1 } }), { now: T0 });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.rule.version).toBe(2);
    expect(proposed.rule.parent_version).toBe(1);
    const tested = await testCandidate(db, proposed.rule._id, { now: T0 });
    expect(tested.ok).toBe(true);
    if (!tested.ok) return;
    expect(tested.gate.passed).toBe(false);
    expect(tested.gate.catch_rate_after).toBe(1);
    expect(tested.gate.false_alarm_rule).toBeCloseTo(0.03, 10);
    expect(tested.gate.reasons).toContain("false alarms 3.0% > 1.0%");
    expect(tested.rule.status).toBe("rejected");
    expect((await collections(db).rules.findOne({ _id: activeId }))?.status).toBe("active");

    const refused = await activateRule(db, { candidate_id: proposed.rule._id, by: "promoter" }, { now: T0 });
    expect(refused.ok).toBe(false);
  });

  it("refuses to activate a pending reject rule with no approved record, and succeeds with one", async () => {
    const db = await mongo.freshDb();
    const contracts = contractsDouble();
    provideServices({ contracts: contracts.service });
    await insertExamples(db, "ship_week", ae1Examples());
    const { rule } = await passedRenameCandidate(db);

    const refused = await activateRule(db, { candidate_id: rule._id, by: "promoter" }, { now: T0 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("not_allowed");
    expect((await collections(db).rules.findOne({ _id: rule._id }))?.status).toBe("candidate");
    expect(contracts.calls).toHaveLength(0);

    await approve(db, rule._id);
    const done = await activateRule(db, { candidate_id: rule._id, by: "promoter" }, { now: T0 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.status).toBe("active");
    expect(done.rule.approval_id).toBe(ruleApprovalId(rule._id));
    expect(done.contracts).toEqual([{ challenge_id: "chl_test", version: 2 }]);
    expect(contracts.calls).toHaveLength(1);
    expect(contracts.calls[0]?.challenge_type).toBe("ship_week");
    expect(contracts.calls[0]?.reason).toBe("rule_activated");
  });

  it("activating an already-active candidate succeeds without publishing a new contract version", async () => {
    const db = await mongo.freshDb();
    const contracts = contractsDouble();
    provideServices({ contracts: contracts.service });
    await insertExamples(db, "ship_week", ae1Examples());
    const { rule } = await passedRenameCandidate(db);
    await approve(db, rule._id);
    const first = await activateRule(db, { candidate_id: rule._id, by: "promoter" }, { now: T0 });
    const second = await activateRule(db, { candidate_id: rule._id, by: "promoter" }, { now: T0 });
    expect(first.ok && first.status).toBe("active");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("active");
    expect(second.already_active).toBe(true);
    expect(second.contracts).toEqual([]);
    expect(contracts.calls).toHaveLength(1);
  });

  it("AE2: an ask_more rule for personal-email calls without notes goes active without approval", async () => {
    const db = await mongo.freshDb();
    provideServices({ contracts: contractsDouble().service });
    await insertExamples(db, "customers", ae2Examples());
    const proposed = await proposeRule(
      db,
      proposal({ challenge_type: "customers", when: PERSONAL_NO_NOTES_WHEN, action: "ask_more", cheat_class: "all_personal_email", source: "dispute" }),
      { now: T0 },
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.rule.rule_key).toBe("learned-all-personal-email");
    const tested = await testCandidate(db, proposed.rule._id, { now: T0 });
    expect(tested.ok && tested.gate.passed).toBe(true);
    const done = await activateRule(db, { candidate_id: proposed.rule._id, by: "promoter" }, { now: T0 });
    expect(done.ok && done.status).toBe("active");
    expect(await collections(db).approvals.countDocuments()).toBe(0);
  });

  it("two candidates with the same parent: one becomes active and the other is superseded", async () => {
    const db = await mongo.freshDb();
    const contracts = contractsDouble();
    provideServices({ contracts: contracts.service });
    await insertExamples(db, "customers", ae2Examples());
    const parentId = await insertActiveRule(db, {
      challenge_type: "customers",
      rule_key: "personal-calls",
      when: { all: [{ feature: "short_call", op: "eq", value: true }] },
      action: "flag",
      cheat_class: "all_personal_email",
    });
    const make = async () => {
      const p = await proposeRule(
        db,
        proposal({ challenge_type: "customers", when: PERSONAL_NO_NOTES_WHEN, action: "flag", cheat_class: "all_personal_email", parent: { rule_key: "personal-calls", version: 1 } }),
        { now: T0 },
      );
      if (!p.ok) throw new Error(p.error.message);
      const t = await testCandidate(db, p.rule._id, { now: T0 });
      if (!t.ok || !t.gate.passed) throw new Error("candidate should pass");
      return p.rule;
    };
    const a = await make();
    const b = await make();
    expect([a.version, b.version].sort()).toEqual([2, 3]);

    const first = await activateRule(db, { candidate_id: a._id, by: "promoter" }, { now: T0 });
    const second = await activateRule(db, { candidate_id: b._id, by: "promoter" }, { now: T0 });
    expect(first.ok && first.status).toBe("active");
    expect(second.ok && second.status).toBe("superseded");
    expect((await collections(db).rules.findOne({ _id: parentId }))?.status).toBe("retired");
    expect(await collections(db).rules.countDocuments({ rule_key: "personal-calls", status: "active" })).toBe(1);
    expect(contracts.calls).toHaveLength(1);
  });

  it("two candidates with the same parent activated concurrently: exactly one wins", async () => {
    const db = await mongo.freshDb();
    provideServices({ contracts: contractsDouble().service });
    await insertExamples(db, "customers", ae2Examples());
    await insertActiveRule(db, {
      challenge_type: "customers",
      rule_key: "personal-calls",
      when: { all: [{ feature: "short_call", op: "eq", value: true }] },
      action: "flag",
      cheat_class: "all_personal_email",
    });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await proposeRule(
        db,
        proposal({ challenge_type: "customers", when: PERSONAL_NO_NOTES_WHEN, action: "flag", cheat_class: "all_personal_email", parent: { rule_key: "personal-calls", version: 1 } }),
        { now: T0 },
      );
      if (!p.ok) throw new Error(p.error.message);
      await testCandidate(db, p.rule._id, { now: T0 });
      ids.push(p.rule._id);
    }
    const results = await Promise.all(ids.map((id) => activateRule(db, { candidate_id: id, by: "promoter" }, { now: T0 })));
    const statuses = results.map((r) => (r.ok ? r.status : r.error.code)).sort();
    expect(statuses).toEqual(["active", "superseded"]);
    expect(await collections(db).rules.countDocuments({ rule_key: "personal-calls", status: "active" })).toBe(1);
  });

  it("a proposal with no parent for an active key becomes a child of the active version", async () => {
    const db = await mongo.freshDb();
    await insertActiveRule(db, { challenge_type: "ship_week", rule_key: "rename-only", when: RENAME_WHEN, action: "flag", cheat_class: "rename_only" });
    const p = await proposeRule(db, proposal({ challenge_type: "ship_week", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only", rule_key: "rename-only" }), { now: T0 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.rule.version).toBe(2);
    expect(p.rule.parent_version).toBe(1);

    const missingParent = await proposeRule(
      db,
      proposal({ challenge_type: "ship_week", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only", parent: { rule_key: "nope", version: 1 } }),
      { now: T0 },
    );
    expect(missingParent.ok).toBe(false);
    const invalid = await proposeRule(db, { challenge_type: "ship_week", when: { all: [] } }, { now: T0 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("invalid_input");
  });

  it("rejecting is idempotent and an active rule cannot be rejected", async () => {
    const db = await mongo.freshDb();
    provideServices({ contracts: contractsDouble().service });
    await insertExamples(db, "ship_week", ae1Examples());
    const { rule } = await passedRenameCandidate(db);
    const r1 = await rejectCandidate(db, { candidate_id: rule._id, by: "promoter" }, { now: T0 });
    const r2 = await rejectCandidate(db, { candidate_id: rule._id, by: "promoter" }, { now: T0 });
    expect(r1.ok && r1.status).toBe("rejected");
    expect(r2.ok && r2.status).toBe("rejected");
    const activeId = await insertActiveRule(db, { challenge_type: "ship_week", rule_key: "other", when: RENAME_WHEN, action: "flag", cheat_class: "rename_only" });
    const r3 = await rejectCandidate(db, { candidate_id: activeId, by: "promoter" }, { now: T0 });
    expect(r3.ok).toBe(false);
  });

  it("rollback restores the parent version and publishes a new contract version", async () => {
    const db = await mongo.freshDb();
    const contracts = contractsDouble();
    provideServices({ contracts: contracts.service });
    await insertExamples(db, "customers", ae2Examples());
    const parentId = await insertActiveRule(db, {
      challenge_type: "customers",
      rule_key: "personal-calls",
      when: { all: [{ feature: "short_call", op: "eq", value: true }] },
      action: "flag",
      cheat_class: "all_personal_email",
    });
    const p = await proposeRule(
      db,
      proposal({ challenge_type: "customers", when: PERSONAL_NO_NOTES_WHEN, action: "ask_more", cheat_class: "all_personal_email", parent: { rule_key: "personal-calls", version: 1 } }),
      { now: T0 },
    );
    if (!p.ok) throw new Error(p.error.message);
    await testCandidate(db, p.rule._id, { now: T0 });
    await activateRule(db, { candidate_id: p.rule._id, by: "promoter" }, { now: T0 });

    const rolled = await rollbackRule(db, { challenge_type: "customers", rule_key: "personal-calls", by: "operator", now: T0 });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.restored).toEqual({ rule_key: "personal-calls", version: 1 });
    expect((await collections(db).rules.findOne({ _id: parentId }))?.status).toBe("active");
    expect((await collections(db).rules.findOne({ _id: p.rule._id }))?.status).toBe("rolled_back");
    expect(contracts.calls.map((c) => c.reason)).toEqual(["rule_activated", "rule_rolled_back"]);

    const none = await rollbackRule(db, { challenge_type: "customers", rule_key: "missing", by: "operator", now: T0 });
    expect(none.ok).toBe(false);
  });

  it("a publish failure is recorded and does not undo the activation", async () => {
    const db = await mongo.freshDb();
    provideServices({ contracts: { publishForType: async () => { throw new Error("contracts down"); } } });
    await insertExamples(db, "customers", ae2Examples());
    const p = await proposeRule(db, proposal({ challenge_type: "customers", when: PERSONAL_NO_NOTES_WHEN, action: "flag", cheat_class: "all_personal_email" }), { now: T0 });
    if (!p.ok) throw new Error(p.error.message);
    await testCandidate(db, p.rule._id, { now: T0 });
    const done = await activateRule(db, { candidate_id: p.rule._id, by: "promoter" }, { now: T0 });
    expect(done.ok && done.status).toBe("active");
    expect(done.ok && done.contracts).toEqual([]);
    expect(await collections(db).events.countDocuments({ kind: "rule.publish_failed" })).toBe(1);
  });
});
