import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

import { messagesReducer, type LanePayload, type MessagesUpdate } from "./lane.js";

/** The reviewer's answer after normalization: anything but an explicit approve is a decline. */
export type PromoterResult = {
  decision: "activated" | "rejected" | "declined";
  candidate_id: string;
  rule_status: string | null;
  notes: string;
};

export type HumanReview = { decision: "approve" | "decline"; reviewer_notes: string };

/**
 * Promoter graph state: the shared Lane channels plus the human review. Everything in it
 * is JSON-serializable, as Agent Engine requires.
 */
export const PromoterStateAnnotation = Annotation.Root({
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
  review: Annotation<HumanReview | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  /** The promoter's decision, mirrors U3 `PromoterOutputSchema` (U10). */
  result: Annotation<PromoterResult | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

export type PromoterState = typeof PromoterStateAnnotation.State;
export type PromoterUpdate = typeof PromoterStateAnnotation.Update;
