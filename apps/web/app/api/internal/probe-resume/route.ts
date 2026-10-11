import { z } from "zod";
import { internalRoleFor, unauthorizedInternal } from "../../../../lib/auth-internal";

// Temporary U8 probe (removed by U9): resumes a suspended promoter execution on Atlas Agent
// Engine from a Vercel function with the service-account token, to prove resume works from
// production. Only the promoter's role key may call it.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_BASE_URL = "https://agentengine.mongodb.com";
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const ProbeResumeRequest = z.object({
  execution_id: ID,
  workspace_id: ID,
  decision: z.enum(["approve", "decline"]),
  reviewer_notes: z.string().max(500).optional(),
});

const REQUIRED_ENV = ["AGENT_ENGINE_PROJECT_ID", "AGENT_ENGINE_CLIENT_ID", "AGENT_ENGINE_CLIENT_SECRET"] as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 1000);
  }
}

export async function POST(request: Request): Promise<Response> {
  const role = internalRoleFor(request);
  if (!role) return unauthorizedInternal();
  if (role !== "promoter") {
    return json({ ok: false, error: "forbidden", fix: "Only the promoter's role key can call probe-resume." }, 403);
  }

  const parsed = ProbeResumeRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "bad_request",
        fix: "Send JSON with execution_id, workspace_id, decision (approve or decline) and optional reviewer_notes.",
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
      400,
    );
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return json({ ok: false, error: "not_configured", fix: `Set ${missing.join(", ")} in Vercel.` }, 503);
  }

  const base = (process.env.AGENT_ENGINE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const credentials = Buffer.from(
    `${process.env.AGENT_ENGINE_CLIENT_ID}:${process.env.AGENT_ENGINE_CLIENT_SECRET}`,
  ).toString("base64");

  const tokenResponse = await fetch(`${base}/api/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tokenResponse.ok) {
    console.error("probe-resume: token exchange failed", tokenResponse.status);
    return json({ ok: false, step: "token", upstream_status: tokenResponse.status, upstream: await readBody(tokenResponse) }, 502);
  }
  const token = (await tokenResponse.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!token || typeof token.access_token !== "string") {
    console.error("probe-resume: token response had no access_token");
    return json({ ok: false, step: "token", error: "no_access_token" }, 502);
  }

  const { execution_id, workspace_id, decision, reviewer_notes } = parsed.data;
  const resumeUrl =
    `${base}/api/v1/projects/${encodeURIComponent(process.env.AGENT_ENGINE_PROJECT_ID as string)}` +
    `/executions/${encodeURIComponent(execution_id)}/resume?workspace_id=${encodeURIComponent(workspace_id)}`;
  const resumeResponse = await fetch(resumeUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify(reviewer_notes ? { decision, reviewer_notes } : { decision }),
  });
  const upstream = await readBody(resumeResponse);
  if (!resumeResponse.ok) {
    console.error("probe-resume: resume failed", resumeResponse.status);
  }
  return json({ ok: resumeResponse.ok, step: "resume", upstream_status: resumeResponse.status, upstream }, resumeResponse.ok ? 200 : 502);
}
