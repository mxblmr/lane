import { cookies } from "next/headers";
import { OPS_COOKIE, isOpsCookieValue } from "../../../lib/auth-ops";

/** Server-side check of the operator cookie (KTD16). The operator panel renders only when true. */
export async function isOperator(): Promise<boolean> {
  const jar = await cookies();
  return isOpsCookieValue(jar.get(OPS_COOKIE)?.value);
}
