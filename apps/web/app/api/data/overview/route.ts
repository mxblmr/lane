import { dataResponse, loadOverview } from "../../../../lib/dashboard-data";

// The three-challenge overview. Public projections only (KTD15); runs the tick (KTD13).
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return dataResponse((db) => loadOverview(db));
}
