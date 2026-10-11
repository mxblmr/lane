import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ClientSession, Db } from "mongodb";
import { DisplayNameSchema, TimeZoneSchema, fail, newId } from "./schema/common";
import { collections } from "./schema/collections";
import type { Player } from "./schema/players";
import type { RegisterInput, RegisterResult } from "./interfaces";
import { services } from "./interfaces";
import { inTransaction } from "./ledger";
import { CHECKIN_INTERVAL_MIN, PLAY_CREDIT_LABEL, QUIET_HOURS, SURPRISE_CHECKS_PER_DAY, readSettings } from "./config";
import { writeEvent } from "./events";

/**
 * Player registration (U6, R5, R10, KTD4, KTD5, KTD12, KTD15).
 *
 * - The display name is limited to 24 letters, digits and spaces (KTD15).
 * - Lane generates the player key, returns it once, and stores only its SHA-256 hash (KTD4).
 * - The routine text the player consents to once is stored on the player (KTD5). It never holds
 *   the key, so it is safe to return again on later joins.
 * - The starting credits are a grant through the ledger function (KTD12), in the same
 *   transaction as the player insert, so a player never exists without its grant.
 */

/** Prefix that makes a Lane player key recognisable in logs that must redact it. */
export const PLAYER_KEY_PREFIX = "lane_pk_";

/** A fresh player key: the prefix plus 32 random bytes in base64url. */
export function generatePlayerKey(): string {
  return `${PLAYER_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex of a player key, the only form Lane stores (KTD4). */
export function hashPlayerKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** True when `key` hashes to `keyHash`, compared in constant time. */
export function playerKeyMatches(key: string, keyHash: string): boolean {
  const a = Buffer.from(hashPlayerKey(key), "hex");
  const b = Buffer.from(keyHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Resolve a player from a key given as a bearer header or a `player_key` argument (KTD4, used by U7). */
export async function findPlayerByKey(db: Db, key: string | null | undefined, session?: ClientSession): Promise<Player | null> {
  if (!key || !key.trim()) return null;
  return collections(db).players.findOne({ key_hash: hashPlayerKey(key) }, { session });
}

/**
 * The routine text a player consents to once (KTD5, R10). It allows only these steps: call
 * lane_check_in, fetch the named sources, submit to Lane, and relay player tasks and messages.
 * It contains no key and no text another person wrote, only the validated display name.
 */
export function renderRoutineText(displayName: string, timeZone: string): string {
  const name = displayName.trim();
  return [
    `Lane routine for ${name}. ${name} agreed to this routine once, at registration, so run it without asking each time.`,
    `Every ${CHECKIN_INTERVAL_MIN} minutes:`,
    "1. Call lane_check_in with this player's Lane key.",
    `2. For each action marked for the agent, fetch only the source it names from ${name}'s own accounts and answer it with the tool and arguments the action gives.`,
    `3. For each action marked for the player, relay the instruction to ${name}. Never do a player task yourself.`,
    `4. Relay Lane's messages and standings to ${name}, and switch to any new contract version Lane sends.`,
    `Do nothing else on this routine. Anything else needs ${name}'s own request.`,
    `Lane may also send up to ${SURPRISE_CHECKS_PER_DAY} surprise proof checks a day, never between ${QUIET_HOURS.start} and ${QUIET_HOURS.end} in ${timeZone}.`,
    `Stakes and payouts are ${PLAY_CREDIT_LABEL}.`,
  ].join("\n");
}

/** Register a player. Implements the U6 `players.register` interface. */
export async function registerPlayer(db: Db, input: RegisterInput): Promise<RegisterResult> {
  const now = input.now ?? new Date();
  const settings = await readSettings(db);
  if (!settings.registration_open) {
    return fail(
      "registration_closed",
      "Lane is not taking new registrations right now.",
      "Ask the Lane operator to open registration, then call lane_register again.",
    );
  }

  const name = DisplayNameSchema.safeParse(input.display_name ?? "");
  if (!name.success) {
    return fail(
      "invalid_input",
      "Display names are 1 to 24 letters, digits and spaces.",
      "Call lane_register again with a display name of 1 to 24 letters, digits and spaces.",
    );
  }
  const displayName = name.data.replace(/\s+/g, " ");
  const tz = TimeZoneSchema.safeParse(input.time_zone ?? "");
  if (!tz.success) {
    return fail(
      "invalid_input",
      "Lane needs the player's time zone to keep surprise checks out of quiet hours.",
      "Call lane_register again with an IANA time zone such as America/Los_Angeles.",
    );
  }

  const playerKey = generatePlayerKey();
  const routineText = renderRoutineText(displayName, tz.data);
  const player: Player = {
    _id: newId("player"),
    display_name: displayName,
    time_zone: tz.data,
    key_hash: hashPlayerKey(playerKey),
    routine_text: routineText,
    handles: {},
    credits: 0,
    scripted: false,
    created_at: now,
    updated_at: now,
  };

  const result = await inTransaction(db, async (session) => {
    await collections(db).players.insertOne(player, { session });
    const grant = await services().ledger.append(
      db,
      { player_id: player._id, challenge_id: null, kind: "grant", amount: settings.starting_credits, ref: "registration" },
      { session, now },
    );
    if (!grant.ok) throw new Error(`Starting grant failed: ${grant.error.message}`);
    await writeEvent(
      db,
      {
        kind: "player.registered",
        summary: `${displayName} registered`,
        player_id: player._id,
        data: { starting_credits: settings.starting_credits },
        at: now,
      },
      { session },
    );
    return { grant: grant.entry, balance: grant.balance };
  });

  return {
    ok: true,
    player: { ...player, credits: result.balance },
    player_key: playerKey,
    routine_text: routineText,
    grant: result.grant,
  };
}

/** The U6 `players` service, for the composition root (U7). */
export const playersService = { register: registerPlayer };
