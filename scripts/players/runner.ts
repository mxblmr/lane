/**
 * Step-by-step stage runner (U13 approach step 3): one scripted step per keypress, printing what
 * happened. Each step checks what it expects, so a rehearsal fails loudly instead of drifting.
 */
import { COUNTING_OUTCOMES, FINAL_OUTCOMES, LaneClient, readVerdict, type EnvelopeLike, type VerdictView } from "./lane-client";
import type { GitHubPlayer } from "./github";
import type { ScriptedPlayerName } from "../seed/roster";

export interface StageIO {
  log(line: string): void;
  /** Wait for the presenter. Resolves "quit" when they press q. */
  waitForKey(prompt: string): Promise<"run" | "quit">;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PlayerHandles {
  name: ScriptedPlayerName;
  lane: LaneClient;
  github: GitHubPlayer;
}

export interface StageContext {
  io: StageIO;
  player(name: ScriptedPlayerName): PlayerHandles;
  /** How often to poll check-in while waiting. */
  pollMs: number;
  /** How long to wait for the presenter's approval to make the rule live. */
  ruleTimeoutMs: number;
  /** How long to wait for a pending verdict. */
  verdictTimeoutMs: number;
  state: Record<string, unknown>;
}

export interface Step {
  title: string;
  run(ctx: StageContext): Promise<void>;
}

export interface Scenario {
  id: string;
  title: string;
  steps: Step[];
}

/** A step's expectation was not met. */
export class ExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectationError";
  }
}

export function expectThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ExpectationError(message);
}

export interface RunResult {
  ok: boolean;
  quit: boolean;
  completed: number;
  failure: { step: string; message: string } | null;
}

export async function runScenario(scenario: Scenario, ctx: StageContext, opts: { auto: boolean }): Promise<RunResult> {
  const { io } = ctx;
  io.log(`== ${scenario.title} ==`);
  let completed = 0;
  for (const [i, step] of scenario.steps.entries()) {
    const label = `[${i + 1}/${scenario.steps.length}] ${step.title}`;
    if (!opts.auto) {
      const key = await io.waitForKey(`${label}  (Enter to run, q to quit) `);
      if (key === "quit") {
        io.log("Stopped by the presenter.");
        return { ok: false, quit: true, completed, failure: null };
      }
    } else {
      io.log(label);
    }
    try {
      await step.run(ctx);
      completed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.log(`FAIL: ${message}`);
      return { ok: false, quit: false, completed, failure: { step: step.title, message } };
    }
  }
  io.log(`PASS: ${scenario.title}`);
  return { ok: true, quit: false, completed, failure: null };
}

// ---------------------------------------------------------------- shared helpers for scenarios

export function short(sha: string): string {
  return sha.slice(0, 7);
}

export function describeVerdict(v: VerdictView): string {
  const by = v.decided_by === "ai" ? "the AI reviewer" : v.decided_by === "rule" ? "a rule" : (v.decided_by ?? "unknown");
  const calls = v.ai_calls === null ? "" : `, ${v.ai_calls} AI call${v.ai_calls === 1 ? "" : "s"}`;
  const reason = v.reason ? ` Reason: ${v.reason}` : "";
  return `Verdict: ${v.outcome ?? "unknown"}, decided by ${by}${calls}.${reason}`;
}

/**
 * Submit a proof and return its final verdict. A reply of pending (the referee took longer than
 * the reply budget) is followed through check-in's feed until the proof is decided.
 */
export async function submitAndSettle(ctx: StageContext, lane: LaneClient, args: Record<string, unknown>): Promise<VerdictView> {
  const env = await lane.submitProof(args);
  if (env.status === "error") {
    throw new ExpectationError(`Lane refused the proof: ${env.error?.code ?? "error"}. ${(env.lines ?? []).join(" ")}`);
  }
  let v = readVerdict(env);
  if (v.outcome && FINAL_OUTCOMES.has(v.outcome)) return v;
  expectThat(v.proof_id, `Lane's reply had no proof id to follow: ${JSON.stringify(env.data ?? {}).slice(0, 200)}`);
  ctx.io.log(`Proof ${v.proof_id} is ${v.outcome ?? "pending"}; following it through check-in...`);
  const deadline = ctx.io.now() + ctx.verdictTimeoutMs;
  while (ctx.io.now() < deadline) {
    await ctx.io.sleep(ctx.pollMs);
    const checked = await lane.checkIn();
    const line = feedLine(checked, v.proof_id);
    if (line?.status && FINAL_OUTCOMES.has(line.status)) {
      v = { ...v, outcome: line.status, decided_by: line.decided_by ?? v.decided_by };
      return v;
    }
  }
  throw new ExpectationError(`No verdict for proof ${v.proof_id} after ${Math.round(ctx.verdictTimeoutMs / 1000)} seconds.`);
}

function feedLine(env: EnvelopeLike, proofId: string) {
  for (const c of env.challenges ?? []) {
    const hit = (c.feed ?? []).find((f) => f.proof_id === proofId);
    if (hit) return hit;
  }
  return null;
}

export function counts(v: VerdictView): boolean {
  return v.outcome !== null && COUNTING_OUTCOMES.has(v.outcome);
}
