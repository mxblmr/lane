/**
 * Lane promoter (U8, KTD10, R22).
 *
 * Activates a candidate rule that passed the gate. For `reject` and `hold_payout` rules
 * the core sets `input.requires_approval`, and the promoter suspends at a LangGraph
 * interrupt until a human approves or declines through the Agent Engine resume API.
 *
 * Graph:
 *   START -> human_review (when requires_approval) -> agent <-> tools -> finalize -> END
 *
 * - A decline goes straight to finalize: no tool is reachable after a decline, so the
 *   promoter cannot activate a rule a human declined.
 * - Anything other than an explicit `approve` counts as a decline.
 * - With `input.no_egress` the promoter calls nothing and only answers.
 *
 * The interrupt value is shaped as the runtime's SuspendPayload
 * (`suspend_reason` and `suspend_context`), so reviewers and the core see the candidate,
 * the action, the rule line and the allowed decisions.
 */

import "dotenv/config";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph, interrupt } from "@langchain/langgraph";
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
  inputString,
  isAiMessage,
  isRecord,
  laneData,
  lanePayload,
  messageText,
  parseAnswer,
  requireTask,
  type LanePayload,
} from "./lane.js";
import { buildLLM } from "./llm.js";
import { PromoterStateAnnotation, type HumanReview, type PromoterState, type PromoterUpdate } from "./state.js";
import { registerLaneApiTool } from "./tools.js";

export const SUSPEND_REASON = "awaiting_human_review";
/** U3 `APPROVAL_DECISIONS`. The Orchestration Engine rejects any other decision. */
export const ALLOWED_DECISIONS = ["approve", "decline"] as const;
const MAX_NOTES_CHARS = 1000;

const APPROVED_NOTE =
  "A human approved activating this rule. Activate it through the internal API, then give your final answer.";
const DECLINED_NOTE =
  "A human declined this rule. Do not activate it. Give your final answer with the declined decision now.";

/** The interrupt value: a SuspendPayload whose context matches U3's `PromoterInterrupt`. */
export function reviewRequest(task: LanePayload): { suspend_reason: string; suspend_context: Record<string, unknown> } {
  const candidateId = inputString(task, "candidate_id") ?? "";
  const action = inputString(task, "action") ?? "";
  const line = inputString(task, "line") ?? "";
  return {
    suspend_reason: SUSPEND_REASON,
    suspend_context: {
      candidate_id: candidateId,
      action,
      line,
      allowed_decisions: [...ALLOWED_DECISIONS],
      message: `Approve activating the ${action} rule for candidate ${candidateId}: ${line}`,
      response_schema: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: [...ALLOWED_DECISIONS] },
          reviewer_notes: { type: "string" },
        },
      },
    },
  };
}

/**
 * Normalizes the resume value. It may arrive as the flat resume body, a decision string,
 * a `human_review` object or a `resume_map` keyed by interrupt id. Only an explicit
 * `approve` approves.
 */
export function normalizeReview(value: unknown): HumanReview {
  let current: unknown = value;
  if (isRecord(current) && isRecord(current.resume_map)) {
    current = Object.values(current.resume_map)[0];
  }
  if (isRecord(current) && isRecord(current.human_review)) {
    current = current.human_review;
  }
  const raw = typeof current === "string" ? current : isRecord(current) && typeof current.decision === "string" ? current.decision : "";
  const notes = isRecord(current) && typeof current.reviewer_notes === "string" ? current.reviewer_notes.slice(0, MAX_NOTES_CHARS) : "";
  return { decision: raw.trim().toLowerCase() === "approve" ? "approve" : "decline", reviewer_notes: notes };
}

export const app = new App({ appName: "promoter" });

registerLaneApiTool(app, "LANE_ROLE_KEY_PROMOTER");

// One session per candidate (KTD10) on the default session-scoped thread, so a resume
// finds the suspended checkpoint.
app.prepareAgentInput((input: AgentInput) => {
  const payload = lanePayload(input, "promoter");
  if (!inputString(payload, "candidate_id")) {
    throw new Error("Promoter input has no candidate_id");
  }
  return { ...freshInput(payload), review: null };
});

export const buildAgent = app.entrypoint(() => {
  const llm = app.llm(buildLLM({ temperature: 0 }));
  const llmWithTools = (
    llm as BaseChatModel & { bindTools: (tools: unknown[]) => BaseChatModel }
  ).bindTools([...app.getToolSchemas()]);

  const humanReview = (state: PromoterState): PromoterUpdate => {
    const task = requireTask(state);
    // Nothing runs before the interrupt, so replaying this node on resume is safe.
    const review = normalizeReview(interrupt(reviewRequest(task)));
    const note = review.decision === "approve" ? APPROVED_NOTE : DECLINED_NOTE;
    return { review, messages: [new HumanMessage(`${laneData("human_review", review)}\n\n${note}`)] };
  };

  const agent = async (state: PromoterState): Promise<PromoterUpdate> => {
    const response = (await llmWithTools.invoke(state.messages)) as BaseMessage;
    return {
      messages: [response],
      tool_rounds: hasToolCalls(response) ? state.tool_rounds + 1 : state.tool_rounds,
    };
  };

  const finalize = async (state: PromoterState): Promise<PromoterUpdate> => {
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

  const start = (state: PromoterState): "human_review" | "agent" | "finalize" => {
    const task = requireTask(state);
    if (inputFlag(task, "requires_approval")) return "human_review";
    return inputFlag(task, "no_egress") ? "finalize" : "agent";
  };
  const afterReview = (state: PromoterState): "agent" | "finalize" =>
    state.review?.decision === "approve" && !inputFlag(requireTask(state), "no_egress") ? "agent" : "finalize";
  const afterAgent = (state: PromoterState): "tools" | "finalize" =>
    hasToolCalls(state.messages[state.messages.length - 1]) ? "tools" : "finalize";
  const afterTools = (state: PromoterState): "agent" | "finalize" =>
    state.tool_rounds >= MAX_TOOL_ROUNDS ? "finalize" : "agent";

  return new StateGraph(PromoterStateAnnotation)
    .addNode("human_review", humanReview)
    .addNode("agent", agent)
    .addNode("tools", new ToolNode([...app.getTools()]))
    .addNode("finalize", finalize)
    .addConditionalEdges(START, start, { human_review: "human_review", agent: "agent", finalize: "finalize" })
    .addConditionalEdges("human_review", afterReview, { agent: "agent", finalize: "finalize" })
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
