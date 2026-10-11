import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { PLAY_CREDIT_LABEL, updateSettings } from "../../src/config";
import { provideServices, resetServices } from "../../src/interfaces";
import { TOOL_NAMES, type ToolName } from "../../src/schema/common";
import { EnvelopeSchema, type Envelope } from "../../src/schema/envelope";
import { LANE_TOOLS, listLaneTools, runTool, toolInputJsonSchema } from "../../src/tools/registry";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import {
  SAMPLE_ARGS,
  T0,
  ae8CheckInChallenge,
  countAll,
  fakeChallenge,
  fakePlayer,
  fakeProof,
  toolDoubles,
  type ToolDoubles,
} from "../../src/testing/tools";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});
afterEach(() => {
  resetServices();
});

const PLAYER_TOOLS = TOOL_NAMES.filter((n) => n !== "lane_register");

async function setup(): Promise<{ db: Db; doubles: ToolDoubles; ctx: { db: () => Promise<Db>; now: Date } }> {
  const db = await mongo.freshDb();
  const doubles = toolDoubles();
  provideServices(doubles.overrides);
  return { db, doubles, ctx: { db: async () => db, now: T0 } };
}

async function register(ctx: { db: () => Promise<Db>; now: Date }, name = "Maya"): Promise<{ key: string; player_id: string; env: Envelope }> {
  const env = await runTool("lane_register", { display_name: name, time_zone: "America/Los_Angeles" }, ctx);
  expect(env.status).toBe("ok");
  const data = env.data as { player_key: string; player_id: string };
  return { key: data.player_key, player_id: data.player_id, env };
}

