import type { Db } from "mongodb";
import { fail, newId } from "./schema/common";
import { collections, isDuplicateKeyError } from "./schema/collections";
import type { Challenge } from "./schema/challenges";
import type { Dispute } from "./schema/disputes";
import type { Proof, Verdict } from "./schema/proofs";
import type { AnyPack } from "./schema/pack";
import { quote, RefereeDisputeOutputSchema, type RefereeDisputeInput, type RefereeDisputeOutput } from "./schema/agents";
import {
  NotImplementedError,
  services,
  type DisputeInput,
  type DisputeResult,
  type LaneServices,
} from "./interfaces";
import { readSettings } from "./config";
import { currentDayIndex, dayStart, graceDeadline, isWindowClosed } from "./clock";
import { queueJob } from "./jobs";
import { writeEvent } from "./events";
import { getPack } from "./packs/index";
import { addInboxItem } from "./inbox";

/**
 * Disputes (U18, R26, F5). A player disputes another player's proof through their Muse.
 * - Accepted only from a member of the proof's challenge, within the `settings` cap per day,
 *   before the window closes, and never on the disputer's own proof.
 * - The referee triages the proof and the reason, both as quoted data (KTD18).
 * - Only ask_more or reject touches the proof: ask_more holds it and opens (or joins) the one
 *   extra-proof request; reject rejects it with a Lane-rendered verdict. Unfounded changes nothing.
 * - The dispute reason is never forwarded to the disputed player (KTD15): every line they see is
 *   rendered by Lane from the contract and the pack, never from the reason or the referee's text.
 * - Every dispute queues a learning job (R20).
 */

export const DISPUTE_REASON_CAP = 500;

export interface DisputeOptions {
  /** Test seam: resolve a pack other than the registry's. */
  packFor?: (type: Challenge["type"]) => AnyPack;
}

function oneTimeCode(): string {
  const n = globalThis.crypto.getRandomValues(new Uint32Array(1))[0]! % 9000;
  return String(1000 + n);
}

/** Lane-rendered line for a cheat class, from the pack's "does not count" templates (KTD15). */
function cheatLine(pack: AnyPack, cheatClass: string | null): string | null {
  if (!cheatClass || !pack.cheatClasses.includes(cheatClass)) return null;
  const template = pack.contract.doesNotCount[cheatClass];
  if (!template) return null;
  try {
    return template({ feature: cheatClass, op: "eq", value: true });
  } catch {
    return null;
  }
}

async function queueDisputeLearning(db: Db, proof: Proof, dispute: Dispute, cheatClass: string | null, now: Date): Promise<void> {
  try {
    await services().learning.fromSource(db, {
      challenge_type: proof.challenge_type,
      source: "dispute",
      cheat_class: cheatClass,
      proof_id: proof._id,
      dispute_id: dispute._id,
      now,
    });
  } catch (err) {
    if (!(err instanceof NotImplementedError)) throw err;
    // U9 not wired yet: queue the learning job directly so the evidence is not lost.
    await queueJob(
      db,
      {
        kind: "learning",
        dedup_key: `dispute:${dispute._id}`,
        payload: {
          source: "dispute",
          challenge_type: proof.challenge_type,
          cheat_class: cheatClass,
          proof_id: proof._id,
          dispute_id: dispute._id,
        },
      },
      { now },
    );
  }
}

async function triage(
  db: Db,
  challenge: Challenge,
  proof: Proof,
  dispute: Dispute,
  pack: AnyPack,
): Promise<{ output: RefereeDisputeOutput; latency_ms: number } | null> {
  const contract = await collections(db).contracts.findOne({ challenge_id: challenge._id }, { sort: { version: -1 } });
  const input: RefereeDisputeInput = {
    mode: "dispute",
    challenge_type: challenge.type,
    contract_version: contract?.version ?? challenge.contract_version,
    does_not_count: contract?.does_not_count.map((l) => l.line) ?? [],
    cheat_classes: [...pack.cheatClasses],
    features: proof.features ?? {},
    trust_level: proof.verdict?.trust_level ?? "agent_attested",
    proof: quote(JSON.stringify(proof.payload)),
    source_text: null,
    source_diff: null,
    current_status: proof.status,
    dispute_reason: quote(dispute.reason, DISPUTE_REASON_CAP),
  };
  try {
    const res = await services().agents.invoke({
      workspace: "referee",
      mode: "dispute",
      input,
      meta: { challenge_id: challenge._id, player_id: dispute.disputer_id, proof_id: proof._id, event_id: dispute._id },
    });
    if (!res.ok || res.status !== "completed") return null;
    const parsed = RefereeDisputeOutputSchema.safeParse(res.output);
    return parsed.success ? { output: parsed.data, latency_ms: res.latency_ms } : null;
  } catch (err) {
    if (err instanceof NotImplementedError) return null;
    throw err;
  }
}

