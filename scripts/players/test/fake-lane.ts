/**
 * A local Lane for the stage runner's tests. It serves the real eight `lane_` tools over MCP
 * (mcp-handler on a local port) through U7's `runTool`, with the real U6, U18 and U14 behind
 * them, like the deployed route. Only U5's proof pipeline is a double: it re-checks commits with
 * the real Ship Week pack against a fake GitHub, evaluates active rules with the real U4 engine, and
 * otherwise calls a referee double that counts AI calls. An AI rejection proposes a reject rule
 * and a pending approval, like U9's learning chain. Test helper only.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "mcp-handler";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import { provideServices, services, type LaneServices } from "@lane/core/interfaces";
import { listLaneTools, runTool, toolInputJsonSchema } from "@lane/core/tools/registry";
import { getPack } from "@lane/core/packs";
import { dayIndexAt } from "@lane/core/clock";
import { collections } from "@lane/core/schema/collections";
import { fail, newId, type Features } from "@lane/core/schema/common";
import { evaluate } from "@lane/core/rules/engine";
import type { Proof, ProofStatus, Verdict } from "@lane/core/schema/proofs";
import type { Rule } from "@lane/core/schema/rules";
import type { Db } from "../../seed/stage";
import { insertPendingApproval } from "../../seed/test/doubles";
import type { FakeGitHub } from "./fake-github";

/** Cheat classes the referee double rejects, in order. */
const AI_REJECTS = ["rename_only", "whitespace_only", "docs_only", "typo_only", "empty_commit", "injection_text"] as const;

export interface FakeLane {
  origin: string;
  /** Referee double calls. */
  readonly aiCalls: number;
  close(): Promise<void>;
}

/** U9 double: one open candidate per cheat class; the promoter suspends for approval. */
async function learnFrom(db: Db, cheat: string, type: Rule["challenge_type"]): Promise<void> {
  const col = collections(db);
  const open = await col.rules.findOne({ challenge_type: type, cheat_class: cheat, status: { $in: ["candidate", "pending_approval", "active"] } });
  if (open) return;
  const ruleKey = `learned-${cheat.replace(/_/g, "-")}`;
  const latest = await col.rules.find({ challenge_type: type, rule_key: ruleKey }).sort({ version: -1 }).limit(1).next();
  const now = new Date();
  const rule: Rule = {
    _id: newId("rule"),
    rule_key: ruleKey,
    version: (latest?.version ?? 0) + 1,
    parent_version: null,
    challenge_type: type,
    when: { all: [{ feature: cheat, op: "eq", value: true }] },
    action: "reject",
    cheat_class: cheat,
    reason: "learned from an AI rejection",
    source: "ai_judgment",
    evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
    status: "pending_approval",
    test_results: null,
    approval_id: null,
    created_at: now,
    updated_at: now,
    activated_at: null,
    retired_at: null,
  };
  await col.rules.insertOne(rule);
  await insertPendingApproval(db, rule);
}

