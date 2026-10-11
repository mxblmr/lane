/**
 * Muse stand-in (U17, Verification Contract "Stand-in").
 *
 *   ANTHROPIC_API_KEY=... pnpm standin --url <deployed url> [--only AE7,AE8]
 *
 * Runs an agent that knows only Lane's connector through AE7 (Build in Public asks which platforms
 * count, the stand-in asks its player and ends with an active challenge) and AE8 (a check-in's
 * player actions and standing reach the player, and a new contract version is acknowledged).
 * `LANE_STANDIN_MODEL` overrides the model. Writes only "E2E" test players. A failed check is a
 * wording fix for a pack contract or a tool description; the report quotes what went wrong.
 * Player keys are never printed.
 */
import { pathToFileURL } from "node:url";
import { connectLane, type LaneClient } from "../e2e/lane-client";
import { normalizeMcpUrl } from "../mcp-smoke";
import { createChallenge, joinChallenge, registerTestPlayer, Blocked, type E2EContext } from "../e2e/scenarios";
import { newRunId } from "../e2e/run";
import { checkAE7, checkAE8, runStandin, scriptedReplies, type CheckResult, type TranscriptEvent } from "./agent";
import { anthropicModel, type ModelClient } from "./model";

export interface StandinScenarioResult {
  id: string;
  status: "pass" | "fail" | "blocked";
  problems: string[];
  transcript: TranscriptEvent[];
}

interface StandinContext {
  lane: LaneClient;
  model: ModelClient;
  runId: string;
}

function e2eContext(ctx: StandinContext): E2EContext {
  return { lane: ctx.lane, runId: ctx.runId, note: () => {} };
}

export const STANDIN_SCENARIOS: Record<string, (ctx: StandinContext) => Promise<{ check: CheckResult; transcript: TranscriptEvent[] }>> = {
  async AE7(ctx) {
    const maya = await registerTestPlayer(e2eContext(ctx), "Maya");
    const transcript = await runStandin({
      lane: ctx.lane,
      model: ctx.model,
      playerKey: maya.key,
      playerName: maya.name,
      routineText: null,
      task: `${maya.name} says: "start Build in Public with my friends"`,
      player: scriptedReplies([
        "X and LinkedIn.",
        "Highest verified score wins, ties split. 50 play credits each.",
        "Yes, create it.",
        "Yes.",
      ]),
    });
    return { check: checkAE7(transcript), transcript };
  },

  async AE8(ctx) {
    const e2e = e2eContext(ctx);
    const maya = await registerTestPlayer(e2e, "Maya");
    const challenge = await createChallenge(e2e, maya, "start Ship Week with my friends", [
      "A meaningful commit on my own GitHub project each day, 7 days, goal 5 days.",
    ]);
    const priya = await registerTestPlayer(e2e, "Priya");
    await joinChallenge(e2e, priya, challenge.join_code, priya.handle);
    const transcript = await runStandin({
      lane: ctx.lane,
      model: ctx.model,
      playerKey: priya.key,
      playerName: priya.name,
      routineText: "Every 27 minutes, call lane_check_in, fetch what Lane asks for, submit it, and relay anything marked for the player.",
      task: "Your Lane routine is due. Run it now.",
      player: scriptedReplies(["Thanks, I'll do that."]),
    });
    return { check: checkAE8(transcript), transcript };
  },
};

export async function runStandinScenarios(ctx: StandinContext, ids: string[]): Promise<StandinScenarioResult[]> {
  const results: StandinScenarioResult[] = [];
  for (const id of ids) {
    const scenario = STANDIN_SCENARIOS[id];
    if (!scenario) throw new Error(`Unknown stand-in scenario: ${id}`);
    try {
      const { check, transcript } = await scenario(ctx);
      results.push({ id, status: check.ok ? "pass" : "fail", problems: check.problems, transcript });
    } catch (error) {
      if (error instanceof Blocked) results.push({ id, status: "blocked", problems: [error.message], transcript: [] });
      else results.push({ id, status: "fail", problems: [error instanceof Error ? error.message : String(error)], transcript: [] });
    }
  }
  return results;
}

/** One line per step, without keys: Lane calls show the tool and status only. */
export function summarizeTranscript(transcript: TranscriptEvent[]): string[] {
  return transcript.map((e) => {
    switch (e.type) {
      case "lane":
        return `  lane  ${e.tool} -> ${e.envelope.status}${e.envelope.error ? ` (${e.envelope.error.code})` : ""}`;
      case "fake_tool":
        return `  tool  ${e.tool}`;
      case "tell_player":
        return `  tell  ${e.text.slice(0, 200)}`;
      case "ask_player":
        return `  ask   ${e.question.slice(0, 160)} -> ${e.reply.slice(0, 80)}`;
      case "final":
        return `  final ${e.text.slice(0, 200)}`;
      case "stopped":
        return `  stop  ${e.reason}`;
    }
  });
}

export function parseStandinArgs(argv: string[]): { url: string; only: string[] } {
  let url: string | undefined;
  let only = Object.keys(STANDIN_SCENARIOS);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[i + 1];
      if (next === undefined || (inline === undefined && next.startsWith("--"))) throw new Error(`${flag} needs a value`);
      if (inline === undefined) i += 1;
      return next;
    };
    if (flag === "--url") url = value();
    else if (flag === "--only") only = value().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!url) throw new Error("Usage: pnpm standin --url <deployed url> [--only AE7,AE8]");
  const unknown = only.filter((id) => !(id in STANDIN_SCENARIOS));
  if (unknown.length > 0) throw new Error(`Unknown stand-in scenario: ${unknown.join(", ")}`);
  return { url: normalizeMcpUrl(url), only };
}

async function main() {
  const options = parseStandinArgs(process.argv.slice(2));
  const model = anthropicModel();
  const runId = newRunId();
  console.log(`Lane stand-in: ${options.url}, run ${runId}`);
  const lane = await connectLane(options.url);
  try {
    const results = await runStandinScenarios({ lane, model, runId }, options.only);
    for (const r of results) {
      console.log(`${r.status.toUpperCase().padEnd(7)} ${r.id}`);
      for (const line of summarizeTranscript(r.transcript)) console.log(line);
      for (const problem of r.problems) console.log(`  problem: ${problem}`);
    }
    process.exitCode = results.some((r) => r.status === "fail") ? 1 : results.some((r) => r.status === "blocked") ? 2 : 0;
  } finally {
    await lane.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
