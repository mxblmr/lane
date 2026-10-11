import { OverviewLive } from "./_components/Overview";

// Judges' dashboard home: the three challenges, polled live (KTD16).
export const dynamic = "force-dynamic";

export default function DashboardHome() {
  return (
    <>
      <h1>Live challenges</h1>
      <OverviewLive />
      <footer className="footer muted">
        Connector: MCP at <code>/api/mcp</code>, JSON ping at <code>POST /api/v1/ping</code>, OpenAPI at{" "}
        <code>/api/v1/openapi.json</code>.
      </footer>
    </>
  );
}
