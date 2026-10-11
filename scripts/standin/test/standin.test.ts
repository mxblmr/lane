import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { provideServices, resetServices } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema/collections";
import type { Envelope } from "@lane/core/schema/envelope";
import type { LocalServer } from "@lane/core/testing/http";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { toolDoubles } from "@lane/core/testing/tools";
import { connectLane, type LaneClient } from "../../e2e/lane-client";
import { registerTestPlayer, type Db } from "../../e2e/scenarios";
import { serveLane } from "../../e2e/test/lane-server";
import { wireWithDoubles } from "../../e2e/test/doubles";
import { checkAE7, checkAE8, checkConsentOrder, laneToolsForModel, runStandin, scriptedReplies, type TranscriptEvent } from "../agent";
import { DEFAULT_STANDIN_MODEL, STANDIN_KEY_ENV, anthropicModel, isToolUse, type ContentBlock, type Message, type ModelClient, type ModelRequest } from "../model";
import { parseStandinArgs, runStandinScenarios, summarizeTranscript } from "../run";

// The stand-in harness against Lane's real tool runner on a local MCP port, with the real U6 and
// U18 services and doubles for units not merged yet. The model is a scripted double: these tests
// never call a model or the network.
let mongo: TestMongo;
let server: LocalServer;
let db: Db;
let lane: LaneClient;

beforeAll(async () => {
  mongo = await startReplSet();
  server = await serveLane(async () => db);
}, 120_000);

afterEach(async () => {
  resetServices();
  await lane?.close();
});

afterAll(async () => {
  await server?.close();
  await mongo?.stop();
});

async function setup(): Promise<void> {
  db = await mongo.freshDb();
  wireWithDoubles();
  lane = await connectLane(server.origin);
}

// ------------------------------------------------------------------- scripted model doubles

interface Seen {
  /** Results of the previous turn's tool calls, by tool name, parsed when JSON. */
  results: Array<{ name: string; value: unknown }>;
  requests: ModelRequest[];
}

let nextId = 0;
const use = (name: string, input: Record<string, unknown>): ContentBlock => ({ type: "tool_use", id: `tu_${(nextId += 1)}`, name, input });
const text = (t: string): ContentBlock => ({ type: "text", text: t });

/** A model double driven by a policy over the previous turn's tool results. */
function policyModel(policy: (seen: Seen) => ContentBlock[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async create(request) {
      requests.push(structuredClone(request));
      const last = request.messages[request.messages.length - 1]!;
      const prev = request.messages[request.messages.length - 2] as Message | undefined;
      const names = new Map<string, string>();
      if (prev?.role === "assistant") for (const b of prev.content) if (isToolUse(b)) names.set(b.id, b.name);
      const results: Seen["results"] = [];
      if (last.role === "user" && Array.isArray(last.content)) {
        for (const block of last.content) {
          if (block.type !== "tool_result") continue;
          let value: unknown = block.content;
          try {
            value = JSON.parse(block.content);
          } catch {
            // plain text result
          }
          results.push({ name: names.get(block.tool_use_id) ?? "?", value });
        }
      }
      const content = policy({ results, requests });
      return { content, stop_reason: content.some(isToolUse) ? "tool_use" : "end_turn" };
    },
  };
}

function lastLane(seen: Seen): Envelope | null {
  const r = seen.results.find((x) => x.name.startsWith("lane_"));
  return (r?.value as Envelope | undefined) ?? null;
}

/** AE7 the right way: relay Lane's question, send the answer back, ask before confirming. */
function ae7Policy(options: { askBeforeConfirm: boolean }) {
  let draftId = "";
  return (seen: Seen): ContentBlock[] => {
    if (seen.results.length === 0) return [use("lane_create_challenge", { sentence: "start Build in Public with my friends" })];
    const r = seen.results[0]!;
    if (r.name === "lane_create_challenge") {
      const env = r.value as Envelope;
      draftId = String(env.data?.draft_id);
      if (env.data?.kind === "question") return [use("ask_player", { question: String(env.data.question) })];
      if (options.askBeforeConfirm) return [use("ask_player", { question: "Which winner rule and how many play credits each?" })];
      return [use("lane_confirm_challenge", { draft_id: draftId, winner_rule: "top_score", stake: 50 })];
    }
    if (r.name === "ask_player") {
      const reply = String(r.value);
      if (/X and LinkedIn/.test(reply)) return [use("lane_create_challenge", { sentence: reply, draft_id: draftId })];
      return [use("lane_confirm_challenge", { draft_id: draftId, winner_rule: "top_score", stake: 50 })];
    }
    return [text("Your Build in Public challenge is live.")];
  };
}

