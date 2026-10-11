/**
 * Promoter graph tests (U10). A fake internal API and LangGraph's in-memory checkpointer,
 * no network and no model. Run with: pnpm test (node:test through tsx).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BaseMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";

import { buildPromoterGraph, normalizeReview } from "../src/promoter_agent/behavior.js";
import { freshInput, messageText, type LanePayload } from "../src/promoter_agent/lane.js";
import type { LaneCaller, LaneReply } from "../src/promoter_agent/lane_call.js";

function payload(overrides: Record<string, unknown> = {}): LanePayload {
  return {
    workspace: "promoter",
    prompt: "PROMOTER_PROMPT_FROM_MONGODB",
    output_schema: { type: "object", required: ["decision", "candidate_id", "rule_status", "notes"] },
    input: {
      candidate_id: "rul_7",
      rule_key: "rename-only",
      version: 2,
      challenge_type: "ship_week",
      action: "reject",
      requires_approval: true,
      line: "Rename, whitespace or docs-only commits don't count.",
      gate: { passed: true, target_class: "rename_only", catch_rate_before: 0, catch_rate_after: 0.95, false_alarm_rule: 0, false_alarm_set: 0 },
      no_egress: false,
      ...overrides,
    },
    internal_api: null,
  };
}

/** Fake internal API holding the active set. Activation of an approval action needs an approved record, as U9 does. */
class FakeLane {
  calls: { path: string; body: Record<string, unknown>; callId: string }[] = [];
  active = new Set<string>(["rename-only@1"]);
  status = new Map<string, string>([["rul_7", "pending_approval"]]);
  approved = new Set<string>();
  refuseActivate = false;

  caller: LaneCaller = async (path, body, callId) => {
    this.calls.push({ path, body, callId });
    const id = String(body.candidate_id);
    const ok = (data: Record<string, unknown>): LaneReply => ({ ok: true, status: 200, data: { ok: true, ...data }, error: null });
    if (path.endsWith("/promoter/activate")) {
      if (this.refuseActivate) return { ok: false, status: 409, data: {}, error: "conflict: approval required" };
      this.active.delete("rename-only@1");
      this.active.add(`${id}`);
      this.status.set(id, "active");
      return ok({ candidate_id: id, status: "active", contract_versions: [{ challenge_id: "chl_1", version: 3 }] });
    }
    if (path.endsWith("/promoter/reject")) {
      this.status.set(id, "rejected");
      return ok({ candidate_id: id, status: "rejected" });
    }
    return { ok: false, status: 404, data: {}, error: "not_found" };
  };

  paths(): string[] {
    return this.calls.map((call) => call.path.replace("/api/internal/", ""));
  }
}

function setup(lane: FakeLane, extra: { noEgressEnv?: boolean } = {}) {
  const graph = buildPromoterGraph({ callLane: lane.caller, checkpointer: new MemorySaver(), ...extra });
  const config = { configurable: { thread_id: `t-${Math.random()}` } };
  return { graph, config };
}

function outputOf(state: unknown): Record<string, any> {
  const messages = (state as { messages: BaseMessage[] }).messages;
  return JSON.parse(messageText(messages[messages.length - 1]!)) as Record<string, any>;
}

async function suspend(lane: FakeLane, overrides: Record<string, unknown> = {}, extra: { noEgressEnv?: boolean } = {}) {
  const { graph, config } = setup(lane, extra);
  await graph.invoke({ ...freshInput(payload(overrides)), review: null, result: null } as never, config);
  return { graph, config };
}

