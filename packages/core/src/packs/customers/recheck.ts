import type { PackContext, RecheckResult } from "../../schema/pack";
import { QUOTE_CAP_CHARS } from "../../config";
import { callMinutes, type CallFacts } from "./features";

/**
 * Talk to Customers re-check (KTD14). A calendar event has no public source Lane can fetch, so
 * every call is `agent_attested` and this module makes no network call: it never touches
 * `ctx.fetch`. The returned source is the agent's already-reduced proof rendered as plain text,
 * so the referee reads it as quoted data the same way it reads a commit or a post. It holds
 * attendee domains and the capped note summary, never a full address (KTD15).
 */

export interface CustomersRecheckProof extends CallFacts {
  event_id: string;
}

/** Lane-rendered text of a reduced calendar proof, for the referee (KTD15, KTD18). */
export function renderCallText(proof: CustomersRecheckProof): string {
  const domains = proof.attendee_domains.length > 0 ? proof.attendee_domains.join(", ") : "none";
  const lines = [
    `Calendar event, ${callMinutes(proof)} min, from ${proof.starts_at} to ${proof.ends_at}.`,
    `Player's domain: ${proof.player_domain ?? "not marked"}.`,
    `Attendee domains: ${domains}.`,
    `Notes summary: ${proof.notes_summary ?? "none"}`,
  ];
  return lines.join("\n").slice(0, QUOTE_CAP_CHARS);
}

function validDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Mark the proof agent-attested and hand the referee its reduced content. It never throws: a
 * stored payload with unreadable times fails closed with a recovery reason.
 */
export async function attestCalendarEvent(proof: CustomersRecheckProof, ctx: Pick<PackContext, "now">): Promise<RecheckResult> {
  const startsAt = validDate(proof.starts_at);
  if (!startsAt || !validDate(proof.ends_at)) {
    return {
      status: "failed",
      source: null,
      reason: "Lane could not read this event's times. Send starts_at and ends_at as ISO times with a time zone.",
      info: {},
    };
  }
  return {
    status: "agent_attested",
    source: {
      kind: "calendar_event",
      text: renderCallText(proof),
      diff: null,
      author: null,
      stats: null,
      created_at: startsAt,
      fetched_at: ctx.now,
    },
    reason: null,
    info: {},
  };
}

/** KTD21: Talk to Customers binds no handle, so there is nothing to verify. Fails closed if ever called. */
export async function verifyNoHandle(): Promise<{ verified: boolean; reason: string | null }> {
  return { verified: false, reason: "Talk to Customers binds no handle." };
}
