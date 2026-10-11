// Shared data and test doubles for the U9 tests (gate, lifecycle, learning, approvals, internal API).
// The packs are still U3 stubs with no seed examples, so tests insert their own labelled examples.

import type { Db } from "mongodb";
import { newId, type ChallengeType, type Features, type Id } from "../../src/schema/common";
import { collections } from "../../src/schema/collections";
import type { Example, ExampleSource } from "../../src/schema/examples";
import type { RuleAction, RuleProposal, When } from "../../src/schema/rule";
import type { Proof } from "../../src/schema/proofs";
import type { PromoterInput, PromoterOutput, RuleLabInput, RuleLabOutput } from "../../src/schema/agents";
import type {
  AgentInvokeInput,
  AgentInvokeResult,
  AgentResumeInput,
  EvaluateInput,
  EvaluateResult,
  PublishForTypeInput,
  PublishForTypeResult,
} from "../../src/interfaces";
import { evaluateRules } from "../../src/rules/engine";
import { activeRules } from "../../src/rules/lifecycle";
import type { GateExample } from "../../src/rules/gate";

export const T0 = new Date("2026-10-11T20:00:00.000Z");
export const plus = (ms: number) => new Date(T0.getTime() + ms);

// ---------------------------------------------------------------- features

export function shipFeatures(over: Partial<Record<string, Features[string]>> = {}): Features {
  return {
    rename_only: false,
    whitespace_only: false,
    docs_only: false,
    typo_only: false,
    empty_commit: false,
    backdated: false,
    injection_text: false,
    code_lines_changed: 40,
    docs_lines_changed: 0,
    lines_added: 30,
    lines_removed: 10,
    files_changed: 6,
    message_matches: "add the export button",
    has_open_code: false,
    has_bind_code: false,
    ...over,
  } as Features;
}

export function callFeatures(over: Partial<Record<string, Features[string]>> = {}): Features {
  return {
    duration_min: 25,
    attendee_count: 1,
    attendee_domains: ["acme.com"],
    all_personal_email: false,
    internal_only: false,
    has_notes: true,
    short_call: false,
    ...over,
  } as Features;
}

export interface ExampleSpec {
  key: string;
  label: "cheat" | "honest";
  cheat_class: string | null;
  features: Features;
  source?: ExampleSource;
}

export function honest(key: string, features: Features): ExampleSpec {
  return { key, label: "honest", cheat_class: null, features, source: "seed" };
}

export function cheat(key: string, cheatClass: string, features: Features, source: ExampleSource = "seed"): ExampleSpec {
  return { key, label: "cheat", cheat_class: cheatClass, features, source };
}

export function toGateExamples(specs: readonly ExampleSpec[]): GateExample[] {
  return specs.map((s) => ({ label: s.label, cheat_class: s.cheat_class, features: s.features, source: s.source ?? "seed" }));
}

/** AE1 data: 20 rename-only cheats (19 flagged rename_only), 10 whitespace cheats, 100 honest commits. */
export function ae1Examples(): ExampleSpec[] {
  const out: ExampleSpec[] = [];
  for (let i = 0; i < 20; i++) {
    out.push(cheat(`rename-${i}`, "rename_only", shipFeatures({ rename_only: i < 19, code_lines_changed: 12 })));
  }
  for (let i = 0; i < 10; i++) {
    out.push(cheat(`ws-${i}`, "whitespace_only", shipFeatures({ whitespace_only: true, code_lines_changed: 8 })));
  }
  for (let i = 0; i < 100; i++) {
    out.push(honest(`honest-${i}`, shipFeatures({ code_lines_changed: 20 + i, files_changed: 2 + (i % 9) })));
  }
  return out;
}

/** AE2 data: 10 personal-email calls without notes, 100 honest calls (some personal email with notes). */
export function ae2Examples(): ExampleSpec[] {
  const out: ExampleSpec[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(cheat(`personal-${i}`, "all_personal_email", callFeatures({ all_personal_email: true, has_notes: false, attendee_domains: ["gmail.com"] })));
  }
  for (let i = 0; i < 100; i++) {
    const personal = i % 10 === 0;
    out.push(honest(`call-${i}`, callFeatures({ all_personal_email: personal, has_notes: true, attendee_domains: personal ? ["gmail.com"] : ["acme.com"] })));
  }
  return out;
}

export const RENAME_WHEN: When = { all: [{ feature: "rename_only", op: "eq", value: true }] };
export const PERSONAL_NO_NOTES_WHEN: When = {
  all: [
    { feature: "all_personal_email", op: "eq", value: true },
    { feature: "has_notes", op: "eq", value: false },
  ],
};

export async function insertExamples(db: Db, type: ChallengeType, specs: readonly ExampleSpec[], now: Date = T0): Promise<void> {
  if (specs.length === 0) return;
  const docs: Example[] = specs.map((s) => ({
    _id: newId("example"),
    challenge_type: type,
    example_key: s.key,
    label: s.label,
    cheat_class: s.cheat_class,
    features: s.features,
    source: s.source ?? "seed",
    summary: null,
    proof_id: null,
    created_at: now,
  }));
  await collections(db).examples.insertMany(docs);
}

export function proposal(over: Partial<RuleProposal> & Pick<RuleProposal, "challenge_type" | "when" | "action" | "cheat_class">): RuleProposal {
  return {
    parent: null,
    reason: "Learned from a rejected proof.",
    source: "ai_judgment",
    evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
    ...over,
  };
}

