import type { Db } from "mongodb";
import { getDb } from "@lane/core/db";
import { ensureIndexes } from "@lane/core/schema/indexes";
import { INTERNAL_API, type InternalEndpointName, type InternalError } from "@lane/core/schema/agents";
import type { ErrorCode } from "@lane/core/schema/common";
import { ensurePackSeeds } from "@lane/core/rules/examples";
import { httpStatusFor, internalError, runInternal, type InternalRequest } from "@lane/core/rules/internal-api";
import { authorizeInternal } from "./auth-internal";

/**
 * Shared route body for every `/api/internal/*` endpoint (U9 approach step 6). Checks the role
 * key, parses the JSON body with the endpoint's request schema from U3's `INTERNAL_API`, runs
 * the core handler, and maps error codes to HTTP statuses. Internal errors never leak details.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export interface InternalDeps {
  env?: NodeJS.ProcessEnv;
  db?: () => Promise<Db>;
  now?: () => Date;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function errorResponse(code: ErrorCode, message: string, recovery: string): Response {
  return json(internalError(code, message, recovery), httpStatusFor(code));
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const text = await request.text();
    return { ok: true, value: text.trim() === "" ? {} : (JSON.parse(text) as unknown) };
  } catch {
    return { ok: false };
  }
}

function issueSummary(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`)
    .join("; ");
}

async function laneDb(): Promise<Db> {
  const db = await getDb();
  await ensureIndexes(db);
  return db;
}

export async function handleInternal<K extends InternalEndpointName>(
  name: K,
  request: Request,
  deps: InternalDeps = {},
): Promise<Response> {
  const auth = authorizeInternal(request.headers, name, deps.env ?? process.env);
  if (!auth.ok) return json(auth.body, auth.status);

  const raw = await readJson(request);
  if (!raw.ok) return errorResponse("invalid_input", "The body is not valid JSON.", "Send a JSON object body.");
  const parsed = INTERNAL_API[name].request.safeParse(raw.value);
  if (!parsed.success) {
    return errorResponse("invalid_input", `Invalid request: ${issueSummary(parsed.error.issues)}`, "Fix the listed fields and call again.");
  }

  try {
    const db = await (deps.db ?? laneDb)();
    await ensurePackSeeds(db);
    const now = deps.now ? deps.now() : new Date();
    const result = await runInternal(name, { db, role: auth.role, now }, parsed.data as InternalRequest<K>);
    if ((result as InternalError).ok === false) {
      const err = result as InternalError;
      return json(err, httpStatusFor(err.error.code));
    }
    return json(result, 200);
  } catch (error) {
    console.error("internal api failed", name, error instanceof Error ? error.name : "Error");
    return errorResponse("internal", "Lane could not complete the call.", "Retry shortly; if it keeps failing, report it to the operator.");
  }
}
