# lane
Hackathon project — HQ (hqforwork.com) is the project brain

## Development

pnpm workspace with `apps/web` (Next.js on Vercel), `packages/core` (domain and MongoDB, subpath exports such as `@lane/core/db`) and `scripts`. Node 22.

```bash
pnpm install
pnpm -r typecheck
pnpm -r test                      # Vitest; MongoDB runs in memory as a single-node replica set
pnpm --filter web build
pnpm --filter web dev             # http://localhost:3000
pnpm mcp:smoke --url <base url>   # MCP tools/list check; /api/mcp is appended to a bare origin
```

Endpoints: `/api/mcp` (MCP, `lane_ping`), `POST /api/v1/ping`, `GET /api/v1/openapi.json`, `POST /api/health/db` (commits one transaction). Environment variable names are in `.env.example`.
