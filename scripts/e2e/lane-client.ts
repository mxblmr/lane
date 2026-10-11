/**
 * A thin MCP client for the eight `lane_` tools, shared by `pnpm e2e` and `pnpm standin`.
 * Calls go over streamable HTTP the way Muse and the scripted players call Lane. The player key
 * travels as the `player_key` argument (KTD4), so every call can open a fresh session.
 *
 * Nothing here logs arguments or results, because `lane_register` results and every later call's
 * arguments carry a player key.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { EnvelopeSchema, type Envelope } from "@lane/core/schema/envelope";
import { normalizeMcpUrl } from "../mcp-smoke";

export interface LaneToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LaneClient {
  /** Calls one tool and returns the parsed Lane envelope. */
  call(tool: string, args: Record<string, unknown>): Promise<Envelope>;
  listTools(): Promise<LaneToolInfo[]>;
  close(): Promise<void>;
}

/** The message Lane's tool runner returns while a unit's service is still a U3 stub. */
export const NOT_LIVE_MESSAGE = "This part of Lane is not live yet.";

/** True when Lane answered that the service behind this call has not merged yet. */
export function isNotLive(envelope: Envelope): boolean {
  return (
    envelope.status === "error" &&
    envelope.error?.code === "internal" &&
    envelope.lines.some((line) => line.includes(NOT_LIVE_MESSAGE))
  );
}

/** Connects to a Lane MCP endpoint. A bare origin gets `/api/mcp` appended. */
export async function connectLane(url: string): Promise<LaneClient> {
  const client = new Client({ name: "lane-u17", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(normalizeMcpUrl(url)));
  await client.connect(transport);
  return {
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: args });
      if (result.isError) {
        throw new Error(`${tool} returned a protocol error instead of a Lane envelope`);
      }
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.find((c) => c.type === "text")?.text;
      if (typeof text !== "string") throw new Error(`${tool} returned no text content`);
      return EnvelopeSchema.parse(JSON.parse(text));
    },
    async listTools() {
      const tools: LaneToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema as Record<string, unknown>,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    close: () => client.close(),
  };
}
