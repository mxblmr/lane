import { appendLedgerEntry } from "@lane/core/ledger";
import { updateSettings } from "@lane/core/config";
import { services, type LaneServices, type ResetStageInput, type ResetStageResult } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema/collections";
import { fail, newId, type ChallengeType } from "@lane/core/schema/common";
import type { Challenge } from "@lane/core/schema/challenges";
import { writeEvent } from "@lane/core/events";
import { createStageChallenge, nextGeneration, stageChallengeId, type Db } from "./stage";

/**
 * Stage reset (KTD22), exposed to U12's reset control through `stage.reset` in U3's services table.
 * Every rehearsal and the stage run start here. In order:
 *   1. Cancel the previous stage challenge of the type: move it to the terminal `cancelled` status
 *      (the tick, settlement and check-in skip it), refund every stake through the ledger function
 *      as new entries, and expire its open inbox items.
 *   2. Decline open rule approvals for the type, which resumes and so ends their suspended
 *      promoter executions (U9).
 *   3. Roll the type's rules back to their seed versions through the U9 lifecycle.
 *   4. Remove the type's non-seed examples.
 *   5. Create a fresh stage challenge on a demo clock starting now, with the scripted players joined.
 * Before step 1 it writes `surprise_checks_enabled: false` to `settings` (unless the caller asks
 * for them, for an AE4 scenario), because demo days last minutes.
 * Every step is idempotent, so a failed reset can simply be run again. Earlier ledger entries stay
 * untouched.
 */

const MAX_ROLLBACKS = 20;

export interface ResetReport {
  cancelled: string[];
  refunds: number;
  expired_items: number;
  declined_approvals: number;
  rolled_back: string[];
  removed_examples: number;
  new_challenge_id: string;
}

export type ResetStageDetailedResult =
  | ({ ok: true; cancelled_challenge_id: string | null; new_challenge_id: string } & { report: ResetReport })
  | Extract<ResetStageResult, { ok: false }>;

/** Step 1 for one challenge. Safe to repeat: refunds are unique per challenge and player. */
async function cancelChallenge(db: Db, challenge: Challenge, resetId: string, now: Date): Promise<{ refunds: number; expired: number }> {
  const col = collections(db);
  if (challenge.status !== "cancelled") {
    await col.challenges.updateOne(
      { _id: challenge._id, status: { $in: ["draft", "active", "settling"] } },
      { $set: { status: "cancelled", closed_at: now, updated_at: now } },
    );
  }
  const current = await col.challenges.findOne({ _id: challenge._id });
  if (current?.status !== "cancelled") {
    // Settlement got there first (settled): its payout stands, so nothing is refunded.
    return { refunds: 0, expired: 0 };
  }

  let refunds = 0;
  const stakes = await col.ledger.find({ challenge_id: challenge._id, kind: "stake" }).toArray();
  for (const stake of stakes) {
    const refund = await appendLedgerEntry(
      db,
      { player_id: stake.player_id, challenge_id: challenge._id, kind: "refund", amount: stake.amount, ref: resetId },
      { now },
    );
    if (!refund.ok) throw new Error(`Refund for ${stake.player_id} on ${challenge._id} failed: ${refund.error.message}`);
    if (!refund.duplicate) refunds += 1;
  }

  const expired = await services().inbox.expire(db, { now, challenge_id: challenge._id });
  if (challenge.status !== "cancelled") {
    await writeEvent(db, {
      kind: "challenge.cancelled",
      summary: `${challenge.title} stage run cancelled by reset`,
      challenge_id: challenge._id,
      challenge_type: challenge.type,
      data: { refunds, reset_id: resetId },
      at: now,
    });
  }
  return { refunds, expired: expired.expired.length };
}

/** Step 3: roll every active non-seed rule of the type back until only seed versions are active. */
async function rollbackToSeed(db: Db, type: ChallengeType, by: string, now: Date): Promise<string[]> {
  const col = collections(db);
  const rolled: string[] = [];
  for (let i = 0; i < MAX_ROLLBACKS; i++) {
    const learned = await col.rules.findOne({ challenge_type: type, status: "active", source: { $ne: "seed" } });
    if (!learned) return rolled;
    const result = await services().lifecycle.rollback(db, { challenge_type: type, rule_key: learned.rule_key, by, now });
    if (!result.ok) {
      throw new Error(`Rolling back ${learned.rule_key} v${learned.version} failed: ${result.error.message}`);
    }
    rolled.push(`${learned.rule_key} v${learned.version}`);
  }
  const left = await col.rules.countDocuments({ challenge_type: type, status: "active", source: { $ne: "seed" } });
  if (left > 0) throw new Error(`${left} learned ${type} rules are still active after ${MAX_ROLLBACKS} rollbacks.`);
  return rolled;
}

