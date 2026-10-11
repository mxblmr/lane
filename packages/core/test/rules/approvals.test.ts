import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import { collections } from "../../src/schema/collections";
import { provideServices, resetServices, type AgentResumeInput, type PayInput } from "../../src/interfaces";
import { markPendingApproval, proposeRule, testCandidate } from "../../src/rules/lifecycle";
import { createApproval, decideApproval, payoutApprovalId, ruleApprovalId } from "../../src/rules/approvals";
import type { SettlementSnapshot } from "../../src/schema/challenges";
import {
  ae1Examples,
  agentsDouble,
  completed,
  contractsDouble,
  insertExamples,
  promoterOutput,
  proposal,
  RENAME_WHEN,
  T0,
  type AgentScript,
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
  delete process.env.AGENT_ENGINE_MODE;
});

/** A reject candidate that passed the gate and waits for approval, as the learning chain leaves it. */
async function pendingRule(db: Db): Promise<{ ruleId: string; approvalId: string }> {
  await insertExamples(db, "ship_week", ae1Examples());
  const p = await proposeRule(db, proposal({ challenge_type: "ship_week", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" }), { now: T0 });
  if (!p.ok) throw new Error(p.error.message);
  const t = await testCandidate(db, p.rule._id, { now: T0 });
  if (!t.ok || !t.gate.passed) throw new Error("candidate should pass");
  const { approval, created } = await createApproval(
    db,
    {
      kind: "rule",
      rule_id: p.rule._id,
      rule_key: p.rule.rule_key,
      rule_version: p.rule.version,
      challenge_type: "ship_week",
      action: "reject",
      execution_id: "exec_suspended",
      workspace_id: "ws_promoter",
      suspend_context: { candidate_id: p.rule._id },
      allowed_decisions: ["approve", "decline"],
    },
    { now: T0 },
  );
  expect(created).toBe(true);
  await markPendingApproval(db, p.rule._id, approval._id, T0);
  return { ruleId: p.rule._id, approvalId: approval._id };
}

/** Promoter resume that behaves like the deployed agent with egress off: returns its decision. */
function resumingPromoter(ruleId: string, opts: { onApprove?: "activated" | "rejected" } = {}): AgentScript["resume"] {
  return async (input: AgentResumeInput) => {
    await new Promise((r) => setTimeout(r, 20));
    return completed(promoterOutput(ruleId, input.decision === "approve" ? (opts.onApprove ?? "activated") : "declined"), input.execution_id);
  };
}

function setup(db: Db, script: AgentScript) {
  const agents = agentsDouble(script);
  const contracts = contractsDouble();
  provideServices({ agents: agents.service, contracts: contracts.service });
  return { agents, contracts };
}

describe("approvals (R22, R28, KTD10, KTD12)", () => {
  it("creating the same rule approval twice returns the existing record", async () => {
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    expect(approvalId).toBe(ruleApprovalId(ruleId));
    const rule = await collections(db).rules.findOne({ _id: ruleId });
    expect(rule?.status).toBe("pending_approval");
    const again = await createApproval(db, {
      kind: "rule",
      rule_id: ruleId,
      rule_key: "learned-rename-only",
      rule_version: 1,
      challenge_type: "ship_week",
      action: "reject",
      execution_id: "exec_other",
      workspace_id: "ws_promoter",
      suspend_context: {},
      allowed_decisions: ["approve", "decline"],
    });
    expect(again.created).toBe(false);
    expect(again.approval.kind === "rule" && again.approval.execution_id).toBe("exec_suspended");
    expect(await collections(db).approvals.countDocuments()).toBe(1);
  });

  it("approve fired twice concurrently gives one decision and one resume call, and the rule goes active", async () => {
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    const { agents, contracts } = setup(db, { resume: resumingPromoter(ruleId) });
    const results = await Promise.all([
      decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 }),
      decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && r.decided)).toHaveLength(1);
    expect(agents.resumes).toHaveLength(1);
    expect(agents.resumes[0]).toMatchObject({ workspace: "promoter", execution_id: "exec_suspended", decision: "approve" });
    const winner = results.find((r) => r.ok && r.decided);
    expect(winner?.ok && winner.rule_status).toBe("active");
    expect(winner?.ok && winner.follow_up.status).toBe("ok");
    expect((await collections(db).rules.findOne({ _id: ruleId }))?.status).toBe("active");
    expect(contracts.calls).toHaveLength(1);
  });

  it("approve and decline fired concurrently give one decision and one resume call", async () => {
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    const { agents } = setup(db, { resume: resumingPromoter(ruleId) });
    const results = await Promise.all([
      decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 }),
      decideApproval(db, { approval_id: approvalId, decision: "decline", decided_by: "presenter", now: T0 }),
    ]);
    const decided = results.filter((r) => r.ok && r.decided);
    expect(decided).toHaveLength(1);
    expect(agents.resumes).toHaveLength(1);
    const approval = await collections(db).approvals.findOne({ _id: approvalId });
    const rule = await collections(db).rules.findOne({ _id: ruleId });
    if (approval?.status === "approved") {
      expect(agents.resumes[0]?.decision).toBe("approve");
      expect(rule?.status).toBe("active");
    } else {
      expect(approval?.status).toBe("declined");
      expect(agents.resumes[0]?.decision).toBe("decline");
      expect(rule?.status).toBe("rejected");
    }
  });

  it("no-egress: an approved decision returned by the promoter activates the rule", async () => {
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    setup(db, { resume: resumingPromoter(ruleId) });
    const res = await decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 });
    expect(res.ok && res.rule_status).toBe("active");
    const rule = await collections(db).rules.findOne({ _id: ruleId });
    expect(rule?.status).toBe("active");
    expect(rule?.approval_id).toBe(approvalId);
    const approval = await collections(db).approvals.findOne({ _id: approvalId });
    expect(approval?.kind === "rule" && approval.rule_status).toBe("active");
  });

  it("no-egress: an unapproved decision returned by the promoter does not activate the rule", async () => {
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    // A misbehaving promoter answers "activated" to a human decline.
    const { agents, contracts } = setup(db, {
      resume: async (input) => completed(promoterOutput(ruleId, "activated"), input.execution_id),
    });
    const res = await decideApproval(db, { approval_id: approvalId, decision: "decline", decided_by: "presenter", now: T0 });
    expect(agents.resumes).toHaveLength(1);
    expect(res.ok && res.rule_status).toBe("rejected");
    expect(res.ok && res.follow_up.status).toBe("failed");
    expect((await collections(db).rules.findOne({ _id: ruleId }))?.status).toBe("rejected");
    expect(contracts.calls).toHaveLength(0);
  });

  it("a failed resume is recorded and the same decision can be retried", async () => {
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    let attempts = 0;
    const { agents } = setup(db, {
      resume: async (input) => {
        attempts += 1;
        if (attempts === 1) return { ok: false, error: "agent engine unavailable", schema_valid: true, timed_out: false, execution_id: input.execution_id, latency_ms: 1 };
        return completed(promoterOutput(ruleId, "activated"), input.execution_id);
      },
    });
    const first = await decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 });
    expect(first.ok && first.decided).toBe(true);
    expect(first.ok && first.follow_up).toMatchObject({ status: "failed", attempts: 1 });
    expect(first.ok && first.follow_up.error).toContain("agent engine unavailable");
    expect((await collections(db).rules.findOne({ _id: ruleId }))?.status).toBe("pending_approval");
    expect(await collections(db).events.countDocuments({ kind: "approval.follow_up_failed" })).toBe(1);

    // The opposite decision cannot change a recorded decision.
    const flip = await decideApproval(db, { approval_id: approvalId, decision: "decline", decided_by: "presenter", now: T0 });
    expect(flip.ok && flip.decided).toBe(false);
    expect(agents.resumes).toHaveLength(1);

    const retry = await decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 });
    expect(retry.ok && retry.decided).toBe(false);
    expect(retry.ok && retry.follow_up).toMatchObject({ status: "ok", attempts: 2, error: null });
    expect(retry.ok && retry.rule_status).toBe("active");
    expect(agents.resumes).toHaveLength(2);

    // Once the follow-up succeeded, deciding again does nothing.
    await decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 });
    expect(agents.resumes).toHaveLength(2);
  });

  it("a promoter that suspends again is recorded as a failed follow-up", async () => {
    const db = await mongo.freshDb();
    const { approvalId } = await pendingRule(db);
    setup(db, {
      resume: async (input) => ({
        ok: true,
        status: "suspended",
        execution_id: input.execution_id,
        workspace_id: "ws",
        interrupt: { candidate_id: "rul_x", action: "reject", line: "x", allowed_decisions: ["approve", "decline"] },
        latency_ms: 1,
      }),
    });
    const res = await decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 });
    expect(res.ok && res.follow_up.status).toBe("failed");
    expect(res.ok && res.rule_status).toBe("pending_approval");
  });

  it("local-agent fallback: the decision is applied directly without a resume", async () => {
    process.env.AGENT_ENGINE_MODE = "local";
    const db = await mongo.freshDb();
    const { ruleId, approvalId } = await pendingRule(db);
    const { agents } = setup(db, {});
    const res = await decideApproval(db, { approval_id: approvalId, decision: "approve", decided_by: "presenter", now: T0 });
    expect(res.ok && res.rule_status).toBe("active");
    expect(agents.resumes).toHaveLength(0);
    expect((await collections(db).rules.findOne({ _id: ruleId }))?.status).toBe("active");
  });

  it("a payout approval's follow-up calls the settlement pay step once", async () => {
    const db = await mongo.freshDb();
    const pays: PayInput[] = [];
    provideServices({
      settlement: {
        pay: async (_db, input) => {
          pays.push(input);
          return { ok: true, status: "paid", entries: [] };
        },
      },
    });
    const snapshot: SettlementSnapshot = {
      snapshot_id: "snp_1",
      computed_at: T0,
      winner_rule: "finishers_split",
      unit: "days",
      goal: 5,
      pot: 300,
      scores: [],
      shares: [],
      refunds: [],
      refund_all: false,
      needs_approval: true,
      approval_reasons: ["over_limit"],
      approval_id: null,
      orchestrator: "agreed",
    };
    const { approval } = await createApproval(db, { kind: "payout", challenge_id: "chl_1", snapshot_id: "snp_1", snapshot }, { now: T0 });
    expect(approval._id).toBe(payoutApprovalId("snp_1"));
    const results = await Promise.all([
      decideApproval(db, { approval_id: approval._id, decision: "approve", decided_by: "presenter", now: T0 }),
      decideApproval(db, { approval_id: approval._id, decision: "approve", decided_by: "presenter", now: T0 }),
    ]);
    expect(results.filter((r) => r.ok && r.decided)).toHaveLength(1);
    expect(pays).toEqual([{ challenge_id: "chl_1", snapshot_id: "snp_1", decision: "approve", now: T0 }]);
    expect((await collections(db).approvals.findOne({ _id: approval._id }))?.follow_up.status).toBe("ok");
  });

  it("deciding an unknown approval returns not_found", async () => {
    const db = await mongo.freshDb();
    const res = await decideApproval(db, { approval_id: "apr_missing", decision: "approve", decided_by: "presenter" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("not_found");
  });
});
