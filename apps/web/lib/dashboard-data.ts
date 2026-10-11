import type { Db } from "mongodb";
import { NotImplementedError, laneDb, services } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema/collections";
import { CHALLENGE_TYPES, type ChallengeType } from "@lane/core/schema/common";
import type { Challenge, ScoreUnit } from "@lane/core/schema/challenges";
import type { Approval } from "@lane/core/schema/approvals";
import type { Rule, GateResult, GateThresholds } from "@lane/core/schema/rules";
import type { Proof } from "@lane/core/schema/proofs";
import type { Standing } from "@lane/core/schema/envelope";
import {
  projectApproval,
  projectChallenge,
  projectPlayer,
  projectProof,
  projectRule,
  projectSettings,
  type PublicApproval,
  type PublicChallenge,
  type PublicPlayer,
  type PublicProof,
  type PublicRule,
  type PublicSettings,
} from "@lane/core/schema/projections";
import { getPack, renderRuleLine } from "@lane/core/packs";
import { PLAY_CREDIT_LABEL, readSettings } from "@lane/core/config";
import { currentDayIndex, dayEnd, dayIndexAt, windowEnd } from "@lane/core/clock";
import { loadDayStatuses, type DayStatus } from "@lane/core/days";

/**
 * Dashboard data (U12, KTD15, KTD16). Every value returned here comes from a U3 public
 * projection or is a count, a pack-rendered line or a pack-built summary. Nothing reads or
 * returns join codes, key hashes, routine text, inbox items, attendee domains or note text.
 * Other units are reached only through `services()`; a call that is not wired yet comes
 * back as `{ available: false }` so the page shows "not available yet" instead of failing.
 */

export type Unavailable = { available: false; reason: string; owner: string | null };
export type Availability<T extends object> = ({ available: true } & T) | Unavailable;

export function isNotImplemented(err: unknown): err is NotImplementedError {
  return err instanceof NotImplementedError || (err instanceof Error && err.name === "NotImplementedError");
}

export function unavailableFrom(err: unknown): Unavailable {
  if (isNotImplemented(err)) {
    return { available: false, reason: "not available yet", owner: (err as NotImplementedError).owner ?? null };
  }
  console.error("dashboard service call failed", err instanceof Error ? err.name : "Error");
  return { available: false, reason: "failed", owner: null };
}

const NO_STORE = { "Cache-Control": "no-store" };

/** Runs a loader against the Lane database and answers JSON, 404 for null, 503 without a database. */
export async function dataResponse(load: (db: Db) => Promise<object | null>): Promise<Response> {
  let db: Db;
  try {
    db = await laneDb();
  } catch (err) {
    console.error("dashboard data has no database", err instanceof Error ? err.name : "Error");
    return Response.json({ ok: false, code: "no_database", message: "The database is not reachable." }, { status: 503, headers: NO_STORE });
  }
  try {
    const data = await load(db);
    if (data === null) {
      return Response.json({ ok: false, code: "not_found", message: "Not found." }, { status: 404, headers: NO_STORE });
    }
    return Response.json(data, { headers: NO_STORE });
  } catch (err) {
    console.error("dashboard data failed", err instanceof Error ? err.name : "Error");
    return Response.json({ ok: false, code: "internal", message: "Dashboard data failed." }, { status: 500, headers: NO_STORE });
  }
}

export type TickStatus = Availability<{ ran: boolean; transitions: number }>;

/** KTD13: every dashboard poll runs the tick. It takes a lease and returns at once if it loses. */
export async function runTick(db: Db, now: Date): Promise<TickStatus> {
  try {
    const result = await services().tick.run(db, { now, holder: "dashboard" });
    return { available: true, ran: result.ran, transitions: result.transitions };
  } catch (err) {
    return unavailableFrom(err);
  }
}

function safeSummary(type: ChallengeType, proof: Pick<Proof, "features">): string | null {
  if (!proof.features) return null;
  try {
    return getPack(type).summarize(proof.features).slice(0, 200);
  } catch (err) {
    console.error("pack summary failed", type, err instanceof Error ? err.name : "Error");
    return null;
  }
}

function safeRuleLine(rule: Pick<Rule, "challenge_type" | "when" | "action">): string | null {
  try {
    return renderRuleLine(getPack(rule.challenge_type), rule);
  } catch (err) {
    console.error("rule line render failed", rule.challenge_type, err instanceof Error ? err.name : "Error");
    return null;
  }
}

function publicRule(rule: Rule): PublicRule {
  return projectRule(rule, { line: safeRuleLine(rule) });
}

