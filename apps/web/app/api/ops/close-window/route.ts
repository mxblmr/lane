import { CloseWindowBodySchema, closeWindow } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// R32: close an active challenge's window (confirmed second click), once.
export const dynamic = "force-dynamic";

export const POST = opsRoute(CloseWindowBodySchema, (db, input) => closeWindow(db, input));
