import type { Db } from "mongodb";
import { collections } from "../schema/collections";
import type { ChallengeType } from "../schema/common";
import type { ClockSettings, PlayerScore, ScoreUnit, Share, WinnerRule } from "../schema/challenges";
import type { Standing } from "../schema/envelope";
import type { InboxItem } from "../schema/inbox";
import { COUNTING_PROOF_STATUSES, type Proof } from "../schema/proofs";
import type { AnyPack } from "../schema/pack";
import type { ComputeScoresInput, ScoresResult } from "../interfaces";
import { playerDayStatuses } from "../days";
import { isDayInWindow } from "../clock";
import { potOf } from "../ledger";
import { getPack } from "../packs/index";
import { safeDisplayName } from "../feed";

/**
 * Scoring (U11, R6, KTD12, KTD13). This is the only scoring implementation: check-in (U18), the
 * dashboard (U12) and settlement all call `computeScores`, and settlement applies the winner and
 * refund rules with `computeResults`.
 *
 * - Days: a player's score is the number of window days the U3 day-status function marks counted,
 *   from their join day on.
 * - Conversations: a player's score is the number of counting proofs on days the day-status
 *   function marks counted, so a held or voided day counts no conversations.
 * - The time a player reached their final counted score is when Lane received the proof that
 *   completed it. It breaks remainder ties (KTD12) and orders equal scores in the standings.
 */

export type ScoreProof = Pick<Proof, "player_id" | "status" | "day_index" | "received_at">;
export type ScoreSurpriseCheck = Pick<InboxItem, "player_id" | "kind" | "status" | "due_at" | "release_at" | "day_index">;

export interface ScorePlayersInput {
  unit: ScoreUnit;
  clock: ClockSettings;
  goal: number;
  now: Date;
  members: { player_id: string; joined_day_index: number }[];
  proofs: readonly ScoreProof[];
  surpriseChecks: readonly ScoreSurpriseCheck[];
}

