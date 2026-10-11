import { isOpsConfigured, opsCookieHeader, opsToken, passcodeMatches } from "../../../../lib/auth-ops";

// KTD16: the presenter types the passcode once; the answer sets the operator cookie.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  if (!isOpsConfigured()) {
    return Response.json(
      { ok: false, code: "not_configured", message: "Operator controls are off: OPS_PASSCODE is not set." },
      { status: 503, headers: NO_STORE },
    );
  }
  let passcode: unknown;
  try {
    passcode = ((await request.json()) as { passcode?: unknown } | null)?.passcode;
  } catch {
    passcode = undefined;
  }
  if (typeof passcode !== "string" || !passcodeMatches(passcode)) {
    return Response.json({ ok: false, code: "unauthenticated", message: "Wrong passcode." }, { status: 401, headers: NO_STORE });
  }
  return Response.json(
    { ok: true },
    { status: 200, headers: { ...NO_STORE, "Set-Cookie": opsCookieHeader(opsToken(passcode)) } },
  );
}