/** AE8: check in, then relay every player action, the standing and the contract version. */
function ae8Policy(options: { doItMyself: boolean }) {
  return (seen: Seen): ContentBlock[] => {
    if (seen.results.length === 0) return [use("lane_check_in", {})];
    const env = lastLane(seen);
    if (seen.results[0]!.name === "lane_check_in" && env) {
      const lines: string[] = [];
      const blocks: ContentBlock[] = [];
      for (const c of env.challenges) {
        for (const a of c.actions.filter((x) => x.actor === "player")) {
          const code = a.instruction.match(/\b(?:LANE-[A-Z0-9]+|\d{4,})\b/)?.[0] ?? "";
          if (options.doItMyself) blocks.push(use("github_push_commit", { repo: "me/app", message: `wip ${code}` }));
          else lines.push(a.instruction);
        }
        const me = c.standings.find((s) => s.is_you);
        if (me) lines.push(`You are rank ${me.rank} with ${me.score} verified ${me.unit}.`);
        if (c.contract_changed && c.contract) lines.push(`Lane switched to contract version ${c.contract.version}: ${c.contract.changes.join(" ")}`);
      }
      if (options.doItMyself) return blocks.length > 0 ? blocks : [text("Done.")];
      return [use("tell_player", { message: lines.join("\n") })];
    }
    return [text("Routine done.")];
  };
}

// ------------------------------------------------------------------------------------ tests

describe("the stand-in's view of Lane", () => {
  it("gets Lane's own tool descriptions and schemas, without the player key argument", async () => {
    await setup();
    const tools = laneToolsForModel(await lane.listTools());
    expect(tools.map((t) => t.name).sort()).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(Object.keys(tool.input_schema.properties as object)).not.toContain("player_key");
    }
  });
});

describe("AE7", () => {
  it("relays the clarifying question, answers it and ends with an active challenge, asking before confirming", async () => {
    await setup();
    const model = policyModel(ae7Policy({ askBeforeConfirm: true }));
    const maya = await registerTestPlayer({ lane, runId: "t1", note: () => {} }, "Maya");
    const transcript = await runStandin({
      lane,
      model,
      playerKey: maya.key,
      playerName: maya.name,
      routineText: null,
      task: `${maya.name} says: "start Build in Public with my friends"`,
      player: scriptedReplies(["X and LinkedIn.", "Top score, 50 each."]),
    });
    expect(checkAE7(transcript)).toEqual({ ok: true, problems: [] });
    const confirmed = transcript.find((e) => e.type === "lane" && e.tool === "lane_confirm_challenge") as Extract<TranscriptEvent, { type: "lane" }>;
    const stored = await collections(db).challenges.findOne({ _id: confirmed.envelope.data?.challenge_id as never });
    expect(stored).toMatchObject({ type: "build_in_public", status: "active" });

    // The model never saw the key: not in the system prompt, the task or any tool result.
    for (const request of model.requests) expect(JSON.stringify(request)).not.toContain(maya.key);
  });

  it("fails the consent check when the stand-in confirms before the player answers", async () => {
    await setup();
    const maya = await registerTestPlayer({ lane, runId: "t2", note: () => {} }, "Maya");
    const transcript = await runStandin({
      lane,
      model: policyModel(ae7Policy({ askBeforeConfirm: false })),
      playerKey: maya.key,
      playerName: maya.name,
      routineText: null,
      task: "start Build in Public with my friends",
      player: scriptedReplies(["X and LinkedIn."]),
    });
    const consent = checkConsentOrder(transcript);
    expect(consent.ok).toBe(false);
    expect(consent.problems[0]).toMatch(/lane_confirm_challenge was called before the player answered/);
    expect(checkAE7(transcript).ok).toBe(false);
  });
});

