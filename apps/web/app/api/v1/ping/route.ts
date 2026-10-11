import { ping } from "../../../../lib/ping";

// JSON face of `lane_ping` (KTD3), so U2 can test Muse's API-based connector.
// POST is the documented operation; GET answers the same for quick checks.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  // The body is optional and ignored, but a malformed one is still drained.
  await request.text().catch(() => "");
  return Response.json(ping(), { headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  return Response.json(ping(), { headers: NO_STORE });
}
