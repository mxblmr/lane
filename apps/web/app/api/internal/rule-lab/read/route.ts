import { handleInternal } from "../../../../../lib/internal-api";

// Internal agent API: rule_lab_read (U9, contract in U3 INTERNAL_API). POST with the role key header.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleInternal("rule_lab_read", request);
}
