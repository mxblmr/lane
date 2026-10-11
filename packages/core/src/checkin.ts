import type { Db } from "mongodb";
import { fail, type Id } from "./schema/common";
import { collections } from "./schema/collections";
import type { Challenge } from "./schema/challenges";
import type { Contract } from "./schema/contracts";
import type { Membership } from "./schema/memberships";
import type { Standing } from "./schema/envelope";
import { INFO_KINDS } from "./schema/inbox";
import { COUNTING_PROOF_STATUSES } from "./schema/proofs";
import type { AnyPack } from "./schema/pack";
import {
  NotImplementedError,
  provideServices,
  services,
  type CheckInChallenge,
  type CheckInInput,
  type CheckInResult,
  type LaneServices,
} from "./interfaces";
import { currentDayIndex, nextCheckInAt } from "./clock";
import { loadDayStatuses } from "./days";
import { getPack } from "./packs/index";
import { deliverInfoItems, inboxService, listOpenActions } from "./inbox";
import { buildFeed, feedService, safeDisplayName } from "./feed";
import { provideJobHandlers, settlementJobHandler, tickService } from "./tick";
import { disputesService } from "./disputes";
// ask.ts imports standingsFor from this module; the cycle is safe because neither side reads the
// other's exports while loading, only inside functions.
import { askService } from "./ask";

/**
 * Check-in (U18, R11, F3). One call returns, for every challenge the player is in: open action
 * items, info items delivered once, the contract if it changed since the player last saw it,
 * standings from U11's scoring and the redacted feed. It writes only the membership's last-seen
 * fields (KTD6). U7 turns this domain data into the connector envelope.
 */

/** Statuses a check-in always reports. Settled challenges appear only while they hold undelivered info. */
const LIVE_STATUSES: Challenge["status"][] = ["active", "settling"];
const MAX_CHANGE_LINES = 20;

export interface CheckInOptions {
  /** Test seam: resolve a pack other than the registry's. */
  packFor?: (type: Challenge["type"]) => AnyPack;
  feedLimit?: number;
}

/** Contract versions published since the player last saw one, folded into the latest version. */
async function contractSinceLastSeen(
  db: Db,
  challenge: Challenge,
  membership: Membership,
): Promise<Contract | null> {
  if (challenge.contract_version <= membership.last_seen_contract_version) return null;
  const versions = await collections(db)
    .contracts.find({ challenge_id: challenge._id, version: { $gt: membership.last_seen_contract_version } })
    .sort({ version: 1 })
    .toArray();
  const latest = versions.at(-1);
  if (!latest) return null;
  const changes = [...new Set(versions.flatMap((v) => v.changes))].slice(-MAX_CHANGE_LINES);
  return { ...latest, changes };
}

function rank(scores: { player_id: string; score: number }[]): Map<string, number> {
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const ranks = new Map<string, number>();
  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];
    ranks.set(s.player_id, prev && prev.score === s.score ? ranks.get(prev.player_id)! : i + 1);
  });
  return ranks;
}

/**
 * Used only while U11's `computeScores` is not wired (it throws NotImplementedError). It applies the
 * same U3 day-status function for days, and counts counting proofs for conversations.
 */
async function fallbackStandings(db: Db, challenge: Challenge, pack: AnyPack, now: Date): Promise<Standing[]> {
  const col = collections(db);
  const members = await col.memberships.find({ challenge_id: challenge._id }, { projection: { player_id: 1 } }).toArray();
  const ids = members.map((m) => m.player_id);
  let scores: { player_id: string; score: number }[];
  if (pack.scoreUnit === "days") {
    const days = await loadDayStatuses(db, challenge, now, { playerIds: ids });
    scores = ids.map((id) => ({ player_id: id, score: days.get(id)?.counted ?? 0 }));
  } else {
    const counted = await col.proofs
      .aggregate<{ _id: string; n: number }>([
        { $match: { challenge_id: challenge._id, status: { $in: [...COUNTING_PROOF_STATUSES] } } },
        { $group: { _id: "$player_id", n: { $sum: 1 } } },
      ])
      .toArray();
    const byId = new Map(counted.map((c) => [c._id, c.n]));
    scores = ids.map((id) => ({ player_id: id, score: byId.get(id) ?? 0 }));
  }
  const players = await col.players.find({ _id: { $in: ids } }, { projection: { _id: 1, display_name: 1 } }).toArray();
  const names = new Map(players.map((p) => [p._id, p.display_name]));
  const ranks = rank(scores);
  const goal = challenge.goal ?? Number.POSITIVE_INFINITY;
  return scores
    .map((s) => ({
      player_id: s.player_id,
      display_name: safeDisplayName(names.get(s.player_id)),
      score: s.score,
      unit: pack.scoreUnit,
      rank: ranks.get(s.player_id) ?? 1,
      reached_goal: s.score >= goal,
      is_you: false,
    }))
    .sort((a, b) => a.rank - b.rank);
}

