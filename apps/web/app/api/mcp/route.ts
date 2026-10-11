import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { LANE_PING_TOOL, ping } from "../../../lib/ping";

// Muse connector (KTD3). U1 ships one `lane_ping` tool; U7 adds the eight `lane_` tools.
// mcp-handler 2.x is stateless Streamable HTTP: no Redis, no SSE, no [transport] route.
const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      LANE_PING_TOOL.name,
      {
        title: LANE_PING_TOOL.title,
        description: LANE_PING_TOOL.description,
        inputSchema: z.object({}),
        outputSchema: z.object({
          ok: z.literal(true),
          service: z.literal("lane"),
          server_time: z.string(),
          message: z.string(),
        }),
        annotations: {
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => {
        const result = ping();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
  },
  {
    serverInfo: { name: "lane", version: "0.1.0" },
  },
);

export { handler as GET, handler as POST, handler as DELETE };
