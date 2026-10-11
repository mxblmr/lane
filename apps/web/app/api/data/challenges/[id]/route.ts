import { dataResponse, loadChallenge } from "../../../../../lib/dashboard-data";

// The stage screen's data: feed, rules, approvals, standings. Public projections only (KTD15).
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return dataResponse((db) => loadChallenge(db, id));
}
