/**
 * End-to-end checks (U17, Verification Contract "End to end").
 *
 *   pnpm e2e --url <deployed url> [--only F1,F3,AE7]
 *
 * Runs F1 to F6 and AE2 to AE8 through the eight `lane_` tools with clearly marked test players
 * ("E2E <persona> <run id>"). When MONGODB_URI is set (and MONGODB_DB, default "lane"), the run
 * also asserts database state, reading only. Never point this at the stage challenge
 * during a rehearsal, and never at production before its database is connected.
 *
 * Exit code: 0 every selected check passed, 1 at least one failed, 2 nothing failed but some are
 * blocked on a unit that is not live yet. Player keys are never printed.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { closeMongoClient, getDb } from "@lane/core/db";
import { connectLane } from "./lane-client";
import { SCENARIOS, exitCode, runScenario, type Db, type Scenario, type ScenarioResult } from "./scenarios";
import { normalizeMcpUrl } from "../mcp-smoke";

export interface E2EOptions {
  url: string;
  only: string[] | null;
}

export function parseE2EArgs(argv: string[]): E2EOptions {
  let url: string | undefined;
  let only: string[] | null = null;
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
  if (!url) throw new Error("Usage: pnpm e2e --url <deployed url> [--only F1,F3,AE7]");
  if (only) {
    const known = new Set(SCENARIOS.map((s) => s.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown scenario: ${unknown.join(", ")}`);
  }
  return { url: normalizeMcpUrl(url), only };
}

/** Letters and digits only, so it fits Lane's display-name rule. */
export function newRunId(): string {
  return randomBytes(4).toString("hex");
}

export async function runE2E(options: {
  url: string;
  scenarios: Scenario[];
  runId?: string;
  db?: Db;
  onResult?: (result: ScenarioResult) => void;
}): Promise<ScenarioResult[]> {
  const lane = await connectLane(options.url);
  const runId = options.runId ?? newRunId();
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of options.scenarios) {
      const result = await runScenario(scenario, { lane, runId, db: options.db });
      results.push(result);
      options.onResult?.(result);
    }
  } finally {
    await lane.close();
  }
  return results;
}

export function formatResult(r: ScenarioResult): string {
  const tag = r.status === "pass" ? "PASS   " : r.status === "fail" ? "FAIL   " : "BLOCKED";
  const notes = r.notes.length > 0 ? ` (${r.notes.join("; ")})` : "";
  return `${tag} ${r.id.padEnd(4)} ${r.title}: ${r.detail}${notes} [${r.ms} ms]`;
}

async function main() {
  const options = parseE2EArgs(process.argv.slice(2));
  const scenarios = options.only ? SCENARIOS.filter((s) => options.only!.includes(s.id)) : SCENARIOS;
  const runId = newRunId();
  console.log(`Lane e2e: ${options.url}, run ${runId}, test players named "E2E <persona> ${runId}"`);

  let db: Db | undefined;
  if (process.env.MONGODB_URI) {
    // Core's client reads MONGODB_URI and MONGODB_DB. The scenarios only read through it.
    db = await getDb();
    console.log("database assertions: on (read-only)");
  } else {
    console.log("database assertions: off (set MONGODB_URI to turn them on)");
  }

  try {
    const results = await runE2E({ url: options.url, scenarios, runId, db, onResult: (r) => console.log(formatResult(r)) });
    const tally = (s: string) => results.filter((r) => r.status === s).length;
    console.log(`${tally("pass")} passed, ${tally("fail")} failed, ${tally("blocked")} blocked`);
    process.exitCode = exitCode(results);
  } finally {
    if (db) await closeMongoClient();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
