/**
 * The stage runner (U13): scripted players act through Lane's MCP connector at --url, like Muse.
 *
 *   pnpm players:stage --url https://<production host>
 *   pnpm players:stage --url <url> --runs 2           AE1 twice; reset on the dashboard between runs
 *   pnpm players:stage --url <url> --scenario sam-injection
 *   pnpm players:stage --url <url> --auto             no keypress between steps (rehearsal checks)
 *
 * One scripted step runs per Enter keypress; q quits. Sam's AE1 waits for the presenter to approve
 * the learned rule on the dashboard, prints "rule live", then pushes and submits at once.
 *
 * Needs, per player in the scenario: <NAME>_LANE_KEY, <NAME>_GITHUB_LOGIN, <NAME>_GITHUB_TOKEN and
 * <NAME>_GITHUB_REPO. Keys and tokens are read from the environment and never printed.
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { readLaneKey, readPlayerGithub, readStagePlayer, MissingEnvError, type Env, type ScriptedPlayerName } from "../seed/roster";
import { GitHubPlayer } from "./github";
import { findChallenge, LaneClient } from "./lane-client";
import { runScenario, type PlayerHandles, type RunResult, type StageContext, type StageIO } from "./runner";
import { SCENARIOS } from "./scenarios/index";

export interface StageOptions {
  url: string;
  scenario: string;
  runs: number;
  auto: boolean;
  pollMs: number;
  ruleTimeoutMs: number;
  verdictTimeoutMs: number;
}

export function parseStageArgs(argv: string[]): StageOptions {
  const opts: StageOptions = {
    url: "",
    scenario: "sam-ae1",
    runs: 1,
    auto: false,
    pollMs: 500,
    ruleTimeoutMs: 10 * 60_000,
    verdictTimeoutMs: 90_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const [flag, inline] = arg.includes("=") ? (arg.split(/=(.*)/s, 2) as [string, string]) : [arg, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    const int = (v: string, min: number): number => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < min) throw new Error(`${flag} needs a whole number of at least ${min}`);
      return n;
    };
    if (flag === "--url") opts.url = value();
    else if (flag === "--scenario") opts.scenario = value();
    else if (flag === "--runs") opts.runs = int(value(), 1);
    else if (flag === "--auto") opts.auto = true;
    else if (flag === "--poll-ms") opts.pollMs = int(value(), 50);
    else if (flag === "--rule-timeout-sec") opts.ruleTimeoutMs = int(value(), 1) * 1000;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.url) throw new Error("Usage: pnpm players:stage --url <deployed url> [--scenario sam-ae1] [--runs 2] [--auto]");
  new URL(opts.url);
  if (!SCENARIOS[opts.scenario]) {
    throw new Error(`Unknown scenario ${opts.scenario}. Use one of ${Object.keys(SCENARIOS).join(", ")}.`);
  }
  return opts;
}

export interface StageDeps {
  env: Env;
  io: StageIO;
  /** GitHub fetch; tests pass a double so they never reach the network. */
  githubFetch?: typeof fetch;
  githubApi?: string;
}

export interface StageResult {
  ok: boolean;
  runs: RunResult[];
  challenge_ids: string[];
}

export async function runStage(opts: StageOptions, deps: StageDeps): Promise<StageResult> {
  const scenario = SCENARIOS[opts.scenario]!;
  const handles = new Map<ScriptedPlayerName, PlayerHandles>();
  const player = (name: ScriptedPlayerName): PlayerHandles => {
    let h = handles.get(name);
    if (!h) {
      if (scenario.needs_github === false) {
        // Talk to Customers needs no GitHub: only the Lane key is required, and any GitHub use fails clearly.
        const lane = new LaneClient(name, opts.url, readLaneKey(deps.env, name));
        h = {
          name,
          lane,
          get github(): GitHubPlayer {
            const github = readPlayerGithub(deps.env, name);
            return new GitHubPlayer({ ...github, fetch: deps.githubFetch, api: deps.githubApi });
          },
        };
      } else {
        const { laneKey, github } = readStagePlayer(deps.env, name);
        h = {
          name,
          lane: new LaneClient(name, opts.url, laneKey),
          github: new GitHubPlayer({ ...github, fetch: deps.githubFetch, api: deps.githubApi }),
        };
      }
      handles.set(name, h);
    }
    return h;
  };
  // Fail before the first step when a variable is missing, naming all of them.
  for (const name of scenario.players) player(name);

  const results: RunResult[] = [];
  const challengeIds: string[] = [];
  try {
    for (let run = 1; run <= opts.runs; run++) {
      if (run > 1) {
        const previous = challengeIds[challengeIds.length - 1]!;
        deps.io.log(`Run ${run - 1} done. Reset the stage on the dashboard; waiting for a new ${scenario.challenge_type} challenge...`);
        await waitForNewChallenge(player(scenario.players[0]!).lane, scenario.challenge_type, previous, deps.io, opts);
      }
      if (opts.runs > 1) deps.io.log(`-- run ${run} of ${opts.runs} --`);
      const ctx: StageContext = {
        io: deps.io,
        player,
        pollMs: opts.pollMs,
        ruleTimeoutMs: opts.ruleTimeoutMs,
        verdictTimeoutMs: opts.verdictTimeoutMs,
        state: {},
      };
      const result = await runScenario(scenario, ctx, { auto: opts.auto });
      results.push(result);
      const key = scenario.challenge_type === "ship_week" ? "shipWeek" : scenario.challenge_type;
      const played = ctx.state[key] as { challenge_id?: string } | undefined;
      if (played?.challenge_id) challengeIds.push(played.challenge_id);
      if (!result.ok) break;
    }
  } finally {
    for (const h of handles.values()) await h.lane.close();
  }
  const ok = results.length === opts.runs && results.every((r) => r.ok);
  return { ok, runs: results, challenge_ids: challengeIds };
}

async function waitForNewChallenge(lane: LaneClient, type: string, previous: string, io: StageIO, opts: StageOptions): Promise<void> {
  const deadline = io.now() + opts.ruleTimeoutMs;
  while (io.now() < deadline) {
    const c = findChallenge(await lane.checkIn(), type);
    if (c && c.challenge_id !== previous) {
      io.log(`New stage challenge ${c.challenge_id} is live.`);
      return;
    }
    await io.sleep(opts.pollMs);
  }
  throw new Error("No new stage challenge appeared. Press Reset on the dashboard, then run again.");
}

function terminalIO(): StageIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    log: (line) => console.log(line),
    waitForKey: async (prompt) => ((await rl.question(prompt)).trim().toLowerCase() === "q" ? "quit" : "run"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    close: () => rl.close(),
  };
}

async function main(): Promise<number> {
  const opts = parseStageArgs(process.argv.slice(2));
  const io = terminalIO();
  try {
    const result = await runStage(opts, { env: process.env, io });
    io.log(result.ok ? `PASS: ${result.runs.length} run(s) of ${opts.scenario}` : "FAIL");
    return result.ok ? 0 : 1;
  } finally {
    io.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof MissingEnvError || error instanceof Error ? error.message : error);
      console.log("FAIL");
      process.exitCode = 1;
    });
}
