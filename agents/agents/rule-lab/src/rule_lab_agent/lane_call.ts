/**
 * Graph-driven calls to Lane's internal API (U10). Rule-lab and the promoter ship an
 * identical copy of this file; keep the two in sync.
 *
 * The graphs decide when to call Lane, so they call the registered `lane_internal_api`
 * tool directly instead of waiting for the model to pick it. Calling the tool object that
 * `app.getTools()` returns keeps the call inside the tool sandbox and Policy Engine's view,
 * the same as a ToolNode call (KTD9, KTD10).
 */
import type { BaseMessage } from "@langchain/core/messages";

import { isRecord, messageText } from "./lane.js";
import { LANE_API_TOOL } from "./tools.js";

/** One Lane internal API reply, normalized. */
export type LaneReply = { ok: boolean; status: number; data: Record<string, unknown>; error: string | null };

/**
 * Calls one internal endpoint. `callId` is stable per graph step, so a durable replay of
 * a step reuses the same tool call identity.
 */
export type LaneCaller = (path: string, body: Record<string, unknown>, callId: string) => Promise<LaneReply>;

type InvokableTool = { name: string; invoke(input: unknown): Promise<unknown> };

/** Parses the lane_internal_api tool's JSON string into a LaneReply. */
export function parseToolReply(text: string): LaneReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, status: 0, data: {}, error: `tool reply is not JSON: ${text.slice(0, 200)}` };
  }
  if (!isRecord(parsed)) return { ok: false, status: 0, data: {}, error: "tool reply is not an object" };
  if (parsed.ok === false && isRecord(parsed.error)) {
    return { ok: false, status: 0, data: {}, error: `${String(parsed.error.code)}: ${String(parsed.error.message)}` };
  }
  const status = typeof parsed.status === "number" ? parsed.status : 0;
  const data = isRecord(parsed.response) ? parsed.response : {};
  const ok = status >= 200 && status < 300 && data.ok === true;
  let error: string | null = null;
  if (!ok) {
    const err = isRecord(data.error) ? data.error : null;
    error = err ? `${String(err.code)}: ${String(err.message)}` : `HTTP ${status}`;
  }
  return { ok, status, data, error };
}

/** Builds a LaneCaller on the registered lane_internal_api tool. */
export function toolLaneCaller(getTools: () => readonly unknown[]): LaneCaller {
  return async (path, body, callId) => {
    const tool = getTools().find(
      (candidate): candidate is InvokableTool =>
        isRecord(candidate) && candidate.name === LANE_API_TOOL && typeof candidate.invoke === "function",
    );
    if (!tool) return { ok: false, status: 0, data: {}, error: `${LANE_API_TOOL} is not registered` };
    let result: unknown;
    try {
      result = await tool.invoke({ type: "tool_call", id: callId, name: LANE_API_TOOL, args: { path, body } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[lane] ${LANE_API_TOOL} ${callId} threw: ${message}`);
      return { ok: false, status: 0, data: {}, error: `tool_error: ${message}` };
    }
    const text = typeof result === "string" ? result : isRecord(result) && "content" in result ? messageText(result as unknown as BaseMessage) : "";
    return parseToolReply(text);
  };
}

/** LANE_AGENT_NO_EGRESS on the agent forces no-egress mode (U9, Risks and Dependencies). */
export function noEgressFromEnv(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
