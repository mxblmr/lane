import { ResetBodySchema, resetStage } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// KTD22: reset the stage challenge of one type through U13 (confirmed second click).
export const dynamic = "force-dynamic";

export const POST = opsRoute(ResetBodySchema, (db, input) => resetStage(db, input));