/** Standings from U11's scoring, with `is_you` set for the viewer and display names re-checked (KTD15). */
export async function standingsFor(
  db: Db,
  challenge: Challenge,
  viewerId: Id,
  now: Date,
  pack: AnyPack,
): Promise<Standing[]> {
  let standings: Standing[];
  try {
    standings = (await services().settlement.computeScores(db, { challenge_id: challenge._id, now })).standings;
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
    standings = await fallbackStandings(db, challenge, pack, now);
  }
  return standings.map((s) => ({ ...s, display_name: safeDisplayName(s.display_name), is_you: s.player_id === viewerId }));
}

async function hasUndeliveredInfo(db: Db, playerId: Id, challengeId: Id): Promise<boolean> {
  const n = await collections(db).inbox.countDocuments(
    { player_id: playerId, challenge_id: challengeId, kind: { $in: [...INFO_KINDS] }, status: "open" },
    { limit: 1 },
  );
  return n > 0;
}

export async function checkIn(db: Db, input: CheckInInput, opts: CheckInOptions = {}): Promise<CheckInResult> {
  const now = input.now ?? new Date();
  const col = collections(db);
  const player = await col.players.findOne({ _id: input.player_id });
  if (!player) {
    return fail("unauthenticated", "Lane does not know this player.", "Register with lane_register, then send the player key it returns.");
  }
  const packFor = opts.packFor ?? getPack;

  const memberships = await col.memberships.find({ player_id: player._id }).toArray();
  const byChallenge = new Map(memberships.map((m) => [m.challenge_id, m]));
  const found = await col.challenges
    .find({ _id: { $in: [...byChallenge.keys()] }, status: { $in: [...LIVE_STATUSES, "settled"] } })
    .sort({ created_at: 1 })
    .toArray();
  const challenges: Challenge[] = [];
  for (const c of found) {
    if (LIVE_STATUSES.includes(c.status) || (await hasUndeliveredInfo(db, player._id, c._id))) challenges.push(c);
  }

  const results = await Promise.all(
    challenges.map(async (challenge): Promise<CheckInChallenge> => {
      const membership = byChallenge.get(challenge._id)!;
      const pack = packFor(challenge.type);
      const [contract, actions, info, standings, feed] = await Promise.all([
        contractSinceLastSeen(db, challenge, membership),
        listOpenActions(db, player._id, challenge._id, now),
        deliverInfoItems(db, player._id, challenge._id, now),
        standingsFor(db, challenge, player._id, now, pack),
        buildFeed(db, { challenge_id: challenge._id, viewer_player_id: player._id, limit: opts.feedLimit }, { packFor }),
      ]);
      // KTD6: a check-in writes only the last-seen time and the acknowledged contract version.
      await col.memberships.updateOne(
        { _id: membership._id },
        {
          $max: {
            last_check_in_at: now,
            last_seen_contract_version: contract?.version ?? membership.last_seen_contract_version,
          },
        },
      );
      return {
        challenge,
        membership,
        day_index: challenge.clock ? currentDayIndex(challenge.clock, now) : null,
        contract,
        contract_changed: contract !== null,
        actions,
        info,
        standings,
        feed,
      };
    }),
  );

  return { ok: true, player, challenges: results, next_check_in_at: nextCheckInAt(now) };
}

/** The U18 check-in service, in the shape of `LaneServices["checkin"]`. */
export const checkinService = {
  checkIn: (db: Db, input: CheckInInput) => checkIn(db, input),
} satisfies LaneServices["checkin"];

/**
 * Wire every U18 service into the U3 services table (check-in, inbox, feed, tick, disputes and
 * ask) and register the settlement job handler the tick runs. The web app's composition root (U7)
 * calls this once at startup; calling it again is harmless.
 */
export function provideU18Services(): void {
  provideServices({
    checkin: checkinService,
    inbox: inboxService,
    feed: feedService,
    tick: tickService,
    disputes: disputesService,
    ask: askService,
  });
  provideJobHandlers({ settlement: settlementJobHandler });
}
