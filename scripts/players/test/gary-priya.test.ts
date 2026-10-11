import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { resetServices, services } from "@lane/core/interfaces";
import { getPack } from "@lane/core/packs";
import { collections } from "@lane/core/schema/collections";
import { normalizeHandle } from "@lane/core/schema/players";
import type { ChallengeType } from "@lane/core/schema/common";
import { seedPlayerInputs, SCRIPTED_PLAYER_NAMES, readPlayerGithub, type ScriptedPlayerName } from "../../seed/roster";
import { seed } from "../../seed/seed";
import { stageChallengeId, type Db } from "../../seed/stage";
import { insertRule, seedEnv, upstreamDoubles } from "../../seed/test/doubles";
import { FakeGitHub, FAKE_GITHUB_API } from "./fake-github";
import { ae2Doubles, LEARNED_FRIEND_CALLS, startFakeLane, type FakeLane } from "./fake-lane";
import { runStage, type StageOptions } from "../stage";
import type { StageIO } from "../runner";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
}, 120_000);
afterAll(async () => {
  await mongo?.stop();
}, 60_000);

// Tests never reach the network: only the local MCP server is allowed through the global fetch.
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "127.0.0.1") throw new Error(`Network blocked in tests: ${url.origin}`);
    return realFetch(input, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetServices();
});

interface Stage {
  db: Db;
  github: FakeGitHub;
  lane: FakeLane;
  env: Record<string, string>;
  log: string[];
  io: StageIO;
  stop(): void;
  approvals: number;
}

/**
 * Seeded stage with U14's seed rules, a fake GitHub and a local Lane. The "dashboard" loop approves
 * pending rules and runs U18's tick on every poll, as the dashboard's data routes do.
 */
