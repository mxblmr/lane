import type { Db } from "mongodb";
import type { z } from "zod";
import { laneDb } from "@lane/core/interfaces";
import { requireOps } from "./auth-ops";
import { parseBody, type OpsResult } from "./ops-actions";

const NO_STORE = { "Cache-Control": "no-store" };

export function opsResponse(result: OpsResult): Response {
  return Response.json(result.body, { status: result.status, headers: NO_STORE });
}

/**
 * Builds a POST-only ops route (KTD16): check the operator cookie first, then parse the JSON
 * body with `schema`, then run `action` against the Lane database.
 */
export function opsRoute<S extends z.ZodType>(
  schema: S,
  action: (db: Db, input: z.infer<S>) => Promise<OpsResult>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const denied = requireOps(request);
    if (denied) return denied;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return opsResponse({ status: 400, body: { ok: false, code: "invalid_input", message: "Send a JSON body." } });
    }
    const parsed = parseBody(schema, body);
    if (!parsed.ok) return opsResponse(parsed.result);
    let db: Db;
    try {
      db = await laneDb();
    } catch (err) {
      console.error("ops route has no database", err instanceof Error ? err.name : "Error");
      return opsResponse({ status: 503, body: { ok: false, code: "no_database", message: "The database is not reachable." } });
    }
    return opsResponse(await action(db, parsed.data));
  };
}
