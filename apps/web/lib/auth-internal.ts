import { createHash, timingSafeEqual } from "node:crypto";
import { INTERNAL_API, INTERNAL_ROLES, ROLE_KEY_HEADER, type InternalEndpointName, type InternalError, type InternalRole } from "@lane/core/schema/agents";

/**
 * Role-key check for Lane's internal agent API (U9 approach step 6, KTD9, KTD10).
 *
 * Each internal role (rule-lab, the promoter) has its own key, sent in the `x-lane-role-key`
 * header. The key only selects the code paths that role may reach; it is not a user identity.
 * Keys are compared as SHA-256 digests with a constant-time compare, an unset key never
 * matches, and two roles configured with the same key are refused so a key cannot open both
 * roles' paths. A configured key shorter than 32 characters counts as not configured, and a
 * presented key longer than 512 characters is refused before hashing.
 */

/** Environment variable that holds each role's key. */
export const ROLE_KEY_ENV: Record<InternalRole, string> = {
  rule_lab: "LANE_ROLE_KEY_RULE_LAB",
  promoter: "LANE_ROLE_KEY_PROMOTER",
};

/** Shorter configured keys are treated as not configured. */
export const MIN_ROLE_KEY_LENGTH = 32;
const MAX_SUBMITTED_LENGTH = 512;

export type InternalAuthResult =
  | { ok: true; role: InternalRole }
  | { ok: false; status: 401 | 403; body: InternalError };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function configuredKey(role: InternalRole, env: NodeJS.ProcessEnv): string | null {
  const value = env[ROLE_KEY_ENV[role]]?.trim();
  return value && value.length >= MIN_ROLE_KEY_LENGTH ? value : null;
}

/** The role a presented key belongs to, or null. Compares against every role so timing does not reveal which one matched. */
export function resolveRole(presented: string | null | undefined, env: NodeJS.ProcessEnv = process.env): InternalRole | null {
  if (!presented || presented.length > MAX_SUBMITTED_LENGTH) return null;
  const given = digest(presented);
  const matches: InternalRole[] = [];
  for (const role of INTERNAL_ROLES) {
    const key = configuredKey(role, env);
    // An unset key is compared against a fixed digest it can never equal, keeping the work constant.
    const expected = key ? digest(key) : digest(`unset:${role}:${presented}x`);
    if (timingSafeEqual(given, expected) && key) matches.push(role);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function deny(status: 401 | 403, code: "unauthenticated" | "not_allowed", message: string, recovery: string): InternalAuthResult {
  return { ok: false, status, body: { ok: false, error: { code, message, recovery } } };
}

/** Check the role key on a request against the roles the endpoint allows. */
export function authorizeInternal(
  headers: Headers,
  endpoint: InternalEndpointName,
  env: NodeJS.ProcessEnv = process.env,
): InternalAuthResult {
  const presented = headers.get(ROLE_KEY_HEADER);
  if (!presented) {
    return deny(401, "unauthenticated", `Missing the ${ROLE_KEY_HEADER} header.`, "Send the role key for your agent in the header.");
  }
  const role = resolveRole(presented, env);
  if (!role) {
    return deny(401, "unauthenticated", "The role key is not recognised.", "Check the role key configured for your agent.");
  }
  const allowed = INTERNAL_API[endpoint].roles as readonly InternalRole[];
  if (!allowed.includes(role)) {
    return deny(403, "not_allowed", `The ${role} role may not call ${INTERNAL_API[endpoint].path}.`, "Call only the endpoints listed for your role.");
  }
  return { ok: true, role };
}

/** The role whose configured key matches the request's role-key header, or null (ping and the U8 probe routes). */
export function internalRoleFor(request: Request): InternalRole | null {
  return resolveRole(request.headers.get(ROLE_KEY_HEADER));
}

/** 401 body for a missing or wrong role key. Never says which roles exist. */
export function unauthorizedInternal(): Response {
  return Response.json(
    { ok: false, error: "unauthorized", fix: `Send this agent's role key in the ${ROLE_KEY_HEADER} header.` },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