async function applyAskMore(
  db: Db,
  challenge: Challenge,
  proof: Proof,
  dispute: Dispute,
  now: Date,
): Promise<void> {
  const col = collections(db);
  for (const from of ["accepted", "flagged_accept"] as const) {
    await col.proofs.updateOne(
      { _id: proof._id, status: from },
      {
        $set: { status: "held", held_reason: "dispute", updated_at: now },
        $push: { history: { at: now, from, to: "held", by: "referee_dispute", note: "dispute triaged as ask_more" } },
      },
    );
  }
  const contract = await col.contracts.findOne({ challenge_id: challenge._id }, { sort: { version: -1 } });
  const extra = contract?.fields.extra_proof[0] ?? "fresh proof for this day";
  const code = oneTimeCode();
  const day = proof.day_index !== null ? ` for day ${proof.day_index + 1}` : "";
  await addInboxItem(
    db,
    {
      player_id: proof.player_id,
      challenge_id: challenge._id,
      kind: "extra_proof",
      actor: "player",
      instruction: (
        `The referees need extra proof${day} before it counts. Ask the player for: ${extra} ` +
        `Use the code ${code}, then send it with lane_submit_proof and this request id.`
      ).slice(0, 600),
      answer_tool: "lane_submit_proof",
      answer_args: { challenge_id: challenge._id },
      day_index: proof.day_index,
      subject_proof_id: proof._id,
      slot: null,
      code,
      release_at: null,
      due_at: challenge.clock ? graceDeadline(challenge.clock, now) : null,
      notify_player_ids: [dispute.disputer_id],
    },
    { now },
  );
}

async function applyReject(
  db: Db,
  challenge: Challenge,
  proof: Proof,
  pack: AnyPack,
  output: RefereeDisputeOutput,
  latency_ms: number,
  now: Date,
): Promise<void> {
  const line = cheatLine(pack, output.cheat_class);
  const verdict: Verdict = {
    outcome: "reject",
    decided_by: "referee_dispute",
    rule: null,
    matched_rules: [],
    evaluated_rules: [],
    contract_version: challenge.contract_version,
    ai_calls: 1,
    ai_judgment: true,
    latency_ms: Math.max(0, Math.round(latency_ms)),
    trust_level: proof.verdict?.trust_level ?? "agent_attested",
    payout_hold: false,
    reason: line
      ? `AI judgment after a dispute: this does not count because ${line}.`
      : "AI judgment after a dispute: the referees found this proof does not meet the contract.",
    fix: "Send a different proof for this day that meets the contract.",
    cheat_class: output.cheat_class && pack.cheatClasses.includes(output.cheat_class) ? output.cheat_class : null,
    confidence: output.confidence,
    push_event_time: null,
    decided_at: now,
  };
  for (const from of ["accepted", "flagged_accept", "held"] as const) {
    await collections(db).proofs.updateOne(
      { _id: proof._id, status: from },
      {
        $set: { status: "rejected", held_reason: null, verdict, updated_at: now },
        $push: { history: { at: now, from, to: "rejected", by: "referee_dispute", note: "dispute upheld" } },
      },
    );
  }
}

