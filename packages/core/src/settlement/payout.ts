import type { ClientSession, Db } from "mongodb";
import { fail, newId, type LaneError } from "../schema/common";
import { collections } from "../schema/collections";
import {
  SettlementSnapshotSchema,
  type Challenge,
  type SettlementSnapshot,
  type Share,
} from "../schema/challenges";
import type { PayoutApproval } from "../schema/approvals";
import type { LedgerEntry } from "../schema/ledger";
import { ACTION_KINDS } from "../schema/inbox";
import { COUNTING_PROOF_STATUSES, OPEN_PROOF_STATUSES } from "../schema/proofs";
import { OrchestratorSettleOutputSchema, type OrchestratorSettleOutput } from "../schema/agents";
import {
  services,
  type LaneServices,
  type PayInput,
  type PayResult,
  type ScoresResult,
  type SettleInput,
  type SettleResult,
} from "../interfaces";
import { PLAY_CREDIT_LABEL, readSettings } from "../config";
import { inTransaction } from "../ledger";
import { writeEvent } from "../events";
import { computeResults, computeScores, type ComputedResults, type ScoringOptions } from "./scoring";

/**
 * Settlement and payouts (U11, R27, R28, F6, AE6, KTD12).
 *
 * `settle` is what the settlement job runs (U18 queues it at window close, keyed by challenge id):
 *   1. Wait (status "requeued") while an action request the final check opened is still in grace.
 *   2. Anything still held or in review stops counting ("unresolved_at_settlement").
 *   3. Compute scores and results, check the orchestrator's proposal (U8) and store one results
 *      snapshot on the challenge with a conditional write. Once stored it never changes, so a proof
 *      that changes later does not change the payout, and a second run adopts the stored snapshot.
 *   4. If any share is above the payout limit or a winner has a proof under a payout hold, create one
 *      payout approval bound to the snapshot (U9) and wait. Otherwise pay.
 *
 * `pay` moves credits in one transaction that starts with the conditional move from settling to
 * settled for that snapshot, then writes every payout or refund through the ledger function. Only
 * the run that wins the move writes entries, so concurrent runs write one set. No agent moves
 * credits: the orchestrator only proposes, and its error or disagreement falls back to the computed
 * results.
 */

export interface SettleOptions extends ScoringOptions {
  /** Timeout for the orchestrator's proposal call. */
  agentTimeoutMs?: number;
}

const DEFAULT_AGENT_TIMEOUT_MS = 30_000;

type OrchestratorCheck = SettlementSnapshot["orchestrator"];
type ApprovalReason = SettlementSnapshot["approval_reasons"][number];

/** An error raised inside the pay transaction so it aborts, then returned as an Outcome. */
class PayAbort extends Error {
  constructor(readonly laneError: LaneError) {
    super(laneError.message);
    this.name = "PayAbort";
  }
}

// ---------------------------------------------------------------- reads

/** True while an action request for the challenge is still inside its grace (KTD12). */
async function hasOpenRequests(db: Db, challengeId: string, now: Date): Promise<boolean> {
  const n = await collections(db).inbox.countDocuments(
    {
      challenge_id: challengeId,
      kind: { $in: [...ACTION_KINDS] },
      status: { $in: ["open", "scheduled"] },
      due_at: { $gt: now },
    },
    { limit: 1 },
  );
  return n > 0;
}

/** Each player's stake in the challenge, from the ledger. */
async function stakesOf(db: Db, challengeId: string, session?: ClientSession): Promise<Share[]> {
  const stakes = await collections(db)
    .ledger.find({ challenge_id: challengeId, kind: "stake" }, { session, projection: { player_id: 1, amount: 1 } })
    .sort({ created_at: 1, _id: 1 })
    .toArray();
  return stakes.map((s) => ({ player_id: s.player_id, amount: s.amount }));
}

/** Payout and refund entries already written for the challenge. */
async function settlementEntries(db: Db, challengeId: string): Promise<LedgerEntry[]> {
  return collections(db)
    .ledger.find({ challenge_id: challengeId, kind: { $in: ["payout", "refund"] } })
    .sort({ created_at: 1, _id: 1 })
    .toArray();
}

/** True when a winner has a counting proof whose verdict holds the payout (KTD7). */
async function hasPayoutHold(db: Db, challengeId: string, playerIds: string[]): Promise<boolean> {
  if (playerIds.length === 0) return false;
  const n = await collections(db).proofs.countDocuments(
    {
      challenge_id: challengeId,
      player_id: { $in: playerIds },
      status: { $in: [...COUNTING_PROOF_STATUSES] },
      "verdict.payout_hold": true,
    },
    { limit: 1 },
  );
  return n > 0;
}

