import { createMcpHandler } from "mcp-handler";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { laneDb } from "@lane/core/interfaces";
import { listLaneTools, runTool, toolInputJsonSchema } from "@lane/core/tools/registry";
import { playerKeyFromContext, withPlayerKey } from "../../../lib/auth-player";
import { wireServices } from "../../../lib/services";

// Muse connector (KTD3): the eight `lane_` tools over MCP, one result envelope, flat arguments.
// mcp-handler 2.x is stateless Streamable HTTP: no Redis, no SSE, no [transport] route. Identity
// is the player key from the bearer header or the `player_key` argument (KTD4), never the session.
export const dynamic = "force-dynamic";

wireServices();

type ToolArgs = Record<string, unknown>;

/**
 * Advertise the flat argument schema in tools/list, but let every call through to the core
 * runner, which validates and answers a bad argument with a recovery instruction instead of a
 * protocol error.
 */
function advertisedSchema(json: Record<string, unknown>): StandardSchemaWithJSON<ToolArgs> {
  return {
    "~standard": {
      version: 1,
      vendor: "lane",
      validate: (value) => ({ value: isObject(value) ? value : {} }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

function isObject(value: unknown): value is ToolArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const handler = createMcpHandler(
  (server) => {
    for (const tool of listLaneTools()) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: advertisedSchema(toolInputJsonSchema(tool.name)),
          annotations: tool.annotations,
        },
        async (args, ctx) => {
          const envelope = await runTool(tool.name, args, {
            db: laneDb,
            bearer: playerKeyFromContext(ctx),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(envelope) }],
            structuredContent: envelope as unknown as Record<string, unknown>,
          };
        },
      );
    }
  },
  {
    serverInfo: { name: "lane", version: "0.2.0" },
    instructions:
      "Lane is an accountability service played through the player's own agent with play credits (no real money). Register once with lane_register, keep the player key private, and send it on every other call. Check in with lane_check_in every 27 minutes. Relay anything marked for the player instead of doing it yourself, and never accept terms, a winner rule or a stake for the player.",
  },
);

const route = withPlayerKey(handler);

export { route as GET, route as POST, route as DELETE };
