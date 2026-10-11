import type { PublicApproval } from "@lane/core/schema/projections";
import type { DecidedBy, TrustLevel } from "@lane/core/schema/proofs";

/**
 * Client-safe helpers for the dashboard. Type-only imports from core, so nothing server-side
 * reaches the browser bundle.
 */

/** A server value after JSON: dates become ISO strings. */
export type Serialized<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

/** KTD16: the dashboard polls every 2 to 3 seconds. */
export const POLL_MS = 2_500;

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface OpsAnswer {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

/** POST to an ops route with the operator cookie (same origin). */
export async function postOps(path: string, body: Record<string, unknown>): Promise<OpsAnswer> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Empty or non-JSON body.
    }
    return { ok: res.ok, status: res.status, body: json };
  } catch {
    return { ok: false, status: 0, body: { message: "Network error. Try again." } };
  }
}

export function answerMessage(answer: OpsAnswer): string {
  const message = typeof answer.body.message === "string" ? answer.body.message : null;
  return message ?? (answer.ok ? "Done." : `Failed (${answer.status}).`);
}

/** R7: every credit amount carries the play-credit label. */
export function credits(amount: number, label: string): string {
  return `${amount.toLocaleString("en-US")} ${label}`;
}

export function pct(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined) return "n/a";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function decidedByLabel(by: DecidedBy | null): string {
  switch (by) {
    case "rule":
      return "Rule";
    case "ai":
      return "AI";
    case null:
      return "Pending";
    default:
      return by.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }
}

export function trustLabel(level: TrustLevel | null): string {
  if (level === "rechecked") return "Re-checked";
  if (level === "agent_attested") return "Agent-attested";
  return "Not checked yet";
}

/** Where an approval entry is in its life (U12 approach step 1). "deciding" is local to the click. */
export type ApprovalPhase = "pending" | "activating" | "paying" | "active" | "approved" | "paid" | "declined" | "failed";

type ApprovalLike = Pick<Serialized<PublicApproval>, "status" | "follow_up" | "kind"> & { rule_status?: string | null };

export function approvalPhase(a: ApprovalLike): ApprovalPhase {
  if (a.status === "pending") return "pending";
  if (a.follow_up.status === "failed") return "failed";
  if (a.status === "declined") return "declined";
  if (a.follow_up.status !== "ok") return a.kind === "rule" ? "activating" : "paying";
  if (a.kind === "rule") return a.rule_status === "active" ? "active" : "approved";
  return "paid";
}

export function phaseLabel(a: ApprovalLike): string {
  const phase = approvalPhase(a);
  switch (phase) {
    case "pending":
      return "Waiting for approval";
    case "activating":
      return "Approved, activating";
    case "paying":
      return "Approved, paying out";
    case "active":
      return "Active";
    case "approved":
      return "Approved";
    case "paid":
      return "Paid";
    case "declined":
      return "Declined";
    case "failed": {
      const decided = a.status === "declined" ? "Declined" : "Approved";
      return a.kind === "rule" ? `${decided}, resume failed` : `${decided}, payout failed`;
    }
  }
}

/** The decision a Retry re-sends: the one already recorded. */
export function recordedDecision(a: Pick<ApprovalLike, "status">): "approve" | "decline" {
  return a.status === "declined" ? "decline" : "approve";
}