/** U5 double for `proofs.submit`. */
export function proofsDouble(github: FakeGitHub, state: { aiCalls: number }, timeline?: string[]): LaneServices["proofs"]["submit"] {
  return async (db, input) => {
    const col = collections(db);
    const now = input.now ?? new Date();
    const player = await col.players.findOne({ _id: input.player_id });
    const challenge = await col.challenges.findOne({ _id: input.challenge_id ?? "", status: "active" });
    const member = challenge && player && (await col.memberships.findOne({ challenge_id: challenge._id, player_id: player._id }));
    if (!player || !challenge || !member) return fail("not_member", "Not in that challenge.", "Join it first.");
    const pack = getPack(challenge.type);
    const parsed = pack.proofSchema.safeParse(input.fields);
    if (!parsed.success) return fail("invalid_input", "Proof fields are invalid.", "Send what the contract asks for.");
    const proofArgs = parsed.data;
    const sourceKey = pack.sourceKey(proofArgs);
    const dup = await col.proofs.findOne({ challenge_id: challenge._id, player_id: player._id, source_key: sourceKey });
    if (dup) return { ok: true, proof: dup, outcome: "rejected", duplicate: true, verdict: dup.verdict, request: null, lines: [] };

    const platform = pack.handlePlatform(challenge);
    const handle = platform ? (player.handles[platform] ?? null) : null;
    const recheck = await pack.recheck(proofArgs, player, handle, { now, fetch: github.fetch, githubToken: "verifier-token" });
    const features =
      recheck.status === "failed"
        ? null
        : pack.extractFeatures({ proof: proofArgs, recheck, openRequests: [], earlierProofs: [], challenge, player_id: player._id });
    const rules = await col.rules.find({ challenge_type: challenge.type, status: "active" }).toArray();
    const base = {
      matched_rules: [],
      evaluated_rules: rules.map((r) => ({ rule_key: r.rule_key, version: r.version })),
      contract_version: challenge.contract_version,
      latency_ms: 1,
      trust_level: recheck.status === "rechecked" ? ("rechecked" as const) : ("agent_attested" as const),
      payout_hold: false,
      fix: "Send proof that meets the contract.",
      confidence: null,
      push_event_time: null,
      decided_at: now,
    };
    let verdict: Verdict;
    if (!features) {
      verdict = { ...base, outcome: "reject", decided_by: "authenticity", rule: null, ai_calls: 0, ai_judgment: false, reason: recheck.reason ?? "failed re-check", cheat_class: null };
    } else {
      // The real U4 engine decides, with no AI call (KTD7).
      const decided = await evaluate(db, { challenge_type: challenge.type, features });
      const hit = decided.decision === "reject" && decided.rule ? rules.find((r) => r.rule_key === decided.rule!.rule_key && r.version === decided.rule!.version) : undefined;
      if (hit) {
        verdict = {
          ...base,
          outcome: "reject",
          decided_by: "rule",
          rule: { rule_key: hit.rule_key, version: hit.version },
          matched_rules: [{ rule_key: hit.rule_key, version: hit.version, action: "reject" }],
          ai_calls: 0,
          ai_judgment: false,
          reason: `Rule ${hit.rule_key} v${hit.version}.`,
          cheat_class: hit.cheat_class,
        };
      } else {
        state.aiCalls += 1;
        const cheat = AI_REJECTS.find((c) => features[c] === true) ?? null;
        verdict = {
          ...base,
          outcome: cheat ? "reject" : "accept",
          decided_by: "ai",
          rule: null,
          ai_calls: 1,
          ai_judgment: true,
          reason: cheat ? `AI judgment: ${cheat.replace(/_/g, " ")} does not count.` : "AI judgment: this counts.",
          cheat_class: cheat,
        };
        if (cheat) await learnFrom(db, cheat, challenge.type);
      }
    }
    const status: ProofStatus = verdict.outcome === "reject" ? "rejected" : "accepted";
    const sourceTime = pack.sourceTime(proofArgs, recheck) ?? now;
    const proof: Proof = {
      _id: newId("proof"),
      challenge_id: challenge._id,
      player_id: player._id,
      challenge_type: challenge.type,
      source_key: sourceKey,
      claimed: features !== null,
      payload: proofArgs,
      features,
      source_time: sourceTime,
      day_index: Math.max(0, dayIndexAt(challenge.clock!, sourceTime)),
      status,
      held_reason: null,
      not_counted_reason: null,
      verdict,
      answers_request_id: null,
      history: [{ at: now, from: null, to: status, by: verdict.decided_by, note: null }],
      received_at: now,
      updated_at: now,
    };
    await col.proofs.insertOne(proof);
    timeline?.push(`lane verdict ${status} by ${verdict.decided_by}`);
    return { ok: true, proof, outcome: status, duplicate: false, verdict, request: null, lines: [verdict.reason] };
  };
}

export const LEARNED_FRIEND_CALLS = "learned-friend-calls";

/**
 * AE2 doubles: U8's referee triages a dispute (ask_more for a personal-email-only call), and U9
 * learns an ask_more rule from the dispute, which goes live without approval (R22) and publishes
 * a contract version through the real U6.
 */
