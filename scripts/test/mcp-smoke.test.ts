import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import { compareToolNames, normalizeMcpUrl, parseArgs, runSmoke } from "../mcp-smoke";

describe("parseArgs", () => {
  it("reads --url and defaults the expected list to lane_ping", () => {
    expect(parseArgs(["--url", "https://lane.example.com"])).toEqual({
      url: "https://lane.example.com/api/mcp",
      expected: ["lane_ping"],
    });
  });

  it("accepts --flag=value, --expect lists and a leading --", () => {
    expect(
      parseArgs(["--", "--url=http://localhost:3000/api/mcp", "--expect", "lane_ping, lane_join"]),
    ).toEqual({
      url: "http://localhost:3000/api/mcp",
      expected: ["lane_ping", "lane_join"],
    });
  });

  it("requires --url and rejects unknown flags", () => {
    expect(() => parseArgs([])).toThrow(/--url/);
    expect(() => parseArgs(["--url"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--url", "https://x.test", "--verbose"])).toThrow(/Unknown argument/);
  });
});

describe("normalizeMcpUrl", () => {
  it("appends /api/mcp to a bare origin and keeps explicit paths", () => {
    expect(normalizeMcpUrl("https://lane.example.com")).toBe("https://lane.example.com/api/mcp");
    expect(normalizeMcpUrl("https://lane.example.com/custom/mcp")).toBe(
      "https://lane.example.com/custom/mcp",
    );
  });
});

describe("compareToolNames", () => {
  it("fails on a missing tool and reports extras without failing", () => {
    expect(compareToolNames(["lane_ping"], ["lane_ping", "lane_other"])).toEqual({
      ok: true,
      missing: [],
      extra: ["lane_other"],
    });
    expect(compareToolNames(["lane_ping", "lane_join"], ["lane_ping"])).toEqual({
      ok: false,
      missing: ["lane_join"],
      extra: [],
    });
  });
});

describe("runSmoke against a live MCP server", () => {
  let server: LocalServer;

  beforeAll(async () => {
    const handler = createMcpHandler((mcp) => {
      mcp.registerTool(
        "lane_ping",
        { description: "test ping", inputSchema: z.object({}) },
        async () => {
          const result = { ok: true, server_time: "2026-10-11T20:00:00.000Z" };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      );
    });
    server = await serveRoutes({ "/api/mcp": { GET: handler, POST: handler } });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("passes when every expected tool is listed and returns lane_ping's time", async () => {
    const result = await runSmoke({ url: normalizeMcpUrl(server.origin), expected: ["lane_ping"] });
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual(["lane_ping"]);
    expect(result.serverTime).toBe("2026-10-11T20:00:00.000Z");
  });

  it("fails when an expected tool is missing", async () => {
    const result = await runSmoke({
      url: `${server.origin}/api/mcp`,
      expected: ["lane_ping", "lane_check_in"],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["lane_check_in"]);
  });
});
