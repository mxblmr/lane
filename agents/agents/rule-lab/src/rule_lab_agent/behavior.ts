/**
 * Rule-lab behavior (U10; R20, R21, KTD8, KTD9, KTD10, KTD11, KTD18).
 *
 * The control flow is fixed code, not a model loop: the model only drafts a rule proposal
 * or cheat variants, and the graph decides when to call Lane, when to revise and when to
 * stop. That keeps the AE1 and AE5 paths deterministic.
 *
 * write_rule:
 *   START -> context -> draft -> propose_test -> (draft once more on a failed gate) -> finish
 *   - context reads the predicate catalog, active rules and examples from the input, or
 *     from rule_lab_read when the input carries no catalog;
 *   - draft asks the model for one proposal linked to the input parent, and checks it
 *     against the catalog (one retry on an invalid reply);
 *   - propose_test calls rule_lab_propose, then rule_lab_test, and keeps the gate result;
 *   - after `max_revisions` failed gates rule-lab stops with outcome gave_up. Lane's gate
 *     marks each failed candidate rejected (U9), so the active set stays (AE5).
 *
 * red_team:
 *   START -> context -> invent -> add -> (invent again while under both caps) -> finish
 *   - invent asks the model for new cheat variants of one challenge type;
 *   - add sends them as cheat examples through rule_lab_add_examples;
 *   - the run stops at the per-run tool-call cap (KTD9) or at `max_examples`.
 *
 * No-egress mode (`input.no_egress`, or LANE_AGENT_NO_EGRESS on the agent): no Lane call
 * is made. write_rule returns its proposal and red_team its examples as the result, and
 * the core runs the gate and the examples loader itself (U9).
 *
 * The prompt text is not here (KTD11): it arrives in the invoke payload. The proposal's
 * JSON Schema comes from the internal API contract in the payload when it is present.
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";

import { DATA_RULE, isRecord, laneData, messageText, requireTask, type LanePayload } from "./lane.js";
import type { LaneCaller } from "./lane_call.js";
import { LaneStateAnnotation, type LabProgress, type LaneState, type LaneUpdate } from "./state.js";

// ---------------------------------------------------------------- contracts (mirrors of U3)

/** U3 `INTERNAL_API` paths (packages/core/src/schema/agents.ts). */
export const RULE_LAB_ENDPOINTS = {
  rule_lab_read: "/api/internal/rule-lab/read",
  rule_lab_propose: "/api/internal/rule-lab/propose",
  rule_lab_test: "/api/internal/rule-lab/test",
  rule_lab_add_examples: "/api/internal/rule-lab/examples",
} as const;
export type RuleLabEndpoint = keyof typeof RULE_LAB_ENDPOINTS;

const FEATURE_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const RULE_KEY = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const OPS = ["eq", "lt", "lte", "gt", "gte", "in", "matches"] as const;
const ACTIONS = ["reject", "hold_payout", "ask_more", "flag"] as const;

/** Mirrors U3 `CondSchema` structurally. Lane's grammar check is authoritative. */
const CondSchema = z.object({
  feature: z.string().regex(FEATURE_NAME),
  op: z.enum(OPS),
  value: z.union([z.number(), z.boolean(), z.string().max(40), z.array(z.union([z.string().max(40), z.number()])).max(20)]),
});
const WhenSchema = z.union([
  z.strictObject({ all: z.array(CondSchema).min(1).max(8) }),
  z.strictObject({ any: z.array(CondSchema).min(1).max(8) }),
]);
const DraftSchema = z.object({
  when: WhenSchema,
  action: z.enum(ACTIONS),
  cheat_class: z.string().regex(FEATURE_NAME).optional(),
  reason: z.string().min(1).max(500),
  rule_key: z.string().optional(),
});

/** Mirrors U3 `RuleProposalSchema`: what rule_lab_propose accepts. */
export type RuleProposal = {
  challenge_type: string;
  parent: { rule_key: string; version: number } | null;
  rule_key?: string;
  when: z.infer<typeof WhenSchema>;
  action: (typeof ACTIONS)[number];
  cheat_class: string;
  reason: string;
  source: string;
  evidence: { proof_ids: string[]; example_keys: string[]; dispute_ids: string[] };
};

