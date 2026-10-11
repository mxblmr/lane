import { currentDayIndex } from "../clock";
import { PLAY_CREDIT_LABEL } from "../config";
import { services } from "../interfaces";
import { HANDLE_NAMES, winnerRuleLabel } from "./copy";
import { buildEnvelope, envelopeAction, envelopeChallenge, errorEnvelope, formatCredits } from "./envelope";
import type { LaneTool } from "./types";

export const joinChallengeTool: LaneTool<"lane_join_challenge"> = {
  name: "lane_join_challenge",
  title: "Join a Lane challenge",
  description: [
    "Join a Lane challenge with the join code the player gives you. Joining takes two calls.",
    "First call with join_code only: Lane returns the terms and a terms_version. The terms state the stake in play credits (no real money), the winner rule, the window, the check-in routine every 27 minutes, up to 3 surprise proof checks a day outside quiet hours, and what to send as proof.",
    "Show the player every line in data.present.lines word for word and wait for the player's own answer.",
    "Only if the player accepts, call again with join_code, accepted_terms_version set to the exact terms_version Lane returned, and handle when the terms ask for one (the GitHub username for Ship Week, the platform handle for Build in Public).",
    "Never accept the terms for the player, never fill accepted_terms_version from a default or another challenge, and never guess the handle.",
    "The second call stakes the credits and returns the contract. If it returns an action with actor \"player\", relay it: the player puts that code in their profile bio themselves.",
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  fields: {
    player_key: "The player key from lane_register, unless you send it as the bearer header.",
    join_code: "The six-character join code the player was given.",
    accepted_terms_version:
      "Second call only, after the player accepted: the exact terms_version from the first call. Never a default.",
    handle: "Second call only, when the terms ask for one: the player's own handle on that platform.",
  },
  async handle({ db, args, player, now }) {
    const result = await services().challenges.join(db, {
      player_id: player._id,
      join_code: args.join_code.trim().toUpperCase(),
      accepted_terms_version: args.accepted_terms_version,
      handle: args.handle,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);

    if (result.phase === "terms") {
      const { terms } = result;
      const handleName = terms.handle_platform ? HANDLE_NAMES[terms.handle_platform] : null;
      return buildEnvelope({
        now,
        lines: [
          `Before joining, show the player these terms. Joining stakes ${formatCredits(terms.stake)}.`,
          handleName
            ? `If the player accepts, ask for their ${handleName} and join with it.`
            : "If the player accepts, join with the terms version below.",
        ],
        data: {
          phase: "terms",
          challenge_id: result.challenge_id,
          terms_version: terms.terms_version,
          present: {
            lines: terms.lines,
            choices: ["accept", "decline"],
          },
          stake: terms.stake,
          credit_label: PLAY_CREDIT_LABEL,
          winner_rule: terms.winner_rule,
          winner_rule_text: winnerRuleLabel(terms.winner_rule),
          window: terms.window,
          checkin: terms.checkin,
          handle_platform: terms.handle_platform,
          next_step: handleName
            ? `Show the player every line in present.lines word for word and wait for their own answer. Only if they accept, call lane_join_challenge again with this join_code, accepted_terms_version "${terms.terms_version}" and handle set to the player's ${handleName}.`
            : `Show the player every line in present.lines word for word and wait for their own answer. Only if they accept, call lane_join_challenge again with this join_code and accepted_terms_version "${terms.terms_version}".`,
        },
      });
    }

    const { challenge, contract, stake_entry, bind_action, already_member } = result;
    const lines = already_member
      ? [`${player.display_name} is already in "${challenge.title}".`]
      : [`${player.display_name} joined "${challenge.title}" and staked ${formatCredits(stake_entry.amount)}.`];
    if (bind_action) lines.push(bind_action.instruction);
    return buildEnvelope({
      now,
      lines,
      data: {
        phase: "joined",
        challenge_id: challenge._id,
        already_member,
        stake: stake_entry.amount,
        credit_label: PLAY_CREDIT_LABEL,
        bind_action: bind_action ? envelopeAction(bind_action) : null,
        routine_text: player.routine_text,
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
