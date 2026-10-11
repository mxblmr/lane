import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { demoClockSettings, nextCheckInAt } from "../clock";
import { CHECKIN_INTERVAL_MIN, PLAY_CREDIT_LABEL, QUIET_HOURS, SURPRISE_CHECKS_PER_DAY } from "../config";
import type { CheckInChallenge, ServiceOverrides } from "../interfaces";
import type { Challenge } from "../schema/challenges";
import { collections } from "../schema/collections";
import { newId, type ChallengeType } from "../schema/common";
import type { Contract } from "../schema/contracts";
import type { Dispute } from "../schema/disputes";
import type { FeedItem, Standing } from "../schema/envelope";
import type { InboxItem } from "../schema/inbox";
import type { LedgerEntry } from "../schema/ledger";
import type { Membership } from "../schema/memberships";
import type { Player } from "../schema/players";
import type { Proof } from "../schema/proofs";
import { hashPlayerKey } from "../tools/identity";

/**
 * Fixtures and recording service doubles for the connector tools (U7). Test helper only; never
 * imported by a route. The doubles stand in for U6, U18 and U5 so the tools can be tested before
 * those units merge, and the register double writes a real player so key lookups hit MongoDB.
 */

export const T0 = new Date("2026-10-11T20:00:00.000Z");

export function testPlayerKey(): string {
  return `lane_pk_${randomBytes(24).toString("base64url")}`;
}

export function fakePlayer(overrides: Partial<Player> = {}): Player {
  return {
    _id: newId("player"),
    display_name: "Maya",
    time_zone: "America/Los_Angeles",
    key_hash: hashPlayerKey(testPlayerKey()),
    routine_text: "Every 27 minutes, call lane_check_in and relay what Lane sends.",
    handles: {},
    credits: 1000,
    scripted: false,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function fakeChallenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    _id: newId("challenge"),
    type: "ship_week" as ChallengeType,
    status: "active",
    title: "Ship Week",
    creator_id: newId("player"),
    join_code: "SHIP42",
    stake: 50,
    winner_rule: "top_score",
    goal: 5,
    params: {},
    draft: null,
    clock: demoClockSettings(T0, { days: 7 }),
    contract_version: 1,
    settlement: null,
    stage: false,
    created_at: T0,
    updated_at: T0,
    activated_at: T0,
    closed_at: null,
    ...overrides,
  };
}

export function fakeContract(challenge: Challenge, version = challenge.contract_version, overrides: Partial<Contract> = {}): Contract {
  return {
    _id: newId("contract"),
    challenge_id: challenge._id,
    version,
    fields: {
      challenge_type: challenge.type,
      title: challenge.title,
      goal: challenge.goal ?? 5,
      score_unit: "days",
      window: { start_at: T0, end_at: new Date(T0.getTime() + 7 * 300_000), days: 7, day_length_sec: 300 },
      stake: challenge.stake ?? 50,
      winner_rule: challenge.winner_rule ?? "top_score",
      credit_label: PLAY_CREDIT_LABEL,
      checkin: { interval_min: CHECKIN_INTERVAL_MIN, surprise_checks_per_day: SURPRISE_CHECKS_PER_DAY, quiet_hours: QUIET_HOURS, grace_sec: 90 },
      send: ["Send one meaningful commit on your own project each day: repo and full SHA."],
      scoring: "One verified day per day with a meaningful commit.",
      extra_proof: ["Lane may ask for a one-time code in your next commit message."],
      params: {},
    },
    agent_instructions: "Fetch the player's newest commit on their own project and submit it with lane_submit_proof.",
    does_not_count: version > 1 ? [{ rule_key: "rename_only", rule_version: 2, line: "A proof where the commit only renames does not count." }] : [],
    built_from_rules: [],
    reason: version > 1 ? "rule_activated" : "created",
    changes: version > 1 ? ["Rename-only commits no longer count."] : [],
    created_at: T0,
    ...overrides,
  };
}

export function fakeMembership(challenge: Challenge, player: Player, overrides: Partial<Membership> = {}): Membership {
  return {
    _id: newId("membership"),
    challenge_id: challenge._id,
    player_id: player._id,
    accepted_terms_version: "t1",
    handle_platform: "github",
    joined_at: T0,
    joined_day_index: 0,
    last_check_in_at: null,
    last_seen_contract_version: 1,
    ...overrides,
  };
}

export function fakeInboxItem(overrides: Partial<InboxItem> & Pick<InboxItem, "player_id">): InboxItem {
  return {
    _id: newId("inbox"),
    challenge_id: null,
    kind: "extra_proof",
    actor: "player",
    instruction: "Put the code 4821 in your next commit message, then tell your agent to send that commit.",
    answer_tool: null,
    answer_args: {},
    day_index: 0,
    subject_proof_id: null,
    slot: null,
    code: "4821",
    release_at: null,
    due_at: new Date(T0.getTime() + 90 * 60_000),
    status: "open",
    notify_player_ids: [],
    answer_proof_id: null,
    created_at: T0,
    updated_at: T0,
    resolved_at: null,
    delivered_at: null,
    ...overrides,
  };
}

