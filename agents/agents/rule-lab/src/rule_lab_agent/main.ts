/**
 * Lane rule-lab (U8 shape, U10 behavior; KTD9, KTD10, KTD11).
 *
 * Two modes, chosen by the core through `input.mode`:
 * - `write_rule`: write one candidate rule from quoted evidence, propose it and run the
 *   gate through the internal API, revising at most `max_revisions` times (U10: once);
 * - `red_team`: add cheat examples through the internal API, under the per-run
 *   tool-call cap.
 *
 * With `input.no_egress`, or LANE_AGENT_NO_EGRESS on the agent, the agent calls nothing
 * and returns the proposal or examples as its answer. The prompt, the input, the output
 * schema and the internal API contract all arrive in the invoke payload.
 *
 * The graph itself is in behavior.ts; this file wires it to the Agent Engine app.
 */

import "dotenv/config";

import type { BaseMessage } from "@langchain/core/messages";
import type { AgentInput } from "@mongodb-js/agent-engine-sdk";
import { App } from "@mongodb-js/agent-engine-sdk-langgraph";

import { DEFAULT_RED_TEAM_TOOL_CALL_CAP, buildRuleLabGraph } from "./behavior.js";
import { freshInput, inputMode, lanePayload } from "./lane.js";
import { noEgressFromEnv, toolLaneCaller } from "./lane_call.js";
import { buildLLM } from "./llm.js";
import { registerLaneApiTool } from "./tools.js";

const RULE_LAB_MODES = new Set(["write_rule", "red_team"]);

export const app = new App({ appName: "rule-lab" });

registerLaneApiTool(app, "LANE_ROLE_KEY_RULE_LAB");

// One session per learning run (KTD10), so the default session-scoped thread is safe.
app.prepareAgentInput((input: AgentInput) => {
  const payload = lanePayload(input, "rule_lab");
  const mode = inputMode(payload);
  if (!mode || !RULE_LAB_MODES.has(mode)) {
    throw new Error(`Unknown rule-lab mode: ${mode ?? "none"}`);
  }
  return { ...freshInput(payload), lab: null };
});

function capFromEnv(value: string | undefined): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RED_TEAM_TOOL_CALL_CAP;
}

export const buildAgent = app.entrypoint(() => {
  const llm = app.llm(buildLLM({ temperature: 0 })) as unknown as { invoke(messages: BaseMessage[]): Promise<BaseMessage> };
  return buildRuleLabGraph({
    llm,
    callLane: toolLaneCaller(() => app.getTools()),
    noEgressEnv: noEgressFromEnv(process.env.LANE_AGENT_NO_EGRESS),
    toolCallCap: capFromEnv(process.env.LANE_RED_TEAM_TOOL_CALL_CAP),
    checkpointer: app.checkpointer() as never,
  });
});

export function main(): void {
  void app.run();
}

const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("main.js"));

if (isDirectInvocation) {
  try {
    main();
  } catch (err) {
    const e = err as Error;
    console.error(e.stack ?? e.message);
    process.exit(1);
  }
}