/** Mirrors U3 `RedTeamExampleSchema`. */
const RedTeamExampleSchema = z.object({
  example_key: z.string().min(1).max(80),
  cheat_class: z.string().regex(FEATURE_NAME),
  features: z.record(z.string(), z.unknown()),
  summary: z.string().max(200).nullable().optional(),
});
export type RedTeamExample = { example_key: string; cheat_class: string; features: Record<string, unknown>; summary: string | null };

/** U3 `RuleLabOutputSchema`. */
export type RuleLabOutput = {
  outcome: "proposed" | "gave_up" | "no_rule" | "examples_added";
  candidate_ids: string[];
  example_keys: string[];
  notes: string;
  proposal: RuleProposal | null;
  examples: RedTeamExample[];
};

/** Fields of U3 `RuleLabInput` the graph reads, plus optional fields the core may add. */
type RuleLabInput = {
  mode: "write_rule" | "red_team";
  challenge_type: string;
  source: string;
  cheat_class: string | null;
  evidence_proof_ids: string[];
  evidence_example_keys: string[];
  parent: { rule_key: string; version: number } | null;
  max_revisions: number;
  max_examples: number;
  no_egress: boolean;
  /** Optional: the predicate catalog. Without it the graph reads it through rule_lab_read. */
  catalog?: unknown[];
  rules?: unknown[];
  examples?: unknown[];
  /** Optional: red-team per-run tool-call cap. Policy Engine enforces the same cap (KTD9). */
  max_tool_calls?: number;
  /** Optional, no-egress revisions: earlier proposals with the gate result the core got. */
  previous_attempts?: unknown[];
};

export const DEFAULT_RED_TEAM_TOOL_CALL_CAP = 6;
/** Hard ceiling on drafts per run whatever max_revisions says (U10: revise once). */
const MAX_DRAFTS = 4;
const MAX_LIST = 60;

// ---------------------------------------------------------------- dependencies

export type ChatInvoker = { invoke(messages: BaseMessage[]): Promise<BaseMessage> };

export type RuleLabDeps = {
  llm: ChatInvoker;
  callLane: LaneCaller;
  /** LANE_AGENT_NO_EGRESS on the agent forces no-egress mode. */
  noEgressEnv?: boolean;
  /** Default red-team tool-call cap when the input sets none. */
  toolCallCap?: number;
  checkpointer?: BaseCheckpointSaver;
};

// ---------------------------------------------------------------- helpers

function readInput(task: LanePayload): RuleLabInput {
  const raw = isRecord(task.input) ? task.input : {};
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const parent =
    isRecord(raw.parent) && typeof raw.parent.rule_key === "string" && typeof raw.parent.version === "number"
      ? { rule_key: raw.parent.rule_key, version: raw.parent.version }
      : null;
  const int = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
  return {
    mode: raw.mode === "red_team" ? "red_team" : "write_rule",
    challenge_type: typeof raw.challenge_type === "string" ? raw.challenge_type : "",
    source: typeof raw.source === "string" ? raw.source : "ai_judgment",
    cheat_class: typeof raw.cheat_class === "string" ? raw.cheat_class : null,
    evidence_proof_ids: strings(raw.evidence_proof_ids),
    evidence_example_keys: strings(raw.evidence_example_keys),
    parent,
    max_revisions: Math.min(int(raw.max_revisions, 1), MAX_DRAFTS - 1),
    max_examples: int(raw.max_examples, 10),
    no_egress: raw.no_egress === true,
    catalog: Array.isArray(raw.catalog) ? raw.catalog : undefined,
    rules: Array.isArray(raw.rules) ? raw.rules : undefined,
    examples: Array.isArray(raw.examples) ? raw.examples : undefined,
    max_tool_calls: typeof raw.max_tool_calls === "number" && raw.max_tool_calls >= 0 ? Math.floor(raw.max_tool_calls) : undefined,
    previous_attempts: Array.isArray(raw.previous_attempts) ? raw.previous_attempts : undefined,
  };
}