/** Insert an active rule directly, as a seed or an earlier activation would leave it. */
export async function insertActiveRule(
  db: Db,
  input: { challenge_type: ChallengeType; rule_key: string; version?: number; when: When; action: RuleAction; cheat_class: string; parent_version?: number | null },
  now: Date = T0,
): Promise<Id> {
  const _id = newId("rule");
  await collections(db).rules.insertOne({
    _id,
    rule_key: input.rule_key,
    version: input.version ?? 1,
    parent_version: input.parent_version ?? null,
    challenge_type: input.challenge_type,
    when: input.when,
    action: input.action,
    cheat_class: input.cheat_class,
    reason: "Seeded for the test.",
    source: "seed",
    evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
    status: "active",
    test_results: null,
    approval_id: null,
    created_at: now,
    updated_at: now,
    activated_at: now,
    retired_at: null,
  });
  return _id;
}

export async function insertProof(
  db: Db,
  input: { challenge_type: ChallengeType; features: Features | null; cheat_class?: string | null; reason?: string; ai_judgment?: boolean },
  now: Date = T0,
): Promise<Id> {
  const _id = newId("proof");
  const proof: Proof = {
    _id,
    challenge_id: newId("challenge"),
    player_id: newId("player"),
    challenge_type: input.challenge_type,
    source_key: `src-${_id}`,
    claimed: true,
    payload: {},
    features: input.features,
    source_time: now,
    day_index: 0,
    status: "rejected",
    held_reason: null,
    not_counted_reason: null,
    verdict: {
      outcome: "reject",
      decided_by: "ai",
      rule: null,
      matched_rules: [],
      evaluated_rules: [],
      contract_version: 1,
      ai_calls: 1,
      ai_judgment: input.ai_judgment ?? true,
      latency_ms: 10,
      trust_level: "rechecked",
      payout_hold: false,
      reason: input.reason ?? "The commit only renames identifiers.",
      fix: "Ship a real change.",
      cheat_class: input.cheat_class ?? null,
      confidence: 0.9,
      push_event_time: null,
      decided_at: now,
    },
    answers_request_id: null,
    history: [],
    received_at: now,
    updated_at: now,
  };
  await collections(db).proofs.insertOne(proof);
  return _id;
}

// ---------------------------------------------------------------- service doubles

/** U6 double: counts publishForType calls and returns one contract version per call. */
export function contractsDouble() {
  const calls: PublishForTypeInput[] = [];
  return {
    calls,
    service: {
      publishForType: async (_db: Db, input: PublishForTypeInput): Promise<PublishForTypeResult> => {
        calls.push(input);
        return { contracts: [{ challenge_id: "chl_test", version: calls.length + 1 }] };
      },
    },
  };
}

/** U4 double: the type's active rules from MongoDB, decided by U4's pure evaluateRules. */
export const engineDouble = {
  evaluate: async (db: Db, input: EvaluateInput): Promise<EvaluateResult> =>
    evaluateRules(await activeRules(db, input.challenge_type), input.features),
};

export function ruleLabOutput(over: Partial<RuleLabOutput> = {}): RuleLabOutput {
  return { outcome: "proposed", candidate_ids: [], example_keys: [], notes: "", proposal: null, examples: [], ...over };
}

export function completed<T>(output: T, executionId = "exec_done") {
  return { ok: true as const, status: "completed" as const, output, execution_id: executionId, latency_ms: 5 };
}

export function suspended(input: PromoterInput, executionId: string) {
  return {
    ok: true as const,
    status: "suspended" as const,
    execution_id: executionId,
    workspace_id: "ws_promoter",
    interrupt: { candidate_id: input.candidate_id, action: input.action, line: input.line, allowed_decisions: ["approve" as const, "decline" as const] },
    latency_ms: 5,
  };
}

export interface AgentScript {
  ruleLab?: (input: RuleLabInput, call: AgentInvokeInput<"rule_lab">) => Promise<RuleLabOutput>;
  promoter?: (input: PromoterInput, call: AgentInvokeInput<"promoter">) => Promise<AgentInvokeResult<"promoter">>;
  resume?: (input: AgentResumeInput) => Promise<AgentInvokeResult<"promoter">>;
}

/** U8 double: routes invoke and resume calls to scripted functions and records every call. */
export function agentsDouble(script: AgentScript) {
  const invokes: AgentInvokeInput<"rule_lab" | "promoter">[] = [];
  const resumes: AgentResumeInput[] = [];
  const invoke = async (call: AgentInvokeInput<never>): Promise<AgentInvokeResult<never>> => {
    const c = call as unknown as AgentInvokeInput<"rule_lab" | "promoter">;
    invokes.push(c);
    if (c.workspace === "rule_lab" && script.ruleLab) {
      const out = await script.ruleLab(c.input as RuleLabInput, c as AgentInvokeInput<"rule_lab">);
      return completed(out) as never;
    }
    if (c.workspace === "promoter" && script.promoter) {
      return (await script.promoter(c.input as PromoterInput, c as AgentInvokeInput<"promoter">)) as never;
    }
    return { ok: false, error: `no script for ${c.workspace}`, schema_valid: true, timed_out: false, execution_id: null, latency_ms: 1 } as never;
  };
  const resume = async (input: AgentResumeInput): Promise<AgentInvokeResult<"promoter">> => {
    resumes.push(input);
    if (script.resume) return script.resume(input);
    return { ok: false, error: "no resume script", schema_valid: true, timed_out: false, execution_id: null, latency_ms: 1 };
  };
  return {
    invokes,
    resumes,
    promoterInvokes: () => invokes.filter((c) => c.workspace === "promoter"),
    ruleLabInvokes: () => invokes.filter((c) => c.workspace === "rule_lab"),
    service: { invoke: invoke as never, resume },
  };
}

export function promoterOutput(candidateId: Id, decision: PromoterOutput["decision"]): PromoterOutput {
  return { decision, candidate_id: candidateId, rule_status: null, notes: "" };
}
