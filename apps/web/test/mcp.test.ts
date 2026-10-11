import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Db } from "mongodb";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serveRoutes, type LocalServer } from "@lane/core/testing/http";
import { closeMongoClient } from "@lane/core/db";
import { updateSettings } from "@lane/core/config";
import { laneDb, provideServices, resetServices } from "@lane/core/interfaces";
import { TOOL_NAMES } from "@lane/core/schema/common";
import { EnvelopeSchema, type Envelope } from "@lane/core/schema/envelope";
import {
  SAMPLE_ARGS,
  ae8CheckInChallenge,
  countAll,
  fakeChallenge,
  fakePlayer,
  toolDoubles,
  type ToolDoubles,
} from "@lane/core/testing/tools";
import { playersService } from "@lane/core/players";
import * as mcpRoute from "../app/api/mcp/route";
import { SERVICE_WIRING } from "../lib/services";

// The real MCP route on a local HTTP port, called the way Muse and the scripted players call it.
// Registration runs through U6's real players service against an in-memory replica set, so key
// hashing and lookup are the real ones. Services owned by units not merged yet are test doubles.
let replSet: MongoMemoryReplSet;
let server: LocalServer;
let db: Db;
let doubles: ToolDoubles;
let dbCounter = 0;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  server = await serveRoutes({ "/api/mcp": { GET: mcpRoute.GET, POST: mcpRoute.POST, DELETE: mcpRoute.DELETE } });
}, 120_000);

beforeEach(async () => {
  dbCounter += 1;
  process.env.MONGODB_DB = `lane_mcp_test_${process.pid}_${dbCounter}`;
  db = await laneDb();
  doubles = toolDoubles();
  const { players: _doublePlayers, ...others } = doubles.overrides;
  provideServices({ ...others, players: playersService });
});

afterEach(() => {
  resetServices();
});

afterAll(async () => {
  await server?.close();
  await closeMongoClient();
  await replSet?.stop();
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB;
});

async function withClient<T>(key: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "lane-web-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${server.origin}/api/mcp`),
    key ? { authProvider: { token: async () => key } } : undefined,
  );
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ env: Envelope; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false).toBe(false);
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? "";
  const env = EnvelopeSchema.parse(JSON.parse(text));
  expect(result.structuredContent).toEqual(env);
  return { env, text };
}

async function registerPlayer(name = "Maya"): Promise<{ key: string; player_id: string }> {
  return withClient(null, async (client) => {
    const { env } = await call(client, "lane_register", { display_name: name, time_zone: "America/Los_Angeles" });
    expect(env.status).toBe("ok");
    const data = env.data as { player_key: string; player_id: string };
    return { key: data.player_key, player_id: data.player_id };
  });
}