/** The endpoint URL from the payload's internal API contract, or U3's path. */
export function endpointPath(task: LanePayload, name: RuleLabEndpoint): string {
  const endpoints = isRecord(task.internal_api) && isRecord(task.internal_api.endpoints) ? task.internal_api.endpoints : {};
  const entry = endpoints[name];
  return isRecord(entry) && typeof entry.url === "string" && entry.url.length > 0 ? entry.url : RULE_LAB_ENDPOINTS[name];
}

function requestSchema(task: LanePayload, name: RuleLabEndpoint): Record<string, unknown> | null {
  const endpoints = isRecord(task.internal_api) && isRecord(task.internal_api.endpoints) ? task.internal_api.endpoints : {};
  const entry = endpoints[name];
  return isRecord(entry) && isRecord(entry.request) ? entry.request : null;
}

/** Catalog features with their allowed ops. An empty map means no catalog to check against. */
function catalogOps(catalog: unknown[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of catalog) {
    if (isRecord(entry) && typeof entry.feature === "string") {
      const ops = Array.isArray(entry.ops) ? entry.ops.filter((op): op is string => typeof op === "string") : [...OPS];
      map.set(entry.feature, new Set(ops));
    }
  }
  return map;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next form.
    }
  }
  return null;
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Checks a drafted rule and fills the fields Lane owns from the input. */
export function normalizeProposal(
  raw: unknown,
  input: RuleLabInput,
  catalog: unknown[],
): { proposal: RuleProposal | null; problem: string | null } {
  const parsed = DraftSchema.safeParse(isRecord(raw) && isRecord(raw.proposal) ? raw.proposal : raw);
  if (!parsed.success) return { proposal: null, problem: issues(parsed.error) };
  const draft = parsed.data;
  const ops = catalogOps(catalog);
  if (ops.size > 0) {
    const conds = "all" in draft.when ? draft.when.all : draft.when.any;
    for (const cond of conds) {
      const allowed = ops.get(cond.feature);
      if (!allowed) return { proposal: null, problem: `feature ${cond.feature} is not in the predicate catalog` };
      if (!allowed.has(cond.op)) return { proposal: null, problem: `op ${cond.op} is not allowed for ${cond.feature}` };
    }
  }
  const cheatClass = input.cheat_class ?? draft.cheat_class;
  if (!cheatClass) return { proposal: null, problem: "cheat_class is missing" };
  const proposal: RuleProposal = {
    challenge_type: input.challenge_type,
    parent: input.parent,
    when: draft.when,
    action: draft.action,
    cheat_class: cheatClass,
    reason: draft.reason,
    source: input.source,
    evidence: { proof_ids: input.evidence_proof_ids, example_keys: input.evidence_example_keys, dispute_ids: [] },
  };
  if (!input.parent && draft.rule_key && RULE_KEY.test(draft.rule_key)) proposal.rule_key = draft.rule_key;
  return { proposal, problem: null };
}

/** Checks drafted cheat variants: only well-formed, new keys, capped. */
export function normalizeExamples(raw: unknown, input: RuleLabInput, seen: Set<string>, limit: number): RedTeamExample[] {
  const list = isRecord(raw) && Array.isArray(raw.examples) ? raw.examples : Array.isArray(raw) ? raw : [];
  const out: RedTeamExample[] = [];
  for (const item of list) {
    if (out.length >= limit) break;
    const parsed = RedTeamExampleSchema.safeParse(item);
    if (!parsed.success) continue;
    const example = parsed.data;
    if (input.cheat_class && example.cheat_class !== input.cheat_class) continue;
    if (seen.has(example.example_key)) continue;
    seen.add(example.example_key);
    out.push({ ...example, summary: example.summary ?? null });
  }
  return out;
}

function emptyProgress(): LabProgress {
  return { catalog: [], rules: [], examples: [], attempts: [], draft: null, tool_calls: 0, added: [], stop: null, notes: [] };
}

function systemFor(task: LanePayload, schema: Record<string, unknown> | string): SystemMessage {
  const contract =
    typeof schema === "string"
      ? schema
      : `Reply with exactly one JSON object and nothing else, no prose and no code fence. It must validate against this JSON Schema: ${JSON.stringify(schema)}`;
  return new SystemMessage([task.prompt, DATA_RULE, contract].join("\n\n"));
}