describe("tool definitions", () => {
  it("defines exactly the eight lane_ tools, each with a description and a flat argument schema", () => {
    expect(listLaneTools().map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of listLaneTools()) {
      expect(tool.description.length).toBeGreaterThan(80);
      const schema = toolInputJsonSchema(tool.name);
      expect(schema.type).toBe("object");
      const properties = schema.properties as Record<string, { type?: string; items?: { type?: string }; description?: string }>;
      for (const [field, prop] of Object.entries(properties)) {
        expect(prop.type, `${tool.name}.${field}`).not.toBe("object");
        if (prop.type === "array") expect(prop.items?.type).toBe("string");
        expect(prop.description, `${tool.name}.${field} has a description`).toBeTruthy();
      }
      if (tool.name !== "lane_register") expect(Object.keys(properties)).toContain("player_key");
    }
  });

  it("tells Muse to show the draft or terms and wait for the player's own answer, never defaults", () => {
    for (const name of ["lane_confirm_challenge", "lane_join_challenge"] as const) {
      const d = LANE_TOOLS[name].description;
      expect(d).toMatch(/wait for the player's own answer/i);
      expect(d).toMatch(/never/i);
    }
    expect(LANE_TOOLS.lane_confirm_challenge.description).toMatch(/never fill winner_rule or stake from defaults/i);
    expect(LANE_TOOLS.lane_join_challenge.description).toMatch(/never fill accepted_terms_version from a default/i);
    expect(LANE_TOOLS.lane_create_challenge.description).toMatch(/word for word/);
    expect(LANE_TOOLS.lane_join_challenge.description).toMatch(/word for word/);
    // Player-kind actions are relayed, not done.
    expect(LANE_TOOLS.lane_check_in.description).toMatch(/relay the instruction to the player and do not do it yourself/);
  });
});

describe("identity (KTD4)", () => {
  it("resolves the same player from a bearer key and from a player_key argument", async () => {
    const { doubles, ctx } = await setup();
    const { key, player_id } = await register(ctx);

    const viaBearer = await runTool("lane_check_in", {}, { ...ctx, bearer: key });
    const viaArgument = await runTool("lane_check_in", { player_key: key }, ctx);
    const viaBoth = await runTool("lane_check_in", { player_key: key }, { ...ctx, bearer: key });
    expect([viaBearer.status, viaArgument.status, viaBoth.status]).toEqual(["ok", "ok", "ok"]);

    const checkIns = doubles.calls.filter((c) => c.service === "checkin.checkIn");
    expect(checkIns.map((c) => c.input.player_id)).toEqual([player_id, player_id, player_id]);
  });

  it("refuses two different keys in one call", async () => {
    const { doubles, ctx } = await setup();
    const maya = await register(ctx, "Maya");
    const sam = await register(ctx, "Sam");
    const env = await runTool("lane_check_in", { player_key: sam.key }, { ...ctx, bearer: maya.key });
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("unauthenticated");
    expect(env.error?.recovery).toMatch(/one player key/);
    expect(doubles.calls.some((c) => c.service === "checkin.checkIn")).toBe(false);
  });

  it("answers an unknown key with a recovery instruction", async () => {
    const { ctx } = await setup();
    const env = await runTool("lane_check_in", { player_key: "lane_pk_not_a_real_key_at_all" }, ctx);
    expect(env.error?.code).toBe("unauthenticated");
    expect(env.error?.recovery).toMatch(/lane_register/);
  });

  it("refuses every tool except lane_register without a key, writing nothing", async () => {
    const { db, doubles } = await setup();
    let opened = 0;
    const ctx = {
      db: async () => {
        opened += 1;
        return db;
      },
      now: T0,
    };
    const before = await countAll(db);
    for (const name of PLAYER_TOOLS) {
      const env = await runTool(name, SAMPLE_ARGS[name], ctx);
      expect(EnvelopeSchema.parse(env)).toEqual(env);
      expect(env.status, name).toBe("error");
      expect(env.error?.code, name).toBe("unauthenticated");
      expect(env.error?.recovery, name).toMatch(/lane_register/);
    }
    expect(doubles.calls).toEqual([]);
    expect(opened).toBe(0);
    expect(await countAll(db)).toEqual(before);
  });
});

describe("lane_register", () => {
  it("returns the key once with the routine and the play-credit label", async () => {
    const { ctx } = await setup();
    const { env, key } = await register(ctx);
    expect(EnvelopeSchema.parse(env)).toEqual(env);
    expect(key).toMatch(/^lane_pk_/);
    expect(env.lines.join(" ")).not.toContain(key);
    expect(env.lines[0]).toContain(`1,000 ${PLAY_CREDIT_LABEL}`);
    expect(env.data).toMatchObject({ credit_label: PLAY_CREDIT_LABEL, routine: { tool: "lane_check_in", interval_min: 27 } });
  });

  it("returns a recovery instruction and creates no player when registration is closed", async () => {
    const { db, doubles, ctx } = await setup();
    await updateSettings(db, { registration_open: false });
    const env = await runTool("lane_register", SAMPLE_ARGS.lane_register, ctx);
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("registration_closed");
    expect(env.error?.recovery).toBeTruthy();
    expect(doubles.calls).toEqual([]);
    expect(await db.collection("players").countDocuments()).toBe(0);
  });

  it("refuses a display name outside 24 letters, digits and spaces", async () => {
    const { db, doubles, ctx } = await setup();
    const env = await runTool("lane_register", { display_name: "<script>alert(1)</script>", time_zone: "UTC" }, ctx);
    expect(env.error?.code).toBe("invalid_input");
    expect(doubles.calls).toEqual([]);
    expect(await db.collection("players").countDocuments()).toBe(0);
  });
});

describe("results never carry the player key", () => {
  it("leaves the key out of every result except the register result that issues it", async () => {
    const { ctx } = await setup();
    const { key } = await register(ctx);
    const calls: [ToolName, Record<string, unknown>][] = [
      ...PLAYER_TOOLS.map((n) => [n, SAMPLE_ARGS[n]!] as [ToolName, Record<string, unknown>]),
      ["lane_create_challenge", { sentence: "Ship Week please", draft_id: "chl_draft1" }],
      ["lane_join_challenge", { join_code: "SHIP42", accepted_terms_version: "terms-v1", handle: "maya" }],
      ["lane_confirm_challenge", { draft_id: "chl_draft1", winner_rule: "nobody", stake: 50 }],
      ["lane_submit_proof", { repo: "maya/app" }],
    ];
    for (const [name, args] of calls) {
      for (const style of ["bearer", "argument"] as const) {
        const env =
          style === "bearer"
            ? await runTool(name, args, { ...ctx, bearer: key })
            : await runTool(name, { ...args, player_key: key }, ctx);
        expect(JSON.stringify(env), `${name} via ${style}`).not.toContain(key);
      }
    }
  });

  it("redacts the key even if a domain result echoes it", async () => {
    const { ctx } = await setup();
    const { key } = await register(ctx);
    provideServices({ ask: { ask: async () => ({ ok: true, answer: `Your key is ${key}` }) } });
    const env = await runTool("lane_ask", { question: "what is my key?" }, { ...ctx, bearer: key });
    expect(JSON.stringify(env)).not.toContain(key);
    expect(env.lines[0]).toBe("Your key is [redacted]");
  });
});

describe("errors come back as results with a recovery instruction", () => {
  it("answers invalid arguments without echoing their values", async () => {
    const { doubles, ctx } = await setup();
    const { key } = await register(ctx);
    const env = await runTool("lane_confirm_challenge", { draft_id: "chl_x", winner_rule: "SECRETVALUE", stake: -3 }, { ...ctx, bearer: key });
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("invalid_input");
    expect(env.lines[0]).toMatch(/winner_rule/);
    expect(env.lines[0]).toMatch(/stake/);
    expect(JSON.stringify(env)).not.toContain("SECRETVALUE");
    expect(env.error?.recovery).toMatch(/lane_confirm_challenge/);
    expect(doubles.calls.some((c) => c.service === "challenges.confirm")).toBe(false);
  });

  it("passes a domain refusal through with its recovery instruction", async () => {
    const { ctx } = await setup();
    const { key } = await register(ctx);
    provideServices({
      challenges: {
        join: async () => ({
          ok: false,
          error: { code: "insufficient_credits", message: `The stake is 2,000 ${PLAY_CREDIT_LABEL}.`, recovery: "Nothing was staked." },
        }),
      },
    });
    const env = await runTool("lane_join_challenge", { join_code: "SHIP42" }, { ...ctx, bearer: key });
    expect(env).toMatchObject({ status: "error", error: { code: "insufficient_credits", recovery: "Nothing was staked." } });
  });

  it("turns a service that is not wired yet into a try-again result", async () => {
    const db = await mongo.freshDb();
    const doubles = toolDoubles();
    provideServices({ players: doubles.overrides.players });
    const ctx = { db: async () => db, now: T0 };
    const { key } = await register(ctx);
    const env = await runTool("lane_ask", { question: "standing?" }, { ...ctx, bearer: key });
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("internal");
    expect(env.lines[0]).toMatch(/not live yet/);
    expect(env.error?.recovery).toMatch(/lane_ask again/);
  });

  it("asks for challenge_id or request_id before submitting proof", async () => {
    const { doubles, ctx } = await setup();
    const { key } = await register(ctx);
    const env = await runTool("lane_submit_proof", { repo: "maya/app", sha: "a".repeat(40) }, { ...ctx, bearer: key });
    expect(env.error?.code).toBe("invalid_input");
    expect(env.error?.recovery).toMatch(/challenge_id/);
    expect(doubles.calls.some((c) => c.service === "proofs.submit")).toBe(false);
  });
});

describe("tool results", () => {
  it("covers AE8: a check-in for a player in two challenges returns one envelope with both", async () => {
    const { doubles, ctx } = await setup();
    const { key, player_id } = await register(ctx);
    const player = fakePlayer({ _id: player_id });
    const shipWeek = ae8CheckInChallenge(player);
    const customers = ae8CheckInChallenge(player, fakeChallenge({ type: "customers", title: "Talk to Customers" }));
    customers.actions = [];
    customers.contract = null;
    customers.contract_changed = false;
    doubles.checkIns.set(player_id, [shipWeek, customers]);

    const env = await runTool("lane_check_in", {}, { ...ctx, bearer: key });
    expect(EnvelopeSchema.parse(env)).toEqual(env);
    expect(env.challenges.map((c) => c.challenge_id)).toEqual([shipWeek.challenge._id, customers.challenge._id]);
    const ship = env.challenges[0]!;
    expect(ship.actions[0]).toMatchObject({ kind: "extra_proof", actor: "player" });
    expect(ship.standings[0]?.is_you).toBe(true);
    expect(ship.contract).toMatchObject({ version: 2 });
    expect(env.lines).toEqual(["Lane has 1 request to relay to the player.", "1 contract changed. Follow the new version from now on."]);
    expect(env.next_check_in_at).toBe(new Date(T0.getTime() + 27 * 60_000).toISOString());
  });

  it("walks create, confirm, join and submit with the draft and terms text to present", async () => {
    const { doubles, ctx } = await setup();
    const { key } = await register(ctx);
    const c = { ...ctx, bearer: key };

    const question = await runTool("lane_create_challenge", { sentence: "start Build in Public with my friends" }, c);
    expect(question.data).toMatchObject({ kind: "question", draft_id: "chl_draft1", question: "Which platforms count?" });
    expect(question.lines).toEqual(["Which platforms count?"]);

    const draft = await runTool("lane_create_challenge", { sentence: "X and LinkedIn", draft_id: "chl_draft1" }, c);
    expect(draft.data).toMatchObject({
      kind: "draft",
      present: {
        lines: ["Ship Week: a meaningful commit on your own project each day for 7 days.", "Goal: 5 verified days."],
        winner_rule_choices: [{ value: "top_score" }, { value: "finishers_split" }],
      },
    });

    const confirmed = await runTool("lane_confirm_challenge", SAMPLE_ARGS.lane_confirm_challenge!, c);
    expect(EnvelopeSchema.parse(confirmed)).toEqual(confirmed);
    expect(confirmed.data).toMatchObject({ join_code: "SHIP42", stake: 50, credit_label: PLAY_CREDIT_LABEL });
    expect(confirmed.lines[0]).toContain(`50 ${PLAY_CREDIT_LABEL}`);
    expect(confirmed.challenges[0]?.contract?.version).toBe(1);
    expect(doubles.calls.find((x) => x.service === "challenges.confirm")?.input).toMatchObject({ winner_rule: "top_score", stake: 50 });

    const terms = await runTool("lane_join_challenge", { join_code: "ship42" }, c);
    expect(terms.data).toMatchObject({ phase: "terms", terms_version: "terms-v1", handle_platform: "github", present: { choices: ["accept", "decline"] } });
    expect((terms.data as { present: { lines: string[] } }).present.lines[0]).toContain(PLAY_CREDIT_LABEL);
    expect(terms.lines[0]).toContain(`50 ${PLAY_CREDIT_LABEL}`);
    expect(doubles.calls.find((x) => x.service === "challenges.join")?.input).toMatchObject({ join_code: "SHIP42" });

    const joined = await runTool("lane_join_challenge", { join_code: "SHIP42", accepted_terms_version: "terms-v1", handle: "maya" }, c);
    expect(joined.data).toMatchObject({ phase: "joined", stake: 50, routine_text: expect.any(String) });
    expect(joined.lines[0]).toContain(`50 ${PLAY_CREDIT_LABEL}`);
    expect(joined.challenges[0]?.actions[0]).toMatchObject({ kind: "bind_code", actor: "player", tool: "lane_submit_proof" });

    const proof = await runTool("lane_submit_proof", SAMPLE_ARGS.lane_submit_proof!, c);
    expect(proof).toMatchObject({ status: "ok", lines: ["Lane accepted the commit for day 1."], data: { outcome: "accepted" } });
    const submitted = doubles.calls.find((x) => x.service === "proofs.submit")?.input as { fields: Record<string, unknown> };
    expect(submitted.fields).toEqual({ repo: "maya/app", sha: "a".repeat(40) });
  });

  it("puts every credit amount in a tool line next to the play-credit label (R7)", async () => {
    const { ctx } = await setup();
    const { key, env: registered } = await register(ctx);
    const c = { ...ctx, bearer: key };
    const results = [
      registered,
      await runTool("lane_confirm_challenge", SAMPLE_ARGS.lane_confirm_challenge!, c),
      await runTool("lane_join_challenge", { join_code: "SHIP42" }, c),
      await runTool("lane_join_challenge", { join_code: "SHIP42", accepted_terms_version: "terms-v1", handle: "maya" }, c),
    ];
    for (const env of results) {
      for (const line of env.lines) {
        if (/credit/i.test(line)) expect(line).toMatch(/\d[\d,]* play credits? \(no real money\)|play credits \(no real money\)/);
      }
    }
  });

  it("returns pending while the referees review and relays a dispute without the reason", async () => {
    const { ctx } = await setup();
    const { key } = await register(ctx);
    const c = { ...ctx, bearer: key };
    provideServices({
      proofs: {
        submit: async (_db, input) => {
          const challenge = fakeChallenge({ _id: input.challenge_id! });
          const proof = fakeProof(challenge, fakePlayer({ _id: input.player_id }), { status: "ai_review", verdict: null });
          return { ok: true, proof, outcome: "pending", duplicate: false, verdict: null, request: null, lines: [] };
        },
      },
    });
    const pending = await runTool("lane_submit_proof", SAMPLE_ARGS.lane_submit_proof!, c);
    expect(pending.status).toBe("pending");
    expect(pending.lines[0]).toMatch(/still reviewing/);

    const dispute = await runTool("lane_dispute", SAMPLE_ARGS.lane_dispute!, c);
    expect(dispute.status).toBe("ok");
    expect(JSON.stringify(dispute)).not.toContain("call with a friend");

    const ask = await runTool("lane_ask", SAMPLE_ARGS.lane_ask!, c);
    expect(ask.lines).toEqual(["You are first with 2 verified days."]);
  });
});
