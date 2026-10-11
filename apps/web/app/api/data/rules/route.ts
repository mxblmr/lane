import { ChallengeTypeSchema } from "@lane/core/schema/common";
import { dataResponse, loadRules } from "../../../../lib/dashboard-data";

// Full rule version history. Public projections only (KTD15); runs the tick (KTD13).
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("type");
  const type = raw ? ChallengeTypeSchema.safeParse(raw) : null;
  if (type && !type.success) {
    return Response.json({ ok: false, code: "invalid_input", message: "Unknown challenge type." }, { status: 400 });
  }
  return dataResponse((db) => loadRules(db, new Date(), type?.data));
}
