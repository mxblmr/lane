import { demoClockSettings } from "@lane/core/clock";
import { services, type ConfirmInput } from "@lane/core/interfaces";
import { getPack } from "@lane/core/packs";
import { collections, isDuplicateKeyError } from "@lane/core/schema/collections";
import { fail, type ChallengeType, type HandlePlatform, type LaneError, type Params } from "@lane/core/schema/common";
import type { Challenge, WinnerRule } from "@lane/core/schema/challenges";
import type { Player } from "@lane/core/schema/players";
import { writeEvent } from "@lane/core/events";
import { SCRIPTED_PLAYER_NAMES, type ScriptedPlayerName } from "./roster";

/** The Lane database handle, typed without importing the driver into this package. */
export type Db = Parameters<typeof collections>[0];

/**
 * The demo stage challenge for each type (KTD22): a demo clock starting now, with the scripted
 * players joined. The creator joins through confirm; the others join through U6's two-phase join.
 */
export interface StageConfig {
  type: ChallengeType;
  title: string;
  goal: number;
  days: number;
  stake: number;
  winner_rule: WinnerRule;
  params: Params;
  creator: ScriptedPlayerName;
  players: readonly ScriptedPlayerName[];
  /** The creator's sentence, stored on the draft as quoted data. */
  sentence: string;
}

export const STAGE_CONFIGS: Record<ChallengeType, StageConfig> = {
  ship_week: {
    type: "ship_week",
    title: "Ship Week",
    goal: 5,
    days: 7,
    stake: 50,
    winner_rule: "top_score",
    params: {},
    creator: "Gary",
    players: SCRIPTED_PLAYER_NAMES,
    sentence: "Ship a meaningful commit on your own project every day this week.",
  },
  customers: {
    type: "customers",
    title: "Talk to Customers",
    goal: 5,
    days: 7,
    stake: 50,
    winner_rule: "top_score",
    params: {},
    creator: "Priya",
    players: SCRIPTED_PLAYER_NAMES,
    sentence: "Talk to five customers or prospects this week.",
  },
  build_in_public: {
    type: "build_in_public",
    title: "Build in Public",
    goal: 5,
    days: 7,
    stake: 50,
    winner_rule: "finishers_split",
    params: { platforms: ["threads"] },
    creator: "Sam",
    players: SCRIPTED_PLAYER_NAMES,
    sentence: "Post a build log on Threads every day this week.",
  },
};

/** Handle platform a scripted player needs for this stage challenge, from the pack. */
export function stageHandlePlatform(type: ChallengeType): HandlePlatform | null {
  const config = STAGE_CONFIGS[type];
  return getPack(type).handlePlatform({ params: config.params });
}

/** Stage challenges have ordered ids per type, so concurrent creators of one generation collide on _id. */
export function stageChallengeId(type: ChallengeType, generation: number): string {
  return `chl_stage_${type}_${String(generation).padStart(6, "0")}`;
}

export function stageIdPrefix(type: ChallengeType): string {
  return `chl_stage_${type}_`;
}