/** The payout approval bound to this snapshot, if U9 has stored one. */
async function findPayoutApproval(db: Db, challengeId: string, snapshot: SettlementSnapshot): Promise<PayoutApproval | null> {
  const col = collections(db).approvals;
  const found = snapshot.approval_id
    ? await col.findOne({ _id: snapshot.approval_id })
    : await col.findOne({ kind: "payout", challenge_id: challengeId, snapshot_id: snapshot.snapshot_id });
  return found && found.kind === "payout" && found.snapshot_id === snapshot.snapshot_id ? found : null;
}

// ---------------------------------------------------------------- settle

/** KTD12: when the job runs, anything still held or in review counts as not counted. */
async function closeUnresolvedProofs(db: Db, challengeId: string, now: Date): Promise<number> {
  let changed = 0;
  for (const from of OPEN_PROOF_STATUSES) {
    const res = await collections(db).proofs.updateMany(
      { challenge_id: challengeId, status: from },
      {
        $set: { status: "not_counted", held_reason: null, not_counted_reason: "unresolved_at_settlement", updated_at: now },
        $push: { history: { at: now, from, to: "not_counted", by: "system", note: "unresolved at settlement" } },
      },
    );
    changed += res.modifiedCount;
  }
  return changed;
}

function sameResults(proposal: OrchestratorSettleOutput, results: ComputedResults): boolean {
  if (proposal.refund_all !== results.refund_all) return false;
  if (results.refund_all) return true;
  const proposed = new Map<string, number>();
  for (const s of proposal.shares) {
    if (s.amount <= 0) continue;
    proposed.set(s.player_id, (proposed.get(s.player_id) ?? 0) + s.amount);
  }
  if (proposed.size !== results.shares.length) return false;
  return results.shares.every((s) => proposed.get(s.player_id) === s.amount);
}

/**
 * Ask the orchestrator (U8) for its proposal and check it against the computed results. Any
 * failure is "error" and a mismatch is "disagreed"; either way the computed results stand.
 */
async function checkProposal(
  scores: ScoresResult,
  results: ComputedResults,
  payoutLimit: number,
  snapshotId: string,
  opts: SettleOptions,
): Promise<OrchestratorCheck> {
  if (scores.scores.length === 0) return "skipped";
  try {
    const res = await services().agents.invoke({
      workspace: "orchestrator",
      mode: "settle",
      input: {
        mode: "settle",
        challenge_id: scores.challenge_id,
        winner_rule: scores.winner_rule,
        unit: scores.unit,
        goal: scores.goal,
        pot: scores.pot,
        payout_limit: payoutLimit,
        scores: scores.scores.map((s) => ({ player_id: s.player_id, score: s.score, reached_goal: s.reached_goal })),
      },
      timeout_ms: opts.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      meta: { challenge_id: scores.challenge_id, event_id: snapshotId },
    });
    if (!res.ok || res.status !== "completed") return "error";
    const proposal = OrchestratorSettleOutputSchema.safeParse(res.output);
    if (!proposal.success) return "error";
    return sameResults(proposal.data, results) ? "agreed" : "disagreed";
  } catch {
    return "error";
  }
}

async function buildSnapshot(db: Db, challenge: Challenge, now: Date, opts: SettleOptions): Promise<SettlementSnapshot> {
  const scores = await computeScores(db, { challenge_id: challenge._id, now }, opts);
  const stakes = await stakesOf(db, challenge._id);
  const results = computeResults({ winner_rule: scores.winner_rule, pot: scores.pot, scores: scores.scores, stakes });
  const settings = await readSettings(db);
  const reasons: ApprovalReason[] = [];
  if (results.shares.some((s) => s.amount > settings.payout_limit)) reasons.push("over_limit");
  if (await hasPayoutHold(db, challenge._id, results.shares.map((s) => s.player_id))) reasons.push("payout_hold");
  const snapshot_id = newId("snapshot");
  const orchestrator = await checkProposal(scores, results, settings.payout_limit, snapshot_id, opts);
  return SettlementSnapshotSchema.parse({
    snapshot_id,
    computed_at: now,
    winner_rule: scores.winner_rule,
    unit: scores.unit,
    goal: scores.goal,
    pot: scores.pot,
    scores: scores.scores,
    shares: results.shares,
    refunds: results.refunds,
    refund_all: results.refund_all,
    needs_approval: reasons.length > 0,
    approval_reasons: reasons,
    approval_id: null,
    orchestrator,
  });
}

/**
 * One payout approval for the snapshot, created through U9 and recorded on the snapshot. A run
 * that finds one already (from an earlier or concurrent run) reuses it. Throws whatever U9's
 * `create` throws, so the settlement job retries while U9 is not wired.
 */
