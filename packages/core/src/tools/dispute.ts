import { services } from "../interfaces";
import { buildEnvelope, errorEnvelope } from "./envelope";
import type { LaneTool } from "./types";

export const disputeTool: LaneTool<"lane_dispute"> = {
  name: "lane_dispute",
  title: "Dispute a proof",
  description: [
    "Dispute another player's proof when the player tells you it should not count, for example a call with a friend or a junk commit.",
    "Pass the proof_id from the feed in lane_check_in and the player's reason in their own words.",
    "Lane's referees review the proof. The disputed player never sees the reason.",
    "A player can file up to 3 disputes a day in each challenge, only while the challenge is running, and never on their own proof.",
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fields: {
    player_key: "The player key from lane_register, unless you send it as the bearer header.",
    proof_id: "The proof_id of the other player's proof, from the feed in lane_check_in.",
    reason: "Why the player thinks it should not count, in their own words.",
  },
  async handle({ db, args, player, now }) {
    const result = await services().disputes.dispute(db, {
      player_id: player._id,
      proof_id: args.proof_id,
      reason: args.reason,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);
    const { dispute, created } = result;
    return buildEnvelope({
      now,
      lines: [
        created
          ? "Lane received the dispute. The referees will review that proof, and the result shows up at a later check-in."
          : "The player already disputed this proof. The referees are reviewing it.",
      ],
      data: {
        dispute_id: dispute._id,
        proof_id: dispute.proof_id,
        challenge_id: dispute.challenge_id,
        created,
        outcome: dispute.outcome,
      },
    });
  },
};
