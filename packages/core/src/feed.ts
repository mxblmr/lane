import type { Db } from "mongodb";
import { DISPLAY_NAME_PATTERN, type Features } from "./schema/common";
import { collections } from "./schema/collections";
import type { FeedItem } from "./schema/envelope";
import type { AnyPack } from "./schema/pack";
import type { Proof } from "./schema/proofs";
import type { BuildFeedInput } from "./interfaces";
import { getPack } from "./packs/index";

/**
 * The redacted feed (U18, KTD15). Every line is Lane-built from pack features, for example
 * "commit, 3 files, +42/-5". No proof payload, commit message, post text, note, attendee,
 * verdict reason or dispute reason ever reaches another player's agent through it.
 */

export const DEFAULT_FEED_LIMIT = 20;
export const MAX_FEED_LIMIT = 100;

/** A display name as stored should already match KTD15; anything else renders as a neutral label. */
export function safeDisplayName(name: string | null | undefined): string {
  return typeof name === "string" && DISPLAY_NAME_PATTERN.test(name) ? name : "Player";
}

/** Short enum-like strings (a platform, a cheat class) may reach `summarize`; free text never does. */
const ENUM_LIKE = /^[a-z0-9_-]{1,24}$/i;

/** Features a pack may summarize: numbers, booleans and enum-like strings. Free text is dropped. */
export function summarizableFeatures(features: Features | null): Features {
  const out: Features = {};
  if (!features) return out;
  for (const [key, value] of Object.entries(features)) {
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && ENUM_LIKE.test(value)) out[key] = value;
  }
  return out;
}

/** Characters a feed summary may contain after the pack renders it. */
const UNSAFE_SUMMARY_CHARS = /[^\p{L}\p{N} ,.+\-/:()%#]/gu;

export function feedSummary(pack: AnyPack, proof: Pick<Proof, "features">): string {
  let summary: string;
  try {
    summary = proof.features ? pack.summarize(summarizableFeatures(proof.features)) : "proof received";
  } catch {
    summary = "proof received";
  }
  const clean = summary.replace(UNSAFE_SUMMARY_CHARS, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return clean || "proof received";
}

export interface FeedOptions {
  /** Test seam: resolve a pack other than the registry's. */
  packFor?: (type: Proof["challenge_type"]) => AnyPack;
}

/** Newest first. Proofs whose day is not known yet are left out until it is. */
export async function buildFeed(db: Db, input: BuildFeedInput, opts: FeedOptions = {}): Promise<FeedItem[]> {
  const col = collections(db);
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_FEED_LIMIT, MAX_FEED_LIMIT));
  const proofs = await col.proofs
    .find(
      { challenge_id: input.challenge_id, day_index: { $ne: null } },
      {
        projection: {
          _id: 1,
          player_id: 1,
          challenge_type: 1,
          day_index: 1,
          status: 1,
          features: 1,
          verdict: 1,
          received_at: 1,
        },
      },
    )
    .sort({ received_at: -1 })
    .limit(limit)
    .toArray();
  if (proofs.length === 0) return [];

  const playerIds = [...new Set(proofs.map((p) => p.player_id))];
  const players = await col.players
    .find({ _id: { $in: playerIds } }, { projection: { _id: 1, display_name: 1 } })
    .toArray();
  const names = new Map(players.map((p) => [p._id, safeDisplayName(p.display_name)]));
  const packFor = opts.packFor ?? getPack;

  return proofs.map(
    (p): FeedItem => ({
      proof_id: p._id,
      player_id: p.player_id,
      display_name: names.get(p.player_id) ?? "Player",
      day_index: p.day_index as number,
      summary: feedSummary(packFor(p.challenge_type), p),
      status: p.status,
      decided_by: p.verdict?.decided_by ?? null,
      trust_level: p.verdict?.trust_level ?? null,
      at: p.received_at.toISOString(),
    }),
  );
}

/** The U18 feed service, in the shape of `LaneServices["feed"]`. */
export const feedService = {
  build: (db: Db, input: BuildFeedInput) => buildFeed(db, input),
};