export function ae2Doubles(): { learned: number } {
  const counts = { learned: 0 };
  const invoke = (async (input: { workspace: string; mode: string; input: { features?: Features } }) => {
    if (input.workspace !== "referee" || input.mode !== "dispute") throw new Error(`unexpected agent call ${input.workspace}.${input.mode}`);
    const personal = input.input.features?.all_personal_email === true;
    return {
      ok: true,
      status: "completed",
      execution_id: newId("job"),
      latency_ms: 5,
      output: {
        outcome: personal ? "ask_more" : "unfounded",
        reason: personal ? "Every attendee uses a personal email domain." : "Looks like a real customer call.",
        fix: "Send the meeting notes.",
        cheat_class: personal ? "all_personal_email" : null,
        confidence: 0.8,
        extra_proof: personal ? "Meeting notes for this call." : null,
      },
    };
  }) as unknown as LaneServices["agents"]["invoke"];
  const fromSource: LaneServices["learning"]["fromSource"] = async (db, input) => {
    if (input.source !== "dispute" || input.cheat_class !== "all_personal_email") {
      return { job_id: null, queued: false, skipped_reason: "not an AE2 dispute" };
    }
    const col = collections(db);
    const now = input.now ?? new Date();
    if (await col.rules.findOne({ challenge_type: input.challenge_type, rule_key: LEARNED_FRIEND_CALLS, status: "active" })) {
      return { job_id: null, queued: false, skipped_reason: "already learned" };
    }
    await col.rules.insertOne({
      _id: newId("rule"),
      rule_key: LEARNED_FRIEND_CALLS,
      version: 1,
      parent_version: null,
      challenge_type: input.challenge_type,
      when: { all: [{ feature: "all_personal_email", op: "eq", value: true }, { feature: "has_notes", op: "eq", value: false }] },
      action: "ask_more",
      cheat_class: "all_personal_email",
      reason: "learned from a dispute",
      source: "dispute",
      evidence: { proof_ids: input.proof_id ? [input.proof_id] : [], example_keys: [], dispute_ids: input.dispute_id ? [input.dispute_id] : [] },
      status: "active",
      test_results: null,
      approval_id: null,
      created_at: now,
      updated_at: now,
      activated_at: now,
      retired_at: null,
    });
    counts.learned += 1;
    await services().contracts.publishForType(db, { challenge_type: input.challenge_type, reason: "rule_activated", now });
    return { job_id: null, queued: true, skipped_reason: null };
  };
  provideServices({ agents: { invoke }, learning: { fromSource } });
  return counts;
}

type ToolArgs = Record<string, unknown>;

/** Advertise the flat JSON schema and let every call through to `runTool`, like the web route. */
function advertisedSchema(json: Record<string, unknown>): StandardSchemaWithJSON<ToolArgs> {
  return {
    "~standard": {
      version: 1,
      vendor: "lane",
      validate: (value) => ({ value: typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ToolArgs) : {} }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

/**
 * Start the local Lane. Callers wire U6 and U18 (see `upstreamDoubles`) first; this adds the U5
 * double. Pass `submit` to replace it.
 */
export async function startFakeLane(
  db: Db,
  github: FakeGitHub,
  timeline?: string[],
  opts: { submit?: LaneServices["proofs"]["submit"] } = {},
): Promise<FakeLane> {
  const state = { aiCalls: 0 };
  provideServices({ proofs: { submit: opts.submit ?? proofsDouble(github, state, timeline) } });
  const keyStore = new AsyncLocalStorage<string | null>();
  const mcp = createMcpHandler((server) => {
    for (const tool of listLaneTools()) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: advertisedSchema(toolInputJsonSchema(tool.name)), annotations: tool.annotations },
        async (args) => {
          const envelope = await runTool(tool.name, args, { db: async () => db, bearer: keyStore.getStore() ?? null });
          return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope as unknown as Record<string, unknown> };
        },
      );
    }
  });
  const handler = (req: Request) => {
    const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    return keyStore.run(key, () => mcp(req));
  };
  const server: LocalServer = await serveRoutes({ "/api/mcp": { GET: handler, POST: handler, DELETE: handler } });
  return {
    origin: server.origin,
    get aiCalls() {
      return state.aiCalls;
    },
    close: () => server.close(),
  };
}
