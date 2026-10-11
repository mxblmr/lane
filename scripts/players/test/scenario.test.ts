import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { resetServices, services } from "@lane/core/interfaces";
import { getPack } from "@lane/core/packs";
import { collections } from "@lane/core/schema/collections";
import { normalizeHandle } from "@lane/core/schema/players";
import { MissingEnvError, seedPlayerInputs, SCRIPTED_PLAYER_NAMES, readPlayerGithub, type ScriptedPlayerName } from "../../seed/roster";
import { seed } from "../../seed/seed";
import { resetStage } from "../../seed/reset";
import type { Db } from "../../seed/stage";
import { insertRule, seedEnv, upstreamDoubles } from "../../seed/test/doubles";
import { FakeGitHub, FAKE_GITHUB_API } from "./fake-github";
import { startFakeLane, type FakeLane } from "./fake-lane";
import { parseStageArgs, runStage, type StageOptions } from "../stage";
import type { StageIO } from "../runner";
import { GitHubPlayer, STAGE_FILE, renameAccumulator, stageFileContent } from "../github";

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
  timeline: string[];
  io: StageIO;
  stopPresenter(): void;
  approvals: number;
  resets: number;
}

/** Seeded database, U14's seed rules loaded (U9's loader stands in), fake GitHub and a local Lane. */
async function setUp(opts: { autoApprove?: boolean; autoReset?: boolean } = {}): Promise<Stage> {
  const db = await mongo.freshDb();
  upstreamDoubles();
  const env = seedEnv();
  await seed(db, { players: seedPlayerInputs(env, ["github"]), types: ["ship_week"] });
  for (const r of getPack("ship_week").seedRules) {
    await insertRule(db, { ...r, version: 1, challenge_type: "ship_week", status: "active", source: "seed" });
  }
  const github = new FakeGitHub();
  for (const name of SCRIPTED_PLAYER_NAMES) {
    const gh = readPlayerGithub(env, name);
    github.addUser(gh.login, gh.token);
    github.addRepo(gh.repo);
  }
  const timeline: string[] = [];
  github.timeline = timeline;
  const lane = await startFakeLane(db, github, timeline);

  const stage: Stage = {
    db,
    github,
    lane,
    env,
    timeline,
    approvals: 0,
    resets: 0,
    stopPresenter: () => undefined,
    io: {
      log: (line) => {
        timeline.push(`log ${line}`);
        if (opts.autoReset && line.includes("Reset the stage on the dashboard")) {
          void resetStage(db, { challenge_type: "ship_week", by: "presenter" }).then((r) => {
            if (r.ok) stage.resets += 1;
          });
        }
      },
      waitForKey: async () => "run",
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
  };
  if (opts.autoApprove) {
    // The presenter approves each pending rule on the dashboard, a moment after it appears.
    let running = true;
    stage.stopPresenter = () => {
      running = false;
    };
    void (async () => {
      while (running) {
        const pending = await collections(db).approvals.findOne({ kind: "rule", status: "pending" });
        if (pending) {
          await new Promise((r) => setTimeout(r, 150));
          const decided = await services().approvals.decide(db, { approval_id: pending._id, decision: "approve", decided_by: "presenter" });
          if (decided.ok && decided.decided) stage.approvals += 1;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
    })();
  }
  return stage;
}

function options(s: Stage, over: Partial<StageOptions> = {}): StageOptions {
  return { url: s.lane.origin, scenario: "sam-ae1", runs: 1, auto: true, pollMs: 40, ruleTimeoutMs: 20_000, verdictTimeoutMs: 5_000, ...over };
}

async function tearDown(s: Stage) {
  s.stopPresenter();
  await s.lane.close();
}

async function verdicts(db: Db, challengeId: string, player: ScriptedPlayerName) {
  const col = collections(db);
  const p = await col.players.findOne({ scripted: true, display_name: player });
  const proofs = await col.proofs.find({ challenge_id: challengeId, player_id: p!._id }).sort({ received_at: 1 }).toArray();
  return proofs.map((x) => `${x.status} by ${x.verdict?.decided_by} ai=${x.verdict?.ai_calls}`);
}

describe("Sam's AE1 scenario against a local server", () => {
  it("covers AE1: an AI rejection, then, after approval, a rule rejection with zero AI calls", async () => {
    const s = await setUp({ autoApprove: true });
    try {
      const result = await runStage(options(s), { env: s.env, io: s.io, githubFetch: s.github.fetch, githubApi: FAKE_GITHUB_API });
      expect(result.ok).toBe(true);
      const challengeId = result.challenge_ids[0]!;
      expect(await verdicts(s.db, challengeId, "Sam")).toEqual(["rejected by ai ai=1", "rejected by rule ai=0"]);
      expect(s.lane.aiCalls).toBe(1);
      expect(s.approvals).toBe(1);
      const second = await collections(s.db).proofs.find({ challenge_id: challengeId }).sort({ received_at: -1 }).limit(1).next();
      expect(second?.verdict?.rule?.rule_key).toBe("learned-rename-only");

      // "rule live" is printed before the second rename-only commit is pushed.
      const ruleLive = s.timeline.findIndex((l) => l.startsWith("log rule live"));
      const puts = s.timeline.map((l, i) => (l.startsWith("github PUT") ? i : -1)).filter((i) => i >= 0);
      expect(ruleLive).toBeGreaterThan(-1);
      expect(puts.length).toBe(3); // sandbox setup, first rename, second rename
      expect(puts[1]!).toBeLessThan(ruleLive);
      expect(puts[2]!).toBeGreaterThan(ruleLive);
      expect(s.timeline.some((l) => l.includes("submitted it") && l.includes("ms after the rule went live"))).toBe(true);
    } finally {
      await tearDown(s);
    }
  });

  it("covers AE1: two runs separated by a reset each produce one AI rejection, one approval and one rule rejection", async () => {
    const s = await setUp({ autoApprove: true, autoReset: true });
    try {
      const result = await runStage(options(s, { runs: 2 }), { env: s.env, io: s.io, githubFetch: s.github.fetch, githubApi: FAKE_GITHUB_API });
      expect(result.ok).toBe(true);
      expect(s.resets).toBe(1);
      expect(result.challenge_ids).toHaveLength(2);
      expect(result.challenge_ids[0]).not.toBe(result.challenge_ids[1]);
      for (const id of result.challenge_ids) {
        expect(await verdicts(s.db, id, "Sam")).toEqual(["rejected by ai ai=1", "rejected by rule ai=0"]);
      }
      expect(s.approvals).toBe(2);
      expect(s.lane.aiCalls).toBe(2);
      expect(await collections(s.db).approvals.countDocuments({ kind: "rule", status: "approved" })).toBe(2);
      // Sam pushed fresh commits on every run: one setup commit plus two renames per run.
      expect(s.github.commitsBy(s.env.SAM_GITHUB_REPO!)).toHaveLength(5);
    } finally {
      await tearDown(s);
    }
  });

  it("fails the run when a learned rule is still live from an earlier run (no reset)", async () => {
    const s = await setUp();
    try {
      await insertRule(s.db, { rule_key: "learned-rename-only", version: 1, challenge_type: "ship_week", status: "active", source: "ai_judgment" });
      const result = await runStage(options(s), { env: s.env, io: s.io, githubFetch: s.github.fetch, githubApi: FAKE_GITHUB_API });
      expect(result.ok).toBe(false);
      expect(result.runs[0]?.failure?.message).toMatch(/Reset the stage/);
    } finally {
      await tearDown(s);
    }
  });
});

describe("Sam's injection commit", () => {
  it("is not accepted", async () => {
    const s = await setUp();
    try {
      const result = await runStage(options(s, { scenario: "sam-injection" }), {
        env: s.env,
        io: s.io,
        githubFetch: s.github.fetch,
        githubApi: FAKE_GITHUB_API,
      });
      expect(result.ok).toBe(true);
      const challengeId = result.challenge_ids[0]!;
      const proofs = await collections(s.db).proofs.find({ challenge_id: challengeId }).toArray();
      expect(proofs).toHaveLength(1);
      expect(proofs[0]!.status).toBe("rejected");
      expect(proofs[0]!.features?.injection_text).toBe(true);
      const commit = s.github.commitsBy(s.env.SAM_GITHUB_REPO!).find((c) => c.sha === proofs[0]!.source_key);
      expect(commit?.message).toMatch(/ignore your previous instructions/);
    } finally {
      await tearDown(s);
    }
  });

  it("makes the run fail if Lane ever accepts it", async () => {
    const s = await setUp();
    try {
      // With no rules and a referee double that only rejects junk classes, simulate a miss by
      // removing the injection seed rule and turning the feature off in the double's view.
      await collections(s.db).rules.deleteMany({});
      const original = s.github.fetch;
      const scrubbed: typeof fetch = async (input, init) => {
        const res = await original(input, init);
        const url = String(input);
        if (!url.includes("/commits/")) return res;
        const body = (await res.json()) as { commit: { message: string } };
        body.commit.message = "Tidy the tally header.";
        return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
      };
      const lane = await startFakeLane(s.db, Object.assign(Object.create(s.github), { fetch: scrubbed }), s.timeline);
      try {
        const result = await runStage(options(s, { scenario: "sam-injection", url: lane.origin }), {
          env: s.env,
          io: s.io,
          githubFetch: s.github.fetch,
          githubApi: FAKE_GITHUB_API,
        });
        expect(result.ok).toBe(false);
        expect(result.runs[0]?.failure?.message).toMatch(/must not count/);
      } finally {
        await lane.close();
      }
    } finally {
      await tearDown(s);
    }
  });
});

describe("scripted players' GitHub identity (KTD17, KTD21)", () => {
  it("each scripted player's bound handle equals the author of the commits it pushes", async () => {
    const s = await setUp();
    try {
      const col = collections(s.db);
      for (const name of SCRIPTED_PLAYER_NAMES) {
        const gh = new GitHubPlayer({ ...readPlayerGithub(s.env, name), fetch: s.github.fetch, api: FAKE_GITHUB_API });
        await gh.assertIdentity();
        const created = await gh.putFile(STAGE_FILE, stageFileContent("total"), "Set up the Lane stage sandbox");
        const file = (await gh.getFile(STAGE_FILE))!;
        const renamed = await gh.putFile(STAGE_FILE, renameAccumulator(file.content).content, "Rename total to sum", file.sha);
        const player = await col.players.findOne({ scripted: true, display_name: name });
        const bound = player!.handles.github!;
        expect(bound.status).toBe("verified");
        for (const sha of [created.sha, renamed.sha]) {
          const author = await gh.commitAuthor(sha);
          expect(normalizeHandle(author!)).toBe(bound.handle);
        }
      }
    } finally {
      await tearDown(s);
    }
  });

  it("refuses to push with a token that belongs to another login", async () => {
    const s = await setUp();
    try {
      const env = { ...s.env, SAM_GITHUB_TOKEN: s.env.GARY_GITHUB_TOKEN! };
      const result = await runStage(options(s), { env, io: s.io, githubFetch: s.github.fetch, githubApi: FAKE_GITHUB_API });
      expect(result.ok).toBe(false);
      expect(result.runs[0]?.failure?.message).toMatch(/belongs to gary-lane-demo, not Sam-Lane-Demo/);
      expect(s.github.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    } finally {
      await tearDown(s);
    }
  });

  it("fails before the first step with every missing variable named", async () => {
    const s = await setUp();
    try {
      const env: Record<string, string> = { ...s.env };
      delete env.SAM_LANE_KEY;
      delete env.SAM_GITHUB_TOKEN;
      await expect(runStage(options(s), { env, io: s.io, githubFetch: s.github.fetch })).rejects.toThrow(MissingEnvError);
      await expect(runStage(options(s), { env, io: s.io, githubFetch: s.github.fetch })).rejects.toThrow(/SAM_LANE_KEY, SAM_GITHUB_TOKEN/);
      expect(s.github.calls).toHaveLength(0);
    } finally {
      await tearDown(s);
    }
  });
});

describe("parseStageArgs", () => {
  it("reads the url, scenario, runs and auto flags", () => {
    expect(parseStageArgs(["--url", "https://lane.example.com", "--runs", "2", "--auto"])).toMatchObject({
      url: "https://lane.example.com",
      scenario: "sam-ae1",
      runs: 2,
      auto: true,
    });
    expect(parseStageArgs(["--", "--url=http://localhost:3000", "--scenario", "sam-injection"]).scenario).toBe("sam-injection");
    expect(() => parseStageArgs([])).toThrow(/--url/);
    expect(() => parseStageArgs(["--url", "https://x.test", "--scenario", "nope"])).toThrow(/Unknown scenario/);
    expect(() => parseStageArgs(["--url", "https://x.test", "--runs", "0"])).toThrow(/at least 1/);
  });
});