async function setUp(types: ChallengeType[], opts: { graceSec?: number } = {}): Promise<Stage> {
  const db = await mongo.freshDb();
  upstreamDoubles();
  const env = seedEnv();
  await seed(db, { players: seedPlayerInputs(env, ["github"]), types });
  for (const r of getPack("ship_week").seedRules) {
    await insertRule(db, { ...r, version: 1, challenge_type: "ship_week", status: "active", source: "seed" });
  }
  if (opts.graceSec !== undefined) {
    await collections(db).challenges.updateMany({ stage: true }, { $set: { "clock.grace_sec": opts.graceSec } });
  }
  const github = new FakeGitHub();
  for (const name of SCRIPTED_PLAYER_NAMES) {
    const gh = readPlayerGithub(env, name);
    github.addUser(gh.login, gh.token);
    github.addRepo(gh.repo);
  }
  const lane = await startFakeLane(db, github);
  const log: string[] = [];
  const stage: Stage = {
    db,
    github,
    lane,
    env,
    log,
    approvals: 0,
    stop: () => undefined,
    io: {
      log: (line) => log.push(line),
      waitForKey: async () => "run",
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
  };
  let running = true;
  stage.stop = () => {
    running = false;
  };
  void (async () => {
    while (running) {
      await services().tick.run(db, { now: new Date(), holder: "dashboard-poll" });
      const pending = await collections(db).approvals.findOne({ kind: "rule", status: "pending" });
      if (pending) {
        const decided = await services().approvals.decide(db, { approval_id: pending._id, decision: "approve", decided_by: "presenter" });
        if (decided.ok && decided.decided) stage.approvals += 1;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return stage;
}

function options(s: Stage, scenario: string): StageOptions {
  return { url: s.lane.origin, scenario, runs: 1, auto: true, pollMs: 40, ruleTimeoutMs: 20_000, verdictTimeoutMs: 5_000 };
}

async function tearDown(s: Stage) {
  s.stop();
  await new Promise((r) => setTimeout(r, 80));
  await s.lane.close();
}

async function proofsOf(db: Db, challengeId: string, name: ScriptedPlayerName) {
  const col = collections(db);
  const p = await col.players.findOne({ scripted: true, display_name: name });
  return col.proofs.find({ challenge_id: challengeId, player_id: p!._id }).sort({ received_at: 1 }).toArray();
}

describe("Gary and Priya on Ship Week", () => {
  it("each pushes a meaningful commit from their own login, and it counts", async () => {
    const s = await setUp(["ship_week"]);
    try {
      const result = await runStage(options(s, "gary-priya-ship-week"), { env: s.env, io: s.io, githubFetch: s.github.fetch, githubApi: FAKE_GITHUB_API });
      expect(result.ok).toBe(true);
      const id = stageChallengeId("ship_week", 1);
      for (const name of ["Gary", "Priya"] as const) {
        const proofs = await proofsOf(s.db, id, name);
        expect(proofs.map((p) => p.status)).toEqual(["accepted"]);
        expect(proofs[0]!.features?.rename_only).toBe(false);
        expect(Number(proofs[0]!.features?.code_lines_changed)).toBeGreaterThan(5);
        // The commit's GitHub author is the player's bound handle.
        const gh = readPlayerGithub(s.env, name);
        const commit = s.github.commitsBy(gh.repo).find((c) => c.sha === proofs[0]!.source_key);
        const player = await collections(s.db).players.findOne({ scripted: true, display_name: name });
        expect(normalizeHandle(commit!.author_login)).toBe(player!.handles.github!.handle);
      }
    } finally {
      await tearDown(s);
    }
  });

  it("runs the full Ship Week stage: honest commits from Gary and Priya, then Sam's AE1", async () => {
    const s = await setUp(["ship_week"]);
    try {
      const result = await runStage(options(s, "ship-week-stage"), { env: s.env, io: s.io, githubFetch: s.github.fetch, githubApi: FAKE_GITHUB_API });
      expect(result.ok).toBe(true);
      const id = stageChallengeId("ship_week", 1);
      expect((await proofsOf(s.db, id, "Gary")).map((p) => p.status)).toEqual(["accepted"]);
      expect((await proofsOf(s.db, id, "Priya")).map((p) => p.status)).toEqual(["accepted"]);
      const sam = await proofsOf(s.db, id, "Sam");
      expect(sam.map((p) => `${p.status} by ${p.verdict?.decided_by}`)).toEqual(["rejected by ai", "rejected by rule"]);
      expect(s.approvals).toBe(1);
      expect(s.log.some((l) => l.startsWith("rule live"))).toBe(true);
    } finally {
      await tearDown(s);
    }
  });
});

describe("AE2 on Talk to Customers", () => {
  it("covers AE2: Priya's dispute gets Gary asked for notes, the call stops counting, and the ask-more rule goes live without approval", async () => {
    const s = await setUp(["customers"], { graceSec: 1 });
    const learned = ae2Doubles();
    try {
      const env = { ...s.env };
      // Talk to Customers needs only the Lane keys.
      for (const name of ["GARY", "PRIYA"]) {
        delete env[`${name}_GITHUB_TOKEN`];
        delete env[`${name}_GITHUB_REPO`];
      }
      const result = await runStage(options(s, "ae2-customers"), { env, io: s.io });
      expect(result.ok, s.log.join("\n")).toBe(true);
      const id = stageChallengeId("customers", 1);
      const gary = await proofsOf(s.db, id, "Gary");
      expect(gary).toHaveLength(1);
      expect(gary[0]!.status).toBe("not_counted");
      expect(gary[0]!.not_counted_reason).toBe("unanswered");
      expect(gary[0]!.features?.all_personal_email).toBe(true);

      const col = collections(s.db);
      const dispute = await col.disputes.findOne({ proof_id: gary[0]!._id });
      expect(dispute?.outcome).toBe("ask_more");
      const ask = await col.inbox.findOne({ kind: "extra_proof", subject_proof_id: gary[0]!._id });
      expect(ask?.status).toBe("expired");

      expect(learned.learned).toBe(1);
      const rule = await col.rules.findOne({ challenge_type: "customers", rule_key: LEARNED_FRIEND_CALLS });
      expect(rule).toMatchObject({ status: "active", action: "ask_more", source: "dispute" });
      expect(s.approvals).toBe(0);
      expect(await col.approvals.countDocuments({})).toBe(0);
      expect(s.log.some((l) => l.startsWith("rule live (no approval needed)"))).toBe(true);
      expect(s.github.calls).toHaveLength(0);
    } finally {
      await tearDown(s);
    }
  });
});
