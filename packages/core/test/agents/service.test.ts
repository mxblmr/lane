import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { agentClientConfigFromEnv, createAgentClient, type AgentClient } from "../../src/agents/client";
import { createAgentsService, type PromptLoader } from "../../src/agents/service";
import type { AgentInvokeInput, AgentResumeInput } from "../../src/interfaces";
import {
  agentOutputJsonSchema,
  internalApiDescription,
  quote,
  type PromoterInput,
  type RefereeProofInput,
  type RuleLabInput,
} from "../../src/schema/agents";
import { AGENT_ENGINE_DEFAULT_BASE_URL } from "../../src/agents/client";
import { TOKEN_PATH, cloudConfig, completed, fakeFetch, invokeBody, json, tokenResponse, type Handler } from "./doubles";

const LANE_URL = "https://lane.example.test";

const refereeInput: RefereeProofInput = {
  mode: "proof",
  challenge_type: "ship_week",
  contract_version: 1,
  does_not_count: ["Merge commits with no change of their own."],
  cheat_classes: ["rename_only"],
  features: { files_changed: 3, renamed_only: false },
  trust_level: "rechecked",
  proof: quote("Shipped the login page."),
  source_text: quote("feat: login page"),
  source_diff: null,
};
const refereeOutput = { verdict: "accept", reason: "A real commit.", fix: "", cheat_class: null, confidence: 0.9, extra_proof: null };

const ruleLabInput: RuleLabInput = {
  mode: "write_rule",
  challenge_type: "ship_week",
  source: "ai_judgment",
  cheat_class: "rename_only",
  evidence: [quote("Renamed three files and called it shipped.")],
  evidence_features: { renamed_only: true },
  evidence_proof_ids: ["proof_1"],
  evidence_example_keys: [],
  parent: null,
  max_revisions: 2,
  max_examples: 0,
  no_egress: false,
};
const ruleLabOutput = { outcome: "proposed", candidate_ids: ["cand_1"], example_keys: [], notes: "One rule.", proposal: null, examples: [] };

const promoterInput: PromoterInput = {
  candidate_id: "cand_1",
  rule_key: "no_rename_only",
  version: 1,
  challenge_type: "ship_week",
  action: "reject",
  requires_approval: true,
  line: "Renaming files does not count.",
  gate: { passed: true, target_class: "rename_only", catch_rate_before: 0, catch_rate_after: 1, false_alarm_rule: 0, false_alarm_set: 0 },
  no_egress: false,
};
const interrupt = { candidate_id: "cand_1", action: "reject", line: "Renaming files does not count.", allowed_decisions: ["approve", "decline"] };

function setup(handler: Handler, options: { laneBaseUrl?: string | undefined; loadPrompt?: PromptLoader } = {}) {
  const { fetchImpl, calls } = fakeFetch((call) => (call.url.pathname === TOKEN_PATH ? tokenResponse() : handler(call)));
  const prompts: string[] = [];
  const loadPrompt: PromptLoader =
    options.loadPrompt ??
    (async (workspace, mode) => {
      prompts.push(`${workspace}.${mode}`);
      return `Prompt for ${workspace}.${mode}`;
    });
  const laneBaseUrl = "laneBaseUrl" in options ? options.laneBaseUrl : LANE_URL;
  const service = createAgentsService({
    client: createAgentClient(cloudConfig(fetchImpl)),
    loadPrompt,
    laneBaseUrl: () => laneBaseUrl,
  });
  const agentCalls = () => calls.filter((c) => c.url.pathname !== TOKEN_PATH);
  return { service, calls, agentCalls, prompts };
}

let errors: MockInstance<typeof console.error>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