function latest(dates: Date[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (!best || d.getTime() > best.getTime()) best = d;
  return best;
}

function earliest(dates: Date[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (!best || d.getTime() < best.getTime()) best = d;
  return best;
}

/** Score every member. Pure. */
export function scorePlayers(input: ScorePlayersInput): PlayerScore[] {
  const { clock, now } = input;
  return input.members.map(({ player_id, joined_day_index }) => {
    const proofs = input.proofs.filter((p) => p.player_id === player_id);
    const checks = input.surpriseChecks.filter((c) => c.player_id === player_id);
    const days = playerDayStatuses({ player_id, clock, now, proofs, surpriseChecks: checks });
    const countedDays = new Set(days.counted_day_indexes.filter((d) => d >= joined_day_index));
    const counting = proofs.filter(
      (p): p is ScoreProof & { day_index: number } =>
        p.day_index !== null &&
        isDayInWindow(clock, p.day_index) &&
        countedDays.has(p.day_index) &&
        COUNTING_PROOF_STATUSES.includes(p.status),
    );

    let score: number;
    let final_counted_at: Date | null;
    if (input.unit === "days") {
      score = countedDays.size;
      // Each counted day became counted when its first counting proof arrived; the score
      // reached its final value when the last of those days did.
      const dayReached = [...countedDays].map((d) => earliest(counting.filter((p) => p.day_index === d).map((p) => p.received_at)));
      final_counted_at = latest(dayReached.filter((d): d is Date => d !== null));
    } else {
      score = counting.length;
      final_counted_at = latest(counting.map((p) => p.received_at));
    }
    return { player_id, score, reached_goal: score >= input.goal, final_counted_at: score > 0 ? final_counted_at : null };
  });
}

/**
 * Order for remainder ties and equal standings: earliest final counted score first, players with
 * no counted score last, then player id so the order never depends on query order.
 */
export function compareReachedFirst(a: PlayerScore, b: PlayerScore): number {
  const at = a.final_counted_at?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.final_counted_at?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0;
}

/** Standings: highest score first with shared ranks for equal scores (1, 1, 3). Pure. */
export function rankStandings(scores: readonly PlayerScore[], unit: ScoreUnit, names: ReadonlyMap<string, string>): Standing[] {
  const sorted = [...scores].sort((a, b) => b.score - a.score || compareReachedFirst(a, b));
  const standings: Standing[] = [];
  sorted.forEach((s, i) => {
    const prev = standings[i - 1];
    const rank = prev && prev.score === s.score ? prev.rank : i + 1;
    standings.push({
      player_id: s.player_id,
      display_name: safeDisplayName(names.get(s.player_id)),
      score: s.score,
      unit,
      rank,
      reached_goal: s.reached_goal,
      is_you: false,
    });
  });
  return standings;
}

export interface ResultsInput {
  winner_rule: WinnerRule;
  pot: number;
  scores: readonly PlayerScore[];
  /** Each player's stake in this challenge, from the ledger. Refunds return exactly these. */
  stakes: readonly Share[];
}

export interface ComputedResults {
  /** Players who qualify for a share, remainder receiver first. Empty when every stake is refunded. */
  winners: string[];
  /** Positive shares only. They sum to the pot unless every stake is refunded. */
  shares: Share[];
  refunds: Share[];
  refund_all: boolean;
}

/**
 * The KTD12 winner and refund rules. Pure.
 * - top_score: the highest score wins even below the goal and ties split; every stake is refunded
 *   only when every score is zero.
 * - finishers_split: everyone who reached the goal splits the pot; every stake is refunded when
 *   nobody reached it.
 * Each share is rounded down, and the remainder goes to the qualifying player who reached their
 * final counted score earliest.
 */
export function computeResults(input: ResultsInput): ComputedResults {
  let qualifying: PlayerScore[];
  if (input.winner_rule === "top_score") {
    const top = Math.max(0, ...input.scores.map((s) => s.score));
    qualifying = top > 0 ? input.scores.filter((s) => s.score === top) : [];
  } else {
    qualifying = input.scores.filter((s) => s.reached_goal);
  }

  if (qualifying.length === 0) {
    const byPlayer = new Map<string, number>();
    for (const s of input.stakes) byPlayer.set(s.player_id, (byPlayer.get(s.player_id) ?? 0) + s.amount);
    const refunds = [...byPlayer.entries()].filter(([, amount]) => amount > 0).map(([player_id, amount]) => ({ player_id, amount }));
    return { winners: [], shares: [], refunds, refund_all: true };
  }

  const ordered = [...qualifying].sort(compareReachedFirst);
  const base = Math.floor(input.pot / ordered.length);
  const remainder = input.pot - base * ordered.length;
  const shares = ordered
    .map((s, i) => ({ player_id: s.player_id, amount: base + (i === 0 ? remainder : 0) }))
    .filter((s) => s.amount > 0);
  return { winners: ordered.map((s) => s.player_id), shares, refunds: [], refund_all: false };
}

export interface ScoringOptions {
  /** Test seam: resolve a pack other than the registry's. */
  packFor?: (type: ChallengeType) => AnyPack;
}

/**
 * Scores, standings and the pot for one challenge, read fresh. Throws when the challenge does not
 * exist or is still a draft, because callers only ask for confirmed challenges.
 */
export async function computeScores(db: Db, input: ComputeScoresInput, opts: ScoringOptions = {}): Promise<ScoresResult> {
  const now = input.now ?? new Date();
  const session = input.session;
  const col = collections(db);
  const challenge = await col.challenges.findOne({ _id: input.challenge_id }, { session });
  if (!challenge) throw new Error(`challenge ${input.challenge_id} does not exist`);
  const { clock, goal, winner_rule } = challenge;
  if (!clock || goal === null || winner_rule === null) {
    throw new Error(`challenge ${challenge._id} is still a draft and has no scores`);
  }
  const unit = (opts.packFor ?? getPack)(challenge.type).scoreUnit;

  // Reads run one after another so they are safe inside a caller's transaction.
  const members = await col.memberships
    .find({ challenge_id: challenge._id }, { session, projection: { player_id: 1, joined_day_index: 1 } })
    .toArray();
  const ids = members.map((m) => m.player_id);
  const proofs = await col.proofs
    .find(
      { challenge_id: challenge._id, player_id: { $in: ids } },
      { session, projection: { player_id: 1, status: 1, day_index: 1, received_at: 1 } },
    )
    .toArray();
  const surpriseChecks = await col.inbox
    .find(
      { challenge_id: challenge._id, player_id: { $in: ids }, kind: "surprise_check" },
      { session, projection: { player_id: 1, kind: 1, status: 1, due_at: 1, release_at: 1, day_index: 1 } },
    )
    .toArray();
  const players = await col.players.find({ _id: { $in: ids } }, { session, projection: { _id: 1, display_name: 1 } }).toArray();
  const pot = await potOf(db, challenge._id, session);

  const scores = scorePlayers({
    unit,
    clock,
    goal,
    now,
    members: members.map((m) => ({ player_id: m.player_id, joined_day_index: m.joined_day_index })),
    proofs,
    surpriseChecks,
  });
  const standings = rankStandings(scores, unit, new Map(players.map((p) => [p._id, p.display_name])));
  const order = new Map(standings.map((s, i) => [s.player_id, i]));
  scores.sort((a, b) => (order.get(a.player_id) ?? 0) - (order.get(b.player_id) ?? 0));
  return { challenge_id: challenge._id, unit, goal, winner_rule, pot, scores, standings };
}
