import { z } from "zod";
import { IdSchema } from "@lane/core/schema/common";
import { notWiredYet } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// Trigger a surprise check now. U18 owns drawing checks and has no entry point in
// interfaces.ts for this yet, so the control answers "not available yet".
export const dynamic = "force-dynamic";

export const POST = opsRoute(z.object({ challenge_id: IdSchema }), async () => notWiredYet("U18", "triggering a surprise check"));
