import { currentDayIndex } from "../clock";
import { PLAY_CREDIT_LABEL } from "../config";
import { services } from "../interfaces";
import type { HandlePlatform } from "../schema/common";
import type { InboxItem } from "../schema/inbox";
import { HANDLE_NAMES, winnerRuleLabel } from "./copy";
import {
  buildEnvelope,
  envelopeAction,
  envelopeChallenge,
  envelopeContract,
  errorEnvelope,
  formatCredits,
} from "./envelope";
import type { LaneTool } from "./types";

/** Optional fields U6's confirm adds to the U3 result (KTD21 handle binding for the creator). */
interface ConfirmExtras {
  bind_action?: InboxItem | null;
  handle_needed?: HandlePlatform | null;
}

export const confirmChallengeTool: LaneTool<"lane_confirm_challenge"> = {
  name: "lane_confirm_challenge",
  title: "Confirm a draft challenge",
  description: [
    "Confirm a draft from lane_create_challenge so the challenge goes live, with the winner rule and stake the player chose.",
    "Only call this after you showed the player the draft lines and the winner-rule choices and the player answered you themselves.",
    "Wait for the player's own answer: never fill winner_rule or stake from defaults, an earlier challenge or your own guess. If the player has not said both, ask them first.",
    "winner_rule is \"top_score\" (highest verified score takes the pot, ties split) or \"finishers_split\" (everyone who reaches the goal splits the pot).",
    "stake is a whole number of play credits (no real money) that every player puts in the pot, including the creator, who joins automatically.",
    "The result carries the join code: relay it to the player so friends can tell their own agent to join with it.",
    "If data.handle_needed is set, ask the player for that handle and send it with lane_join_challenge, using the same join code.",
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fields: {
    player_key: "The player key from lane_register, unless you send it as the bearer header.",
    draft_id: "The draft_id from lane_create_challenge.",
    winner_rule: "The rule the player picked: \"top_score\" or \"finishers_split\". Never a default.",
    stake: "The whole number of play credits (no real money) the player said each player stakes. Never a default.",
  },
  async handle({ db, args, player, now }) {
    const result = await services().challenges.confirm(db, {
      player_id: player._id,
      draft_id: args.draft_id,
      winner_rule: args.winner_rule,
      stake: args.stake,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);

    const { challenge, join_code, contract, stake_entry } = result;
    const { bind_action = null, handle_needed = null } = result as typeof result & ConfirmExtras;
    const stake = challenge.stake ?? stake_entry.amount;
    const lines = [
      `"${challenge.title}" is live. The join code is ${join_code}. You staked ${formatCredits(stake_entry.amount)}.`,
      "Share the join code with friends. Each of them tells their own agent to join Lane with it.",
    ];
    if (handle_needed) {
      lines.push(`Ask the player for their ${HANDLE_NAMES[handle_needed]} so their proof can count.`);
    } else if (bind_action) {
      lines.push(bind_action.instruction);
    }
    return buildEnvelope({
      now,
      lines,
      data: {
        challenge_id: challenge._id,
        join_code,
        title: challenge.title,
        stake,
        credit_label: PLAY_CREDIT_LABEL,
        winner_rule: challenge.winner_rule,
        winner_rule_text: challenge.winner_rule ? winnerRuleLabel(challenge.winner_rule) : null,
        handle_needed,
        next_step: handle_needed
          ? `Ask the player for their ${HANDLE_NAMES[handle_needed]}, then call lane_join_challenge with join_code ${join_code} and handle set to it.`
          : null,
        bind_action: bind_action ? envelopeAction(bind_action) : null,
        contract: envelopeContract(contract),
      },
      challenges: [
        envelopeChallenge({
          challenge,
          day_index: challenge.clock ? currentDayIndex(challenge.clock, now) : null,
          contract,
          contract_changed: true,
          actions: bind_action ? [bind_action] : [],
          now,
        }),
      ],
    });
  },
};