describe("tools/list", () => {
  it("returns exactly the eight lane_ tools, each with a description and a flat argument schema", async () => {
    const tools = await withClient(null, async (client) => (await client.listTools()).tools);
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe("object");
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
      expect(Object.keys(properties).length, tool.name).toBeGreaterThan(0);
      for (const [field, prop] of Object.entries(properties)) {
        expect(prop.type, `${tool.name}.${field}`).not.toBe("object");
        if (prop.type === "array") expect(prop.items?.type).toBe("string");
      }
    }
    const confirm = tools.find((t) => t.name === "lane_confirm_challenge")!;
    expect(confirm.inputSchema.required).toEqual(expect.arrayContaining(["draft_id", "winner_rule", "stake"]));
    expect(confirm.description).toMatch(/wait for the player's own answer/i);
    expect(tools.find((t) => t.name === "lane_join_challenge")!.description).toMatch(/wait for the player's own answer/i);
  });
});

describe("identity over MCP (KTD4)", () => {
  it("resolves the same player from a bearer header and from a player_key argument", async () => {
    const { key, player_id } = await registerPlayer();
    const viaBearer = await withClient(key, (client) => call(client, "lane_check_in", {}));
    const viaArgument = await withClient(null, (client) => call(client, "lane_check_in", { player_key: key }));
    expect(viaBearer.env.status).toBe("ok");
    expect(viaArgument.env.status).toBe("ok");
    const checkIns = doubles.calls.filter((c) => c.service === "checkin.checkIn").map((c) => c.input.player_id);
    expect(checkIns).toEqual([player_id, player_id]);
  });

  it("answers every tool except lane_register with a recovery instruction when the key is missing, and writes nothing", async () => {
    const before = await countAll(db);
    await withClient(null, async (client) => {
      for (const name of TOOL_NAMES.filter((n) => n !== "lane_register")) {
        const { env } = await call(client, name, SAMPLE_ARGS[name]!);
        expect(env.status, name).toBe("error");
        expect(env.error?.code, name).toBe("unauthenticated");
        expect(env.error?.recovery, name).toMatch(/lane_register/);
      }
    });
    expect(doubles.calls).toEqual([]);
    expect(await countAll(db)).toEqual(before);
  });

  it("answers a bad argument as a result with a recovery instruction, not a protocol error", async () => {
    const { key } = await registerPlayer();
    const { env } = await withClient(key, (client) =>
      call(client, "lane_confirm_challenge", { draft_id: "chl_x", winner_rule: "whatever", stake: "lots" }),
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("invalid_input");
    expect(env.error?.recovery).toBeTruthy();
  });
});

describe("lane_register", () => {
  it("registers through U6 and starts the player with play credits", async () => {
    const { key, player_id } = await registerPlayer();
    expect(key).toMatch(/^lane_pk_/);
    const stored = await db.collection("players").findOne({ _id: player_id as never });
    expect(stored?.credits).toBe(1000);
    expect(JSON.stringify(stored)).not.toContain(key);
  });

  it("returns a recovery instruction and creates no player when registration is closed", async () => {
    await updateSettings(db, { registration_open: false });
    const { env } = await withClient(null, (client) => call(client, "lane_register", SAMPLE_ARGS.lane_register!));
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("registration_closed");
    expect(env.error?.recovery).toBeTruthy();
    expect(await db.collection("players").countDocuments()).toBe(0);
    expect(await db.collection("ledger").countDocuments()).toBe(0);
  });
});

describe("results", () => {
  it("contain the player key only in the lane_register result that issues it", async () => {
    const { key } = await registerPlayer();
    for (const name of TOOL_NAMES.filter((n) => n !== "lane_register")) {
      const viaBearer = await withClient(key, (client) => call(client, name, SAMPLE_ARGS[name]!));
      const viaArgument = await withClient(null, (client) => call(client, name, { ...SAMPLE_ARGS[name]!, player_key: key }));
      expect(viaBearer.text, name).not.toContain(key);
      expect(viaArgument.text, name).not.toContain(key);
      expect(viaBearer.env.status, name).not.toBe("error");
    }
  });

  it("covers AE8: a check-in for a player in two challenges returns one envelope with both", async () => {
    const { key, player_id } = await registerPlayer();
    const player = fakePlayer({ _id: player_id });
    const now = new Date();
    const shipWeek = ae8CheckInChallenge(player, undefined, now);
    const customers = ae8CheckInChallenge(player, fakeChallenge({ type: "customers", title: "Talk to Customers" }), now);
    customers.actions = [];
    customers.contract = null;
    customers.contract_changed = false;
    doubles.checkIns.set(player_id, [shipWeek, customers]);

    const { env } = await withClient(key, (client) => call(client, "lane_check_in", {}));
    expect(env.challenges.map((c) => c.challenge_id)).toEqual([shipWeek.challenge._id, customers.challenge._id]);
    expect(env.challenges[0]!.actions[0]).toMatchObject({ kind: "extra_proof", actor: "player" });
    expect(env.challenges[0]!.standings[0]).toMatchObject({ player_id, is_you: true });
    expect(env.challenges[0]!.contract_changed).toBe(true);
    expect(env.challenges[0]!.contract?.version).toBe(2);
  });
});

describe("wiring", () => {
  it("runs U6's real services and U3's jobs and ledger, with stubs for units not merged yet", () => {
    expect(SERVICE_WIRING.players).toBe("real");
    expect(SERVICE_WIRING.challenges).toBe("real");
    expect(SERVICE_WIRING.contracts).toBe("real");
    expect(SERVICE_WIRING.jobs).toBe("real");
    expect(SERVICE_WIRING.ledger).toBe("real");
  });
});
