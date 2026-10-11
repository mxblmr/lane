import type { ReactNode } from "react";
import { isOperator } from "./_components/operator";
import "./dashboard.css";

function LaneMark() {
  return (
    <svg className="lane-mark" viewBox="0 0 24 24" fill="none" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path className="run" d="M4 19L9.5 6M16 19l5.5-13" />
      <path className="you" d="M10 17l5.5-13" />
    </svg>
  );
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const operator = await isOperator();
  return (
    <div className="dashboard">
      <nav className="topnav" aria-label="Main">
        <a className="brand" href="/" aria-label="Lane home">
          <LaneMark />
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