export async function fileDispute(db: Db, input: DisputeInput, opts: DisputeOptions = {}): Promise<DisputeResult> {
  const now = input.now ?? new Date();
  const col = collections(db);
  const reason = input.reason.trim().slice(0, DISPUTE_REASON_CAP);
  if (!reason) {
    return fail("invalid_input", "A dispute needs a reason.", "Call lane_dispute again with a short reason.");
  }
  const proof = await col.proofs.findOne({ _id: input.proof_id });
  if (!proof) {
    return fail("not_found", "Lane has no proof with that id.", "Call lane_check_in and pick a proof id from the feed.");
  }
  const challenge = await col.challenges.findOne({ _id: proof.challenge_id });
  const member = challenge
    ? await col.memberships.findOne({ challenge_id: challenge._id, player_id: input.player_id }, { projection: { _id: 1 } })
    : null;
  if (!challenge || !member) {
    return fail(
      "not_member",
      "Only players in this challenge can dispute its proofs.",
      "Dispute proofs only from challenges listed in your own check-in.",
    );
  }
  if (proof.player_id === input.player_id) {
    return fail("not_allowed", "You cannot dispute your own proof.", "Dispute another player's proof from your check-in feed.");
  }
  if (challenge.status !== "active" || !challenge.clock || isWindowClosed(challenge.clock, now)) {
    return fail("window_closed", "This challenge's window has closed, so disputes are over.", "Call lane_check_in for the results.");
  }

  const existing = await col.disputes.findOne({ proof_id: proof._id, disputer_id: input.player_id });
  if (existing) return { ok: true, dispute: existing, created: false };

  const dayIndex = currentDayIndex(challenge.clock, now) ?? 0;
  const settings = await readSettings(db);
  const filedToday = await col.disputes.countDocuments({
    challenge_id: challenge._id,
    disputer_id: input.player_id,
    day_index: dayIndex,
  });
  if (filedToday >= settings.dispute_cap_per_day) {
    const nextDay = dayStart(challenge.clock, dayIndex + 1).toISOString();
    return fail(
      "dispute_cap",
      `You can file ${settings.dispute_cap_per_day} disputes a day in this challenge, and you have used them.`,
      `Try again when the next challenge day starts at ${nextDay}.`,
    );
  }

  const dispute: Dispute = {
    _id: newId("dispute"),
    challenge_id: challenge._id,
    proof_id: proof._id,
    disputer_id: input.player_id,
    disputed_player_id: proof.player_id,
    reason,
    day_index: dayIndex,
    outcome: "pending",
    referee: null,
    created_at: now,
    decided_at: null,
  };
  try {
    await col.disputes.insertOne(dispute);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const raced = await col.disputes.findOne({ proof_id: proof._id, disputer_id: input.player_id });
    if (!raced) throw err;
    return { ok: true, dispute: raced, created: false };
  }
  await writeEvent(db, {
    kind: "dispute.filed",
    summary: "A player disputed a proof; the referees are triaging it.",
    challenge_id: challenge._id,
    challenge_type: challenge.type,
    player_id: input.player_id,
    proof_id: proof._id,
    data: { dispute_id: dispute._id },
    at: now,
  });

  const pack = (opts.packFor ?? getPack)(challenge.type);
  const triaged = await triage(db, challenge, proof, dispute, pack);
  let decided: Dispute = dispute;
  if (triaged) {
    const { output, latency_ms } = triaged;
    if (output.outcome === "ask_more") await applyAskMore(db, challenge, proof, dispute, now);
    if (output.outcome === "reject") await applyReject(db, challenge, proof, pack, output, latency_ms, now);
    const updated = await col.disputes.findOneAndUpdate(
      { _id: dispute._id, outcome: "pending" },
      {
        $set: {
          outcome: output.outcome,
          referee: {
            reason: output.reason.slice(0, 500),
            cheat_class: output.cheat_class,
            confidence: output.confidence,
          },
          decided_at: now,
        },
      },
      { returnDocument: "after" },
    );
    decided = updated ?? dispute;
    await writeEvent(db, {
      kind: "dispute.decided",
      summary: `The referees triaged a dispute as ${output.outcome.replace("_", " ")}.`,
      challenge_id: challenge._id,
      challenge_type: challenge.type,
      proof_id: proof._id,
      data: { dispute_id: dispute._id, outcome: output.outcome, cheat_class: output.cheat_class },
      at: now,
    });
  }
  await queueDisputeLearning(db, proof, decided, triaged?.output.cheat_class ?? null, now);
  return { ok: true, dispute: decided, created: true };
}

/** The U18 disputes service, in the shape of `LaneServices["disputes"]`. */
export const disputesService = {
  dispute: (db: Db, input: DisputeInput) => fileDispute(db, input),
} satisfies LaneServices["disputes"];
