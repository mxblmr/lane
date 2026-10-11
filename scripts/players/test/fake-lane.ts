/**
 * A local Lane MCP server for the stage runner's tests, standing in for U7's connector and U5's
 * proof pipeline until they merge. It serves lane_check_in and lane_submit_proof over real MCP
 * (mcp-handler on a local port) against the test database, resolves the player from the bearer
 * key hash like U7, re-checks commits with the real Ship Week pack (U14) against a fake GitHub,
 * evaluates active rules with no AI call, and otherwise calls a referee double that counts AI
 * calls. An AI rejection proposes a reject rule and a pending approval, like U9's learning chain.
 * Test helper only.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import { getPack } from "@lane/core/packs";
import { hashPlayerKey } from "@lane/core/players";
import { currentDayIndex, dayIndexAt } from "@lane/core/clock";
import { collections } from "@lane/core/schema/collections";
import { newId, type Features } from "@lane/core/schema/common";
import type { Cond, When } from "@lane/core/schema/rule";
import type { Proof, Verdict } from "@lane/core/schema/proofs";
import type { Rule } from "@lane/core/schema/rules";
import type { Db } from "../../seed/stage";
import { insertPendingApproval } from "../../seed/test/doubles";
import type { FakeGitHub } from "./fake-github";

/** Cheat classes the referee double rejects, in order. */
const AI_REJECTS = ["rename_only", "whitespace_only", "docs_only", "typo_only", "empty_commit", "injection_text"] as const;

function condHolds(c: Cond, f: Features): boolean {
  const v = f[c.feature];
  switch (c.op) {
    case "eq":
      return v === c.value;
    case "in":
      return Array.isArray(c.value) && (c.value as unknown[]).includes(v);
    case "lt":
      return typeof v === "number" && v < (c.value as number);
    case "lte":
      return typeof v === "number" && v <= (c.value as number);
    case "gt":
      return typeof v === "number" && v > (c.value as number);
    case "gte":
      return typeof v === "number" && v >= (c.value as number);
    case "matches":
      return typeof v === "string" && v.toLowerCase().includes(String(c.value).toLowerCase());
  }
}

function whenHolds(w: When, f: Features): boolean {
  return "all" in w ? w.all.every((c) => condHolds(c, f)) : w.any.some((c) => condHolds(c, f));
}

export interface FakeLane {
  origin: string;
  /** Referee double calls. */
  aiCalls: number;
  close(): Promise<void>;
}

