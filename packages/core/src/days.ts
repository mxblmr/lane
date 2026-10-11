import type { ClientSession, Db } from "mongodb";
import type { Challenge, ClockSettings } from "./schema/challenges";
import type { InboxItem } from "./schema/inbox";
import { isInboxItemExpired, isInboxItemLive } from "./schema/inbox";
import type { Proof } from "./schema/proofs";
import { COUNTING_PROOF_STATUSES, OPEN_PROOF_STATUSES } from "./schema/proofs";
import { collections } from "./schema/collections";
import { dayGraceEnd, dayStart, isDayInWindow } from "./clock";

/**
 * The one day-status function (KTD13), used by the tick, scoring (U11) and the dashboard.
 *
 * A day counts for a player only if at least one of their proofs for that day is accepted or
 * flagged-accepted and no surprise check for that day expired unanswered. A later proof cannot
 * revive a day voided by an expired check. Reads treat an open item past its due time as expired.
 *
 * - counted: an accepted proof and no live or expired surprise check.
 * - held: a released surprise check for the day is still open within its grace (R18).
 * - voided: a surprise check for the day expired unanswered (AE4).
 * - pending: no counting proof yet, but a proof is still in review or held.
 * - open: nothing counts yet and the day's grace period is still open.
 * - missed: the grace period ended with nothing counted.
 * - future: the day has not started.
 */
export type DayStatus = "counted" | "held" | "voided" | "pending" | "open" | "missed" | "future";

export const DAY_STATUSES: readonly DayStatus[] = ["counted", "held", "voided", "pending", "open", "missed", "future"];

export type DayProof = Pick<Proof, "status" | "day_index">;
export type DaySurpriseCheck = Pick<InboxItem, "kind" | "status" | "due_at" | "release_at" | "day_index">;

export interface DayStatusInput {
  clock: ClockSettings;
  dayIndex: number;
  /** The player's proofs for this challenge (any day; filtered here). */
  proofs: readonly DayProof[];
  /** The player's surprise-check inbox items for this challenge (any day; filtered here). */
  surpriseChecks: readonly DaySurpriseCheck[];
  now: Date;
}

export function dayStatus(input: DayStatusInput): DayStatus {
  const { clock, dayIndex, now } = input;
  const checks = input.surpriseChecks.filter((c) => c.kind === "surprise_check" && c.day_index === dayIndex);
  if (checks.some((c) => isInboxItemExpired(c, now))) return "voided";
  if (checks.some((c) => isInboxItemLive(c, now))) return "held";

  const proofs = input.proofs.filter((p) => p.day_index === dayIndex);
  if (proofs.some((p) => COUNTING_PROOF_STATUSES.includes(p.status))) return "counted";
  if (proofs.some((p) => OPEN_PROOF_STATUSES.includes(p.status))) return "pending";

  if (now.getTime() < dayStart(clock, dayIndex).getTime()) return "future";
  if (now.getTime() < dayGraceEnd(clock, dayIndex).getTime()) return "open";
  return "missed";
}

export function dayCounts(status: DayStatus): boolean {
  return status === "counted";
}

export interface PlayerDays {
  player_id: string;
  /** Status per day index, 0 to days - 1. */
  days: DayStatus[];
  counted: number;
  /** Day indexes that count, ascending. */
  counted_day_indexes: number[];
}

/** Status of every day in the window for one player. Pure. */
export function playerDayStatuses(input: Omit<DayStatusInput, "dayIndex"> & { player_id: string }): PlayerDays {
  const days: DayStatus[] = [];
  for (let i = 0; i < input.clock.days; i++) {
    days.push(dayStatus({ ...input, dayIndex: i }));
  }
  const counted_day_indexes = days.flatMap((s, i) => (s === "counted" ? [i] : []));
  return { player_id: input.player_id, days, counted: counted_day_indexes.length, counted_day_indexes };
}

/**
 * Load proofs and surprise checks for a challenge and compute every member's day statuses.
 * Pass `playerIds` to limit to some players; otherwise every member is included.
 */
export async function loadDayStatuses(
  db: Db,
  challenge: Pick<Challenge, "_id" | "clock">,
  now: Date,
  opts: { playerIds?: string[]; session?: ClientSession } = {},
): Promise<Map<string, PlayerDays>> {
  const clock = challenge.clock;
  if (!clock) throw new Error(`challenge ${challenge._id} has no clock (still a draft)`);
  const col = collections(db);
  const session = opts.session;
  const playerIds =
    opts.playerIds ??
    (await col.memberships.find({ challenge_id: challenge._id }, { session, projection: { player_id: 1 } }).toArray()).map(
      (m) => m.player_id,
    );
  const [proofs, checks] = await Promise.all([
    col.proofs
      .find(
        { challenge_id: challenge._id, player_id: { $in: playerIds } },
        { session, projection: { player_id: 1, status: 1, day_index: 1 } },
      )
      .toArray(),
    col.inbox
      .find(
        { challenge_id: challenge._id, player_id: { $in: playerIds }, kind: "surprise_check" },
        { session, projection: { player_id: 1, kind: 1, status: 1, due_at: 1, release_at: 1, day_index: 1 } },
      )
      .toArray(),
  ]);
  const result = new Map<string, PlayerDays>();
  for (const player_id of playerIds) {
    result.set(
      player_id,
      playerDayStatuses({
        player_id,
        clock,
        now,
        proofs: proofs.filter((p) => p.player_id === player_id),
        surpriseChecks: checks.filter((c) => c.player_id === player_id),
      }),
    );
  }
  return result;
}

export { isDayInWindow };
