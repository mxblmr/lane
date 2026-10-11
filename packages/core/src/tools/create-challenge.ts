import { PLAY_CREDIT_LABEL } from "../config";
import { services } from "../interfaces";
import { CHALLENGE_NAMES, WINNER_RULE_CHOICES } from "./copy";
import { buildEnvelope, errorEnvelope } from "./envelope";
import type { LaneTool } from "./types";

export const createChallengeTool: LaneTool<"lane_create_challenge"> = {
  name: "lane_create_challenge",
  title: "Start a Lane challenge",
  description: [
    "Start a new Lane challenge from the player's own one-sentence description, for example \"start Ship Week with my friends\".",
    "Lane runs three challenges: Ship Week (a meaningful commit on the player's own project each day), Talk to Customers (real conversations with customers or prospects) and Build in Public (a real build-log post on X, Instagram or LinkedIn each day).",
    "Pass the player's words as sentence. This only creates a draft: nothing is staked and nobody is invited yet.",
    "If data.kind is \"question\", ask the player data.question, then call this tool again with the same draft_id and the player's answer as sentence.",
    "If data.kind is \"draft\", show the player every line in data.present.lines word for word, offer the winner-rule choices in data.present.winner_rule_choices, ask how many play credits (no real money) each player stakes, and wait for the player's own answer before calling lane_confirm_challenge.",
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fields: {
    player_key: "The player key from lane_register, unless you send it as the bearer header.",
    sentence: "The player's own words describing the challenge, or their answer to Lane's clarifying question.",
    draft_id: "Only when answering Lane's clarifying question: the draft_id Lane returned with the question.",
  },
  async handle({ db, args, player, now }) {
    const result = await services().challenges.draft(db, {
      player_id: player._id,
      sentence: args.sentence,
      draft_id: args.draft_id,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);

    if (result.kind === "question") {
      return buildEnvelope({
        now,
        lines: [result.question],
        data: {
          kind: "question",
          draft_id: result.draft_id,
          question: result.question,
          missing_fields: result.missing_fields,
          next_step:
            "Ask the player this question and wait for their answer. Then call lane_create_challenge with this draft_id and the player's answer as sentence.",
        },
      });
    }

    const choices = WINNER_RULE_CHOICES.filter((c) => result.winner_rules.includes(c.value));
    return buildEnvelope({
      now,
      lines: [
        `Lane drafted "${result.title}" (${CHALLENGE_NAMES[result.challenge_type]}). Show the player the draft and ask them to pick a winner rule and a stake in ${PLAY_CREDIT_LABEL}.`,
      ],
      data: {
        kind: "draft",
        draft_id: result.draft_id,
        challenge_type: result.challenge_type,
        title: result.title,
        goal: result.goal,
        days: result.days,
        present: {
          lines: result.preview_lines,
          winner_rule_choices: choices.length > 0 ? choices : WINNER_RULE_CHOICES,
          stake_question: `How many ${PLAY_CREDIT_LABEL} should each player stake?`,
        },
        credit_label: PLAY_CREDIT_LABEL,
        next_step:
          "Show the player every line in present.lines word for word, then ask which winner rule they want and how many play credits each player stakes. Wait for the player's own answer. Then call lane_confirm_challenge with this draft_id and the winner_rule and stake the player chose. Never fill them in yourself.",
      },
    });
  },
};
