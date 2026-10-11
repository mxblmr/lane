/**
 * HTTP doubles for the Agent Engine API, shared by the client and service tests. `fakeFetch`
 * records every request and answers from a handler, so tests assert the exact wire shapes.
 */
import { AGENT_ENGINE_DEFAULT_BASE_URL, type AgentClientConfig } from "../../src/agents/client";

export const TOKEN_PATH = "/api/v1/oauth/token";
export const WORKSPACE_IDS = { orchestrator: "ws-orc", referee: "ws-ref", rule_lab: "ws-lab", promoter: "ws-pro" } as const;

export type Call = { url: URL; method: string; headers: Headers; body: string | undefined };
export type Handler = (call: Call) => Response | Promise<Response>;

export function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function tokenResponse(token = "tok-1", expiresIn = 3600): Response {
  return json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

export function completed(answer: unknown, executionId = "ex-1"): Response {
  return json({
    success: true,
    response: typeof answer === "string" ? answer : JSON.stringify(answer),
    execution_id: executionId,
    status: "completed",
  });
}

export function cloudConfig(fetchImpl: typeof fetch, extra: Partial<AgentClientConfig> = {}): AgentClientConfig {
  return {
    mode: "cloud",
    baseUrl: AGENT_ENGINE_DEFAULT_BASE_URL,
    projectId: "proj-1",
    clientId: "ae_sa_id_test",
    clientSecret: "ae_sa_sk_test",
    workspaceIds: WORKSPACE_IDS,
    fetch: fetchImpl,
    sleep: async () => {},
    ...extra,
  } as AgentClientConfig;
}

export function invokeBody(call: Call): Record<string, unknown> {
  return JSON.parse(call.body ?? "null") as Record<string, unknown>;
}
