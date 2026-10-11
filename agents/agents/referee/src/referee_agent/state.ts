import type { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

import { messagesReducer, type LanePayload, type MessagesUpdate } from "./lane.js";

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
});

export type LaneState = typeof LaneStateAnnotation.State;
export type LaneUpdate = typeof LaneStateAnnotation.Update;
