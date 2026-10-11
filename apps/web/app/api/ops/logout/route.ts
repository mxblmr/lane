import { clearOpsCookieHeader } from "../../../../lib/auth-ops";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": clearOpsCookieHeader() } });
}
