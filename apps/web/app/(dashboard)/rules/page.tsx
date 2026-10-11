import { RulesLive } from "../_components/Rules";
import { isOperator } from "../_components/operator";

// Full rule version history (R23). Roll back appears only for the operator.
export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const operator = await isOperator();
  return (
    <>
      <h1>Rule versions</h1>
      <RulesLive operator={operator} />
    </>
  );
}