describe("AE8", () => {
  it("relays the commit-code request, the standing and the new contract version from one check-in", async () => {
    await setup();
    const doubles = toolDoubles();
    provideServices({ checkin: doubles.overrides.checkin });
    const maya = await registerTestPlayer({ lane, runId: "t3", note: () => {} }, "Maya");
    const transcript = await runStandin({
      lane,
      model: policyModel(ae8Policy({ doItMyself: false })),
      playerKey: maya.key,
      playerName: maya.name,
      routineText: "Every 27 minutes, call lane_check_in and relay what Lane sends.",
      task: "Your Lane routine is due. Run it now.",
      player: scriptedReplies([]),
    });
    const told = transcript.filter((e) => e.type === "tell_player").map((e) => (e as { text: string }).text).join("\n");
    expect(told).toContain("4821");
    expect(told).toMatch(/contract version 2/);
    expect(checkAE8(transcript)).toEqual({ ok: true, problems: [] });
  });

  it("fails when the stand-in tries to put the code in a commit itself", async () => {
    await setup();
    const doubles = toolDoubles();
    provideServices({ checkin: doubles.overrides.checkin });
    const maya = await registerTestPlayer({ lane, runId: "t4", note: () => {} }, "Maya");
    const transcript = await runStandin({
      lane,
      model: policyModel(ae8Policy({ doItMyself: true })),
      playerKey: maya.key,
      playerName: maya.name,
      routineText: null,
      task: "Your Lane routine is due. Run it now.",
      player: scriptedReplies([]),
    });
    const check = checkAE8(transcript);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toMatch(/tried to do the extra_proof itself/);
    expect(check.problems.join(" ")).toMatch(/code 4821 was not relayed/);
  });
});

describe("runStandinScenarios on main's services", () => {
  it("passes AE7 and AE8 (bind code relay) with well-behaved model doubles", async () => {
    await setup();
    const scenarioModel: ModelClient = {
      create: async (request) => {
        const first = request.messages[0]!.content as string;
        return (first.includes("Build in Public") ? ae7Model : ae8Model).create(request);
      },
    };
    const ae7Model = policyModel(ae7Policy({ askBeforeConfirm: true }));
    const ae8Model = policyModel(ae8Policy({ doItMyself: false }));
    const results = await runStandinScenarios({ lane, model: scenarioModel, runId: "t5" }, ["AE7", "AE8"]);
    expect(results.map((r) => [r.id, r.status, r.problems])).toEqual([
      ["AE7", "pass", []],
      ["AE8", "pass", []],
    ]);
    const ae8 = results[1]!.transcript;
    expect(ae8.some((e) => e.type === "tell_player" && /LANE-[A-Z0-9]+/.test(e.text))).toBe(true);
    for (const line of summarizeTranscript(ae8)) expect(line).not.toMatch(/lane_pk_/);
  }, 60_000);

  it("parses --url and --only", () => {
    expect(parseStandinArgs(["--url", "https://lane.example.com"])).toEqual({ url: "https://lane.example.com/api/mcp", only: ["AE7", "AE8"] });
    expect(parseStandinArgs(["--url=https://x.test", "--only", "ae8"]).only).toEqual(["AE8"]);
    expect(() => parseStandinArgs(["--url", "https://x.test", "--only", "AE1"])).toThrow(/Unknown stand-in scenario/);
    expect(() => parseStandinArgs([])).toThrow(/--url/);
  });
});

describe("anthropicModel", () => {
  it("reads the key from the environment variable name and sends a Messages API request", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), { status: 200 });
    }) as unknown as typeof fetch;
    const model = anthropicModel({ env: { [STANDIN_KEY_ENV]: "test-key-not-real" }, fetchImpl });
    const out = await model.create({ system: "s", messages: [{ role: "user", content: "go" }], tools: [] });
    expect(out).toEqual({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-not-real");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ model: DEFAULT_STANDIN_MODEL, tool_choice: { type: "auto" }, system: "s" });
    expect(body.thinking).toBeUndefined();
  });

  it("refuses to start without the key and reports API errors without echoing the key", async () => {
    expect(() => anthropicModel({ env: {} })).toThrow(new RegExp(STANDIN_KEY_ENV));
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 })) as unknown as typeof fetch;
    const model = anthropicModel({ env: { [STANDIN_KEY_ENV]: "test-key-not-real" }, fetchImpl, model: "claude-opus-5-5" });
    await expect(model.create({ system: "", messages: [{ role: "user", content: "x" }], tools: [] })).rejects.toThrow(/401: authentication_error/);
    await expect(model.create({ system: "", messages: [{ role: "user", content: "x" }], tools: [] })).rejects.not.toThrow(/test-key-not-real/);
  });
});
