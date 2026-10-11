import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Operator authentication (KTD16).
 *
 * The presenter types a long random passcode (OPS_PASSCODE) once. Lane answers with an
 * httpOnly, Secure, SameSite=Strict cookie that holds an HMAC-SHA256 of a fixed label keyed
 * with the passcode. Every ops route recomputes that value and compares it in constant time,
 * so a hand-set cookie with any other value is refused. The passcode itself is never stored
 * in the cookie or sent back.
 */

export const OPS_COOKIE = "lane_ops";
/** Fixed label the cookie value is an HMAC of. Changing it signs every operator out. */
export const OPS_COOKIE_LABEL = "lane-ops-cookie-v1";
/** Shorter passcodes are treated as not configured: KTD16 asks for a long random one. */
export const MIN_PASSCODE_LENGTH = 16;
/** Twelve hours covers rehearsals and the stage run. */
export const OPS_COOKIE_MAX_AGE_SEC = 12 * 60 * 60;

function configuredPasscode(): string | null {
  const passcode = process.env.OPS_PASSCODE;
  if (!passcode || passcode.length < MIN_PASSCODE_LENGTH) return null;
  return passcode;
}

export function isOpsConfigured(): boolean {
  return configuredPasscode() !== null;
}

/** HMAC-SHA256 of the fixed label keyed with `passcode`, as lowercase hex. */
export function opsToken(passcode: string): string {
  return createHmac("sha256", passcode).update(OPS_COOKIE_LABEL).digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** True when `submitted` is the configured passcode. Compares derived digests in constant time. */
export function passcodeMatches(submitted: unknown): boolean {
  const passcode = configuredPasscode();
  if (!passcode || typeof submitted !== "string" || submitted.length === 0 || submitted.length > 512) return false;
  return constantTimeHexEqual(opsToken(submitted), opsToken(passcode));
}

/** True when a cookie value is the operator token for the configured passcode. */
export function isOpsCookieValue(value: string | null | undefined): boolean {
  const passcode = configuredPasscode();
  if (!passcode || typeof value !== "string") return false;
  return constantTimeHexEqual(value, opsToken(passcode));
}

/** Reads one cookie from a raw Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

export function isOpsRequest(request: Request): boolean {
  return isOpsCookieValue(readCookie(request.headers.get("cookie"), OPS_COOKIE));
}

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Guard for every ops route. Returns a refusal response, or null when the request carries a
 * valid operator cookie.
 */
export function requireOps(request: Request): Response | null {
  if (!isOpsConfigured()) {
    return Response.json(
      { ok: false, code: "not_configured", message: "Operator controls are off: OPS_PASSCODE is not set." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!isOpsRequest(request)) {
    return Response.json(
      { ok: false, code: "unauthenticated", message: "Operator passcode required." },
      { status: 401, headers: NO_STORE },
    );
  }
  return null;
}

/** Set-Cookie value that signs the operator in. */
export function opsCookieHeader(token: string): string {
  return `${OPS_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${OPS_COOKIE_MAX_AGE_SEC}`;
}

/** Set-Cookie value that signs the operator out. */
export function clearOpsCookieHeader(): string {
  return `${OPS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
