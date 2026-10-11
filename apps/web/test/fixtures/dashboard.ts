import type { Db } from "mongodb";
import { demoClockSettings } from "@lane/core/clock";
import { DEFAULT_SETTINGS } from "@lane/core/config";
import {
  ChallengeSchema,
  InboxItemSchema,
  LedgerEntrySchema,
  MembershipSchema,
  PayoutApprovalSchema,
  PlayerSchema,
  ProofSchema,
  RuleApprovalSchema,
  RuleSchema,
  collections,
  newId,
  type Approval,
  type Challenge,
  type ChallengeType,
  type GateResult,
  type InboxItem,
  type Membership,
  type PayoutApproval,
  type Player,
  type Proof,
  type Rule,
  type RuleApproval,
  type Verdict,
} from "@lane/core/schema";
import type { DecideApprovalInput, DecideApprovalResult } from "@lane/core/interfaces";
import { opsToken, OPS_COOKIE } from "../../lib/auth-ops";

/** Builders for valid documents. Every builder parses with the U3 schema so fixtures stay honest. */

export const PASSCODE = "test-passcode-6f1c2a9b8e7d4c3a";

export function opsCookie(passcode: string = PASSCODE): string {
  return `${OPS_COOKIE}=${opsToken(passcode)}`;
}

export function postJson(path: string, body: unknown, cookie: string | null = opsCookie()): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

export function getReq(path: string): Request {
  return new Request(`http://localhost${path}`);
}

const T0 = new Date("2026-10-11T19:00:00.000Z");

export function at(offsetSec: number): Date {
  return new Date(T0.getTime() + offsetSec * 1000);
}

export function player(over: Partial<Player> = {}): Player {
  return PlayerSchema.parse({
    _id: newId("player"),
    display_name: "Sam",
    time_zone: "America/Los_Angeles",
    key_hash: "a".repeat(64),
    routine_text: "Every 27 minutes call lane_check_in.",
    handles: {},
    credits: 900,
    scripted: true,
    created_at: T0,
    updated_at: T0,
    ...over,
  });
}

export function challenge(over: Partial<Challenge> = {}): Challenge {
  return ChallengeSchema.parse({
    _id: newId("challenge"),
    type: "ship_week",
    status: "active",
    title: "Ship Week stage",
    creator_id: "plr_creator",
    join_code: "QZXJ42",
    stake: 100,
    winner_rule: "top_score",
    goal: 5,
    params: {},
    draft: null,
    clock: demoClockSettings(T0, { days: 7, day_length_sec: 300, grace_sec: 90 }),
    contract_version: 1,
    settlement: null,
    stage: true,
    created_at: T0,
    updated_at: T0,
    activated_at: T0,
    closed_at: null,
    ...over,
  });
}

export function membership(c: Challenge, p: Player, over: Partial<Membership> = {}): Membership {
  return MembershipSchema.parse({
    _id: newId("membership"),
    challenge_id: c._id,
    player_id: p._id,
    accepted_terms_version: "terms-1",
    handle_platform: c.type === "customers" ? null : "github",
    joined_at: T0,
    joined_day_index: 0,
    last_check_in_at: null,
    last_seen_contract_version: 1,
    ...over,
  });
}

export function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    outcome: "reject",
    decided_by: "ai",
    rule: null,
    matched_rules: [],
    evaluated_rules: [],
    contract_version: 1,
    ai_calls: 1,
    ai_judgment: true,
    latency_ms: 1200,
    trust_level: "rechecked",
    payout_hold: false,
    reason: "The commit only renames a variable, which the contract says does not count.",
    fix: "Send a commit that changes behavior.",
    cheat_class: "rename_only",
    confidence: 0.9,
    push_event_time: null,
    decided_at: at(30),
    ...over,
  };
}

export function proof(c: Challenge, p: Player, over: Partial<Proof> = {}): Proof {
  return ProofSchema.parse({
    _id: newId("proof"),
    challenge_id: c._id,
    player_id: p._id,
    challenge_type: c.type,
    source_key: "f".repeat(40),
    claimed: true,
    payload: { repo: "sam/sandbox", sha: "f".repeat(40) },
    features: { rename_only: true, code_lines_changed: 2, files_changed: 1 },
    source_time: at(10),
    day_index: 0,
    status: "rejected",
    held_reason: null,
    not_counted_reason: null,
    verdict: verdict(),
    answers_request_id: null,
    history: [],
    received_at: at(20),
    updated_at: at(30),
    ...over,
  });
}

export function gate(over: Partial<GateResult> = {}): GateResult {
  return {
    passed: true,
    target_class: "rename_only",
    catch_rate_before: 0,
    catch_rate_after: 0.95,
    per_class_before: { rename_only: 0 },
    per_class_after: { rename_only: 0.95 },
    false_alarm_rule: 0,
    false_alarm_set: 0,
    bound_violations: [],
    honest_count: 40,
    cheat_count: 20,
    thresholds: DEFAULT_SETTINGS.gate,
    reasons: [],
    tested_at: at(60),
    ...over,
  };
}

