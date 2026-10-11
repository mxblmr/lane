import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_KEY_HEADER } from "@lane/core/schema/agents";
import * as pingRoute from "../app/api/internal/ping/route";
import * as probeResumeRoute from "../app/api/internal/probe-resume/route";

const RULE_LAB_KEY = "r".repeat(64);
const PROMOTER_KEY = "p".repeat(64);
const ENV_NAMES = [
  "LANE_ROLE_KEY_RULE_LAB",
  "LANE_ROLE_KEY_PROMOTER",
  "AGENT_ENGINE_BASE_URL",
  "AGENT_ENGINE_PROJECT_ID",
  "AGENT_ENGINE_CLIENT_ID",
  "AGENT_ENGINE_CLIENT_SECRET",
] as const;
const saved: Record<string, string | undefined> = {};

function request(path: string, init: { method?: string; key?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.key !== undefined) headers[ROLE_KEY_HEADER] = init.key;
  return new Request(`http://lane.test${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined || init.method === "GET" ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  process.env.LANE_ROLE_KEY_RULE_LAB = RULE_LAB_KEY;
  process.env.LANE_ROLE_KEY_PROMOTER = PROMOTER_KEY;
  delete process.env.AGENT_ENGINE_BASE_URL;
  process.env.AGENT_ENGINE_PROJECT_ID = "proj_1";
  process.env.AGENT_ENGINE_CLIENT_ID = "ae_sa_id_test";
  process.env.AGENT_ENGINE_CLIENT_SECRET = "ae_sa_sk_test";
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.unstubAllGlobals();
});

describe("POST /api/internal/ping", () => {
  it("refuses a request with no role key", async () => {
    const res = await pingRoute.POST(request("/api/internal/ping", { body: {} }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("refuses a wrong role key", async () => {
    const res = await pingRoute.POST(request("/api/internal/ping", { key: "x".repeat(64), body: {} }));
    expect(res.status).toBe(401);
  });

  it("answers the rule-lab key with its role and the server time", async () => {
    const res = await pingRoute.POST(request("/api/internal/ping", { key: RULE_LAB_KEY, body: {} }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, role: "rule_lab" });
    expect(Number.isNaN(Date.parse(body.server_time))).toBe(false);
  });

  it("answers the promoter key with the promoter role, over GET too", async () => {
    const res = await pingRoute.GET(request("/api/internal/ping", { method: "GET", key: PROMOTER_KEY }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, role: "promoter" });
  });

  it("treats a configured key shorter than 32 characters as not configured", async () => {
    process.env.LANE_ROLE_KEY_RULE_LAB = "short";
    const res = await pingRoute.POST(request("/api/internal/ping", { key: "short", body: {} }));
    expect(res.status).toBe(401);
  });

  it("refuses everyone when no role keys are configured", async () => {
    delete process.env.LANE_ROLE_KEY_RULE_LAB;
    delete process.env.LANE_ROLE_KEY_PROMOTER;
    const res = await pingRoute.POST(request("/api/internal/ping", { key: RULE_LAB_KEY, body: {} }));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/internal/probe-resume", () => {
  const valid = { execution_id: "exec_123", workspace_id: "ws-promoter", decision: "approve" };

  it("refuses the rule-lab key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await probeResumeRoute.POST(request("/api/internal/probe-resume", { key: RULE_LAB_KEY, body: valid }));
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a request with no role key", async () => {
    const res = await probeResumeRoute.POST(request("/api/internal/probe-resume", { body: valid }));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body and names the fields, not the values", async () => {
    const res = await probeResumeRoute.POST(
      request("/api/internal/probe-resume", { key: PROMOTER_KEY, body: { execution_id: "bad id!", decision: "maybe" } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields).toEqual(expect.arrayContaining(["execution_id", "workspace_id", "decision"]));
    expect(JSON.stringify(body)).not.toContain("bad id!");
  });

  it("names the missing Agent Engine settings without calling out", async () => {
    delete process.env.AGENT_ENGINE_CLIENT_SECRET;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await probeResumeRoute.POST(request("/api/internal/probe-resume", { key: PROMOTER_KEY, body: valid }));
    expect(res.status).toBe(503);
    expect((await res.json()).fix).toContain("AGENT_ENGINE_CLIENT_SECRET");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exchanges the service-account secret for a token, then resumes with a flat body", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "tok_abc", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ status: "completed", execution_id: "exec_123" }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await probeResumeRoute.POST(
      request("/api/internal/probe-resume", { key: PROMOTER_KEY, body: { ...valid, reviewer_notes: "probe" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, step: "resume", upstream_status: 200 });

    const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://agentengine.mongodb.com/api/v1/oauth/token");
    expect((tokenInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("ae_sa_id_test:ae_sa_sk_test").toString("base64")}`,
    );
    expect(tokenInit.body).toBe("grant_type=client_credentials");

    const [resumeUrl, resumeInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(resumeUrl).toBe(
      "https://agentengine.mongodb.com/api/v1/projects/proj_1/executions/exec_123/resume?workspace_id=ws-promoter",
    );
    expect((resumeInit.headers as Record<string, string>).Authorization).toBe("Bearer tok_abc");
    expect(JSON.parse(resumeInit.body as string)).toEqual({ decision: "approve", reviewer_notes: "probe" });
  });

  it("reports an upstream resume failure with its status and never returns the token", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "tok_secret_value" }))
      .mockResolvedValueOnce(Response.json({ detail: "role is not PROJECT_OWNER" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await probeResumeRoute.POST(request("/api/internal/probe-resume", { key: PROMOTER_KEY, body: valid }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, step: "resume", upstream_status: 403 });
    expect(JSON.stringify(body)).not.toContain("tok_secret_value");
  });

  it("stops at a failed token exchange", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await probeResumeRoute.POST(request("/api/internal/probe-resume", { key: PROMOTER_KEY, body: valid }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, step: "token", upstream_status: 429 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses AGENT_ENGINE_BASE_URL when it is set", async () => {
    process.env.AGENT_ENGINE_BASE_URL = "https://ae.example.test/";
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "tok" }))
      .mockResolvedValueOnce(Response.json({ status: "completed" }));
    vi.stubGlobal("fetch", fetchSpy);
    await probeResumeRoute.POST(request("/api/internal/probe-resume", { key: PROMOTER_KEY, body: valid }));
    expect(fetchSpy.mock.calls[0][0]).toBe("https://ae.example.test/api/v1/oauth/token");
  });
});