async function ensurePayoutApproval(db: Db, challenge: Challenge, snapshot: SettlementSnapshot, now: Date): Promise<PayoutApproval> {
  let approval = await findPayoutApproval(db, challenge._id, snapshot);
  if (!approval) {
    const created = await services().approvals.create(db, {
      kind: "payout",
      challenge_id: challenge._id,
      snapshot_id: snapshot.snapshot_id,
      snapshot,
    });
    if (created.approval.kind !== "payout") throw new Error("approvals.create returned a rule approval for a payout");
    approval = created.approval;
  }
  if (snapshot.approval_id === null) {
    const set = await collections(db).challenges.updateOne(
      { _id: challenge._id, "settlement.snapshot_id": snapshot.snapshot_id, "settlement.approval_id": null },
      { $set: { "settlement.approval_id": approval._id, updated_at: now } },
    );
    if (set.modifiedCount === 1) {
      await writeEvent(db, {
        kind: "settlement.awaiting_approval",
        summary: `${challenge.title}: the payout waits for a human to approve it.`,
        challenge_id: challenge._id,
        challenge_type: challenge.type,
        data: { snapshot_id: snapshot.snapshot_id, approval_id: approval._id, reasons: snapshot.approval_reasons.join(",") },
        at: now,
      });
    } else {
      // A concurrent run recorded its approval first; report the recorded one.
      const stored = (await collections(db).challenges.findOne({ _id: challenge._id }))?.settlement;
      if (stored?.snapshot_id === snapshot.snapshot_id && stored.approval_id) {
        const recorded = await findPayoutApproval(db, challenge._id, stored);
        if (recorded) approval = recorded;
      }
    }
  }
  return approval;
}

export async function settle(db: Db, input: SettleInput, opts: SettleOptions = {}): Promise<SettleResult> {
  const now = input.now ?? new Date();
  const col = collections(db).challenges;
  let challenge = await col.findOne({ _id: input.challenge_id });
  if (!challenge) return fail("not_found", "That challenge does not exist.", "Check the challenge id.");
  if (challenge.status === "settled") {
    return { ok: true, status: "already_settled", snapshot: challenge.settlement, approval_id: challenge.settlement?.approval_id ?? null };
  }
  if (challenge.status !== "settling") {
    return fail(
      "not_allowed",
      `The challenge is ${challenge.status}, so it cannot settle.`,
      "Settlement runs after the window closes and the tick moves the challenge to settling.",
    );
  }

  if (!challenge.settlement) {
    if (await hasOpenRequests(db, challenge._id, now)) {
      return { ok: true, status: "requeued", snapshot: null, approval_id: null };
    }
    await closeUnresolvedProofs(db, challenge._id, now);
    const computed = await buildSnapshot(db, challenge, now, opts);
    const stored = await col.findOneAndUpdate(
      { _id: challenge._id, status: "settling", settlement: null },
      { $set: { settlement: computed, updated_at: now } },
      { returnDocument: "after" },
    );
    if (stored) {
      await writeEvent(db, {
        kind: "settlement.computed",
        summary: computed.refund_all
          ? `${challenge.title}: results computed; nobody qualifies, so every stake is refunded.`
          : `${challenge.title}: results computed; ${computed.shares.length} player(s) share ${computed.pot} ${PLAY_CREDIT_LABEL}.`,
        challenge_id: challenge._id,
        challenge_type: challenge.type,
        data: {
          snapshot_id: computed.snapshot_id,
          pot: computed.pot,
          winners: computed.shares.length,
          refund_all: computed.refund_all,
          needs_approval: computed.needs_approval,
          orchestrator: computed.orchestrator,
        },
        at: now,
      });
    }
    // A concurrent run stored its snapshot first: adopt it, so every run pays the same results.
    challenge = stored ?? (await col.findOne({ _id: challenge._id }));
    if (!challenge) return fail("not_found", "That challenge does not exist.", "Check the challenge id.");
    if (challenge.status === "settled") {
      return { ok: true, status: "already_settled", snapshot: challenge.settlement, approval_id: challenge.settlement?.approval_id ?? null };
    }
  }

  const snapshot = challenge.settlement;
  if (!snapshot) return fail("conflict", "The results snapshot could not be stored.", "Run settlement again.");

  if (!snapshot.needs_approval) {
    const paid = await pay(db, { challenge_id: challenge._id, snapshot_id: snapshot.snapshot_id, decision: "approve", now });
    if (!paid.ok) return paid;
    return { ok: true, status: paid.status, snapshot, approval_id: null };
  }

  const approval = await ensurePayoutApproval(db, challenge, snapshot, now);
  const bound: SettlementSnapshot = { ...snapshot, approval_id: snapshot.approval_id ?? approval._id };
  if (approval.status === "pending") {
    return { ok: true, status: "awaiting_approval", snapshot: bound, approval_id: approval._id };
  }
  // Decided already, but its pay step did not finish (for example a failed follow-up): finish it.
  const paid = await pay(db, {
    challenge_id: challenge._id,
    snapshot_id: snapshot.snapshot_id,
    decision: approval.status === "approved" ? "approve" : "decline",
    now,
  });
  if (!paid.ok) return paid;
  return { ok: true, status: paid.status, snapshot: bound, approval_id: approval._id };
}

