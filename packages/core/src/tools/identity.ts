import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { fail, type Outcome } from "../schema/common";
import { collections } from "../schema/collections";
import type { Player } from "../schema/players";

/**
 * Player identity (KTD4). The player key comes from `lane_register` and arrives either as a
 * bearer header or as a `player_key` argument, never through the MCP session. Lane stores only
 * the SHA-256 hex of the key, so a lookup hashes the key and finds the player by `key_hash`.
 * The key never goes into a URL, a log line or any tool text other than the register result.
 */

/** SHA-256 hex of a player key, the value stored in `players.key_hash`. */
export function hashPlayerKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export type KeySource = "bearer" | "argument";

export const RECOVERY_NO_KEY =
  "Send the player key Lane returned from lane_register, as the bearer header or as the player_key argument. If this player never registered, call lane_register first.";
export const RECOVERY_UNKNOWN_KEY =
  "Use the player key exactly as lane_register returned it. If the player lost it, call lane_register again to get a new one.";

/**
 * Picks the key from the bearer header or the `player_key` argument. Both may be sent, but they
 * must be the same key, so a call can never act as two players.
 */
export function pickPlayerKey(input: {
  bearer?: string | null;
  argument?: unknown;
}): Outcome<{ key: string; source: KeySource }> {
  const bearer = typeof input.bearer === "string" && input.bearer.trim() ? input.bearer.trim() : null;
  const argument = typeof input.argument === "string" && input.argument.trim() ? input.argument.trim() : null;
  if (bearer && argument && bearer !== argument) {
    return fail(
      "unauthenticated",
      "The bearer header and player_key hold two different player keys.",
      "Send one player key, either as the bearer header or as player_key, not two different keys.",
    );
  }
  if (bearer) return { ok: true, key: bearer, source: "bearer" };
  if (argument) return { ok: true, key: argument, source: "argument" };
  return fail("unauthenticated", "Lane needs the player key for this call.", RECOVERY_NO_KEY);
}

/** Finds the player whose key hash matches. One indexed read on `players.key_hash`. */
export async function findPlayerByKey(db: Db, key: string): Promise<Player | null> {
  return collections(db).players.findOne({ key_hash: hashPlayerKey(key) });
}

/** Resolves the calling player, or returns an unauthenticated error with a recovery instruction. */
export async function resolvePlayer(db: Db, key: string): Promise<Outcome<{ player: Player }>> {
  const player = await findPlayerByKey(db, key);
  if (!player) {
    return fail("unauthenticated", "Lane does not recognize this player key.", RECOVERY_UNKNOWN_KEY);
  }
  return { ok: true, player };
}
