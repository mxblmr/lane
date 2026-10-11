import { DecideBodySchema, decideApproval } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// Approve, decline or retry a rule or payout approval through U9's approvals.
export const dynamic = "force-dynamic";

export const POST = opsRoute(DecideBodySchema, (db, input) => decideApproval(db, input));