// ---------------------------------------------------------------- pay

export async function pay(db: Db, input: PayInput): Promise<PayResult> {
  const now = input.now ?? new Date();
  const col = collections(db).challenges;
  const challenge = await col.findOne({ _id: input.challenge_id });
  if (!challenge) return fail("not_found", "That challenge does not exist.", "Check the challenge id.");
  if (challenge.status === "settled") {
    return { ok: true, status: "already_settled", entries: await settlementEntries(db, challenge._id) };
  }
  if (challenge.status !== "settling") {
    return fail("not_allowed", `The challenge is ${challenge.status}, so it cannot pay out.`, "Pay only after settlement computes the results.");
  }
  const snapshot = challenge.settlement;
  if (!snapshot || snapshot.snapshot_id !== input.snapshot_id) {
    return fail(
      "conflict",
      "That payout is for a results snapshot this challenge does not hold.",
      "Reload the challenge and decide its current payout approval.",
    );
  }
  if (snapshot.needs_approval) {
    const approval = await findPayoutApproval(db, challenge._id, snapshot);
    const wanted = input.decision === "approve" ? "approved" : "declined";
    if (!approval || approval.status !== wanted) {
      return fail("not_allowed", "This payout waits for a human decision.", "Approve or decline the payout approval on the dashboard first.");
    }
  } else if (input.decision === "decline") {
    return fail("not_allowed", "This payout needs no approval, so it cannot be declined.", "Let settlement pay it.");
  }

  // Declining refunds every stake (KTD12); otherwise pay the snapshot exactly.
  const refunding = input.decision === "decline" || snapshot.refund_all;
  const kind = refunding ? "refund" : "payout";
  try {
    const outcome = await inTransaction(db, async (session) => {
      const moved = await col.updateOne(
        { _id: challenge._id, status: "settling", "settlement.snapshot_id": snapshot.snapshot_id },
        { $set: { status: "settled", updated_at: now } },
        { session },
      );
      if (moved.modifiedCount !== 1) return null;
      const lines = input.decision === "decline" ? await stakesOf(db, challenge._id, session) : refunding ? snapshot.refunds : snapshot.shares;
      const entries: LedgerEntry[] = [];
      for (const line of lines) {
        if (line.amount <= 0) continue;
        const res = await services().ledger.append(
          db,
          { player_id: line.player_id, challenge_id: challenge._id, kind, amount: line.amount, ref: snapshot.snapshot_id },
          { session, now },
        );
        if (!res.ok) throw new PayAbort(res.error);
        entries.push(res.entry);
      }
      const total = entries.reduce((sum, e) => sum + e.amount, 0);
      await writeEvent(
        db,
        {
          kind: "challenge.settled",
          summary: refunding
            ? `${challenge.title}: settled; ${total} ${PLAY_CREDIT_LABEL} refunded to ${entries.length} player(s).`
            : `${challenge.title}: settled; ${total} ${PLAY_CREDIT_LABEL} paid to ${entries.length} player(s).`,
          challenge_id: challenge._id,
          challenge_type: challenge.type,
          data: { snapshot_id: snapshot.snapshot_id, status: refunding ? "refunded" : "paid", decision: input.decision, total, entries: entries.length },
          at: now,
        },
        { session },
      );
      return entries;
    });
    if (outcome === null) {
      return { ok: true, status: "already_settled", entries: await settlementEntries(db, challenge._id) };
    }
    return { ok: true, status: refunding ? "refunded" : "paid", entries: outcome };
  } catch (err) {
    if (err instanceof PayAbort) return { ok: false, error: err.laneError };
    throw err;
  }
}

// ---------------------------------------------------------------- the service

/**
 * The U11 settlement service, in the shape of `LaneServices["settlement"]`. The composition root
 * (U7) wires it with `provideServices({ settlement: settlementService })`; the tick's settlement
 * job handler (U18) and U9's payout approval follow-up then reach it through `services()`.
 */
export const settlementService = {
  computeScores: (db, input) => computeScores(db, input),
  settle: (db, input) => settle(db, input),
  pay: (db, input) => pay(db, input),
} satisfies LaneServices["settlement"];