export function generationOf(id: string, type: ChallengeType): number | null {
  const prefix = stageIdPrefix(type);
  if (!id.startsWith(prefix)) return null;
  const n = Number(id.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The newest stage challenge of a type, whatever its status. */
export async function latestStageChallenge(db: Db, type: ChallengeType): Promise<Challenge | null> {
  return collections(db)
    .challenges.find({ stage: true, type, _id: { $regex: `^${stageIdPrefix(type)}` } })
    .sort({ _id: -1 })
    .limit(1)
    .next();
}

/** Stage challenges of a type that are still live (not cancelled or settled). */
export async function liveStageChallenges(db: Db, type: ChallengeType): Promise<Challenge[]> {
  return collections(db)
    .challenges.find({ stage: true, type, status: { $in: ["draft", "active", "settling"] } })
    .sort({ _id: 1 })
    .toArray();
}

/** The scripted players, by display name. Missing ones mean the seed has not run. */
export async function scriptedPlayers(db: Db): Promise<Map<ScriptedPlayerName, Player>> {
  const rows = await collections(db)
    .players.find({ scripted: true, display_name: { $in: [...SCRIPTED_PLAYER_NAMES] } })
    .toArray();
  const byName = new Map<ScriptedPlayerName, Player>();
  for (const p of rows) byName.set(p.display_name as ScriptedPlayerName, p);
  return byName;
}

export type CreateStageResult = { ok: true; challenge_id: string; join_code: string } | { ok: false; error: LaneError };

/**
 * Create stage challenge `generation` of `type` and join the scripted players (KTD22).
 * Idempotent: a second caller for the same generation finds the same draft, and U6's confirm and
 * join return the existing state (KTD6).
 */
export async function createStageChallenge(
  db: Db,
  input: { type: ChallengeType; generation: number; now: Date },
): Promise<CreateStageResult> {
  const config = STAGE_CONFIGS[input.type];
  const players = await scriptedPlayers(db);
  const missing = config.players.filter((n) => !players.has(n));
  if (missing.length > 0) {
    return fail(
      "not_found",
      `Scripted players missing: ${missing.join(", ")}.`,
      "Run the seed first: pnpm exec tsx scripts/seed/cli.ts seed.",
    );
  }
  const platform = stageHandlePlatform(input.type);
  const handleOf = (name: ScriptedPlayerName): string | undefined => {
    if (!platform) return undefined;
    const h = players.get(name)!.handles[platform];
    return h?.status === "verified" ? h.handle : undefined;
  };
  if (platform) {
    const unbound = config.players.filter((n) => !handleOf(n));
    if (unbound.length > 0) {
      return fail(
        "handle_unverified",
        `Scripted players without a verified ${platform} handle: ${unbound.join(", ")}.`,
        "Seed the players again with their handle variables set.",
      );
    }
  }

  const id = stageChallengeId(input.type, input.generation);
  const creator = players.get(config.creator)!;
  const col = collections(db);
  const draft: Challenge = {
    _id: id,
    type: input.type,
    status: "draft",
    title: config.title,
    creator_id: creator._id,
    stake: null,
    winner_rule: null,
    goal: config.goal,
    params: config.params,
    draft: { sentence: config.sentence, question: null, missing_fields: [] },
    clock: demoClockSettings(input.now, { days: config.days }),
    contract_version: 0,
    settlement: null,
    stage: true,
    created_at: input.now,
    updated_at: input.now,
    activated_at: null,
    closed_at: null,
  };
  try {
    await col.challenges.insertOne(draft);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Another reset or seed created this generation first; confirm and join are idempotent.
  }

  // U6's confirm takes two local extensions: the creator's handle and the clock mode (demo days).
  const confirmInput: ConfirmInput & { handle?: string; clock: { mode: "demo" } } = {
    player_id: creator._id,
    draft_id: id,
    winner_rule: config.winner_rule,
    stake: config.stake,
    now: input.now,
    handle: handleOf(config.creator),
    clock: { mode: "demo" },
  };
  const confirmed = await services().challenges.confirm(db, confirmInput);
  if (!confirmed.ok) return confirmed;
  const joinCode = confirmed.join_code;

  // KTD22 needs a demo clock starting now. If confirm ignored the clock extension, fix it while
  // nobody has submitted anything yet.
  if (confirmed.challenge.clock?.mode !== "demo") {
    await col.challenges.updateOne(
      { _id: id, "clock.mode": "real" },
      { $set: { clock: demoClockSettings(input.now, { days: config.days }), updated_at: input.now } },
    );
  }

  for (const name of config.players) {
    if (name === config.creator) continue;
    const player = players.get(name)!;
    const terms = await services().challenges.join(db, { player_id: player._id, join_code: joinCode, now: input.now });
    if (!terms.ok) return terms;
    if (terms.phase === "joined") continue;
    const joined = await services().challenges.join(db, {
      player_id: player._id,
      join_code: joinCode,
      accepted_terms_version: terms.terms.terms_version,
      handle: handleOf(name),
      now: input.now,
    });
    if (!joined.ok) return joined;
  }
  return { ok: true, challenge_id: id, join_code: joinCode };
}

/** Next generation number for a type: one more than the newest stage challenge. */
export async function nextGeneration(db: Db, type: ChallengeType): Promise<number> {
  const latest = await latestStageChallenge(db, type);
  return latest ? (generationOf(latest._id, type) ?? 0) + 1 : 1;
}

export async function stageEvent(db: Db, input: Parameters<typeof writeEvent>[1]): Promise<void> {
  await writeEvent(db, input);
}