describe("promoter", () => {
  it("covers AE1: suspends on a reject rule with the candidate, action, line and allowed decisions", async () => {
    const lane = new FakeLane();
    const { graph, config } = await suspend(lane);
    const snapshot = await graph.getState(config);
    assert.deepEqual(snapshot.next, ["human_review"]);
    const value = snapshot.tasks[0]!.interrupts[0]!.value as { suspend_reason: string; suspend_context: Record<string, unknown> };
    assert.equal(value.suspend_reason, "awaiting_human_review");
    assert.equal(value.suspend_context.candidate_id, "rul_7");
    assert.equal(value.suspend_context.action, "reject");
    assert.equal(value.suspend_context.line, "Rename, whitespace or docs-only commits don't count.");
    assert.deepEqual(value.suspend_context.allowed_decisions, ["approve", "decline"]);
    assert.equal(lane.calls.length, 0, "nothing is called before the human decides");
  });

  it("covers AE1: resuming with approve makes the rule active", async () => {
    const lane = new FakeLane();
    const { graph, config } = await suspend(lane);
    const state = await graph.invoke(new Command({ resume: { decision: "approve", reviewer_notes: "ok" } }), config);
    const output = outputOf(state);
    assert.equal(output.decision, "activated");
    assert.equal(output.candidate_id, "rul_7");
    assert.equal(output.rule_status, "active");
    assert.deepEqual(lane.paths(), ["promoter/activate"]);
    assert.deepEqual(lane.calls[0]!.body, { candidate_id: "rul_7" });
    assert.ok(lane.active.has("rul_7"));
  });

  it("resuming with decline marks the candidate rejected and leaves the active set unchanged", async () => {
    const lane = new FakeLane();
    const { graph, config } = await suspend(lane);
    const state = await graph.invoke(new Command({ resume: { decision: "decline", reviewer_notes: "too broad" } }), config);
    const output = outputOf(state);
    assert.equal(output.decision, "declined");
    assert.equal(output.rule_status, "rejected");
    assert.deepEqual(lane.paths(), ["promoter/reject"]);
    assert.match(String(lane.calls[0]!.body.reason), /too broad/);
    assert.equal(lane.status.get("rul_7"), "rejected");
    assert.deepEqual([...lane.active], ["rename-only@1"]);
  });

  it("anything other than an explicit approve is a decline", async () => {
    for (const resume of ["yes", "maybe", { decision: "approved" }, { decision: "Approve " }, {}, { decision: 42 }]) {
      const lane = new FakeLane();
      const { graph, config } = await suspend(lane);
      const output = outputOf(await graph.invoke(new Command({ resume }), config));
      const expected = isApprove(resume) ? "activated" : "declined";
      assert.equal(output.decision, expected, `resume ${JSON.stringify(resume)}`);
      if (expected === "declined") assert.ok(!lane.paths().includes("promoter/activate"));
    }
    assert.equal(normalizeReview({ resume_map: { a: { decision: "approve" } } }).decision, "approve");
    assert.equal(normalizeReview({ human_review: { decision: "decline" } }).decision, "decline");
  });

  it("activates an ask_more candidate without suspending", async () => {
    const lane = new FakeLane();
    const { graph, config } = setup(lane);
    const state = await graph.invoke(
      { ...freshInput(payload({ action: "ask_more", requires_approval: false })), review: null, result: null } as never,
      config,
    );
    assert.deepEqual((await graph.getState(config)).next, []);
    assert.equal(outputOf(state).decision, "activated");
    assert.deepEqual(lane.paths(), ["promoter/activate"]);
  });

  it("activates a flag candidate without suspending", async () => {
    const lane = new FakeLane();
    const { graph, config } = setup(lane);
    const state = await graph.invoke(
      { ...freshInput(payload({ action: "flag", requires_approval: false })), review: null, result: null } as never,
      config,
    );
    assert.equal(outputOf(state).decision, "activated");
  });

  it("suspends a hold_payout candidate even when the core forgot requires_approval", async () => {
    const lane = new FakeLane();
    const { graph, config } = await suspend(lane, { action: "hold_payout", requires_approval: false });
    assert.deepEqual((await graph.getState(config)).next, ["human_review"]);
    assert.equal(lane.calls.length, 0);
  });

  it("rejects a candidate whose gate did not pass, without asking a human", async () => {
    const lane = new FakeLane();
    const { graph, config } = setup(lane);
    const state = await graph.invoke(
      {
        ...freshInput(payload({ gate: { passed: false, target_class: "rename_only", catch_rate_before: 0, catch_rate_after: 0, false_alarm_rule: 0.03, false_alarm_set: 0.03 } })),
        review: null,
        result: null,
      } as never,
      config,
    );
    assert.equal(outputOf(state).decision, "rejected");
    assert.deepEqual(lane.paths(), ["promoter/reject"]);
  });

  it("never reports an activation Lane refused", async () => {
    const lane = new FakeLane();
    lane.refuseActivate = true;
    const { graph, config } = await suspend(lane);
    await assert.rejects(graph.invoke(new Command({ resume: { decision: "approve" } }), config), /refused to activate/);
  });

  it("no-egress mode returns the approved decision without calling Lane", async () => {
    const lane = new FakeLane();
    const { graph, config } = await suspend(lane, { no_egress: true });
    const output = outputOf(await graph.invoke(new Command({ resume: { decision: "approve" } }), config));
    assert.equal(output.decision, "activated");
    assert.equal(output.candidate_id, "rul_7");
    assert.equal(output.rule_status, null);
    assert.equal(lane.calls.length, 0);
  });

  it("no-egress mode returns a decline without calling Lane, also when forced by LANE_AGENT_NO_EGRESS", async () => {
    const lane = new FakeLane();
    const { graph, config } = await suspend(lane, {}, { noEgressEnv: true });
    const output = outputOf(await graph.invoke(new Command({ resume: { decision: "decline" } }), config));
    assert.equal(output.decision, "declined");
    assert.equal(lane.calls.length, 0);
  });
});

function isApprove(resume: unknown): boolean {
  const raw = typeof resume === "string" ? resume : resume && typeof resume === "object" ? String((resume as { decision?: unknown }).decision ?? "") : "";
  return raw.trim().toLowerCase() === "approve";
}
