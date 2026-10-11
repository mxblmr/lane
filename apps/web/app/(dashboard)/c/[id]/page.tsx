import { ChallengeLive } from "../../_components/ChallengeLive";
import { isOperator } from "../../_components/operator";

// The stage screen for one challenge (AE1). Operator controls only with the operator cookie.
export const dynamic = "force-dynamic";

export default async function ChallengePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const operator = await isOperator();
  return <ChallengeLive id={id} operator={operator} />;
}
