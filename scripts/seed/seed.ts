import { appendLedgerEntry } from "@lane/core/ledger";
import { readSettings, updateSettings } from "@lane/core/config";
import { collections, isDuplicateKeyError } from "@lane/core/schema/collections";
import { newId, type ChallengeType, type HandlePlatform } from "@lane/core/schema/common";
import type { Handle, Player } from "@lane/core/schema/players";
import { normalizeHandle } from "@lane/core/schema/players";
import { PLAY_CREDIT_LABEL } from "@lane/core/config";
import type { SeedPlayerInput, ScriptedPlayerName } from "./roster";
import {
  createStageChallenge,
  generationOf,
  latestStageChallenge,
  liveStageChallenges,
  nextGeneration,
  type Db,
} from "./stage";

/**
 * Idempotent seed (U13 approach step 1): the scripted players with verified handles and their
 * starting grant, then one live stage challenge per type on a demo clock. Seeding twice leaves one
 * copy of each. Example and seed-rule loading belongs to U9.
 */

export interface SeededPlayer {
  name: ScriptedPlayerName;
  player_id: string;
  created: boolean;
}

function routineText(name: string): string {
  return [
    `Lane routine for ${name}, a scripted demo player.`,
    "The stage runner calls lane_check_in and lane_submit_proof on cue; there is no unattended routine.",
    `Stakes and payouts are ${PLAY_CREDIT_LABEL}.`,
  ].join("\n");
}

/** Upsert one scripted player by display name and grant starting credits once, on insert. */
export async function seedPlayer(db: Db, input: SeedPlayerInput, now: Date): Promise<SeededPlayer> {
  const col = collections(db);
  const handles: Partial<Record<HandlePlatform, Handle>> = {};
  for (const [platform, raw] of Object.entries(input.handles) as [HandlePlatform, string][]) {
    handles[platform] = {
      platform,
      handle: normalizeHandle(raw),
      status: "verified",
      bind_code: null,
      verified_at: now,
    };
  }
  const handleSet = Object.fromEntries(Object.entries(handles).map(([p, h]) => [`handles.${p}`, h]));

  const existing = await col.players.findOne({ scripted: true, display_name: input.name });
  if (existing) {
    // Keep the key hash and verified handles in step with the environment.
    const sameHandles = Object.entries(handles).every(
      ([p, h]) => existing.handles[p as HandlePlatform]?.handle === h!.handle && existing.handles[p as HandlePlatform]?.status === "verified",
    );
    if (existing.key_hash !== input.key_hash || !sameHandles) {
      await col.players.updateOne(
        { _id: existing._id },
        { $set: { key_hash: input.key_hash, ...handleSet, updated_at: now } },
      );
    }
    return { name: input.name, player_id: existing._id, created: false };
  }

  const player: Player = {
    _id: newId("player"),
    display_name: input.name,
    time_zone: input.time_zone,
    key_hash: input.key_hash,
    routine_text: routineText(input.name),
    handles,
    credits: 0,
    scripted: true,
    created_at: now,
    updated_at: now,
  };
  try {
    await col.players.insertOne(player);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // A concurrent seed inserted the same key hash or verified handle first.
    const winner = await col.players.findOne({ scripted: true, display_name: input.name });
    if (!winner) throw err;
    return { name: input.name, player_id: winner._id, created: false };
  }
  const settings = await readSettings(db);
  const grant = await appendLedgerEntry(
    db,
    { player_id: player._id, challenge_id: null, kind: "grant", amount: settings.starting_credits, ref: "seed" },
    { now },
  );
  if (!grant.ok) throw new Error(`Starting grant for ${input.name} failed: ${grant.error.message}`);
  return { name: input.name, player_id: player._id, created: true };
}

export async function seedPlayers(db: Db, inputs: SeedPlayerInput[], now: Date = new Date()): Promise<SeededPlayer[]> {
  const out: SeededPlayer[] = [];
  for (const input of inputs) out.push(await seedPlayer(db, input, now));
  return out;
}

export interface SeededStage {
  type: ChallengeType;
  challenge_id: string;
  created: boolean;
}

/**
 * Make sure each type has exactly one live stage challenge. An active one is kept as it is; a draft
 * left by an interrupted run is finished; with none, generation 1 (or the next) is created.
 */
export async function seedStageChallenges(db: Db, types: readonly ChallengeType[], now: Date = new Date()): Promise<SeededStage[]> {
  const out: SeededStage[] = [];
  for (const type of types) {
    const live = await liveStageChallenges(db, type);
    const active = live.filter((c) => c.status !== "draft");
    if (active.length > 0) {
      out.push({ type, challenge_id: active[active.length - 1]!._id, created: false });
      continue;
    }
    const latest = await latestStageChallenge(db, type);
    const generation =
      latest && latest.status === "draft" ? (generationOf(latest._id, type) ?? (await nextGeneration(db, type))) : await nextGeneration(db, type);
    const created = await createStageChallenge(db, { type, generation, now });
    if (!created.ok) {
      throw new Error(`Creating the ${type} stage challenge failed: ${created.error.message} ${created.error.recovery}`);
    }
    out.push({ type, challenge_id: created.challenge_id, created: true });
  }
  return out;
}

export interface SeedResult {
  players: SeededPlayer[];
  stage: SeededStage[];
}

export async function seed(
  db: Db,
  input: { players: SeedPlayerInput[]; types: readonly ChallengeType[]; now?: Date; surprise_checks_enabled?: boolean },
): Promise<SeedResult> {
  const now = input.now ?? new Date();
  // Demo days last minutes, so surprise checks stay off on stage unless a scenario tests AE4.
  await updateSettings(db, { surprise_checks_enabled: input.surprise_checks_enabled ?? false }, now);
  const players = await seedPlayers(db, input.players, now);
  const stage = await seedStageChallenges(db, input.types, now);
  return { players, stage };
}
