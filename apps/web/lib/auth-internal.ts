import { createHash, timingSafeEqual } from "node:crypto";
import { ROLE_KEY_HEADER, type InternalRole } from "@lane/core/schema/agents";

/**
 * Internal API authentication (KTD10).
 *
 * Each Lane agent sends its role key in the `x-lane-role-key` header. The key decides which
 * internal paths answer. Keys come from LANE_ROLE_KEY_RULE_LAB and LANE_ROLE_KEY_PROMOTER;
 * a missing or short key leaves that role switched off. Comparison hashes both sides first so
 * every check runs in constant time whatever the submitted length.
 */

export const ROLE_KEY_ENV: Record<InternalRole, string> = {
  rule_lab: "LANE_ROLE_KEY_RULE_LAB",
  promoter: "LANE_ROLE_KEY_PROMOTER",
};

/** Shorter configured keys are treated as not configured. */
export const MIN_ROLE_KEY_LENGTH = 32;
const MAX_SUBMITTED_LENGTH = 512;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The role whose configured key matches the request's role-key header, or null. */
export function internalRoleFor(request: Request): InternalRole | null {
  const submitted = request.headers.get(ROLE_KEY_HEADER);
  if (!submitted || submitted.length > MAX_SUBMITTED_LENGTH) return null;
  const submittedDigest = digest(submitted);
  let match: InternalRole | null = null;
  for (const role of Object.keys(ROLE_KEY_ENV) as InternalRole[]) {
    const configured = process.env[ROLE_KEY_ENV[role]];
    if (!configured || configured.length < MIN_ROLE_KEY_LENGTH) continue;
    if (timingSafeEqual(submittedDigest, digest(configured))) match = role;
  }
  return match;
}

/** 401 body for a missing or wrong role key. Never says which roles exist. */
export function unauthorizedInternal(): Response {
  return Response.json(
    { ok: false, error: "unauthorized", fix: `Send this agent's role key in the ${ROLE_KEY_HEADER} header.` },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
