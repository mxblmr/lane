import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_ENGINE_DEFAULT_BASE_URL,
  AgentClientConfigError,
  TOKEN_REFRESH_MARGIN_MS,
  agentClientConfigFromEnv,
  agentSessionId,
  createAgentClient,
  type AgentClientConfig,
} from "../../src/agents/client";
import { TOKEN_PATH, WORKSPACE_IDS, cloudConfig, completed, fakeFetch, invokeBody, json, tokenResponse } from "./doubles";

// Fixture schemas. The real agent schemas belong to U3 (`schema/agents.ts`).
const VerdictSchema = z.object({
  verdict: z.enum(["accept", "reject", "ask_more"]),
  reason: z.string().max(500),
});
const PromotionSchema = z.object({
  decision: z.enum(["activated", "rejected", "declined"]),
  candidate_id: z.string(),
});

function clock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function refereeRequest(input: unknown) {
  return { workspace: "referee" as const, prompt: "Review the proof.", input, outputSchema: VerdictSchema };
}

const promoterInput = { candidate_id: "cand_1", requires_approval: true, action: "reject", line: "No merge commits." };

describe("service account token", () => {
  it("fetches one token with Basic auth and reuses it until five minutes before expiry", async () => {
    const time = clock();
    let issued = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse(`tok-${++issued}`);
      return completed({ verdict: "accept", reason: "ok" });
    });
    const client = createAgentClient(cloudConfig(fetchImpl, { now: time.now }));

    await client.invoke(refereeRequest({ n: 1 }));
    time.advance(3600_000 - TOKEN_REFRESH_MARGIN_MS - 1);
    await client.invoke(refereeRequest({ n: 2 }));
    time.advance(2);
    await client.invoke(refereeRequest({ n: 3 }));

    const tokenCalls = calls.filter((c) => c.url.pathname === TOKEN_PATH);
    expect(tokenCalls).toHaveLength(2);
    const first = tokenCalls[0]!;
    expect(first.method).toBe("POST");
    expect(first.url.origin).toBe(AGENT_ENGINE_DEFAULT_BASE_URL);
    expect(first.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("ae_sa_id_test:ae_sa_sk_test").toString("base64")}`,
    );
    expect(first.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(first.body).toBe("grant_type=client_credentials");

    const invokes = calls.filter((c) => c.url.pathname !== TOKEN_PATH);
    expect(invokes.map((c) => c.headers.get("authorization"))).toEqual([
      "Bearer tok-1",
      "Bearer tok-1",
      "Bearer tok-2",
    ]);
  });

  it("shares one token request between concurrent calls", async () => {
    const { fetchImpl, calls } = fakeFetch(async (call) => {
      if (call.url.pathname === TOKEN_PATH) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return tokenResponse();
      }
      return completed({ verdict: "accept", reason: "ok" });
    });
    const client = createAgentClient(cloudConfig(fetchImpl));

    const results = await Promise.all([1, 2, 3].map((n) => client.invoke(refereeRequest({ n }))));

    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls.filter((c) => c.url.pathname === TOKEN_PATH)).toHaveLength(1);
  });

  it("reports a rejected token request as an auth error and sends no invoke", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ error: "invalid_client" }, 401));
    const client = createAgentClient(cloudConfig(fetchImpl));

    const result = await client.invoke(refereeRequest({}));

    expect(result).toMatchObject({ ok: false, reason: "auth_error", http_status: 401, schema_valid: true });
    expect(calls).toHaveLength(1);
  });

  it("drops a cached token after a 401 so the next call fetches a new one", async () => {
    let issued = 0;
    let invokes = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse(`tok-${++issued}`);
      return ++invokes === 1 ? json({ error: "token revoked" }, 401) : completed({ verdict: "accept", reason: "ok" });
    });
    const client = createAgentClient(cloudConfig(fetchImpl));

    const first = await client.invoke(refereeRequest({}));
    const second = await client.invoke(refereeRequest({}));

    expect(first).toMatchObject({ ok: false, reason: "auth_error" });
    expect(second.ok).toBe(true);
    expect(calls.filter((c) => c.url.pathname === TOKEN_PATH)).toHaveLength(2);
  });
});

describe("invoke request shapes", () => {
  it("sends the cloud shape: workspace URL, bearer token, X-Session-ID header and the lane payload", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url.pathname === TOKEN_PATH ? tokenResponse() : completed({ verdict: "reject", reason: "duplicate" }),
    );
    const client = createAgentClient(cloudConfig(fetchImpl));
    const input = { mode: "proof", proof: { quoted_data: "did 20 pushups", note: "untrusted" } };

    const result = await client.invoke(refereeRequest(input));

    const call = calls[1]!;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe(`${AGENT_ENGINE_DEFAULT_BASE_URL}/api/v1/projects/proj-1/workspaces/ws-ref/invoke`);
    expect(call.headers.get("authorization")).toBe("Bearer tok-1");
    expect(call.headers.get("x-session-id")).toBe("lane-referee");
    expect(invokeBody(call)).toEqual({
      message: "Lane referee",
      lane: {
        workspace: "referee",
        prompt: "Review the proof.",
        output_schema: z.toJSONSchema(VerdictSchema, { unrepresentable: "any" }),
        input,
        internal_api: null,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      output: { verdict: "reject", reason: "duplicate" },
      execution_id: "ex-1",
      session_id: "lane-referee",
    });
  });

  it("sends the local shape: tunnel URL with the agent name, no auth, session id in the body", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ execution_id: "loc-1", result: JSON.stringify({ verdict: "accept", reason: "ok" }), status: "completed" }),
    );
    const client = createAgentClient({ mode: "local", localUrl: "https://lane-dev.example.test", fetch: fetchImpl });
    const internalApi = { role_key_header: "x-lane-role-key", role: "rule_lab", endpoints: {} };

    const result = await client.invoke({
      workspace: "rule_lab",
      prompt: "Write a rule.",
      input: { mode: "write_rule" },
      outputSchema: VerdictSchema,
      internalApi,
      sessionId: "lane-rule_lab-run_7",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.href).toBe("https://lane-dev.example.test/invoke?workspace=rule-lab");
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("x-session-id")).toBe("lane-rule_lab-run_7");
    const body = invokeBody(call);
    expect(body).toMatchObject({ message: "Lane rule_lab", session_id: "lane-rule_lab-run_7", wait: true });
    expect((body.lane as Record<string, unknown>).internal_api).toEqual(internalApi);
    expect(result).toMatchObject({ ok: true, output: { verdict: "accept" }, execution_id: "loc-1" });
  });

  it("polls the execution while it is pending", async () => {
    const time = clock();
    let polls = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse();
      if (call.method === "POST") return json({ success: true, execution_id: "ex-9", status: "running" });
      polls += 1;
      return polls < 2
        ? json({ success: true, execution: { execution_id: "ex-9", status: "running" } })
        : json({
            success: true,
            execution: { execution_id: "ex-9", status: "completed", result: { verdict: "ask_more", reason: "blurry" } },
          });
    });
    const client = createAgentClient(cloudConfig(fetchImpl, { now: time.now, sleep: async (ms) => time.advance(ms) }));

    const result = await client.invoke(refereeRequest({}));

    expect(result).toMatchObject({ ok: true, output: { verdict: "ask_more" }, execution_id: "ex-9" });
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(2);
    expect(gets[0]!.url.href).toBe(
      `${AGENT_ENGINE_DEFAULT_BASE_URL}/api/v1/projects/proj-1/executions/ex-9?workspace_id=ws-ref`,
    );
  });

  it("times out when the execution never finishes", async () => {
    const time = clock();
    const { fetchImpl } = fakeFetch((call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse();
      return json({ success: true, execution_id: "ex-slow", status: "running" });
    });
    const client = createAgentClient(
      cloudConfig(fetchImpl, { now: time.now, sleep: async (ms) => time.advance(ms), timeoutMs: 5_000, pollIntervalMs: 1_000 }),
    );

    const result = await client.invoke(refereeRequest({}));

    expect(result).toMatchObject({ ok: false, reason: "timeout", timed_out: true, execution_id: "ex-slow" });
  });
});

describe("schema validation", () => {
  async function invokeWith(response: () => Response) {
    const { fetchImpl } = fakeFetch((call) => (call.url.pathname === TOKEN_PATH ? tokenResponse() : response()));
    return createAgentClient(cloudConfig(fetchImpl)).invoke(refereeRequest({}));
  }

  it("reports an answer that fails its schema as a failure, never an acceptance", async () => {
    const result = await invokeWith(() => completed({ verdict: "accept_with_bonus", reason: "trust me" }));

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("output");
    expect(result).toMatchObject({ reason: "schema_invalid", schema_valid: false, timed_out: false, execution_id: "ex-1" });
  });

  it("reports an answer that is not JSON as a schema failure", async () => {
    const result = await invokeWith(() => completed("I think this proof is fine."));

    expect(result).toMatchObject({ ok: false, reason: "schema_invalid", schema_valid: false });
  });

  it("accepts a fenced JSON answer and a message object answer", async () => {
    const fenced = await invokeWith(() => completed('```json\n{"verdict":"accept","reason":"ok"}\n```'));
    const message = await invokeWith(() =>
      json({
        success: true,
        execution_id: "ex-2",
        status: "completed",
        response: { type: "ai", content: [{ type: "text", text: '{"verdict":"reject","reason":"late"}' }] },
      }),
    );

    expect(fenced).toMatchObject({ ok: true, output: { verdict: "accept" } });
    expect(message).toMatchObject({ ok: true, output: { verdict: "reject" } });
  });

  it("unwraps the LangGraph adapter's response wrapper before validating", async () => {
    const wrapper = (text: string) => () =>
      json({
        success: true,
        execution_id: "ex-4",
        status: "completed",
        response: { response: text, execution_id: "lane-referee:ws-ref:ex-4", status: "completed", message_count: 3, resumed: false },
      });

    const valid = await invokeWith(wrapper('{"verdict":"accept","reason":"ok"}'));
    const prose = await invokeWith(wrapper("Looks fine to me."));

    expect(valid).toMatchObject({ ok: true, output: { verdict: "accept", reason: "ok" }, execution_id: "ex-4" });
    expect(prose).toMatchObject({ ok: false, reason: "schema_invalid", schema_valid: false });
  });

  it("reports agent errors, HTTP errors and network errors as failures", async () => {
    const agentError = await invokeWith(() =>
      json({ success: false, execution_id: "ex-3", status: "error", error: "LLM call failed" }),
    );
    const httpError = await invokeWith(() => json({ error: "pool full" }, 503));
    const { fetchImpl } = fakeFetch((call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse();
      throw new TypeError("fetch failed");
    });
    const networkError = await createAgentClient(cloudConfig(fetchImpl)).invoke(refereeRequest({}));

    expect(agentError).toMatchObject({ ok: false, reason: "agent_error", error: "LLM call failed", schema_valid: true });
    expect(httpError).toMatchObject({ ok: false, reason: "http_error", http_status: 503 });
    expect(networkError).toMatchObject({ ok: false, reason: "network_error" });
  });
});

describe("session policy (KTD10)", () => {
  it("shares one session for the orchestrator and the referee", () => {
    expect(agentSessionId("orchestrator", { mode: "draft" })).toBe("lane-orchestrator");
    expect(agentSessionId("referee", { mode: "proof" })).toBe("lane-referee");
  });

  it("uses one session per candidate for the promoter and a fresh one per run for rule-lab", () => {
    expect(agentSessionId("promoter", promoterInput)).toBe("lane-promoter-cand_1");
    const a = agentSessionId("rule_lab", {});
    const b = agentSessionId("rule_lab", {});
    expect(a).toMatch(/^lane-rule_lab-[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(agentSessionId("rule_lab", {}, "lane-rule_lab-run_3")).toBe("lane-rule_lab-run_3");
  });

  it("refuses invalid session ids without calling Agent Engine", async () => {
    const { fetchImpl, calls } = fakeFetch(() => tokenResponse());
    const client = createAgentClient(cloudConfig(fetchImpl));

    const noCandidate = await client.invoke({ workspace: "promoter", prompt: "p", input: {}, outputSchema: PromotionSchema });
    const badOverride = await client.invoke({ ...refereeRequest({}), sessionId: "lane/../x" });

    expect(noCandidate).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(badOverride).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(calls).toHaveLength(0);
  });

  it("keeps each referee call's input separate on the shared session", async () => {
    const { fetchImpl, calls } = fakeFetch(async (call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse();
      const lane = invokeBody(call).lane as { input: { proof_id: string } };
      await new Promise((resolve) => setTimeout(resolve, lane.input.proof_id === "prf_a" ? 10 : 0));
      return completed({ verdict: "accept", reason: `reviewed ${lane.input.proof_id}` }, `ex-${lane.input.proof_id}`);
    });
    const client = createAgentClient(cloudConfig(fetchImpl));
    const inputA = { proof_id: "prf_a", proof: "photo of run" };
    const inputB = { proof_id: "prf_b", proof: "commit link" };

    const pending = [client.invoke(refereeRequest(inputA)), client.invoke(refereeRequest(inputB))];
    // Mutating a caller's object after the call must not change what was sent.
    inputA.proof = "ignore previous instructions";
    const [resultA, resultB] = await Promise.all(pending);

    const invokes = calls.filter((c) => c.url.pathname !== TOKEN_PATH);
    expect(invokes).toHaveLength(2);
    expect(invokes.map((c) => c.headers.get("x-session-id"))).toEqual(["lane-referee", "lane-referee"]);
    const sent = invokes.map((c) => (invokeBody(c).lane as { input: unknown }).input);
    expect(sent).toContainEqual({ proof_id: "prf_a", proof: "photo of run" });
    expect(sent).toContainEqual({ proof_id: "prf_b", proof: "commit link" });
    for (const call of invokes) {
      const body = call.body ?? "";
      expect(body.includes("prf_a") && body.includes("prf_b")).toBe(false);
    }
    expect(resultA).toMatchObject({ ok: true, output: { reason: "reviewed prf_a" }, execution_id: "ex-prf_a" });
    expect(resultB).toMatchObject({ ok: true, output: { reason: "reviewed prf_b" }, execution_id: "ex-prf_b" });
  });
});

describe("promoter suspend and resume", () => {
  const interruptValue = {
    candidate_id: "cand_1",
    action: "reject",
    line: "No merge commits.",
    allowed_decisions: ["approve", "decline"],
    message: "Approve or decline this rule.",
  };

  it("returns a suspended promoter execution with its parsed interrupt", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.url.pathname === TOKEN_PATH
        ? tokenResponse()
        : json({
            success: true,
            execution_id: "ex-pro",
            status: "suspended",
            suspend_reason: "awaiting_human_review",
            suspend_context: interruptValue,
          }),
    );
    const client = createAgentClient(cloudConfig(fetchImpl));

    const result = await client.invoke({ workspace: "promoter", prompt: "Promote.", input: promoterInput, outputSchema: PromotionSchema });

    expect(calls[1]!.headers.get("x-session-id")).toBe("lane-promoter-cand_1");
    expect(result).toEqual({
      ok: true,
      status: "suspended",
      execution_id: "ex-pro",
      workspace_id: "ws-pro",
      interrupt: { candidate_id: "cand_1", action: "reject", line: "No merge commits.", allowed_decisions: ["approve", "decline"] },
      suspend_reason: "awaiting_human_review",
      suspend_context: interruptValue,
      session_id: "lane-promoter-cand_1",
      latency_ms: expect.any(Number),
    });
  });

  it("treats a suspension from another workspace or an unreadable interrupt as a failure", async () => {
    const suspended = (context: unknown) => () =>
      json({ success: true, execution_id: "ex-s", status: "suspended", suspend_context: context });
    const run = async (workspace: "referee" | "promoter", response: () => Response) => {
      const { fetchImpl } = fakeFetch((call) => (call.url.pathname === TOKEN_PATH ? tokenResponse() : response()));
      const schema: z.ZodType<unknown> = workspace === "referee" ? VerdictSchema : PromotionSchema;
      return createAgentClient(cloudConfig(fetchImpl)).invoke({ workspace, prompt: "p", input: promoterInput, outputSchema: schema });
    };

    expect(await run("referee", suspended(interruptValue))).toMatchObject({
      ok: false,
      reason: "unexpected_interrupt",
      execution_id: "ex-s",
    });
    expect(await run("promoter", suspended({ question: "?" }))).toMatchObject({ ok: false, reason: "bad_response" });
  });

  it("reads the interrupt from the adapter's raw interrupt values", async () => {
    const payload = { suspend_reason: "awaiting_human_review", suspend_context: interruptValue };
    const run = async (body: Record<string, unknown>) => {
      const { fetchImpl } = fakeFetch((call) =>
        call.url.pathname === TOKEN_PATH ? tokenResponse() : json({ success: true, execution_id: "ex-raw", status: "suspended", ...body }),
      );
      return createAgentClient(cloudConfig(fetchImpl)).invoke({ workspace: "promoter", prompt: "p", input: promoterInput, outputSchema: PromotionSchema });
    };
    const expected = { candidate_id: "cand_1", action: "reject", line: "No merge commits.", allowed_decisions: ["approve", "decline"] };

    const fromValues = await run({ suspend_context: { checkpoint_id: "chk_1", interrupt_values: [payload] } });
    const fromInterrupts = await run({ interrupts: [{ id: "int_1", value: payload }] });

    expect(fromValues).toMatchObject({ ok: true, status: "suspended", interrupt: expected });
    expect(fromInterrupts).toMatchObject({ ok: true, status: "suspended", interrupt: expected, suspend_context: {} });
  });

  it("resumes in the cloud with a flat decision body and waits for the answer", async () => {
    let polls = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.pathname === TOKEN_PATH) return tokenResponse();
      if (call.method === "POST") return json({ success: true, execution_id: "ex-pro", status: "resuming" });
      polls += 1;
      // The first read still shows the state from before the resume.
      return polls === 1
        ? json({ success: true, execution: { execution_id: "ex-pro", status: "suspended", suspend_context: interruptValue } })
        : json({
            success: true,
            execution: {
              execution_id: "ex-pro",
              status: "completed",
              result: JSON.stringify({ decision: "activated", candidate_id: "cand_1" }),
            },
          });
    });
    const client = createAgentClient(cloudConfig(fetchImpl));

    const result = await client.resume({
      workspace: "promoter",
      executionId: "ex-pro",
      decision: "approve",
      reviewerNotes: "Looks right.",
      outputSchema: PromotionSchema,
    });

    const resume = calls.find((c) => c.method === "POST" && c.url.pathname !== TOKEN_PATH)!;
    expect(resume.url.href).toBe(
      `${AGENT_ENGINE_DEFAULT_BASE_URL}/api/v1/projects/proj-1/executions/ex-pro/resume?workspace_id=ws-pro`,
    );
    expect(resume.headers.get("authorization")).toBe("Bearer tok-1");
    expect(resume.body).toBe(JSON.stringify({ decision: "approve", reviewer_notes: "Looks right." }));
    expect(JSON.parse(resume.body ?? "{}")).not.toHaveProperty("human_review");
    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      output: { decision: "activated", candidate_id: "cand_1" },
      execution_id: "ex-pro",
    });
  });

  it("resumes locally on the tunnel's review path", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ execution_id: "ex-pro", status: "completed", result: { decision: "declined", candidate_id: "cand_1" } }),
    );
    const client = createAgentClient({ mode: "local", localUrl: "https://lane-dev.example.test", fetch: fetchImpl });

    const result = await client.resume({ workspace: "promoter", executionId: "ex-pro", decision: "decline", outputSchema: PromotionSchema });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe("https://lane-dev.example.test/api/v1/executions/ex-pro/resume?workspace=promoter");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(calls[0]!.body).toBe(JSON.stringify({ decision: "decline" }));
    expect(result).toMatchObject({ ok: true, output: { decision: "declined" } });
  });

  it("refuses an unknown decision or a malformed execution id without calling Agent Engine", async () => {
    const { fetchImpl, calls } = fakeFetch(() => tokenResponse());
    const client = createAgentClient(cloudConfig(fetchImpl));

    const badDecision = await client.resume({
      workspace: "promoter",
      executionId: "ex-pro",
      decision: "approved" as "approve",
      outputSchema: PromotionSchema,
    });
    const badId = await client.resume({ workspace: "promoter", executionId: "../x", decision: "approve", outputSchema: PromotionSchema });

    expect(badDecision).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(badId).toMatchObject({ ok: false, reason: "invalid_request" });
    expect(calls).toHaveLength(0);
  });
});

describe("configuration", () => {
  const cloudEnv = {
    AGENT_ENGINE_MODE: "cloud",
    AGENT_ENGINE_PROJECT_ID: "proj-1",
    AGENT_ENGINE_CLIENT_ID: "ae_sa_id_x",
    AGENT_ENGINE_CLIENT_SECRET: "ae_sa_sk_x",
    AGENT_ENGINE_WORKSPACE_ORCHESTRATOR: "ws-orc",
    AGENT_ENGINE_WORKSPACE_REFEREE: "ws-ref",
    AGENT_ENGINE_WORKSPACE_RULE_LAB: "ws-lab",
    AGENT_ENGINE_WORKSPACE_PROMOTER: "ws-pro",
  };

  it("reads cloud mode from the U1 variable names and defaults the base URL", () => {
    expect(agentClientConfigFromEnv(cloudEnv)).toEqual({
      mode: "cloud",
      baseUrl: AGENT_ENGINE_DEFAULT_BASE_URL,
      projectId: "proj-1",
      clientId: "ae_sa_id_x",
      clientSecret: "ae_sa_sk_x",
      workspaceIds: WORKSPACE_IDS,
    });
  });

  it("names every missing cloud variable", () => {
    expect(() => agentClientConfigFromEnv({ AGENT_ENGINE_MODE: "cloud", AGENT_ENGINE_PROJECT_ID: "p" })).toThrow(
      /AGENT_ENGINE_CLIENT_ID, AGENT_ENGINE_CLIENT_SECRET, AGENT_ENGINE_WORKSPACE_ORCHESTRATOR/,
    );
  });

  it("reads local mode and rejects an unknown mode", () => {
    expect(agentClientConfigFromEnv({ AGENT_ENGINE_MODE: "local", AGENT_ENGINE_LOCAL_URL: "https://t.example.test" })).toEqual({
      mode: "local",
      localUrl: "https://t.example.test",
    });
    expect(() => agentClientConfigFromEnv({ AGENT_ENGINE_MODE: "local" })).toThrow(AgentClientConfigError);
    expect(() => agentClientConfigFromEnv({ AGENT_ENGINE_MODE: "staging" })).toThrow(/must be "cloud" or "local"/);
  });

  it("requires https for a non-loopback cloud base URL", () => {
    expect(() =>
      createAgentClient({ ...agentClientConfigFromEnv(cloudEnv), baseUrl: "http://agentengine.example.test" } as AgentClientConfig),
    ).toThrow(/must use https/);
  });
});

describe("over real HTTP", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  it("exchanges a token and invokes a workspace against an HTTP server", async () => {
    const seen: Array<{ path: string; auth: string | undefined; session: string | undefined; body: string }> = [];
    server = createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        session: req.headers["x-session-id"] as string | undefined,
        body,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === TOKEN_PATH) {
        res.end(JSON.stringify({ access_token: "tok-http", token_type: "Bearer", expires_in: 3600 }));
        return;
      }
      res.setHeader("x-session-id", "lane-referee");
      res.end(
        JSON.stringify({
          success: true,
          execution_id: "ex-http",
          status: "completed",
          response: JSON.stringify({ verdict: "accept", reason: "valid commit" }),
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const client = createAgentClient({
      mode: "cloud",
      baseUrl: `http://127.0.0.1:${port}`,
      projectId: "proj-1",
      clientId: "ae_sa_id_http",
      clientSecret: "ae_sa_sk_http",
      workspaceIds: WORKSPACE_IDS,
    });

    const result = await client.invoke(refereeRequest({ proof_id: "prf_http" }));

    expect(result).toMatchObject({
      ok: true,
      output: { verdict: "accept", reason: "valid commit" },
      execution_id: "ex-http",
      session_id: "lane-referee",
    });
    expect(seen.map((s) => s.path)).toEqual([TOKEN_PATH, "/api/v1/projects/proj-1/workspaces/ws-ref/invoke"]);
    expect(seen[0]!.body).toBe("grant_type=client_credentials");
    expect(seen[1]!.auth).toBe("Bearer tok-http");
    expect(seen[1]!.session).toBe("lane-referee");
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ lane: { workspace: "referee", input: { proof_id: "prf_http" } } });
  });
});
