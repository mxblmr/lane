import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

import type { RuleProposal } from "./behavior.js";
import { messagesReducer, type LanePayload, type MessagesUpdate } from "./lane.js";

/** One proposed candidate and its gate result (U10). */
export type LabAttempt = {
  candidate_id: string;
  proposal: unknown;
  passed: boolean;
  status: string | null;
  gate_reasons: unknown[];
  gate: Record<string, unknown> | null;
};

/** A drafted red-team cheat example (mirrors U3 `RedTeamExampleSchema`). */
export type LabExample = { example_key: string; cheat_class: string; features: Record<string, unknown>; summary: string | null };

/** Rule-lab progress through one run (U10). Replaced as a whole by each node. */
export type LabProgress = {
  catalog: unknown[];
  rules: unknown[];
  examples: unknown[];
  attempts: LabAttempt[];
  /** The checked proposal waiting to be proposed, or returned in no-egress mode. */
  draft: RuleProposal | null;
  /** Lane internal API calls made this run (the red team's per-run cap counts these). */
  tool_calls: number;
  /** Example keys Lane added, or that no-egress mode returns. */
  added: string[];
  pending?: LabExample[];
  /** No-egress mode: the examples returned as the result. */
  returned?: LabExample[];
  stop: string | null;
  notes: string[];
};

/** Graph state. Everything in it is JSON-serializable, as Agent Engine requires. */
export const LaneStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], MessagesUpdate>({
    reducer: messagesReducer,
    default: () => [],
  }),
  task: Annotation<LanePayload | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  tool_rounds: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  lab: Annotation<LabProgress | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

export type LaneState = typeof LaneStateAnnotation.State;
export type LaneUpdate = typeof LaneStateAnnotation.Update;