describe("agents service invoke", () => {
  it("sends the loaded prompt, the mode's output schema and the parsed input, and returns U3's completed shape", async () => {
    const { service, agentCalls, prompts } = setup(() => completed(refereeOutput, "ex-ref"));

    const result = await service.invoke({ workspace: "referee", mode: "proof", input: refereeInput, meta: { proof_id: "proof_1" } });

    expect(prompts).toEqual(["referee.proof"]);
    const [call] = agentCalls();
    expect(call!.url.href).toBe(`${AGENT_ENGINE_DEFAULT_BASE_URL}/api/v1/projects/proj-1/workspaces/ws-ref/invoke`);
    expect(call!.headers.get("x-session-id")).toBe("lane-referee");
    expect(invokeBody(call!)).toEqual({
      message: "Lane referee",
      lane: {
        workspace: "referee",
        prompt: "Prompt for referee.proof",
        output_schema: agentOutputJsonSchema("referee", "proof"),
        input: refereeInput,
        internal_api: null,
      },
    });
    // Exactly U3's fields: the client's extra diagnostics stay inside the adapter.
    expect(result).toEqual({ ok: true, status: "completed", output: refereeOutput, execution_id: "ex-ref", latency_ms: expect.any(Number) });
  });

  it("passes the internal API contract for rule-lab, with a fresh session per run", async () => {
    const { service, agentCalls } = setup(() => completed(ruleLabOutput, "ex-lab"));

    const result = await service.invoke({ workspace: "rule_lab", mode: "write_rule", input: ruleLabInput });

    const body = invokeBody(agentCalls()[0]!);
    const lane = body.lane as Record<string, unknown>;
    expect(lane.internal_api).toEqual(internalApiDescription("rule_lab", LANE_URL));
    expect(lane.output_schema).toEqual(agentOutputJsonSchema("rule_lab", "write_rule"));
    expect(agentCalls()[0]!.headers.get("x-session-id")).toMatch(/^lane-rule_lab-[0-9a-f-]{36}$/);
    expect(result).toEqual({ ok: true, status: "completed", output: ruleLabOutput, execution_id: "ex-lab", latency_ms: expect.any(Number) });
  });

  it("maps a suspended promoter to U3's suspended shape and sends the promoter's contract", async () => {
    const { service, agentCalls } = setup(() =>
      json({ success: true, execution_id: "ex-pro", status: "suspended", suspend_reason: "awaiting_human_review", suspend_context: interrupt }),
    );

    const result = await service.invoke({ workspace: "promoter", mode: "promote", input: promoterInput });

    const call = agentCalls()[0]!;
    expect(call.headers.get("x-session-id")).toBe("lane-promoter-cand_1");
    expect((invokeBody(call).lane as Record<string, unknown>).internal_api).toEqual(internalApiDescription("promoter", LANE_URL));
    expect(result).toEqual({
      ok: true,
      status: "suspended",
      execution_id: "ex-pro",
      workspace_id: "ws-pro",
      interrupt,
      latency_ms: expect.any(Number),
    });
  });

  it("reports an answer that fails the mode's output schema as a failure with U3's fields", async () => {
    const { service } = setup(() => completed({ verdict: "maybe", reason: "?" }, "ex-bad"));

    const result = await service.invoke({ workspace: "referee", mode: "proof", input: refereeInput });

    expect(result).toEqual({
      ok: false,
      error: expect.any(String),
      schema_valid: false,
      timed_out: false,
      execution_id: "ex-bad",
      latency_ms: expect.any(Number),
    });
    expect(errors).toHaveBeenCalled();
  });

  it("reports an Agent Engine error without throwing", async () => {
    const { service } = setup(() => json({ detail: "boom" }, 500));

    const result = await service.invoke({ workspace: "referee", mode: "proof", input: refereeInput });

    expect(result).toMatchObject({ ok: false, schema_valid: true, timed_out: false, execution_id: null });
    expect(errors).toHaveBeenCalled();
  });

  it("refuses an unknown mode, an invalid input or a missing LANE_BASE_URL without calling Agent Engine", async () => {
    const unknownMode = setup(() => completed(refereeOutput));
    const badInput = setup(() => completed(refereeOutput));
    const noBase = setup(() => completed(ruleLabOutput), { laneBaseUrl: undefined });
    const relativeBase = setup(() => completed(ruleLabOutput), { laneBaseUrl: "/api" });

    const results = [
      await unknownMode.service.invoke({ workspace: "referee", mode: "verdict", input: refereeInput }),
      await badInput.service.invoke({
        workspace: "referee",
        mode: "proof",
        input: { ...refereeInput, proof: "raw text, not quoted" } as unknown as RefereeProofInput,
      }),
      await noBase.service.invoke({ workspace: "rule_lab", mode: "write_rule", input: ruleLabInput }),
      await relativeBase.service.invoke({ workspace: "promoter", mode: "promote", input: promoterInput }),
    ];

    for (const result of results) {
      expect(result).toEqual({ ok: false, error: expect.any(String), schema_valid: true, timed_out: false, execution_id: null, latency_ms: expect.any(Number) });
    }
    expect(results[1]).toMatchObject({ error: expect.stringContaining("proof") });
    expect(results[2]).toMatchObject({ error: expect.stringContaining("LANE_BASE_URL") });
    for (const run of [unknownMode, badInput, noBase, relativeBase]) {
      expect(run.calls).toHaveLength(0);
      expect(run.prompts).toEqual([]);
    }
  });

  it("returns a failure when Agent Engine is not configured, and retries the configuration on the next call", async () => {
    let builds = 0;
    const service = createAgentsService({
      client: () => {
        builds += 1;
        return createAgentClient(agentClientConfigFromEnv({}));
      },
      loadPrompt: async () => "p",
    });
    const input: AgentInvokeInput<"referee"> = { workspace: "referee", mode: "proof", input: refereeInput };

    const first = await service.invoke(input);
    const second = await service.invoke(input);

    expect(first).toMatchObject({ ok: false, execution_id: null, error: expect.stringContaining("AGENT_ENGINE_PROJECT_ID") });
    expect(second).toMatchObject({ ok: false });
    expect(builds).toBe(2);
  });

  it("returns a failure when the prompt cannot be loaded", async () => {
    const { service, calls } = setup(() => completed(refereeOutput), {
      loadPrompt: async () => {
        throw new Error("no prompt");
      },
    });

    const result = await service.invoke({ workspace: "referee", mode: "proof", input: refereeInput });

    expect(result).toMatchObject({ ok: false, execution_id: null, error: expect.stringContaining("no prompt") });
    expect(calls).toHaveLength(0);
  });

  it("builds the client once and reuses it", async () => {
    let builds = 0;
    const { fetchImpl } = fakeFetch((call) => (call.url.pathname === TOKEN_PATH ? tokenResponse() : completed(refereeOutput)));
    const service = createAgentsService({
      client: (): AgentClient => {
        builds += 1;
        return createAgentClient(cloudConfig(fetchImpl));
      },
      loadPrompt: async () => "p",
    });

    await service.invoke({ workspace: "referee", mode: "proof", input: refereeInput });
    await service.invoke({ workspace: "referee", mode: "proof", input: refereeInput });

    expect(builds).toBe(1);
  });
});

