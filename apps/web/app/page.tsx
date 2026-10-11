export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Lane</h1>
      <p>The dashboard arrives with U12. Connector endpoints:</p>
      <ul>
        <li>
          MCP: <code>/api/mcp</code>
        </li>
        <li>
          JSON ping: <code>POST /api/v1/ping</code>
        </li>
        <li>
          OpenAPI: <code>/api/v1/openapi.json</code>
        </li>
      </ul>
    </main>
  );
}
