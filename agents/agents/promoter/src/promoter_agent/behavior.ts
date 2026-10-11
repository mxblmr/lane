/**
 * Promoter behavior (U10; R22, KTD10).
 *
 * The promoter's decision is fixed code. No model output can activate a rule:
 * - a flag or ask_more candidate that passed the gate is activated directly;
 * - a reject or hold_payout candidate (or any candidate the core marks
 *   `requires_approval`) suspends at a LangGraph interrupt. On resume an explicit
 *   `approve` activates it; anything else is a decline, and the candidate is rejected
 *   (U8 kept: only an explicit approve approves);
 * - a candidate whose gate did not pass is rejected without review.
 *
 * Graph:
 *   START -> human_review -> activate | decline -> finish -> END
 *   START -> activate -> finish -> END
 *   START -> reject_failed -> finish -> END
 *
 * No-egress mode (`input.no_egress`, or LANE_AGENT_NO_EGRESS on the agent): the promoter
 * calls nothing and returns its decision and the candidate id as its result. The core
 * applies it through U9's activate step, which still requires the approved record.
 *
 * Lane's activate endpoint is the authority (KTD10): it refuses a reject or hold_payout
 * candidate without an approved record, whatever this graph does.
 */
import { AIMessage } from "@langchain/core/messages";
import { END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";

import { inputString, isRecord, requireTask, type LanePayload } from "./lane.js";
import type { LaneCaller } from "./lane_call.js";
import { type HumanReview, PromoterStateAnnotation, type PromoterState, type PromoterUpdate } from "./state.js";

export const SUSPEND_REASON = "awaiting_human_review";
/** U3 `APPROVAL_DECISIONS`. The Orchestration Engine rejects any other decision. */
export const ALLOWED_DECISIONS = ["approve", "decline"] as const;
/** U3 `APPROVAL_ACTIONS`: actions that need a human before activation (R22). */
export const APPROVAL_ACTIONS = ["reject", "hold_payout"] as const;
const MAX_NOTES_CHARS = 1000;

/** U3 `INTERNAL_API` paths (packages/core/src/schema/agents.ts). */
export const PROMOTER_ENDPOINTS = {
  promoter_activate: "/api/internal/promoter/activate",
  promoter_reject: "/api/internal/promoter/reject",
} as const;
export type PromoterEndpoint = keyof typeof PROMOTER_ENDPOINTS;

/** U3 `PromoterOutputSchema`. */
export type PromoterOutput = {
  decision: "activated" | "rejected" | "declined";
  candidate_id: string;
  rule_status: string | null;
  notes: string;
};

export type PromoterDeps = {
  callLane: LaneCaller;
  /** LANE_AGENT_NO_EGRESS on the agent forces no-egress mode. */
  noEgressEnv?: boolean;
  checkpointer?: BaseCheckpointSaver;
};

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

/** True when the candidate needs a human: the core's flag, or an approval action (defense in depth). */
export function needsApproval(task: LanePayload): boolean {
  const input = isRecord(task.input) ? task.input : {};
  const action = typeof input.action === "string" ? input.action : "";
  return input.requires_approval === true || (APPROVAL_ACTIONS as readonly string[]).includes(action);
}

function gatePassed(task: LanePayload): boolean {
  const input = isRecord(task.input) ? task.input : {};
  // A missing gate summary is left to Lane's activate step, which checks the stored result.
  return !(isRecord(input.gate) && input.gate.passed === false);
}

export function endpointPath(task: LanePayload, name: PromoterEndpoint): string {
  const endpoints = isRecord(task.internal_api) && isRecord(task.internal_api.endpoints) ? task.internal_api.endpoints : {};
  const entry = endpoints[name];
  return isRecord(entry) && typeof entry.url === "string" && entry.url.length > 0 ? entry.url : PROMOTER_ENDPOINTS[name];
}

export function buildPromoterGraph(deps: PromoterDeps) {
  const noEgress = (task: LanePayload): boolean =>
    deps.noEgressEnv === true || (isRecord(task.input) && task.input.no_egress === true);
  const candidateOf = (task: LanePayload): string => inputString(task, "candidate_id") ?? "";

  const humanReview = (state: PromoterState): PromoterUpdate => {
    const task = requireTask(state);
    // Nothing runs before the interrupt, so replaying this node on resume is safe.
    return { review: normalizeReview(interrupt(reviewRequest(task))) };
  };

  const activate = async (state: PromoterState): Promise<PromoterUpdate> => {
    const task = requireTask(state);
    const candidateId = candidateOf(task);
    const approvedNote = state.review?.decision === "approve" ? "approved by a human reviewer; " : "";
    if (noEgress(task)) {
      return { result: { decision: "activated", candidate_id: candidateId, rule_status: null, notes: `${approvedNote}no egress: the core applies the activation` } };
    }
    const reply = await deps.callLane(endpointPath(task, "promoter_activate"), { candidate_id: candidateId }, `activate-${candidateId}`);
    if (!reply.ok) {
      // Never report an activation Lane did not confirm. The failed run is visible to the
      // core, which records it so the same decision can be retried (U9).
      throw new Error(`Lane refused to activate candidate ${candidateId}: ${reply.error ?? "unknown error"}`);
    }
    const status = typeof reply.data.status === "string" ? reply.data.status : null;
    return { result: { decision: "activated", candidate_id: candidateId, rule_status: status, notes: `${approvedNote}activated` } };
  };

  const rejectWith = async (task: LanePayload, decision: "declined" | "rejected", reason: string): Promise<PromoterUpdate> => {
    const candidateId = candidateOf(task);
    if (noEgress(task)) {
      return { result: { decision, candidate_id: candidateId, rule_status: null, notes: `${reason}; no egress: the core applies the rejection` } };
    }
    const reply = await deps.callLane(endpointPath(task, "promoter_reject"), { candidate_id: candidateId, reason: reason.slice(0, 500) }, `reject-${candidateId}`);
    const status = reply.ok && typeof reply.data.status === "string" ? reply.data.status : null;
    const notes = reply.ok ? reason : `${reason}; Lane did not confirm the rejection (${reply.error ?? "unknown error"}), the rule was not activated`;
    return { result: { decision, candidate_id: candidateId, rule_status: status, notes } };
  };

  const decline = async (state: PromoterState): Promise<PromoterUpdate> => {
    const notes = state.review?.reviewer_notes ? `: ${state.review.reviewer_notes}` : "";
    return rejectWith(requireTask(state), "declined", `declined by a human reviewer${notes}`);
  };

  const rejectFailed = async (state: PromoterState): Promise<PromoterUpdate> =>
    rejectWith(requireTask(state), "rejected", "the candidate did not pass the gate");

  const finish = (state: PromoterState): PromoterUpdate => {
    const task = requireTask(state);
    const result: PromoterOutput = state.result ?? {
      decision: "declined",
      candidate_id: candidateOf(task),
      rule_status: null,
      notes: "no decision was reached",
    };
    return { messages: [new AIMessage(JSON.stringify({ ...result, notes: result.notes.slice(0, MAX_NOTES_CHARS) }))] };
  };

  const start = (state: PromoterState): "reject_failed" | "human_review" | "activate" => {
    const task = requireTask(state);
    if (!gatePassed(task)) return "reject_failed";
    return needsApproval(task) ? "human_review" : "activate";
  };
  const afterReview = (state: PromoterState): "activate" | "decline" => (state.review?.decision === "approve" ? "activate" : "decline");

  return new StateGraph(PromoterStateAnnotation)
    .addNode("human_review", humanReview)
    .addNode("activate", activate)
    .addNode("decline", decline)
    .addNode("reject_failed", rejectFailed)
    .addNode("finish", finish)
    .addConditionalEdges(START, start, { reject_failed: "reject_failed", human_review: "human_review", activate: "activate" })
    .addConditionalEdges("human_review", afterReview, { activate: "activate", decline: "decline" })
    .addEdge("activate", "finish")
    .addEdge("decline", "finish")
    .addEdge("reject_failed", "finish")
    .addEdge("finish", END)
    .compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {});
}