export async function startFakeLane(db: Db, github: FakeGitHub, timeline?: string[]): Promise<FakeLane> {
  const keyStore = new AsyncLocalStorage<string | null>();
  const state = { aiCalls: 0 };
  const col = collections(db);

  const envelope = (body: Record<string, unknown>) => {
    const full = { status: "ok", lines: [], server_time: new Date().toISOString(), next_check_in_at: null, error: null, data: null, challenges: [], ...body };
    return { content: [{ type: "text" as const, text: JSON.stringify(full) }], structuredContent: full };
  };
  const unauth = () => envelope({ status: "error", error: { code: "unauthenticated", recovery: "Send your Lane key." }, lines: ["No Lane key."] });

  async function currentPlayer() {
    const key = keyStore.getStore();
    if (!key) return null;
    return col.players.findOne({ key_hash: hashPlayerKey(key) });
  }

  async function submit(args: { challenge_id?: string; repo?: string; sha?: string }) {
    const player = await currentPlayer();
    if (!player) return unauth();
    const now = new Date();
    const challenge = await col.challenges.findOne({ _id: args.challenge_id ?? "", status: "active" });
    const member = challenge && (await col.memberships.findOne({ challenge_id: challenge._id, player_id: player._id }));
    if (!challenge || !member) return envelope({ status: "error", error: { code: "not_member", recovery: "Join first." } });
    const pack = getPack(challenge.type);
    const parsed = pack.proofSchema.safeParse({ repo: args.repo, sha: args.sha });
    if (!parsed.success) return envelope({ status: "error", error: { code: "invalid_input", recovery: "Send owner/name and the full SHA." } });
    const proofArgs = parsed.data;
    const sourceKey = pack.sourceKey(proofArgs);
    const dup = await col.proofs.findOne({ challenge_id: challenge._id, player_id: player._id, source_key: sourceKey });
    if (dup) return envelope({ data: { proof_id: dup._id, outcome: dup.status, verdict: dup.verdict, duplicate: true } });

    const recheck = await pack.recheck(proofArgs, player, player.handles.github ?? null, { now, fetch: github.fetch, githubToken: "verifier-token" });
    const features =
      recheck.status === "failed"
        ? null
        : pack.extractFeatures({ proof: proofArgs, recheck, openRequests: [], earlierProofs: [], challenge, player_id: player._id });
    const rules = await col.rules.find({ challenge_type: challenge.type, status: "active" }).toArray();
    const verdictBase = {
      matched_rules: [],
      evaluated_rules: rules.map((r) => ({ rule_key: r.rule_key, version: r.version })),
      contract_version: challenge.contract_version,
      latency_ms: 1,
      trust_level: "rechecked" as const,
      payout_hold: false,
      fix: "Send a commit with a meaningful code change.",
      confidence: null,
      push_event_time: null,
      decided_at: now,
    };
    let verdict: Verdict;
    if (!features) {
      verdict = { ...verdictBase, outcome: "reject", decided_by: "authenticity", rule: null, ai_calls: 0, ai_judgment: false, reason: recheck.reason ?? "failed re-check", cheat_class: null };
    } else {
      const hit: Rule | undefined = rules.find((r) => r.action === "reject" && whenHolds(r.when, features));
      if (hit) {
        verdict = {
          ...verdictBase,
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
          ...verdictBase,
          outcome: cheat ? "reject" : "accept",
          decided_by: "ai",
          rule: null,
          ai_calls: 1,
          ai_judgment: true,
          reason: cheat ? `AI judgment: ${cheat.replace(/_/g, " ")} does not count.` : "AI judgment: meaningful commit.",
          cheat_class: cheat,
        };
        if (cheat) await learnFrom(cheat, challenge.type);
      }
    }
    const status = verdict.outcome === "reject" ? "rejected" : "accepted";
    const sourceTime = recheck.source?.created_at ?? now;
    const proof: Proof = {
      _id: newId("proof"),
      challenge_id: challenge._id,
      player_id: player._id,
      challenge_type: challenge.type,
      source_key: sourceKey,
      claimed: recheck.status === "rechecked",
      payload: { repo: proofArgs.repo, sha: proofArgs.sha },
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
    return envelope({ lines: [verdict.reason], data: { proof_id: proof._id, outcome: status, verdict, duplicate: false } });
  }

  /** U9 double: one open candidate per cheat class; the promoter suspends for approval. */
  async function learnFrom(cheat: string, type: Rule["challenge_type"]) {
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

  async function checkIn() {
    const player = await currentPlayer();
    if (!player) return unauth();
    const now = new Date();
    const memberships = await col.memberships.find({ player_id: player._id }).toArray();
    const challenges = [];
    for (const m of memberships) {
      const c = await col.challenges.findOne({ _id: m.challenge_id, status: "active" });
      if (!c) continue; // cancelled and settled challenges are skipped
      const contract = await col.contracts.find({ challenge_id: c._id }).sort({ version: -1 }).limit(1).next();
      const proofs = await col.proofs.find({ challenge_id: c._id }).sort({ received_at: 1 }).toArray();
      challenges.push({
        challenge_id: c._id,
        type: c.type,
        title: c.title,
        status: c.status,
        day_index: currentDayIndex(c.clock!, now),
        contract_version: c.contract_version,
        contract_changed: (contract?.version ?? 0) > m.last_seen_contract_version,
        contract: contract
          ? { version: contract.version, agent_instructions: contract.agent_instructions, send: contract.fields.send, does_not_count: contract.does_not_count.map((l) => l.line), changes: contract.changes }
          : null,
        actions: [],
        messages: [],
        standings: [],
        feed: proofs.map((p) => ({ proof_id: p._id, player_id: p.player_id, status: p.status, decided_by: p.verdict?.decided_by ?? null, summary: "commit" })),
      });
      await col.memberships.updateOne({ _id: m._id }, { $set: { last_check_in_at: now, last_seen_contract_version: c.contract_version } });
    }
    return envelope({ challenges });
  }

  const mcp = createMcpHandler((server) => {
    server.registerTool("lane_check_in", { description: "check in", inputSchema: z.object({}) }, async () => checkIn());
    server.registerTool(
      "lane_submit_proof",
      {
        description: "submit proof",
        inputSchema: z.object({ challenge_id: z.string().optional(), repo: z.string().optional(), sha: z.string().optional() }),
      },
      async (args) => submit(args),
    );
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