describe("agents service resume", () => {
  const resumeInput: AgentResumeInput = { workspace: "promoter", execution_id: "ex-pro", decision: "approve" };

  function resumeHandler(answer: unknown): Handler {
    return (call) =>
      call.method === "POST"
        ? json({ success: true, execution_id: "ex-pro", status: "resuming" })
        : json({ success: true, execution: { execution_id: "ex-pro", status: "completed", result: JSON.stringify(answer) } });
  }

  it("resumes with a flat decision body and validates the answer against PromoterOutputSchema", async () => {
    const answer = { decision: "activated", candidate_id: "cand_1", rule_status: "active", notes: "Activated after approval." };
    const { service, agentCalls } = setup(resumeHandler(answer));

    const result = await service.resume(resumeInput);

    const post = agentCalls().find((c) => c.method === "POST")!;
    expect(post.url.href).toBe(`${AGENT_ENGINE_DEFAULT_BASE_URL}/api/v1/projects/proj-1/executions/ex-pro/resume?workspace_id=ws-pro`);
    expect(JSON.parse(post.body ?? "{}")).toEqual({ decision: "approve" });
    expect(result).toEqual({ ok: true, status: "completed", output: answer, execution_id: "ex-pro", latency_ms: expect.any(Number) });
  });

  it("reports a resumed answer that fails PromoterOutputSchema as a schema failure", async () => {
    const { service } = setup(resumeHandler({ decision: "activated", candidate_id: "cand_1" }));

    const result = await service.resume({ ...resumeInput, decision: "decline" });

    expect(result).toMatchObject({ ok: false, schema_valid: false, execution_id: "ex-pro" });
  });

  it("refuses to resume a workspace other than the promoter", async () => {
    const { service, calls } = setup(resumeHandler({}));

    const result = await service.resume({ ...resumeInput, workspace: "referee" } as unknown as AgentResumeInput);

    expect(result).toMatchObject({ ok: false, execution_id: null });
    expect(calls).toHaveLength(0);
  });
});
