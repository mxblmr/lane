import { services } from "../interfaces";
import { buildEnvelope, errorEnvelope } from "./envelope";
import type { LaneTool } from "./types";

export const askTool: LaneTool<"lane_ask"> = {
  name: "lane_ask",
  title: "Ask Lane",
  description: [
    "Ask Lane a question for the player at any time: their standing, the leaderboard, the current rules, what counts as proof, or why a proof was rejected.",
    "Pass the player's question in their own words, and challenge_id when it is about one challenge.",
    "Lane answers only from this player's own data and the public standings, and changes nothing. Relay the answer to the player.",
  ].join(" "),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fields: {
    player_key: "The player key from lane_register, unless you send it as the bearer header.",
    question: "The player's question in their own words.",
    challenge_id: "The challenge the question is about, when there is one.",
  },
  async handle({ db, args, player, now }) {
    const result = await services().ask.ask(db, {
      player_id: player._id,
      question: args.question,
      challenge_id: args.challenge_id,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);
    return buildEnvelope({
      now,
      lines: [result.answer],
      data: { answer: result.answer, challenge_id: args.challenge_id ?? null },
    });
  },
};
