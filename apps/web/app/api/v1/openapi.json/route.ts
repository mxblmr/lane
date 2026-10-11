import { buildOpenApiDocument } from "../../../../lib/openapi";

// Served at /api/v1/openapi.json. The server URL is the origin the request came
// in on, so the production alias and preview URLs each describe themselves.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const origin = publicOrigin(request);
  return Response.json(buildOpenApiDocument(origin), {
    headers: { "Cache-Control": "no-store" },
  });
}

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  // Proxies may send a comma-separated chain; the first entry is the client-facing one.
  const first = (name: string) => request.headers.get(name)?.split(",")[0]?.trim() || undefined;
  const host = first("x-forwarded-host") ?? url.host;
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
