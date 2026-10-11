import type { ChallengeType, HandlePlatform, RuleRef } from "./common";
import type { Approval } from "./approvals";
import type { Challenge, ClockSettings, Share } from "./challenges";
import type { Contract } from "./contracts";
import type { Dispute } from "./disputes";
import type { LaneEvent } from "./events";
import type { Example } from "./examples";
import type { InboxItem } from "./inbox";
import type { Job } from "./jobs";
import type { LedgerEntry } from "./ledger";
import type { Membership } from "./memberships";
import type { OpsLease } from "./ops";
import type { Player } from "./players";
import type { Proof, Verdict } from "./proofs";
import type { Cond, When } from "./rule";
import type { Rule } from "./rules";
import type { Settings } from "./settings";

/**
 * Public projections, one per collection (KTD15). Dashboard JSON routes return only these.
 * They exclude join codes, key hashes, routine text, inbox items, attendee domains and note text.
 * For Talk to Customers proofs they show the cheat class and rule id instead of AI reason text.
 * Proof payloads and features are never projected; the feed summary comes from the pack.
 */

export interface PublicPlayer {
  id: string;
  display_name: string;
  credits: number;
  verified_platforms: HandlePlatform[];
  scripted: boolean;
}

export function projectPlayer(p: Player): PublicPlayer {
  const verified = Object.values(p.handles)
    .filter((h) => h && h.status === "verified")
    .map((h) => h!.platform);
  return { id: p._id, display_name: p.display_name, credits: p.credits, verified_platforms: verified, scripted: p.scripted };
}

export interface PublicSettlement {
  snapshot_id: string;
  computed_at: Date;
  pot: number;
  shares: Share[];
  refunds: Share[];
  refund_all: boolean;
  needs_approval: boolean;
  approval_reasons: string[];
}

export interface PublicChallenge {
  id: string;
  type: ChallengeType;
  status: Challenge["status"];
  title: string;
  creator_id: string;
  stake: number | null;
  winner_rule: Challenge["winner_rule"];
  goal: number | null;
  clock: ClockSettings | null;
  contract_version: number;
  settlement: PublicSettlement | null;
  stage: boolean;
  created_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
}

export function projectChallenge(c: Challenge): PublicChallenge {
  const s = c.settlement;
  return {
    id: c._id,
    type: c.type,
    status: c.status,
    title: c.title,
    creator_id: c.creator_id,
    stake: c.stake,
    winner_rule: c.winner_rule,
    goal: c.goal,
    clock: c.clock,
    contract_version: c.contract_version,
    settlement: s
      ? {
          snapshot_id: s.snapshot_id,
          computed_at: s.computed_at,
          pot: s.pot,
          shares: s.shares,
          refunds: s.refunds,
          refund_all: s.refund_all,
          needs_approval: s.needs_approval,
          approval_reasons: s.approval_reasons,
        }
      : null,
    stage: c.stage,
    created_at: c.created_at,
    activated_at: c.activated_at,
    closed_at: c.closed_at,
  };
}

export type PublicContract = Omit<Contract, "_id"> & { id: string };

export function projectContract(c: Contract): PublicContract {
  const { _id, ...rest } = c;
  return { id: _id, ...rest };
}

export interface PublicMembership {
  challenge_id: string;
  player_id: string;
  joined_at: Date;
  joined_day_index: number;
  last_check_in_at: Date | null;
  last_seen_contract_version: number;
}

export function projectMembership(m: Membership): PublicMembership {
  return {
    challenge_id: m.challenge_id,
    player_id: m.player_id,
    joined_at: m.joined_at,
    joined_day_index: m.joined_day_index,
    last_check_in_at: m.last_check_in_at,
    last_seen_contract_version: m.last_seen_contract_version,
  };
}

export interface PublicVerdict {
  outcome: Verdict["outcome"];
  decided_by: Verdict["decided_by"];
  rule: RuleRef | null;
  matched_rules: Verdict["matched_rules"];
  evaluated_rules: RuleRef[];
  contract_version: number;
  ai_calls: number;
  ai_judgment: boolean;
  latency_ms: number;
  trust_level: Verdict["trust_level"];
  payout_hold: boolean;
  /** Null for Talk to Customers proofs (KTD15). */
  reason: string | null;
  /** Null for Talk to Customers proofs (KTD15). */
  fix: string | null;
  cheat_class: string | null;
  decided_at: Date;
}

