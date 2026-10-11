/**
 * Lane rule-lab (U8, KTD9, KTD10).
 *
 * Two modes, chosen by the core through `input.mode`:
 * - `write_rule`: write a candidate rule from quoted evidence, propose it and test it
 *   through the internal API, revising at most `max_revisions` times;
 * - `red_team`: add cheat examples through the internal API.
 *
 * With `input.no_egress` the agent calls nothing and returns the proposal or examples
 * as its answer. The prompt, the input, the output schema and the internal API contract
 * all arrive in the invoke payload.
 *
 * Graph: START -> (agent <-> tools)* -> finalize -> END, or START -> finalize in
 * no-egress mode. At most MAX_TOOL_ROUNDS tool rounds per run.
 */

import "dotenv/config";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { AgentInput } from "@mongodb-js/agent-engine-sdk";
import { App } from "@mongodb-js/agent-engine-sdk-langgraph";

import {
  ANSWER_NOW,
  MAX_TOOL_ROUNDS,
  finalAnswer,
  freshInput,
  hasToolCalls,
  inputFlag,
  inputMode,
  isAiMessage,
  lanePayload,
  messageText,
  parseAnswer,
  requireTask,
} from "./lane.js";
import { buildLLM } from "./llm.js";
import { LaneStateAnnotation, type LaneState, type LaneUpdate } from "./state.js";
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
  return freshInput(payload);
});

export const buildAgent = app.entrypoint(() => {
  const llm = app.llm(buildLLM({ temperature: 0 }));
  const llmWithTools = (
    llm as BaseChatModel & { bindTools: (tools: unknown[]) => BaseChatModel }
  ).bindTools([...app.getToolSchemas()]);

  const agent = async (state: LaneState): Promise<LaneUpdate> => {
    const response = (await llmWithTools.invoke(state.messages)) as BaseMessage;
    return {
      messages: [response],
      tool_rounds: hasToolCalls(response) ? state.tool_rounds + 1 : state.tool_rounds,
    };
  };

  const finalize = async (state: LaneState): Promise<LaneUpdate> => {
    const task = requireTask(state);
    const last = state.messages[state.messages.length - 1];
    if (isAiMessage(last) && !hasToolCalls(last)) {
      const check = parseAnswer(messageText(last!), task.output_schema);
      if (check.answer && !check.problem) {
        return { messages: [new AIMessage(JSON.stringify(check.answer))] };
      }
    }
    // A history with tool calls needs the tool definitions bound (Anthropic requires them).
    const model = state.messages.some((message) => hasToolCalls(message)) ? llmWithTools : llm;
    return { messages: [await finalAnswer(model, [...state.messages, new HumanMessage(ANSWER_NOW)], task.output_schema)] };
  };

  const start = (state: LaneState): "agent" | "finalize" =>
    inputFlag(requireTask(state), "no_egress") ? "finalize" : "agent";
  const afterAgent = (state: LaneState): "tools" | "finalize" =>
    hasToolCalls(state.messages[state.messages.length - 1]) ? "tools" : "finalize";
  const afterTools = (state: LaneState): "agent" | "finalize" =>
    state.tool_rounds >= MAX_TOOL_ROUNDS ? "finalize" : "agent";

  return new StateGraph(LaneStateAnnotation)
    .addNode("agent", agent)
    .addNode("tools", new ToolNode([...app.getTools()]))
    .addNode("finalize", finalize)
    .addConditionalEdges(START, start, { agent: "agent", finalize: "finalize" })
    .addConditionalEdges("agent", afterAgent, { tools: "tools", finalize: "finalize" })
    .addConditionalEdges("tools", afterTools, { agent: "agent", finalize: "finalize" })
    .addEdge("finalize", END)
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
