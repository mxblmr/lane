import {
  CHECKIN_INTERVAL_MIN,
  PLAY_CREDIT_LABEL,
  QUIET_HOURS,
  SURPRISE_CHECKS_PER_DAY,
  readSettings,
} from "../config";
import { services } from "../interfaces";
import { DisplayNameSchema, TimeZoneSchema, fail } from "../schema/common";
import { buildEnvelope, errorEnvelope, formatCredits } from "./envelope";
import type { LaneTool } from "./types";

export const registerTool: LaneTool<"lane_register"> = {
  name: "lane_register",
  title: "Register with Lane",
  description: [
    "Register the player with Lane, an accountability service where friends stake play credits (no real money) on a challenge, send proof of progress, and Lane's referees verify it.",
    "Call this once per player, the first time they want to create or join a Lane challenge and you have no Lane player key for them.",
    "Before calling, tell the player that Lane checks in through a routine every 27 minutes and may ask for up to 3 surprise proof checks a day, never between 10 PM and 8 AM in their time zone, and register only if they agree.",
    "Use the display name the player wants (1 to 24 letters, digits and spaces) and their IANA time zone, for example America/Los_Angeles.",
    "The result's data.player_key appears only in this result: keep it private, send it on every other Lane call as the bearer header or as the player_key argument, and never show it to the player or put it in a URL.",
    "Set up the routine described in data.routine_text: call lane_check_in every 27 minutes.",
  ].join(" "),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  fields: {
    display_name: "The name other players see: 1 to 24 letters, digits and spaces.",
    time_zone: "The player's IANA time zone, for example America/Los_Angeles. Lane keeps surprise checks out of 10 PM to 8 AM there.",
  },
  async handle({ db, args, now }) {
    const name = DisplayNameSchema.safeParse(args.display_name);
    if (!name.success) {
      return errorEnvelope(
        fail(
          "invalid_input",
          "That display name does not work on Lane.",
          "Ask the player for a display name of 1 to 24 letters, digits and spaces, then call lane_register again.",
        ).error,
        now,
      );
    }
    const zone = TimeZoneSchema.safeParse(args.time_zone);
    if (!zone.success) {
      return errorEnvelope(
        fail(
          "invalid_input",
          "Lane does not recognize that time zone.",
          "Send an IANA time zone such as America/Los_Angeles, then call lane_register again.",
        ).error,
        now,
      );
    }

    const settings = await readSettings(db);
    if (!settings.registration_open) {
      return errorEnvelope(
        fail(
          "registration_closed",
          "Lane is not taking new players right now.",
          "Tell the player registration is closed for the moment and try lane_register again later.",
        ).error,
        now,
      );
    }

    const result = await services().players.register(db, {
      display_name: name.data,
      time_zone: zone.data,
      now,
    });
    if (!result.ok) return errorEnvelope(result.error, now);

    const { player, player_key, routine_text, grant } = result;
    return buildEnvelope({
      now,
      lines: [
        `${player.display_name} is registered with Lane and starts with ${formatCredits(grant.amount)}.`,
        `Lane will check in every ${CHECKIN_INTERVAL_MIN} minutes and may ask for up to ${SURPRISE_CHECKS_PER_DAY} surprise proof checks a day, never between 10 PM and 8 AM.`,
      ],
      data: {
        player_id: player._id,
        display_name: player.display_name,
        player_key,
        key_instructions:
          "Keep player_key private. Send it on every other Lane call as the bearer header or as the player_key argument. Never show it to the player, put it in a URL or include it in a message.",
        credits: player.credits,
        credit_label: PLAY_CREDIT_LABEL,
        routine_text,
        routine: {
          tool: "lane_check_in",
          interval_min: CHECKIN_INTERVAL_MIN,
          surprise_checks_per_day: SURPRISE_CHECKS_PER_DAY,
          quiet_hours: QUIET_HOURS,
        },
      },
    });
  },
};
