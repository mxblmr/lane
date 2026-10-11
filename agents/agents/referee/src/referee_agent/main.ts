/**
 * Lane referee (U8, KTD10).
 *
 * Reviews one proof (`mode: "proof"`) or one dispute (`mode: "dispute"`) when no
 * active rule decides it. The prompt, the input and the output schema all arrive in
 * the invoke payload; the core validates the answer and treats any failure as a failed
 * review, never an acceptance.
 *
 * Graph: START -> review -> END. No tools, no interrupts.
 */

import "dotenv/config";

import { END, START, StateGraph } from "@langchain/langgraph";
import type { AgentInput } from "@mongodb-js/agent-engine-sdk";
import { App } from "@mongodb-js/agent-engine-sdk-langgraph";

import { finalAnswer, freshInput, inputMode, lanePayload, perExecutionThreadId, requireTask } from "./lane.js";
import { buildLLM } from "./llm.js";
import { LaneStateAnnotation, type LaneState, type LaneUpdate } from "./state.js";

const REFEREE_MODES = new Set(["proof", "dispute"]);

export const app = new App({ appName: "referee" });

// The referee shares one session (KTD10); one checkpoint thread per execution keeps
// concurrent reviews from reading each other's state.
app.resolveThreadId(perExecutionThreadId);

app.prepareAgentInput((input: AgentInput) => {
  const payload = lanePayload(input, "referee");
  const mode = inputMode(payload);
  if (!mode || !REFEREE_MODES.has(mode)) {
    throw new Error(`Unknown referee mode: ${mode ?? "none"}`);
  }
  return freshInput(payload);
});

export const buildAgent = app.entrypoint(() => {
  const llm = app.llm(buildLLM({ temperature: 0 }));

  const review = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    return { messages: [await finalAnswer(llm, state.messages, task.output_schema)] };
  };

  return new StateGraph(LaneStateAnnotation)
    .addNode("review", review)
    .addEdge(START, "review")
    .addEdge("review", END)
    .compile({ checkpointer: app.checkpointer() as never });
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
