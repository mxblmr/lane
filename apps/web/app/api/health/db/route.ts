import { runDbHealthCheck } from "../../../../lib/db-health";

// U1 verification: POST commits one multi-document transaction against the
// configured cluster, so a deploy can prove MongoDB works from a Vercel function.
// It writes only two fixed health documents, so repeated calls stay bounded.
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const result = await runDbHealthCheck();
  return Response.json(result, {
    status: result.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
