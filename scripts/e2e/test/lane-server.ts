import { createMcpHandler } from "mcp-handler";
import type { Db } from "../scenarios";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import { listLaneTools, runTool, toolInputJsonSchema } from "@lane/core/tools/registry";

/**
 * Test helper: Lane's eight tools over MCP on a local port, wired like
 * `apps/web/app/api/mcp/route.ts` (same tool list, descriptions, schemas and `runTool`), against
 * the database the test hands in. The e2e and stand-in tests call it exactly as they call a
 * deployed URL. Identity uses the `player_key` argument, so no bearer plumbing is needed.
 */
type ToolArgs = Record<string, unknown>;

function advertised(json: Record<string, unknown>): StandardSchemaWithJSON<ToolArgs> {
  return {
    "~standard": {
      version: 1,
      vendor: "lane",
      validate: (value) => ({ value: typeof value === "object" && value !== null && !Array.isArray(value) ? (value as ToolArgs) : {} }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

export async function serveLane(db: () => Promise<Db>): Promise<LocalServer> {
  const handler = createMcpHandler(
    (server) => {
      for (const tool of listLaneTools()) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: advertised(toolInputJsonSchema(tool.name)),
            annotations: tool.annotations,
          },
          async (args) => {
            const envelope = await runTool(tool.name, args, { db });
            return {
              content: [{ type: "text", text: JSON.stringify(envelope) }],
              structuredContent: envelope as unknown as Record<string, unknown>,
            };
          },
        );
      }
    },
    { serverInfo: { name: "lane-test", version: "0.0.0" } },
  );
  return serveRoutes({ "/api/mcp": { GET: handler, POST: handler, DELETE: handler } });
}
