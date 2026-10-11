import type { Db, Filter } from "mongodb";
import { services } from "../interfaces";
import type { Challenge } from "../schema/challenges";
import type { ChallengeType } from "../schema/common";
import type { AnyPack } from "../schema/pack";
import { getPack as registryGetPack } from "../packs/index";
import { collections } from "../schema/collections";
import type { InboxItem } from "../schema/inbox";
import type { Proof, Verdict } from "../schema/proofs";
import { graceDeadline } from "../clock";
import { cap, historyEntry, newCode, writeProofEvent } from "./state";

/**
 * Extra-proof requests (U5 approach step 4, R17, KTD6, KTD7). Requests are written only through
 * the U18 inbox interface; this module reads the inbox collection to find a request by id.
 */

/** Held reasons an extra-proof answer can resolve: a referee or rule ask, or a dispute ask (U18). */
const ANSWERABLE_HELD_REASONS = ["extra_proof", "dispute"] as const;

export function extraProofInstruction(extraProofLines: readonly string[] | undefined, code: string): string {
  const how = extraProofLines?.[0] ?? "Send extra proof that includes the code below.";
  return cap(
    `Lane needs extra proof before this proof counts. ${how} Use the one-time code ${code}. ` +
      "Then call lane_submit_proof with this action's request id and the new proof.",
    600,
  );
}

/**
 * Open one extra-proof request for a held proof, due when the challenge's grace period ends.
 * The inbox's unique index keeps at most one open request per proof (KTD6).
 */
export async function openExtraProofRequest(
  db: Db,
  input: { proof: Proof; challenge: Challenge; extraProofLines?: readonly string[]; now: Date },
): Promise<InboxItem | null> {
  const clock = input.challenge.clock;
  if (!clock) return null;
  const code = newCode();
  const { item } = await services().inbox.add(
    db,
    {
      player_id: input.proof.player_id,
      challenge_id: input.proof.challenge_id,
      kind: "extra_proof",
      actor: "player",
      instruction: extraProofInstruction(input.extraProofLines, code),
      answer_tool: "lane_submit_proof",
      answer_args: { challenge_id: input.proof.challenge_id },
      day_index: input.proof.day_index,
      subject_proof_id: input.proof._id,
      slot: null,
      code,
      release_at: null,
      due_at: graceDeadline(clock, input.now),
      status: "open",
    },
    { now: input.now },
  );
  return item;
}

export async function loadRequest(db: Db, requestId: string): Promise<InboxItem | null> {
  return collections(db).inbox.findOne({ _id: requestId });
}

/**
 * Only the player who owns the subject proof or the surprise-check slot may answer (U5, U18).
 * Both the item's player and the subject proof's player must be the caller.
 */
export function ownsRequest(item: InboxItem, subject: Proof | null, playerId: string): boolean {
  if (item.player_id !== playerId) return false;
  if (item.subject_proof_id !== null && (!subject || subject.player_id !== playerId)) return false;
  return true;
}

/** A literal, case-insensitive search for the one-time code in the answer's texts. */
export function answerHasCode(code: string | null, texts: readonly (string | null | undefined)[]): boolean {
  if (!code) return true;
  const needle = code.toLowerCase();
  return texts.some((t) => typeof t === "string" && t.toLowerCase().includes(needle));
}

function heldFilter(proofId: string): Filter<Proof> {
  return { _id: proofId, status: "held", held_reason: { $in: [...ANSWERABLE_HELD_REASONS] } };
}

/** Proof states: held to accepted when the extra proof is answered within grace. */
export async function acceptAnsweredProof(
  db: Db,
  proof: Proof,
  opts: { now: Date; packTitle: string },
): Promise<Proof | null> {
  const verdict: Verdict | null = proof.verdict
    ? {
        ...proof.verdict,
        outcome: "accept",
        reason: "Extra proof received within the grace period.",
        fix: "",
        decided_at: opts.now,
      }
    : null;
  const updated = await collections(db).proofs.findOneAndUpdate(
    heldFilter(proof._id),
    {
      $set: { status: "accepted", held_reason: null, verdict, updated_at: opts.now },
      $push: { history: historyEntry(opts.now, "held", "accepted", verdict?.decided_by ?? "system", "extra proof answered") },
    },
    { returnDocument: "after" },
  );
  if (updated) await writeProofEvent(db, "proof.verdict", updated, { packTitle: opts.packTitle, at: opts.now });
  return updated;
}

/**
 * Proof states: held to not counted when the grace period expired (KTD7). The dashboard shows
 * "not counted (unanswered)" apart from "rejected". A conditional update, so a late tick or a
 * late answer changes nothing twice.
 */
export async function markUnanswered(
  db: Db,
  proofId: string,
  opts: { now: Date; packTitle: string },
): Promise<Proof | null> {
  const current = await collections(db).proofs.findOne(heldFilter(proofId));
  if (!current) return null;
  const verdict: Verdict | null = current.verdict
    ? {
        ...current.verdict,
        outcome: "reject",
        decided_by: "grace_expired",
        reason: "Not counted (unanswered): the extra-proof request expired before an answer arrived.",
        fix: "Answer extra-proof requests before their grace period ends.",
        decided_at: opts.now,
      }
    : null;
  const updated = await collections(db).proofs.findOneAndUpdate(
    heldFilter(proofId),
    {
      $set: { status: "not_counted", not_counted_reason: "unanswered", held_reason: null, verdict, updated_at: opts.now },
      $push: { history: historyEntry(opts.now, "held", "not_counted", "grace_expired", "extra-proof request unanswered") },
    },
    { returnDocument: "after" },
  );
  if (updated) await writeProofEvent(db, "proof.not_counted", updated, { packTitle: opts.packTitle, at: opts.now });
  return updated;
}

/**
 * For U18's tick: expire open extra-proof requests past their due time through the inbox
 * interface, and mark each subject proof not counted (unanswered). Safe to run concurrently.
 */
export async function expireUnansweredRequests(
  db: Db,
  input: { now: Date; challenge_id?: string; getPack?: (type: ChallengeType) => AnyPack },
): Promise<{ expired: number; not_counted: string[] }> {
  const filter: Filter<InboxItem> = { kind: "extra_proof", status: "open", due_at: { $lte: input.now } };
  if (input.challenge_id) filter.challenge_id = input.challenge_id;
  const due = await collections(db).inbox.find(filter, { projection: { _id: 1, subject_proof_id: 1 } }).toArray();
  if (due.length === 0) return { expired: 0, not_counted: [] };
  const { expired } = await services().inbox.expire(db, { now: input.now, item_ids: due.map((d) => d._id) });
  const notCounted: string[] = [];
  for (const item of due) {
    if (!item.subject_proof_id) continue;
    const proof = await collections(db).proofs.findOne({ _id: item.subject_proof_id });
    if (!proof) continue;
    const title = (input.getPack ?? registryGetPack)(proof.challenge_type).title;
    const updated = await markUnanswered(db, proof._id, { now: input.now, packTitle: title });
    if (updated) notCounted.push(updated._id);
  }
  return { expired: expired.length, not_counted: notCounted };
}
