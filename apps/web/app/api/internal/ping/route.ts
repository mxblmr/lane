import { internalRoleFor, unauthorizedInternal } from "../../../../lib/auth-internal";

// U8 probe: proves a deployed Lane agent can reach Lane's internal API with its role key.
// The contract (INTERNAL_API.ping) is POST; GET answers the same so a probe from a browser
// or curl without a body also works.
export const dynamic = "force-dynamic";

function ping(request: Request): Response {
  const role = internalRoleFor(request);
  if (!role) return unauthorizedInternal();
  return Response.json(
    { ok: true, role, server_time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  return ping(request);
}

export async function GET(request: Request): Promise<Response> {
  return ping(request);
}