export function rule(over: Partial<Rule> = {}): Rule {
  return RuleSchema.parse({
    _id: newId("rule"),
    rule_key: "no-rename-only",
    version: 1,
    parent_version: null,
    challenge_type: "ship_week" as ChallengeType,
    when: { all: [{ feature: "rename_only", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "rename_only",
    reason: "Rule-writer reason text that must never be shown.",
    source: "ai_judgment",
    evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
    status: "pending_approval",
    test_results: gate(),
    approval_id: null,
    created_at: at(50),
    updated_at: at(60),
    activated_at: null,
    retired_at: null,
    ...over,
  });
}

export function ruleApproval(r: Rule, over: Partial<RuleApproval> = {}): RuleApproval {
  return RuleApprovalSchema.parse({
    _id: newId("approval"),
    kind: "rule",
    status: "pending",
    decided_by: null,
    decided_at: null,
    created_at: at(70),
    updated_at: at(70),
    rule_id: r._id,
    rule_key: r.rule_key,
    rule_version: r.version,
    challenge_type: r.challenge_type,
    action: r.action,
    execution_id: "exec_promoter_1",
    workspace_id: "ws_promoter",
    suspend_context: { note: "suspend context is internal" },
    allowed_decisions: ["approve", "decline"],
    follow_up: { status: "not_started", attempts: 0, error: null },
    rule_status: null,
    ...over,
  });
}

export function payoutApproval(c: Challenge, shares: { player_id: string; amount: number }[], over: Partial<PayoutApproval> = {}): PayoutApproval {
  const snapshotId = newId("snapshot");
  return PayoutApprovalSchema.parse({
    _id: newId("approval"),
    kind: "payout",
    status: "pending",
    decided_by: null,
    decided_at: null,
    created_at: at(400),
    updated_at: at(400),
    challenge_id: c._id,
    snapshot_id: snapshotId,
    snapshot: {
      snapshot_id: snapshotId,
      computed_at: at(400),
      winner_rule: "top_score",
      unit: "days",
      goal: 5,
      pot: shares.reduce((n, s) => n + s.amount, 0),
      scores: shares.map((s) => ({ player_id: s.player_id, score: 5, reached_goal: true, final_counted_at: at(300) })),
      shares,
      refunds: [],
      refund_all: false,
      needs_approval: true,
      approval_reasons: ["over_limit"],
      approval_id: null,
      orchestrator: "agreed",
    },
    follow_up: { status: "not_started", attempts: 0, error: null },
    ...over,
  });
}

export function inboxItem(c: Challenge, p: Player, over: Partial<InboxItem> = {}): InboxItem {
  return InboxItemSchema.parse({
    _id: newId("inbox"),
    player_id: p._id,
    challenge_id: c._id,
    kind: "extra_proof",
    actor: "player",
    instruction: "Put the code 7Q2K in your next commit message.",
    answer_tool: "lane_submit_proof",
    answer_args: {},
    day_index: 0,
    subject_proof_id: null,
    slot: null,
    code: "7Q2K",
    release_at: null,
    due_at: at(600),
    status: "open",
    notify_player_ids: [],
    answer_proof_id: null,
    created_at: at(40),
    updated_at: at(40),
    resolved_at: null,
    delivered_at: null,
    ...over,
  });
}

export async function stakeEntry(db: Db, c: Challenge, p: Player, amount: number): Promise<void> {
  await collections(db).ledger.insertOne(
    LedgerEntrySchema.parse({
      _id: newId("ledger"),
      player_id: p._id,
      challenge_id: c._id,
      kind: "stake",
      amount,
      delta: -amount,
      balance_after: 900,
      ref: null,
      created_at: T0,
    }),
  );
}

/**
 * A U9-like approvals double: one conditional update from pending (or a retry of a failed
 * follow-up), then the follow-up. Counts calls so tests can assert "once".
 */
export function approvalsDouble(
  db: Db,
  opts: { followUp?: (approval: Approval) => Promise<"ok" | "failed">; delayMs?: number } = {},
) {
  const calls: DecideApprovalInput[] = [];
  const decide = async (_db: Db, input: DecideApprovalInput): Promise<DecideApprovalResult> => {
    calls.push(input);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 25));
    const col = collections(db).approvals;
    const status = input.decision === "approve" ? "approved" : "declined";
    const decided = await col.findOneAndUpdate(
      { _id: input.approval_id, $or: [{ status: "pending" }, { status, "follow_up.status": "failed" }] },
      { $set: { status, decided_by: input.decided_by, decided_at: input.now ?? new Date(), "follow_up.status": "running" } },
      { returnDocument: "after" },
    );
    if (!decided) {
      const current = (await col.findOne({ _id: input.approval_id }))!;
      return { ok: true, approval: current, decided: false, follow_up: current.follow_up, rule_status: null };
    }
    const outcome = opts.followUp ? await opts.followUp(decided) : "ok";
    const ruleStatus = decided.kind === "rule" && outcome === "ok" && status === "approved" ? "active" : null;
    const set: Record<string, unknown> = {
      "follow_up.status": outcome,
      "follow_up.error": outcome === "ok" ? null : "promoter resume timed out",
    };
    if (decided.kind === "rule") set.rule_status = ruleStatus;
    const after = (await col.findOneAndUpdate(
      { _id: decided._id },
      { $set: set, $inc: { "follow_up.attempts": 1 } },
      { returnDocument: "after" },
    ))!;
    return { ok: true, approval: after, decided: true, follow_up: after.follow_up, rule_status: ruleStatus };
  };
  return { calls, decide };
}
