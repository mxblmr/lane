import { services } from "../interfaces";
import { fail } from "../schema/common";
import { buildEnvelope, envelopeAction, errorEnvelope } from "./envelope";
import type { LaneTool } from "./types";

export const submitProofTool: LaneTool<"lane_submit_proof"> = {
  name: "lane_submit_proof",
  title: "Send proof to Lane",
  description: [
    "Send proof of progress for one challenge, following that challenge's contract. Call it when the contract or a check-in action asks for proof, or when the player asks you to send proof.",
    "Fetch the proof from the player's own accounts yourself, and never invent, edit or borrow it.",
    "Ship Week: repo as owner/name and the full 40-character commit sha.",
    "Talk to Customers: the calendar event_id, starts_at, ends_at, attendees (email addresses) and notes when asked.",
    "Build in Public: post_url, platform (x, instagram, linkedin or threads) and post_text.",
    "For new proof pass challenge_id. To answer an action from lane_check_in (extra proof, surprise check or bind code), pass its id as request_id with the fields it asks for.",
    "Lane answers with the verdict: accepted, rejected with the reason and how to fix it, held until extra proof arrives, or pending while the referees review. Relay it to the player.",
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fields: {
    player_key: "The player key from lane_register, unless you send it as the bearer header.",
    challenge_id: "The challenge this proof is for. Required unless request_id is set.",
    request_id: "When answering a check-in action: that action's id.",
    source_time: "ISO time the source was created, when you know it. Lane re-checks it where it can.",
    repo: "Ship Week: the repository as owner/name.",
    sha: "Ship Week: the full 40-character commit SHA. Short SHAs are refused.",
    event_id: "Talk to Customers: the calendar event id.",
    starts_at: "Talk to Customers: ISO start time of the conversation.",
    ends_at: "Talk to Customers: ISO end time of the conversation.",
    attendees: "Talk to Customers: attendee email addresses.",
    notes: "Talk to Customers: meeting notes, only when the contract or an action asks for them.",
    post_url: "Build in Public: the public URL of the post.",
    platform: "Build in Public: x, instagram, linkedin or threads.",
    post_text: "Build in Public: the post's text as published.",
  },
  async handle({ db, args, player, now }) {
    const { player_key: _key, challenge_id, request_id, ...fields } = args;
    if (!challenge_id && !request_id) {
      return errorEnvelope(
        fail(
          "invalid_input",
          "Lane needs to know which challenge this proof is for.",
          "Call lane_submit_proof again with challenge_id, or with request_id when answering a check-in action.",
        ).error,
        now,
      );
    }

    const result = await services().proofs.submit(db, {
      player_id: player._id,
      challenge_id,
      request_id,
      fields,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);

    const { proof, outcome, duplicate, verdict, request } = result;
    const lines = result.lines.length > 0 ? result.lines : [defaultLine(outcome, duplicate)];
    return buildEnvelope({
      now,
      status: outcome === "pending" ? "pending" : "ok",
      lines,
      data: {
        proof_id: proof._id,
        challenge_id: proof.challenge_id,
        outcome,
        duplicate,
        day_index: proof.day_index,
        verdict: verdict
          ? {
              outcome: verdict.outcome,
              decided_by: verdict.decided_by,
              ai_judgment: verdict.ai_judgment,
              rule: verdict.rule,
              reason: verdict.reason,
              fix: verdict.fix,
              trust_level: verdict.trust_level,
            }
          : null,
        request: request ? envelopeAction(request) : null,
      },
    });
  },
};

function defaultLine(outcome: string, duplicate: boolean): string {
  if (duplicate) return "Lane already has this proof. Nothing changed.";
  switch (outcome) {
    case "accepted":
    case "flagged_accept":
      return "Lane accepted the proof.";
    case "rejected":
      return "Lane rejected the proof.";
    case "held":
      return "Lane is holding the proof until the extra proof it asked for arrives.";
    case "pending":
      return "The referees are still reviewing this proof. The verdict arrives at a later check-in.";
    default:
      return "This proof does not count.";
  }
}
