import { OpsPanel, PasscodeForm } from "../_components/OpsPanel";
import { isOperator } from "../_components/operator";

// Operator panel behind the passcode form (KTD16).
export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const operator = await isOperator();
  return (
    <>
      <h1>Operator</h1>
      {operator ? <OpsPanel /> : <PasscodeForm />}
    </>
  );
}