const DRAFT_SHAPE =
  'Reply with exactly one JSON object and nothing else: {"when": {"all": [{"feature": string, "op": string, "value": ...}]} or {"any": [...]}, "action": "reject" | "hold_payout" | "ask_more" | "flag", "cheat_class": string, "reason": string}. Use only features and ops from the predicate catalog.';
const EXAMPLES_SHAPE =
  'Reply with exactly one JSON object and nothing else: {"examples": [{"example_key": string, "cheat_class": string, "features": object, "summary": string}]}. Features use only names from the predicate catalog.';

// ---------------------------------------------------------------- graph

export function buildRuleLabGraph(deps: RuleLabDeps) {
  const noEgress = (state: LaneState): boolean => deps.noEgressEnv === true || readInput(requireTask(state)).no_egress;
  const lab = (state: LaneState): LabProgress => state.lab ?? emptyProgress();

  /** Reads the catalog, active rules and examples: from the input, else from Lane. */
  const context = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    const input = readInput(task);
    const progress = { ...emptyProgress() };
    progress.catalog = input.catalog ?? [];
    progress.rules = input.rules ?? [];
    progress.examples = input.examples ?? [];
    const needsRead = input.catalog === undefined || (input.mode === "red_team" && input.examples === undefined);
    if (needsRead && !noEgress(state)) {
      const body: Record<string, unknown> = {
        challenge_type: input.challenge_type,
        include: ["catalog", "rules", "examples"],
        limit: MAX_LIST,
      };
      if (input.cheat_class) body.cheat_class = input.cheat_class;
      const reply = await deps.callLane(endpointPath(task, "rule_lab_read"), body, "context-read");
      progress.tool_calls += 1;
      if (reply.ok) {
        if (input.catalog === undefined && Array.isArray(reply.data.catalog)) progress.catalog = reply.data.catalog;
        if (input.rules === undefined && Array.isArray(reply.data.rules)) progress.rules = reply.data.rules;
        if (input.examples === undefined && Array.isArray(reply.data.examples)) progress.examples = reply.data.examples.slice(0, MAX_LIST);
      } else {
        progress.notes.push(`read failed (${reply.error ?? "unknown"})`);
      }
    }
    return { lab: progress };
  };

  /** Asks the model for one proposal; one retry when the reply is not a valid proposal. */
  const draft = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    const input = readInput(task);
    const progress = lab(state);
    const attempts = progress.attempts.length > 0 ? progress.attempts : (input.previous_attempts ?? []);
    const data = [
      laneData("input", task.input),
      laneData("predicate_catalog", progress.catalog),
      laneData("active_rules", progress.rules),
    ];
    if (attempts.length > 0) data.push(laneData("previous_attempts", attempts));
    const ask =
      attempts.length > 0
        ? "The previous candidate failed Lane's gate for the reasons in previous_attempts. Write one revised proposal that fixes them."
        : "Write one rule proposal from this evidence.";
    const schema = requestSchema(task, "rule_lab_propose");
    const messages: BaseMessage[] = [systemFor(task, schema ?? DRAFT_SHAPE), new HumanMessage(`${data.join("\n\n")}\n\n${ask}`)];
    const first = messageText(await deps.llm.invoke(messages));
    let check = normalizeProposal(extractJson(first), input, progress.catalog);
    if (!check.proposal) {
      const retry = messageText(
        await deps.llm.invoke([
          ...messages,
          new AIMessage(first || "(no text)"),
          new HumanMessage(`That is not a valid proposal (${check.problem}). Reply again with only the JSON object.`),
        ]),
      );
      check = normalizeProposal(extractJson(retry), input, progress.catalog);
    }
    const notes = check.proposal ? progress.notes : [...progress.notes, `draft invalid twice (${check.problem})`];
    return { lab: { ...progress, draft: check.proposal, notes, stop: check.proposal ? null : "no_rule" } };
  };

  /** Proposes the draft and runs Lane's gate on it. */
  const proposeTest = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    const progress = lab(state);
    const proposal = progress.draft;
    if (!proposal) return { lab: { ...progress, stop: "no_rule" } };
    const n = progress.attempts.length + 1;
    const proposed = await deps.callLane(endpointPath(task, "rule_lab_propose"), proposal, `propose-${n}`);
    if (!proposed.ok || typeof proposed.data.candidate_id !== "string") {
      return {
        lab: {
          ...progress,
          tool_calls: progress.tool_calls + 1,
          notes: [...progress.notes, `propose failed (${proposed.error ?? "no candidate_id"})`],
          stop: progress.attempts.length > 0 ? "gave_up" : "no_rule",
        },
      };
    }
    const candidateId = proposed.data.candidate_id;
    const tested = await deps.callLane(endpointPath(task, "rule_lab_test"), { candidate_id: candidateId }, `test-${n}`);
    const gate = tested.ok && isRecord(tested.data.gate) ? tested.data.gate : null;
    const attempt = {
      candidate_id: candidateId,
      proposal,
      passed: gate?.passed === true,
      status: typeof tested.data.status === "string" ? tested.data.status : null,
      gate_reasons: gate && Array.isArray(gate.reasons) ? gate.reasons : tested.ok ? [] : [`test failed (${tested.error ?? "unknown"})`],
      gate,
    };
    return { lab: { ...progress, tool_calls: progress.tool_calls + 2, attempts: [...progress.attempts, attempt], draft: null } };
  };

  /** Asks the model for new cheat variants, capped by what is left of max_examples. */
  const invent = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    const input = readInput(task);
    const progress = lab(state);
    const remaining = input.max_examples - progress.added.length - (progress.pending?.length ?? 0);
    if (remaining <= 0) return { lab: { ...progress, stop: "max_examples" } };
    const known = progress.examples
      .map((example) => (isRecord(example) && typeof example.example_key === "string" ? example.example_key : null))
      .filter((key): key is string => key !== null);
    const data = [
      laneData("input", task.input),
      laneData("predicate_catalog", progress.catalog),
      laneData("known_examples", progress.examples),
      laneData("already_added", progress.added),
    ];
    const ask = `Write up to ${remaining} new cheat variants for this challenge type. Each example_key must be new.`;
    const reply = messageText(
      await deps.llm.invoke([systemFor(task, EXAMPLES_SHAPE), new HumanMessage(`${data.join("\n\n")}\n\n${ask}`)]),
    );
    const seen = new Set([...known, ...progress.added]);
    const examples = normalizeExamples(extractJson(reply), input, seen, remaining);
    if (examples.length === 0) return { lab: { ...progress, pending: [], stop: "no_new_examples" } };
    return { lab: { ...progress, pending: examples } };
  };

  /** Sends pending variants as cheat examples. Never sends honest examples (KTD9). */
  const add = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    const input = readInput(task);
    const progress = lab(state);
    const pending = progress.pending ?? [];
    if (noEgress(state)) {
      return { lab: { ...progress, added: [...progress.added, ...pending.map((e) => e.example_key)], returned: [...(progress.returned ?? []), ...pending], pending: [] } };
    }
    const n = progress.tool_calls + 1;
    const reply = await deps.callLane(
      endpointPath(task, "rule_lab_add_examples"),
      { challenge_type: input.challenge_type, examples: pending },
      `add-${n}`,
    );
    const toolCalls = progress.tool_calls + 1;
    if (!reply.ok) {
      return { lab: { ...progress, tool_calls: toolCalls, pending: [], notes: [...progress.notes, `add failed (${reply.error ?? "unknown"})`], stop: "tool_error" } };
    }
    const added = Array.isArray(reply.data.added) ? reply.data.added.filter((k): k is string => typeof k === "string") : [];
    return { lab: { ...progress, tool_calls: toolCalls, added: [...progress.added, ...added], pending: [] } };
  };

  const finish = (state: LaneState): LaneUpdate => {
    const task = requireTask(state);
    const input = readInput(task);
    const progress = lab(state);
    const output = buildOutput(input, progress, noEgress(state), toolCallCap(input));
    return { messages: [new AIMessage(JSON.stringify(output))], lab: progress };
  };

  const toolCallCap = (input: RuleLabInput): number => input.max_tool_calls ?? deps.toolCallCap ?? DEFAULT_RED_TEAM_TOOL_CALL_CAP;

  // Routing.
  const afterContext = (state: LaneState): "draft" | "invent" =>
    readInput(requireTask(state)).mode === "red_team" ? "invent" : "draft";
  const afterDraft = (state: LaneState): "propose_test" | "finish" =>
    lab(state).draft && !noEgress(state) ? "propose_test" : "finish";
  const afterProposeTest = (state: LaneState): "draft" | "finish" => {
    const progress = lab(state);
    if (progress.stop) return "finish";
    const last = progress.attempts[progress.attempts.length - 1];
    if (!last || last.passed) return "finish";
    const revisions = progress.attempts.length - 1;
    return revisions < readInput(requireTask(state)).max_revisions ? "draft" : "finish";
  };
  const afterInvent = (state: LaneState): "add" | "finish" => (lab(state).stop ? "finish" : "add");
  const afterAdd = (state: LaneState): "invent" | "finish" => {
    const progress = lab(state);
    const input = readInput(requireTask(state));
    if (progress.stop) return "finish";
    if (progress.added.length >= input.max_examples) return "finish";
    if (noEgress(state)) return "finish";
    return progress.tool_calls >= toolCallCap(input) ? "finish" : "invent";
  };

  return new StateGraph(LaneStateAnnotation)
    .addNode("context", context)
    .addNode("draft", draft)
    .addNode("propose_test", proposeTest)
    .addNode("invent", invent)
    .addNode("add", add)
    .addNode("finish", finish)
    .addEdge(START, "context")
    .addConditionalEdges("context", afterContext, { draft: "draft", invent: "invent" })
    .addConditionalEdges("draft", afterDraft, { propose_test: "propose_test", finish: "finish" })
    .addConditionalEdges("propose_test", afterProposeTest, { draft: "draft", finish: "finish" })
    .addConditionalEdges("invent", afterInvent, { add: "add", finish: "finish" })
    .addConditionalEdges("add", afterAdd, { invent: "invent", finish: "finish" })
    .addEdge("finish", END)
    .compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {});
}

