import type { ReactNode } from "react";
import { isOperator } from "./_components/operator";
import "./dashboard.css";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const operator = await isOperator();
  return (
    <div className="dashboard">
      <nav className="topnav">
        <a className="brand" href="/">
          Lane
        </a>
        <a href="/">Challenges</a>
        <a href="/rules">Rules</a>
        <a href="/ops">{operator ? "Operator panel" : "Operator"}</a>
        {operator ? <span className="badge warn">Operator mode</span> : null}
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}
