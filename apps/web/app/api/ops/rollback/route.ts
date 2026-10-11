import { RollbackBodySchema, rollbackRule } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// R23: restore an active non-seed rule's parent through U9's lifecycle (confirmed second click).
export const dynamic = "force-dynamic";

export const POST = opsRoute(RollbackBodySchema, (db, input) => rollbackRule(db, input));