export interface StageResetInput extends ResetStageInput {
  /**
   * Surprise checks stay off on stage unless a scenario tests AE4: on demo days of a few minutes,
   * scripted players would get up to 3 a day and an unanswered one voids the day (KTD13).
   */
  surprise_checks_enabled?: boolean;
}

export async function resetStageDetailed(db: Db, input: StageResetInput): Promise<ResetStageDetailedResult> {
  const now = input.now ?? new Date();
  const type = input.challenge_type;
  const resetId = `reset_${newId("event").slice(4)}`;
  const col = collections(db);
  let step = "turn surprise checks off for the stage";
  try {
    await updateSettings(db, { surprise_checks_enabled: input.surprise_checks_enabled ?? false }, now);
    step = "cancel the previous stage challenge";
    // The new generation is fixed first, so two resets that start together create the same one.
    const generation = await nextGeneration(db, type);
    const newId_ = stageChallengeId(type, generation);
    let refunds = 0;
    let expired = 0;
    const cancelled: string[] = [];

    // 1. Cancel every older stage challenge of the type that is still live, plus any cancelled one
    //    an interrupted reset left without its refunds. Settled challenges are left alone.
    const cancelOlder = async (): Promise<void> => {
      const previous = await col.challenges
        .find({ stage: true, type, _id: { $lt: newId_ }, status: { $in: ["draft", "active", "settling", "cancelled"] } })
        .sort({ _id: 1 })
        .toArray();
      for (const challenge of previous) {
        const wasLive = challenge.status !== "cancelled";
        if (!wasLive) {
          const [stakes, refunded] = await Promise.all([
            col.ledger.countDocuments({ challenge_id: challenge._id, kind: "stake" }),
            col.ledger.countDocuments({ challenge_id: challenge._id, kind: "refund" }),
          ]);
          if (refunded >= stakes) continue;
        }
        const r = await cancelChallenge(db, challenge, resetId, now);
        refunds += r.refunds;
        expired += r.expired;
        if (wasLive && !cancelled.includes(challenge._id)) cancelled.push(challenge._id);
      }
    };
    await cancelOlder();

    // 2. Decline open rule approvals for the type (U9 resumes the promoter with decline).
    step = "decline open rule approvals";
    const pending = await col.approvals.find({ kind: "rule", status: "pending", challenge_type: type }).toArray();
    let declined = 0;
    for (const approval of pending) {
      const decided = await services().approvals.decide(db, {
        approval_id: approval._id,
        decision: "decline",
        decided_by: input.by,
        now,
      });
      if (!decided.ok) throw new Error(decided.error.message);
      if (decided.decided) declined += 1;
    }

    // 3. Roll the type's rules back to their seed versions (U9 lifecycle).
    step = "roll rules back to seed";
    const rolled = await rollbackToSeed(db, type, input.by, now);

    // 4. Remove the type's non-seed examples.
    step = "remove non-seed examples";
    const removed = await col.examples.deleteMany({ challenge_type: type, source: { $ne: "seed" } });

    // 5. Fresh stage challenge on a demo clock starting now, scripted players joined.
    step = "create the new stage challenge";
    const created = await createStageChallenge(db, { type, generation, now });
    if (!created.ok) return created;

    // A reset that started earlier may have created an older generation meanwhile: the newest wins.
    step = "cancel older stage challenges";
    await cancelOlder();

    const report: ResetReport = {
      cancelled,
      refunds,
      expired_items: expired,
      declined_approvals: declined,
      rolled_back: rolled,
      removed_examples: removed.deletedCount,
      new_challenge_id: created.challenge_id,
    };
    await writeEvent(db, {
      kind: "stage.reset",
      summary: `Stage reset for ${type}: new challenge ready`,
      challenge_id: created.challenge_id,
      challenge_type: type,
      data: {
        reset_id: resetId,
        cancelled: cancelled.length,
        refunds,
        declined_approvals: declined,
        rolled_back: rolled.length,
        removed_examples: removed.deletedCount,
      },
      at: now,
    });
    return {
      ok: true,
      cancelled_challenge_id: cancelled.length > 0 ? cancelled[cancelled.length - 1]! : null,
      new_challenge_id: created.challenge_id,
      report,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("internal", `Reset could not ${step}: ${message}`.slice(0, 300), "Run the reset again; every step is safe to repeat.");
  }
}

/** Implements U3's `stage.reset` (KTD22). */
export async function resetStage(db: Db, input: ResetStageInput): Promise<ResetStageResult> {
  const result = await resetStageDetailed(db, input);
  if (!result.ok) return result;
  return { ok: true, cancelled_challenge_id: result.cancelled_challenge_id, new_challenge_id: result.new_challenge_id };
}

/** For the composition root: `provideServices({ stage: stageService })`. */
export const stageService = { reset: resetStage } satisfies LaneServices["stage"];