async function potsFor(db: Db, challengeIds: string[]): Promise<Map<string, number>> {
  if (challengeIds.length === 0) return new Map();
  const rows = await collections(db)
    .ledger.aggregate<{ _id: string; pot: number }>([
      { $match: { challenge_id: { $in: challengeIds }, kind: "stake" } },
      { $group: { _id: "$challenge_id", pot: { $sum: "$amount" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.pot]));
}

async function countBy(
  db: Db,
  collection: "memberships" | "proofs",
  challengeIds: string[],
): Promise<Map<string, number>> {
  if (challengeIds.length === 0) return new Map();
  const col = collection === "memberships" ? collections(db).memberships : collections(db).proofs;
  const rows = await col
    .aggregate<{ _id: string; n: number }>([
      { $match: { challenge_id: { $in: challengeIds } } },
      { $group: { _id: "$challenge_id", n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

function potOf(challenge: Challenge, pots: Map<string, number>): number {
  return challenge.settlement?.pot ?? pots.get(challenge._id) ?? 0;
}

// ---------------------------------------------------------------- overview (three challenges)

export interface ChallengeCard {
  challenge: PublicChallenge;
  day_index: number | null;
  players: number;
  proofs: number;
  pot: number;
  pending_approvals: number;
}

export interface OverviewData {
  server_time: Date;
  credit_label: string;
  tick: TickStatus;
  types: { type: ChallengeType; title: string; challenges: ChallengeCard[] }[];
  pending_approvals: number;
  settings: PublicSettings;
}

const LISTED_STATUSES: Challenge["status"][] = ["active", "settling", "settled"];
const CARDS_PER_TYPE = 3;

export async function loadOverview(db: Db, now: Date = new Date()): Promise<OverviewData> {
  const tick = await runTick(db, now);
  const col = collections(db);
  const [challenges, pendingApprovals, settings] = await Promise.all([
    col.challenges.find({ status: { $in: LISTED_STATUSES } }).sort({ created_at: -1 }).limit(60).toArray(),
    col.approvals.find({ status: "pending" }).toArray(),
    readSettings(db),
  ]);

  const byType = new Map<ChallengeType, Challenge[]>();
  for (const c of challenges) {
    const list = byType.get(c.type) ?? [];
    list.push(c);
    byType.set(c.type, list);
  }
  const shown = CHALLENGE_TYPES.flatMap((type) =>
    (byType.get(type) ?? [])
      .sort((a, b) => Number(b.stage) - Number(a.stage) || b.created_at.getTime() - a.created_at.getTime())
      .slice(0, CARDS_PER_TYPE),
  );
  const ids = shown.map((c) => c._id);
  const [pots, members, proofs] = await Promise.all([potsFor(db, ids), countBy(db, "memberships", ids), countBy(db, "proofs", ids)]);

  const pendingFor = (c: Challenge) =>
    pendingApprovals.filter((a) => (a.kind === "rule" ? a.challenge_type === c.type : a.challenge_id === c._id)).length;

  return {
    server_time: now,
    credit_label: PLAY_CREDIT_LABEL,
    tick,
    types: CHALLENGE_TYPES.map((type) => ({
      type,
      title: getPack(type).title,
      challenges: shown
        .filter((c) => c.type === type)
        .map((c) => ({
          challenge: projectChallenge(c),
          day_index: c.clock ? currentDayIndex(c.clock, now) : null,
          players: members.get(c._id) ?? 0,
          proofs: proofs.get(c._id) ?? 0,
          pot: potOf(c, pots),
          pending_approvals: pendingFor(c),
        })),
    })),
    pending_approvals: pendingApprovals.length,
    settings: projectSettings(settings),
  };
}

// ---------------------------------------------------------------- one challenge (the stage screen)

export interface FeedEntry extends PublicProof {
  display_name: string;
}

export interface PlayerRow {
  player: PublicPlayer;
  joined_at: Date;
  /** Days that count so far (KTD13's one day-status function), for day-scored packs. */
  counted_days: number | null;
  days: DayStatus[] | null;
}

export type CandidateStep = "proposed" | "tested" | "awaiting_approval" | "active" | "rejected" | "retired";

export interface RuleActivity {
  rule: PublicRule;
  step: CandidateStep;
  gate_passed: boolean | null;
}

export interface RuleVersionPoint {
  rule_key: string;
  version: number;
  parent_version: number | null;
  status: Rule["status"];
  source: Rule["source"];
  action: Rule["action"];
  cheat_class: string | null;
  catch_rate_before: number | null;
  catch_rate_after: number | null;
  false_alarm_set: number | null;
  passed: boolean | null;
  created_at: Date;
  activated_at: Date | null;
}

export type RuleApprovalEntry = Extract<PublicApproval, { kind: "rule" }> & {
  parent_version: number | null;
  cheat_class: string | null;
  gate: GateResult | null;
  evidence_summary: string | null;
};
export type PayoutApprovalEntry = Extract<PublicApproval, { kind: "payout" }> & {
  names: Record<string, string>;
};
export type ApprovalEntry = RuleApprovalEntry | PayoutApprovalEntry;

export interface ClockView {
  mode: "real" | "demo";
  /** Raw day index on the challenge clock; ops advance-day sends it back as the expected day. */
  day_index: number;
  current_day: number | null;
  days: number;
  day_ends_at: Date | null;
  window_ends_at: Date;
}

export interface ActivityLine {
  id: string;
  kind: string;
  summary: string;
  at: Date;
}

export interface ChallengeData {
  server_time: Date;
  credit_label: string;
  tick: TickStatus;
  challenge: PublicChallenge;
  pack_title: string;
  score_unit: ScoreUnit;
  clock: ClockView | null;
  pot: number;
  players: PlayerRow[];
  standings: Availability<{ standings: Standing[] }>;
  feed: FeedEntry[];
  rules: {
    active: PublicRule[];
    activity: RuleActivity | null;
    versions: RuleVersionPoint[];
    thresholds: GateThresholds;
  };
  approvals: ApprovalEntry[];
  activity: ActivityLine[];
}

const FEED_LIMIT = 30;
/** Decided approvals stay visible this long so the stage sees "approved, activating, active". */
const RECENT_DECISION_MS = 10 * 60_000;

export function candidateStep(rule: Pick<Rule, "status" | "test_results">): CandidateStep {
  switch (rule.status) {
    case "candidate":
      return rule.test_results ? "tested" : "proposed";
    case "pending_approval":
      return "awaiting_approval";
    case "active":
      return "active";
    case "rejected":
      return "rejected";
    default:
      return "retired";
  }
}

function versionPoint(r: Rule): RuleVersionPoint {
  const t = r.test_results;
  return {
    rule_key: r.rule_key,
    version: r.version,
    parent_version: r.parent_version,
    status: r.status,
    source: r.source,
    action: r.action,
    cheat_class: r.cheat_class,
    catch_rate_before: t ? t.catch_rate_before : null,
    catch_rate_after: t ? t.catch_rate_after : null,
    false_alarm_set: t ? t.false_alarm_set : null,
    passed: t ? t.passed : null,
    created_at: r.created_at,
    activated_at: r.activated_at,
  };
}

function isApprovalVisible(a: Approval, now: Date): boolean {
  if (a.status === "pending") return true;
  if (a.follow_up.status !== "ok") return true;
  return a.decided_at !== null && now.getTime() - a.decided_at.getTime() < RECENT_DECISION_MS;
}

export async function loadChallenge(db: Db, challengeId: string, now: Date = new Date()): Promise<ChallengeData | null> {
  const tick = await runTick(db, now);
  const col = collections(db);
  const challenge = await col.challenges.findOne({ _id: challengeId });
  if (!challenge || challenge.status === "draft") return null;
  const pack = getPack(challenge.type);

  const [memberships, proofs, rules, approvals, pots, settings, events] = await Promise.all([
    col.memberships.find({ challenge_id: challenge._id }).sort({ joined_at: 1 }).toArray(),
    col.proofs.find({ challenge_id: challenge._id }).sort({ received_at: -1 }).limit(FEED_LIMIT).toArray(),
    col.rules.find({ challenge_type: challenge.type }).sort({ created_at: 1 }).limit(200).toArray(),
    col.approvals
      .find({
        $or: [
          { kind: "rule", challenge_type: challenge.type },
          { kind: "payout", challenge_id: challenge._id },
        ],
      })
      .sort({ created_at: -1 })
      .limit(30)
      .toArray(),
    potsFor(db, [challenge._id]),
    readSettings(db),
    col.events.find({ challenge_id: challenge._id }).sort({ at: -1 }).limit(15).toArray(),
  ]);

  const playerIds = [...new Set([...memberships.map((m) => m.player_id), ...proofs.map((p) => p.player_id)])];
  const players = await col.players.find({ _id: { $in: playerIds } }).toArray();
  const publicPlayers = new Map(players.map((p) => [p._id, projectPlayer(p)]));
  const nameOf = (id: string) => publicPlayers.get(id)?.display_name ?? "Unknown player";

  let dayStatuses: Awaited<ReturnType<typeof loadDayStatuses>> | null = null;
  if (challenge.clock && pack.scoreUnit === "days") {
    dayStatuses = await loadDayStatuses(db, challenge, now, { playerIds: memberships.map((m) => m.player_id) });
  }

  let standings: ChallengeData["standings"];
  try {
    const scores = await services().settlement.computeScores(db, { challenge_id: challenge._id, now });
    standings = { available: true, standings: scores.standings.map((s) => ({ ...s, is_you: false })) };
  } catch (err) {
    standings = unavailableFrom(err);
  }

  const rulesById = new Map(rules.map((r) => [r._id, r]));
  const evidenceIds = rules.flatMap((r) => r.evidence.proof_ids.slice(0, 1));
  const evidenceProofs = evidenceIds.length
    ? await col.proofs.find({ _id: { $in: evidenceIds } }, { projection: { _id: 1, challenge_type: 1, features: 1 } }).toArray()
    : [];
  const evidenceSummary = new Map(evidenceProofs.map((p) => [p._id, safeSummary(p.challenge_type, p)]));

  const approvalEntries: ApprovalEntry[] = approvals
    .filter((a) => isApprovalVisible(a, now))
    .sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.created_at.getTime() - a.created_at.getTime())
    .slice(0, 10)
    .map((a): ApprovalEntry => {
      if (a.kind === "rule") {
        const rule = rulesById.get(a.rule_id) ?? null;
        const projected = projectApproval(a, { line: rule ? safeRuleLine(rule) : null });
        const firstEvidence = rule?.evidence.proof_ids[0];
        return {
          ...(projected as Extract<PublicApproval, { kind: "rule" }>),
          parent_version: rule?.parent_version ?? null,
          cheat_class: rule?.cheat_class ?? null,
          gate: rule?.test_results ?? null,
          evidence_summary: firstEvidence ? (evidenceSummary.get(firstEvidence) ?? null) : null,
        };
      }
      const projected = projectApproval(a) as Extract<PublicApproval, { kind: "payout" }>;
      const names: Record<string, string> = {};
      for (const s of [...projected.shares, ...projected.refunds]) names[s.player_id] = nameOf(s.player_id);
      return { ...projected, names };
    });

  const learned = rules
    .filter((r) => r.source !== "seed" && r.created_at.getTime() >= challenge.created_at.getTime())
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  const open = learned[0] ?? null;

  const clock = challenge.clock;
  let clockView: ClockView | null = null;
  if (clock) {
    const raw = dayIndexAt(clock, now);
    const current = currentDayIndex(clock, now);
    clockView = {
      mode: clock.mode,
      day_index: raw,
      current_day: current,
      days: clock.days,
      day_ends_at: current === null ? null : dayEnd(clock, current),
      window_ends_at: windowEnd(clock),
    };
  }

  return {
    server_time: now,
    credit_label: PLAY_CREDIT_LABEL,
    tick,
    challenge: projectChallenge(challenge),
    pack_title: pack.title,
    score_unit: pack.scoreUnit,
    clock: clockView,
    pot: potOf(challenge, pots),
    players: memberships
      .flatMap((m): PlayerRow[] => {
        const player = publicPlayers.get(m.player_id);
        if (!player) return [];
        const days = dayStatuses?.get(m.player_id) ?? null;
        return [{ player, joined_at: m.joined_at, counted_days: days ? days.counted : null, days: days ? days.days : null }];
      })
      .sort(
        (a, b) =>
          (b.counted_days ?? 0) - (a.counted_days ?? 0) ||
          a.joined_at.getTime() - b.joined_at.getTime() ||
          a.player.display_name.localeCompare(b.player.display_name),
      ),
    standings,
    feed: proofs.map((p) => ({
      ...projectProof(p, { summary: safeSummary(p.challenge_type, p) }),
      display_name: nameOf(p.player_id),
    })),
    rules: {
      active: rules.filter((r) => r.status === "active").map(publicRule),
      activity: open
        ? { rule: publicRule(open), step: candidateStep(open), gate_passed: open.test_results ? open.test_results.passed : null }
        : null,
      versions: rules.map(versionPoint),
      thresholds: settings.gate,
    },
    approvals: approvalEntries,
    activity: events.map((e) => ({ id: e._id, kind: e.kind, summary: e.summary, at: e.at })),
  };
}

// ---------------------------------------------------------------- rules page (full version history)

export interface RulesData {
  server_time: Date;
  tick: TickStatus;
  types: { type: ChallengeType; title: string; rules: PublicRule[] }[];
}

export async function loadRules(db: Db, now: Date = new Date(), type?: ChallengeType): Promise<RulesData> {
  const tick = await runTick(db, now);
  const types = type ? [type] : [...CHALLENGE_TYPES];
  const rules = await collections(db)
    .rules.find({ challenge_type: { $in: types } })
    .sort({ rule_key: 1, version: -1 })
    .limit(500)
    .toArray();
  return {
    server_time: now,
    tick,
    types: types.map((t) => ({
      type: t,
      title: getPack(t).title,
      rules: rules.filter((r) => r.challenge_type === t).map(publicRule),
    })),
  };
}
