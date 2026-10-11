import type { Db } from "mongodb";
import { collections } from "../../src/schema/collections";
import { newId, type ChallengeType } from "../../src/schema/common";
import { ChallengeSchema, type Challenge, type ClockSettings } from "../../src/schema/challenges";
import { ContractSchema, type Contract } from "../../src/schema/contracts";
import { MembershipSchema, type Membership } from "../../src/schema/memberships";
import { PlayerSchema, type Player } from "../../src/schema/players";
import { ProofSchema, type Proof } from "../../src/schema/proofs";
import type { NewInboxItem } from "../../src/schema/inbox";
import type { Features } from "../../src/schema/common";
import { CHECKIN_INTERVAL_MIN, PLAY_CREDIT_LABEL, QUIET_HOURS, SURPRISE_CHECKS_PER_DAY } from "../../src/config";
import { windowEnd, windowStart } from "../../src/clock";

/**
 * U18 test doubles for U6 (players, challenges, memberships, contracts) and U5 (proofs):
 * documents written straight to the collections, validated against U3's schemas.
 */

function hex64(): string {
  return (globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID()).replace(/-/g, "").slice(0, 64);
}

export async function seedPlayer(
  db: Db,
  display_name: string,
  opts: { time_zone?: string; skipValidation?: boolean } = {},
): Promise<Player> {
  const now = new Date("2026-10-11T00:00:00.000Z");
  const raw = {
    _id: newId("player"),
    display_name,
    time_zone: opts.time_zone ?? "America/Los_Angeles",
    key_hash: hex64(),
    routine_text: "Check in with Lane.",
    handles: {},
    credits: 1000,
    scripted: true,
    created_at: now,
    updated_at: now,
  };
  // skipValidation simulates a bad name that got past registration (KTD15 defence in depth).
  const player = opts.skipValidation ? (raw as Player) : PlayerSchema.parse(raw);
  await collections(db).players.insertOne(player);
  return player;
}

export async function seedChallenge(
  db: Db,
  input: {
    creator: Player;
    clock: ClockSettings;
    type?: ChallengeType;
    status?: Challenge["status"];
    contract_version?: number;
    goal?: number;
    title?: string;
  },
): Promise<Challenge> {
  const now = input.clock.start_at;
  const challenge = ChallengeSchema.parse({
    _id: newId("challenge"),
    type: input.type ?? "ship_week",
    status: input.status ?? "active",
    title: input.title ?? "Ship Week",
    creator_id: input.creator._id,
    join_code: Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "X").replace(/[^A-Z0-9]/g, "Q"),
    stake: 100,
    winner_rule: "top_score",
    goal: input.goal ?? 3,
    params: {},
    draft: null,
    clock: input.clock,
    contract_version: input.contract_version ?? 1,
    settlement: null,
    stage: false,
    created_at: now,
    updated_at: now,
    activated_at: now,
    closed_at: null,
  });
  await collections(db).challenges.insertOne(challenge);
  return challenge;
}

export async function seedContract(
  db: Db,
  challenge: Challenge,
  version: number,
  opts: { changes?: string[]; reason?: string; does_not_count?: Contract["does_not_count"] } = {},
): Promise<Contract> {
  const clock = challenge.clock!;
  const contract = ContractSchema.parse({
    _id: newId("contract"),
    challenge_id: challenge._id,
    version,
    fields: {
      challenge_type: challenge.type,
      title: challenge.title,
      goal: challenge.goal,
      score_unit: "days",
      window: {
        start_at: windowStart(clock),
        end_at: windowEnd(clock),
        days: clock.days,
        day_length_sec: clock.day_length_sec,
      },
      stake: challenge.stake,
      winner_rule: challenge.winner_rule,
      credit_label: PLAY_CREDIT_LABEL,
      checkin: {
        interval_min: CHECKIN_INTERVAL_MIN,
        surprise_checks_per_day: SURPRISE_CHECKS_PER_DAY,
        quiet_hours: QUIET_HOURS,
        grace_sec: clock.grace_sec,
      },
      send: ["One commit per day."],
      scoring: "One meaningful commit counts for that day.",
      extra_proof: ["A one-time code in your next commit message."],
      params: {},
    },
    agent_instructions: "Submit one commit per day.",
    does_not_count: opts.does_not_count ?? [],
    built_from_rules: [],
    reason: opts.reason ?? (version === 1 ? "created" : "rule_activated"),
    changes: opts.changes ?? [],
    created_at: clock.start_at,
  });
  await collections(db).contracts.insertOne(contract);
  return contract;
}

