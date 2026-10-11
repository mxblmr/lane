import { AdvanceDayBodySchema, advanceDay } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// R32: move an active challenge forward one day, only from the day the operator saw.
export const dynamic = "force-dynamic";

export const POST = opsRoute(AdvanceDayBodySchema, (db, input) => advanceDay(db, input));
