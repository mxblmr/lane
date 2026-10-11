import type { Db } from "mongodb";
import type { Contract } from "../schema/contracts";
import { collections } from "../schema/collections";
import type { DecidedBy, Proof, ProofHistoryEntry, ProofStatus } from "../schema/proofs";
import { OPEN_PROOF_STATUSES } from "../schema/proofs";
import type { SubmitProofOutcome } from "../interfaces";
import { writeEvent } from "../events";

/** Small helpers shared by the proof pipeline, authenticity and requests (U5). */

export function historyEntry(
  at: Date,
  from: ProofStatus | null,
  to: ProofStatus,
  by: DecidedBy | "system",
  note: string | null = null,
): ProofHistoryEntry {
  return { at, from, to, by, note: note === null ? null : note.slice(0, 200) };
}

/** The submit outcome a proof's status maps to. Open statuses read as pending, except held. */
export function outcomeOf(status: ProofStatus): SubmitProofOutcome {
  switch (status) {
    case "accepted":
    case "flagged_accept":
    case "rejected":
    case "held":
    case "not_counted":
      return status;
    default:
      return "pending";
  }
}

export function isFinalStatus(status: ProofStatus): boolean {
  return !OPEN_PROOF_STATUSES.includes(status);
}

export function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

/** "day 3" for day index 2. Players count days from 1. */
export function dayLabel(dayIndex: number | null): string {
  return dayIndex === null ? "its day" : `day ${dayIndex + 1}`;
}

/** The challenge's latest contract version, or null before the first one is published. */
export async function loadLatestContract(db: Db, challengeId: string): Promise<Contract | null> {
  return collections(db).contracts.findOne({ challenge_id: challengeId }, { sort: { version: -1 } });
}

/** A six-character one-time code for extra-proof requests (R17). */
export function newCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const STATUS_WORDS: Record<ProofStatus, string> = {
  received: "received",
  held: "held",
  rules: "checked against rules",
  ai_review: "sent to AI review",
  accepted: "accepted",
  flagged_accept: "accepted and flagged",
  rejected: "rejected",
  not_counted: "not counted",
};

function decidedPhrase(proof: Proof): string {
  const v = proof.verdict;
  if (!v) return "";
  if (v.decided_by === "rule" && v.rule) return ` by rule ${v.rule.rule_key} v${v.rule.version}, no AI call`;
  if (v.decided_by === "ai") return " by AI judgment";
  return ` (${v.decided_by.replace(/_/g, " ")})`;
}

/**
 * Write a proof event for the dashboard feed. The summary is Lane-rendered and `data` holds
 * ids, counts and pack features only, never player or model text (KTD15).
 */
export async function writeProofEvent(
  db: Db,
  kind: "proof.received" | "proof.verdict" | "proof.held" | "proof.not_counted",
  proof: Proof,
  opts: { packTitle: string; feedSummary?: string | null; at: Date },
): Promise<void> {
  const v = proof.verdict;
  await writeEvent(db, {
    kind,
    summary: cap(`${opts.packTitle} proof ${STATUS_WORDS[proof.status]}${decidedPhrase(proof)}`, 300),
    challenge_id: proof.challenge_id,
    challenge_type: proof.challenge_type,
    player_id: proof.player_id,
    proof_id: proof._id,
    rule_key: v?.rule?.rule_key ?? null,
    rule_version: v?.rule?.version ?? null,
    data: {
      status: proof.status,
      outcome: v?.outcome ?? null,
      decided_by: v?.decided_by ?? null,
      ai_calls: v?.ai_calls ?? 0,
      trust_level: v?.trust_level ?? null,
      payout_hold: v?.payout_hold ?? false,
      day_index: proof.day_index,
      held_reason: proof.held_reason,
      not_counted_reason: proof.not_counted_reason,
      feed_summary: opts.feedSummary ? cap(opts.feedSummary, 200) : null,
    },
    at: opts.at,
  });
}