/** Publish a new contract version the way U6 does: bump the counter, store the version, queue an info item per member. */
export async function publishVersion(db: Db, challenge: Challenge, changes: string[], now: Date): Promise<Contract> {
  const updated = await collections(db).challenges.findOneAndUpdate(
    { _id: challenge._id },
    { $inc: { contract_version: 1 }, $set: { updated_at: now } },
    { returnDocument: "after" },
  );
  const contract = await seedContract(db, updated!, updated!.contract_version, { changes, reason: "rule_activated" });
  const members = await collections(db).memberships.find({ challenge_id: challenge._id }).toArray();
  const { addInboxItem } = await import("../../src/inbox");
  for (const m of members) {
    await addInboxItem(db, infoItem(m.player_id, challenge._id, "contract_update", `Contract version ${contract.version} is live.`), { now });
  }
  return contract;
}

export async function seedMembership(
  db: Db,
  challenge: Challenge,
  player: Player,
  opts: { last_seen_contract_version?: number } = {},
): Promise<Membership> {
  const membership = MembershipSchema.parse({
    _id: newId("membership"),
    challenge_id: challenge._id,
    player_id: player._id,
    accepted_terms_version: "terms-1",
    handle_platform: "github",
    joined_at: challenge.clock!.start_at,
    joined_day_index: 0,
    last_check_in_at: null,
    last_seen_contract_version: opts.last_seen_contract_version ?? challenge.contract_version,
  });
  await collections(db).memberships.insertOne(membership);
  return membership;
}

export async function seedProof(
  db: Db,
  input: {
    challenge: Challenge;
    player: Player;
    day_index: number;
    status?: Proof["status"];
    held_reason?: Proof["held_reason"];
    features?: Features;
    payload?: Record<string, unknown>;
    received_at?: Date;
  },
): Promise<Proof> {
  const at = input.received_at ?? input.challenge.clock!.start_at;
  const proof = ProofSchema.parse({
    _id: newId("proof"),
    challenge_id: input.challenge._id,
    player_id: input.player._id,
    challenge_type: input.challenge.type,
    source_key: hex64().slice(0, 40),
    claimed: true,
    payload: input.payload ?? {},
    features: input.features ?? { files_changed: 3, lines_added: 42, lines_removed: 5, code_lines_changed: 47 },
    source_time: at,
    day_index: input.day_index,
    status: input.status ?? "accepted",
    held_reason: input.held_reason ?? null,
    not_counted_reason: null,
    verdict: null,
    answers_request_id: null,
    history: [],
    received_at: at,
    updated_at: at,
  });
  await collections(db).proofs.insertOne(proof);
  return proof;
}

export function infoItem(
  player_id: string,
  challenge_id: string,
  kind: "contract_update" | "verdict" | "standing" | "message" | "dispute_notice",
  instruction: string,
): NewInboxItem {
  return {
    player_id,
    challenge_id,
    kind,
    actor: "agent",
    instruction,
    answer_tool: null,
    answer_args: {},
    day_index: null,
    subject_proof_id: null,
    slot: null,
    code: null,
    release_at: null,
    due_at: null,
  };
}

export function extraProofItem(input: {
  player_id: string;
  challenge_id: string;
  proof_id: string;
  due_at: Date;
  code?: string;
  notify?: string[];
}): NewInboxItem {
  const code = input.code ?? "4821";
  return {
    player_id: input.player_id,
    challenge_id: input.challenge_id,
    kind: "extra_proof",
    actor: "player",
    instruction: `Ask the player to put the code ${code} in their next commit message, then send that commit.`,
    answer_tool: "lane_submit_proof",
    answer_args: { challenge_id: input.challenge_id },
    day_index: null,
    subject_proof_id: input.proof_id,
    slot: null,
    code,
    release_at: null,
    due_at: input.due_at,
    notify_player_ids: input.notify,
  };
}

export function surpriseCheckItem(input: {
  player_id: string;
  challenge_id: string;
  day_index: number;
  slot: number;
  release_at: Date;
  due_at: Date;
  code?: string;
}): NewInboxItem {
  const code = input.code ?? "4821";
  return {
    player_id: input.player_id,
    challenge_id: input.challenge_id,
    kind: "surprise_check",
    actor: "player",
    instruction: `Surprise check: ask the player for a commit containing the code ${code}.`,
    answer_tool: "lane_submit_proof",
    answer_args: { challenge_id: input.challenge_id },
    day_index: input.day_index,
    subject_proof_id: null,
    slot: input.slot,
    code,
    release_at: input.release_at,
    due_at: input.due_at,
  };
}