/** The final RuleLabOutput, built from progress only (never from model text). */
export function buildOutput(input: RuleLabInput, progress: LabProgress, noEgress: boolean, cap: number): RuleLabOutput {
  const notes = [...progress.notes];
  if (input.mode === "red_team") {
    const capped = !noEgress && progress.tool_calls >= cap && progress.added.length < input.max_examples;
    if (capped) notes.push(`stopped at the per-run tool-call cap of ${cap}`);
    if (progress.stop === "max_examples" || progress.added.length >= input.max_examples) notes.push(`reached max_examples ${input.max_examples}`);
    notes.push(noEgress ? `returned ${progress.returned?.length ?? 0} examples (no egress)` : `added ${progress.added.length} cheat examples`);
    return {
      outcome: "examples_added",
      candidate_ids: [],
      example_keys: progress.added,
      notes: notes.join("; ").slice(0, 1000),
      proposal: null,
      examples: noEgress ? (progress.returned ?? []) : [],
    };
  }
  const candidateIds = progress.attempts.map((attempt) => attempt.candidate_id);
  if (noEgress) {
    const proposal = progress.draft;
    notes.push(proposal ? "proposal returned without calling Lane (no egress)" : "no valid proposal");
    return {
      outcome: proposal ? "proposed" : "no_rule",
      candidate_ids: [],
      example_keys: [],
      notes: notes.join("; ").slice(0, 1000),
      proposal,
      examples: [],
    };
  }
  const last = progress.attempts[progress.attempts.length - 1];
  let outcome: RuleLabOutput["outcome"];
  if (last?.passed) {
    outcome = "proposed";
    notes.push(`candidate ${last.candidate_id} passed the gate`);
  } else if (progress.attempts.length > 0) {
    outcome = "gave_up";
    for (const attempt of progress.attempts) {
      notes.push(`candidate ${attempt.candidate_id} failed the gate: ${attempt.gate_reasons.join(", ") || "no reason given"}`);
    }
    notes.push("stopped; Lane's gate rejects failed candidates and the active set stays");
  } else {
    outcome = "no_rule";
  }
  return {
    outcome,
    candidate_ids: candidateIds,
    example_keys: [],
    notes: notes.join("; ").slice(0, 1000),
    proposal: null,
    examples: [],
  };
}