export interface PublicProof {
  id: string;
  challenge_id: string;
  player_id: string;
  challenge_type: ChallengeType;
  day_index: number | null;
  status: Proof["status"];
  held_reason: Proof["held_reason"];
  not_counted_reason: Proof["not_counted_reason"];
  /** Lane-built summary from pack features, for example "commit, 3 files, +42/-5". */
  summary: string | null;
  verdict: PublicVerdict | null;
  received_at: Date;
  updated_at: Date;
}

/** Types whose proofs carry third-party data; reason text is replaced by cheat class and rule id. */
export const REDACTED_REASON_TYPES: readonly ChallengeType[] = ["customers"];

export function projectVerdict(v: Verdict, type: ChallengeType): PublicVerdict {
  const redact = REDACTED_REASON_TYPES.includes(type);
  return {
    outcome: v.outcome,
    decided_by: v.decided_by,
    rule: v.rule,
    matched_rules: v.matched_rules,
    evaluated_rules: v.evaluated_rules,
    contract_version: v.contract_version,
    ai_calls: v.ai_calls,
    ai_judgment: v.ai_judgment,
    latency_ms: v.latency_ms,
    trust_level: v.trust_level,
    payout_hold: v.payout_hold,
    reason: redact ? null : v.reason,
    fix: redact ? null : v.fix,
    cheat_class: v.cheat_class,
    decided_at: v.decided_at,
  };
}

export function projectProof(p: Proof, opts: { summary?: string | null } = {}): PublicProof {
  return {
    id: p._id,
    challenge_id: p.challenge_id,
    player_id: p.player_id,
    challenge_type: p.challenge_type,
    day_index: p.day_index,
    status: p.status,
    held_reason: p.held_reason,
    not_counted_reason: p.not_counted_reason,
    summary: opts.summary ?? null,
    verdict: p.verdict ? projectVerdict(p.verdict, p.challenge_type) : null,
    received_at: p.received_at,
    updated_at: p.updated_at,
  };
}

/** Inbox items are never projected (KTD15). Dashboard routes must not return them. */
export function projectInboxItem(_item: InboxItem): null {
  return null;
}

/** String and list parameter values are omitted from public rules (KTD15). */
export function redactWhen(when: When): When {
  const redact = (c: Cond): Cond =>
    typeof c.value === "string" || Array.isArray(c.value) ? { ...c, value: "(text)" } : c;
  return "all" in when ? { all: when.all.map(redact) } : { any: when.any.map(redact) };
}

export interface PublicRule {
  id: string;
  rule_key: string;
  version: number;
  parent_version: number | null;
  challenge_type: ChallengeType;
  when: When;
  action: Rule["action"];
  cheat_class: string | null;
  source: Rule["source"];
  status: Rule["status"];
  /** "Does not count" line rendered by the pack template, when the caller supplies it. */
  line: string | null;
  test_results: Rule["test_results"];
  evidence_count: number;
  approval_id: string | null;
  created_at: Date;
  activated_at: Date | null;
  retired_at: Date | null;
}

export function projectRule(r: Rule, opts: { line?: string | null } = {}): PublicRule {
  return {
    id: r._id,
    rule_key: r.rule_key,
    version: r.version,
    parent_version: r.parent_version,
    challenge_type: r.challenge_type,
    when: redactWhen(r.when),
    action: r.action,
    cheat_class: r.cheat_class,
    source: r.source,
    status: r.status,
    line: opts.line ?? null,
    test_results: r.test_results,
    evidence_count: r.evidence.proof_ids.length + r.evidence.example_keys.length + r.evidence.dispute_ids.length,
    approval_id: r.approval_id,
    created_at: r.created_at,
    activated_at: r.activated_at,
    retired_at: r.retired_at,
  };
}

export interface PublicExample {
  challenge_type: ChallengeType;
  example_key: string;
  label: Example["label"];
  cheat_class: string | null;
  source: Example["source"];
  summary: string | null;
}

