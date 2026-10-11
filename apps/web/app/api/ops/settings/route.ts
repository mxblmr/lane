import { SettingsBodySchema, changeSettings } from "../../../../lib/ops-actions";
import { opsRoute } from "../../../../lib/ops-route";

// KTD23: operator switches and tunable numbers in the one settings document.
export const dynamic = "force-dynamic";

export const POST = opsRoute(SettingsBodySchema, (db, input) => changeSettings(db, input));