export function fakeLedger(
  kind: LedgerEntry["kind"],
  amount: number,
  player_id: string,
  challenge_id: string | null = null,
): LedgerEntry {
  return {
    _id: newId("ledger"),
    player_id,
    challenge_id,
    kind,
    amount,
    delta: kind === "stake" ? -amount : amount,
    balance_after: 1000,
    ref: null,
    created_at: T0,
  };
}

export function fakeStanding(player: Player, overrides: Partial<Standing> = {}): Standing {
  return {
    player_id: player._id,
    display_name: player.display_name,
    score: 2,
    unit: "days",
    rank: 1,
    reached_goal: false,
    is_you: true,
    ...overrides,
  };
}

export function fakeFeedItem(player: Player, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    proof_id: newId("proof"),
    player_id: player._id,
    display_name: player.display_name,
    day_index: 0,
    summary: "commit, 3 files, +42/-5",
    status: "accepted",
    decided_by: "rule",
    trust_level: "rechecked",
    at: T0.toISOString(),
    ...overrides,
  };
}

export function fakeProof(challenge: Challenge, player: Player, overrides: Partial<Proof> = {}): Proof {
  return {
    _id: newId("proof"),
    challenge_id: challenge._id,
    player_id: player._id,
    challenge_type: challenge.type,
    source_key: "a".repeat(40),
    claimed: true,
    payload: {},
    features: null,
    source_time: T0,
    day_index: 0,
    status: "accepted",
    held_reason: null,
    not_counted_reason: null,
    verdict: {
      outcome: "accept",
      decided_by: "ai",
      rule: null,
      matched_rules: [],
      evaluated_rules: [],
      contract_version: 1,
      ai_calls: 1,
      ai_judgment: true,
      latency_ms: 900,
      trust_level: "rechecked",
      payout_hold: false,
      reason: "A real feature commit.",
      fix: "",
      cheat_class: null,
      confidence: 0.9,
      push_event_time: null,
      decided_at: T0,
    },
    answers_request_id: null,
    history: [],
    received_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

/**
 * AE8: one check-in challenge with an extra-proof request for the player, a standing and a new
 * contract. The request is due 90 minutes after `now`.
 */
export function ae8CheckInChallenge(
  player: Player,
  challenge = fakeChallenge({ contract_version: 2 }),
  now: Date = T0,
): CheckInChallenge {
  return {
    challenge,
    membership: fakeMembership(challenge, player),
    day_index: 1,
    contract: fakeContract(challenge, 2),
    contract_changed: true,
    actions: [
      fakeInboxItem({
        player_id: player._id,
        challenge_id: challenge._id,
        subject_proof_id: newId("proof"),
        due_at: new Date(now.getTime() + 90 * 60_000),
      }),
    ],
    info: [fakeInboxItem({ player_id: player._id, challenge_id: challenge._id, kind: "standing", actor: "agent", instruction: "Maya is first with 2 verified days.", code: null, due_at: null })],
    standings: [fakeStanding(player)],
    feed: [fakeFeedItem(player)],
  };
}

export interface RecordedCall {
  service: string;
  input: Record<string, unknown>;
}

export interface ToolDoubles {
  overrides: ServiceOverrides;
  calls: RecordedCall[];
  /** Plaintext keys issued by the register double, by player id. */
  keys: Map<string, string>;
  /** Challenges the check-in double returns, per player id. Defaults to one AE8 challenge. */
  checkIns: Map<string, CheckInChallenge[]>;
}

/**
 * Recording doubles for every service the eight tools call. The register double inserts a real
 * player (with the key's hash) and returns its key; the others return realistic results.
 */
export function toolDoubles(): ToolDoubles {
  const calls: RecordedCall[] = [];
  const keys = new Map<string, string>();
  const checkIns = new Map<string, CheckInChallenge[]>();
  const record = (service: string, input: object) => calls.push({ service, input: { ...input } });

  const overrides: ServiceOverrides = {
    players: {
      async register(db: Db, input) {
        record("players.register", input);
        const key = testPlayerKey();
        const now = input.now ?? new Date();
        const player = fakePlayer({
          _id: newId("player"),
          display_name: input.display_name,
          time_zone: input.time_zone,
          key_hash: hashPlayerKey(key),
          created_at: now,
          updated_at: now,
        });
        await collections(db).players.insertOne(player);
        keys.set(player._id, key);
        return { ok: true, player, player_key: key, routine_text: player.routine_text, grant: fakeLedger("grant", 1000, player._id) };
      },
    },
    challenges: {
      async draft(_db, input) {
        record("challenges.draft", input);
        if (!input.draft_id) {
          return { ok: true, kind: "question", draft_id: "chl_draft1", question: "Which platforms count?", missing_fields: ["platforms"] };
        }
        return {
          ok: true,
          kind: "draft",
          draft_id: input.draft_id,
          challenge_type: "ship_week",
          title: "Ship Week",
          goal: 5,
          days: 7,
          params: {},
          preview_lines: ["Ship Week: a meaningful commit on your own project each day for 7 days.", "Goal: 5 verified days."],
          winner_rules: ["top_score", "finishers_split"],
        };
      },
      async confirm(_db, input) {
        record("challenges.confirm", input);
        const challenge = fakeChallenge({ creator_id: input.player_id, stake: input.stake, winner_rule: input.winner_rule });
        const player = fakePlayer({ _id: input.player_id });
        return {
          ok: true,
          challenge,
          join_code: "SHIP42",
          membership: fakeMembership(challenge, player),
          contract: fakeContract(challenge, 1),
          stake_entry: fakeLedger("stake", input.stake, input.player_id, challenge._id),
        };
      },
      async join(_db, input) {
        record("challenges.join", input);
        const challenge = fakeChallenge();
        if (!input.accepted_terms_version) {
          return {
            ok: true,
            phase: "terms",
            challenge_id: challenge._id,
            terms: {
              terms_version: "terms-v1",
              lines: [
                `Stakes and payouts are ${PLAY_CREDIT_LABEL}. You stake 50 ${PLAY_CREDIT_LABEL}.`,
                "Highest verified score takes the pot, and ties split it.",
              ],
              stake: 50,
              winner_rule: "top_score",
              window: { start_at: T0, end_at: new Date(T0.getTime() + 7 * 300_000), days: 7 },
              checkin: { interval_min: CHECKIN_INTERVAL_MIN, surprise_checks_per_day: SURPRISE_CHECKS_PER_DAY, quiet_hours: QUIET_HOURS, grace_sec: 90 },
              handle_platform: "github",
              credit_label: PLAY_CREDIT_LABEL,
            },
          };
        }
        const player = fakePlayer({ _id: input.player_id });
        return {
          ok: true,
          phase: "joined",
          challenge,
          membership: fakeMembership(challenge, player),
          contract: fakeContract(challenge, 1),
          stake_entry: fakeLedger("stake", 50, input.player_id, challenge._id),
          bind_action: fakeInboxItem({
            player_id: input.player_id,
            challenge_id: challenge._id,
            kind: "bind_code",
            instruction: "Put the code LANE-7Q2 in your GitHub profile bio. Lane checks it within a few minutes.",
            code: "LANE-7Q2",
          }),
          already_member: false,
        };
      },
    },
    proofs: {
      async submit(_db, input) {
        record("proofs.submit", input);
        const challenge = fakeChallenge({ _id: input.challenge_id ?? newId("challenge") });
        const proof = fakeProof(challenge, fakePlayer({ _id: input.player_id }));
        return { ok: true, proof, outcome: "accepted", duplicate: false, verdict: proof.verdict, request: null, lines: ["Lane accepted the commit for day 1."] };
      },
    },
    checkin: {
      async checkIn(_db, input) {
        record("checkin.checkIn", input);
        const now = input.now ?? new Date();
        const player = fakePlayer({ _id: input.player_id });
        const challenges = checkIns.get(input.player_id) ?? [ae8CheckInChallenge(player, undefined, now)];
        return { ok: true, player, challenges, next_check_in_at: nextCheckInAt(now) };
      },
    },
    ask: {
      async ask(_db, input) {
        record("ask.ask", input);
        return { ok: true, answer: "You are first with 2 verified days." };
      },
    },
    disputes: {
      async dispute(_db, input) {
        record("disputes.dispute", input);
        const dispute: Dispute = {
          _id: newId("dispute"),
          challenge_id: newId("challenge"),
          proof_id: input.proof_id,
          disputer_id: input.player_id,
          disputed_player_id: newId("player"),
          reason: input.reason,
          day_index: 0,
          outcome: "pending",
          referee: null,
          created_at: T0,
          decided_at: null,
        };
        return { ok: true, dispute, created: true };
      },
    },
  };

  return { overrides, calls, keys, checkIns };
}

/** Valid arguments for every tool, without the key. */
export const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  lane_register: { display_name: "Maya", time_zone: "America/Los_Angeles" },
  lane_create_challenge: { sentence: "start Ship Week with my friends" },
  lane_confirm_challenge: { draft_id: "chl_draft1", winner_rule: "top_score", stake: 50 },
  lane_join_challenge: { join_code: "SHIP42" },
  lane_check_in: {},
  lane_submit_proof: { challenge_id: "chl_1", repo: "maya/app", sha: "a".repeat(40) },
  lane_ask: { question: "How am I doing?" },
  lane_dispute: { proof_id: "prf_1", reason: "That was a call with a friend." },
};

/** Counts every Lane collection, to show a refused call wrote nothing. */
export async function countAll(db: Db): Promise<Record<string, number>> {
  const c = collections(db);
  const entries = await Promise.all(
    (Object.keys(c) as (keyof typeof c)[]).map(async (name) => [name, await c[name].countDocuments()] as const),
  );
  return Object.fromEntries(entries);
}
