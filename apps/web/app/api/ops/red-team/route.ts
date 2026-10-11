import { z } from "zod";
import { ChallengeTypeSchema } from "@lane/core/schema/common";
import { notWiredYet } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// Start a red-team run. U9 and U10 own it and have no entry point in interfaces.ts for this
// yet, so the control answers "not available yet".
export const dynamic = "force-dynamic";

export const POST = opsRoute(z.object({ challenge_type: ChallengeTypeSchema }), async () => notWiredYet("U9 and U10", "a red-team run"));
