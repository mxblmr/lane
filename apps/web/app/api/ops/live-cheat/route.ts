import { LiveCheatBodySchema, markLiveCheat } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// R20: the presenter marks a proof as a live cheat; U9 learns from it.
export const dynamic = "force-dynamic";

export const POST = opsRoute(LiveCheatBodySchema, (db, input) => markLiveCheat(db, input));
