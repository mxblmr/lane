/**
 * Lane orchestrator (U8, KTD10).
 *
 * Three modes, chosen by the core through `input.mode`:
 * - `draft`: turn a creator's sentence into a contract, or ask one clarifying question;
 * - `answer`: answer a player's question from the context Lane built for that player;
 * - `settle`: propose a settlement, which Lane checks against its own computation.
 *
 * The prompt, the input and the output schema all arrive in the invoke payload.
 *
 * Graph: START -> (draft | answer | settle) -> END. No tools, no interrupts.
 */

import "dotenv/config";

import { END, START, StateGraph } from "@langchain/langgraph";
import type { AgentInput } from "@mongodb-js/agent-engine-sdk";
import { App } from "@mongodb-js/agent-engine-sdk-langgraph";

import { finalAnswer, freshInput, inputMode, lanePayload, perExecutionThreadId, requireTask } from "./lane.js";
import { buildLLM } from "./llm.js";
import { LaneStateAnnotation, type LaneState, type LaneUpdate } from "./state.js";

const ORCHESTRATOR_MODES = ["draft", "answer", "settle"] as const;
type OrchestratorMode = (typeof ORCHESTRATOR_MODES)[number];

function orchestratorMode(mode: string | null): OrchestratorMode {
  const found = ORCHESTRATOR_MODES.find((known) => known === mode);
  if (!found) {
    throw new Error(`Unknown orchestrator mode: ${mode ?? "none"}`);
  }
  return found;
}

export const app = new App({ appName: "orchestrator" });

// The orchestrator shares one session (KTD10); one checkpoint thread per execution keeps
// concurrent calls from reading each other's state.
app.resolveThreadId(perExecutionThreadId);

app.prepareAgentInput((input: AgentInput) => {
  const payload = lanePayload(input, "orchestrator");
  orchestratorMode(inputMode(payload));
  return freshInput(payload);
});

export const buildAgent = app.entrypoint(() => {
  const llm = app.llm(buildLLM({ temperature: 0 }));

  const respond = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    return { messages: [await finalAnswer(llm, state.messages, task.output_schema)] };
  };

  const route = (state: LaneState): OrchestratorMode => orchestratorMode(inputMode(requireTask(state)));

  return new StateGraph(LaneStateAnnotation)
    .addNode("draft", respond)
    .addNode("answer", respond)
    .addNode("settle", respond)
    .addConditionalEdges(START, route, { draft: "draft", answer: "answer", settle: "settle" })
    .addEdge("draft", END)
    .addEdge("answer", END)
    .addEdge("settle", END)
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
