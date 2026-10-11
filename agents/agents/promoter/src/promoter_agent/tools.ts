/**
 * The Lane internal API tool (U8, KTD9, KTD10). Rule-lab and the promoter ship an
 * identical copy; each passes the name of its own role key secret.
 *
 * The tool only ever calls `LANE_BASE_URL` under `/api/internal/`, with the agent's role
 * key in the `x-lane-role-key` header. The endpoint list and request shapes arrive in the
 * invoke payload (`internal_api`), so they can change without a redeploy.
 */
import type { App } from "@mongodb-js/agent-engine-sdk-langgraph";
import { z } from "zod";

/** U3 `ROLE_KEY_HEADER` (packages/core/src/schema/agents.ts). */
const ROLE_KEY_HEADER = "x-lane-role-key";
/** U3 `INTERNAL_API_BASE`. */
const INTERNAL_API_BASE = "/api/internal";
const INTERNAL_PATH_PATTERN = /^\/api\/internal\/[a-z0-9][a-z0-9/_-]*$/;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 20_000;

export type RoleKeyEnv = "LANE_ROLE_KEY_RULE_LAB" | "LANE_ROLE_KEY_PROMOTER";

export const LANE_API_TOOL = "lane_internal_api";

/**
 * Resolves an endpoint given as a path or as the full URL from `internal_api` to a URL
 * on `LANE_BASE_URL`. Returns null for anything outside the internal API.
 */
export function internalApiUrl(pathOrUrl: string, baseUrl: string): URL | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    console.error("[lane] LANE_BASE_URL is not an absolute URL");
    return null;
  }
  let path = pathOrUrl.trim();
  if (/^https?:\/\//i.test(path)) {
    let given: URL;
    try {
      given = new URL(path);
    } catch {
      return null;
    }
    if (given.origin !== base.origin || given.search || given.hash) return null;
    path = given.pathname;
  }
  if (!INTERNAL_PATH_PATTERN.test(path) || path.includes("//") || path.includes("..")) return null;
  return new URL(path, base.origin);
}

function toolError(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

export function registerLaneApiTool(app: App, roleKeyEnv: RoleKeyEnv): void {
  app.tool({
    isLocal: false,
    description:
      "Call one Lane internal API endpoint listed in the internal_api data. " +
      `Pass the endpoint path (it starts with ${INTERNAL_API_BASE}/) or its url, and the JSON request body. ` +
      "Every endpoint is POST. Returns the HTTP status and the JSON response.",
    schema: z.object({
      path: z.string().describe(`Endpoint path such as ${INTERNAL_API_BASE}/ping, or the endpoint url from internal_api`),
      body: z.record(z.string(), z.unknown()).default({}).describe("JSON request body matching the endpoint's request schema"),
    }),
  })(async function lane_internal_api({ path, body }: { path: string; body: Record<string, unknown> }): Promise<string> {
    const baseUrl = process.env.LANE_BASE_URL ?? "";
    const roleKey = process.env[roleKeyEnv] ?? "";
    if (!baseUrl || !roleKey) {
      console.error(`[lane] ${LANE_API_TOOL}: LANE_BASE_URL or ${roleKeyEnv} is not set`);
      return toolError("agent_misconfigured", `LANE_BASE_URL or ${roleKeyEnv} is not set on this agent`);
    }
    const url = internalApiUrl(path, baseUrl);
    if (!url) {
      return toolError("invalid_path", `Only ${INTERNAL_API_BASE}/ endpoints on Lane can be called`);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", [ROLE_KEY_HEADER]: roleKey },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lane] ${LANE_API_TOOL} ${url.pathname} failed: ${message}`);
      return toolError("network_error", `Lane did not answer: ${message}`);
    }
    const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      // Not JSON (or truncated): return the raw text so the model can report it.
    }
    return JSON.stringify({ status: response.status, response: parsed });
  });
}
