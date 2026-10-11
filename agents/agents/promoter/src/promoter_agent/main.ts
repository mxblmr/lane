/**
 * Lane promoter (U8 shape, U10 behavior; KTD10, R22).
 *
 * Activates a candidate rule that passed the gate. For `reject` and `hold_payout` rules
 * it suspends at a LangGraph interrupt until a human approves or declines through the
 * Agent Engine resume API; anything other than an explicit `approve` is a decline. Flag
 * and ask_more rules are activated without suspending. With `input.no_egress`, or
 * LANE_AGENT_NO_EGRESS on the agent, it calls nothing and returns its decision.
 *
 * The interrupt value is shaped as the runtime's SuspendPayload (`suspend_reason` and
 * `suspend_context`), so reviewers and the core see the candidate, the action, the rule
 * line and the allowed decisions. The graph itself is in behavior.ts.
 */

import "dotenv/config";

import type { AgentInput } from "@mongodb-js/agent-engine-sdk";
import { App } from "@mongodb-js/agent-engine-sdk-langgraph";

import { buildPromoterGraph } from "./behavior.js";
import { freshInput, inputString, lanePayload } from "./lane.js";
import { noEgressFromEnv, toolLaneCaller } from "./lane_call.js";
import { registerLaneApiTool } from "./tools.js";

export { ALLOWED_DECISIONS, SUSPEND_REASON, normalizeReview, reviewRequest } from "./behavior.js";

export const app = new App({ appName: "promoter" });

registerLaneApiTool(app, "LANE_ROLE_KEY_PROMOTER");

// One session per candidate (KTD10) on the default session-scoped thread, so a resume
// finds the suspended checkpoint.
app.prepareAgentInput((input: AgentInput) => {
  const payload = lanePayload(input, "promoter");
  if (!inputString(payload, "candidate_id")) {
    throw new Error("Promoter input has no candidate_id");
  }
  return { ...freshInput(payload), review: null, result: null };
});

// The promoter's decision never goes through a model, so the graph binds no LLM.
export const buildAgent = app.entrypoint(() =>
  buildPromoterGraph({
    callLane: toolLaneCaller(() => app.getTools()),
    noEgressEnv: noEgressFromEnv(process.env.LANE_AGENT_NO_EGRESS),
    checkpointer: app.checkpointer() as never,
  }),
);

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