export function projectExample(e: Example): PublicExample {
  return {
    challenge_type: e.challenge_type,
    example_key: e.example_key,
    label: e.label,
    cheat_class: e.cheat_class,
    source: e.source,
    summary: e.challenge_type === "customers" ? null : e.summary,
  };
}

/** Dispute reasons are never projected or forwarded (KTD15). */
export interface PublicDispute {
  id: string;
  challenge_id: string;
  proof_id: string;
  disputer_id: string;
  disputed_player_id: string;
  outcome: Dispute["outcome"];
  created_at: Date;
  decided_at: Date | null;
}

export function projectDispute(d: Dispute): PublicDispute {
  return {
    id: d._id,
    challenge_id: d.challenge_id,
    proof_id: d.proof_id,
    disputer_id: d.disputer_id,
    disputed_player_id: d.disputed_player_id,
    outcome: d.outcome,
    created_at: d.created_at,
    decided_at: d.decided_at,
  };
}

interface PublicApprovalBase {
  id: string;
  status: Approval["status"];
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  follow_up: Approval["follow_up"];
}

export type PublicApproval =
  | (PublicApprovalBase & {
      kind: "rule";
      rule_id: string;
      rule_key: string;
      rule_version: number;
      challenge_type: ChallengeType;
      action: Rule["action"];
      rule_status: Rule["status"] | null;
      /** Rule line rendered by the pack template, when the caller supplies it. */
      line: string | null;
    })
  | (PublicApprovalBase & {
      kind: "payout";
      challenge_id: string;
      snapshot_id: string;
      pot: number;
      winner_rule: Challenge["winner_rule"];
      shares: Share[];
      refunds: Share[];
      approval_reasons: string[];
    });

export function projectApproval(a: Approval, opts: { line?: string | null } = {}): PublicApproval {
  const base: PublicApprovalBase = {
    id: a._id,
    status: a.status,
    decided_by: a.decided_by,
    decided_at: a.decided_at,
    created_at: a.created_at,
    follow_up: a.follow_up,
  };
  if (a.kind === "rule") {
    return {
      ...base,
      kind: "rule",
      rule_id: a.rule_id,
      rule_key: a.rule_key,
      rule_version: a.rule_version,
      challenge_type: a.challenge_type,
      action: a.action,
      rule_status: a.rule_status,
      line: opts.line ?? null,
    };
  }
  return {
    ...base,
    kind: "payout",
    challenge_id: a.challenge_id,
    snapshot_id: a.snapshot_id,
    pot: a.snapshot.pot,
    winner_rule: a.snapshot.winner_rule,
    shares: a.snapshot.shares,
    refunds: a.snapshot.refunds,
    approval_reasons: a.snapshot.approval_reasons,
  };
}

export interface PublicLedgerEntry {
  id: string;
  player_id: string;
  challenge_id: string | null;
  kind: LedgerEntry["kind"];
  amount: number;
  delta: number;
  created_at: Date;
}

export function projectLedgerEntry(e: LedgerEntry): PublicLedgerEntry {
  return {
    id: e._id,
    player_id: e.player_id,
    challenge_id: e.challenge_id,
    kind: e.kind,
    amount: e.amount,
    delta: e.delta,
    created_at: e.created_at,
  };
}

export interface PublicJob {
  id: string;
  kind: Job["kind"];
  status: Job["status"];
  attempt: number;
  due_at: Date;
  finished_at: Date | null;
  failed: boolean;
}

export function projectJob(j: Job): PublicJob {
  return {
    id: j._id,
    kind: j.kind,
    status: j.status,
    attempt: j.attempt,
    due_at: j.due_at,
    finished_at: j.finished_at,
    failed: j.status === "failed",
  };
}

export type PublicSettings = Omit<Settings, "_id">;

export function projectSettings(s: Settings): PublicSettings {
  const { _id, ...rest } = s;
  return rest;
}

/** The tick lease is internal. */
export function projectOpsLease(_lease: OpsLease): null {
  return null;
}

export type PublicEvent = Omit<LaneEvent, "_id"> & { id: string };

export function projectEvent(e: LaneEvent): PublicEvent {
  const { _id, ...rest } = e;
  return { id: _id, ...rest };
}
