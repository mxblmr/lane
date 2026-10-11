import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import * as mcpRoute from "../app/api/mcp/route";
import * as pingRoute from "../app/api/v1/ping/route";
import * as openapiRoute from "../app/api/v1/openapi.json/route";

// The real route modules, served on a local HTTP port with the same paths as
// the deployed app, and called the way Muse and the smoke script call them.
let server: LocalServer;

beforeAll(async () => {
  server = await serveRoutes({
    "/api/mcp": { GET: mcpRoute.GET, POST: mcpRoute.POST, DELETE: mcpRoute.DELETE },
    "/api/v1/ping": { GET: pingRoute.GET, POST: pingRoute.POST },
    "/api/v1/openapi.json": { GET: openapiRoute.GET },
  });
});

afterAll(async () => {
  await server?.close();
});

async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "lane-web-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/api/mcp`)));
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function expectServerTime(value: unknown, before: number, after: number) {
  expect(typeof value).toBe("string");
  const time = Date.parse(value as string);
  expect(new Date(time).toISOString()).toBe(value);
  expect(time).toBeGreaterThanOrEqual(before);
  expect(time).toBeLessThanOrEqual(after);
}

describe("MCP route", () => {
  it("answers tools/list with lane_ping", async () => {
    const tools = await withMcpClient(async (client) => (await client.listTools()).tools);
    expect(tools.map((tool) => tool.name)).toEqual(["lane_ping"]);
    const pingTool = tools[0];
    expect(pingTool?.description).toMatch(/server time/i);
  });

  it("returns the server time from lane_ping", async () => {
    const before = Date.now();
    const result = await withMcpClient((client) =>
      client.callTool({ name: "lane_ping", arguments: {} }),
    );
    const after = Date.now();

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.service).toBe("lane");
    expectServerTime(structured.server_time, before, after);

    const content = result.content as Array<{ type: string; text?: string }>;
    expect(content[0]?.type).toBe("text");
    expect(JSON.parse(content[0]?.text ?? "{}")).toEqual(structured);
  });
});

describe("JSON ping route", () => {
  it("answers a POST with the server time", async () => {
    const before = Date.now();
    const response = await fetch(`${server.origin}/api/v1/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("lane");
    expectServerTime(body.server_time, before, after);
  });

  it("answers a POST with no body", async () => {
    const response = await fetch(`${server.origin}/api/v1/ping`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.server_time).toBe("string");
  });
});

describe("OpenAPI stub", () => {
  it("describes lane_ping as POST /api/v1/ping on the requesting origin", async () => {
    const response = await fetch(`${server.origin}/api/v1/openapi.json`);
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, { post?: { operationId?: string } }>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe(server.origin);
    expect(doc.paths["/api/v1/ping"]?.post?.operationId).toBe("lane_ping");
  });

  it("uses the forwarded host and protocol behind Vercel's proxy", async () => {
    const response = await openapiRoute.GET(
      new Request("http://internal:3000/api/v1/openapi.json", {
        headers: { "x-forwarded-host": "lane.example.com", "x-forwarded-proto": "https" },
      }),
    );
    const doc = (await response.json()) as { servers: Array<{ url: string }> };
    expect(doc.servers[0]?.url).toBe("https://lane.example.com");
  });
});
