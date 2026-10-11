import { z } from "zod";
import { ChallengeTypeSchema, FeaturesSchema, IdSchema, RuleRefSchema, ShortTextSchema } from "./common";
import { RuleActionSchema } from "./rule";

/** Proof states (High-Level Technical Design, "Proof states"). */
export const PROOF_STATUSES = [
  "received",
  "held",
  "rules",
  "ai_review",
  "accepted",
  "flagged_accept",
  "rejected",
  "not_counted",
] as const;
export const ProofStatusSchema = z.enum(PROOF_STATUSES);
export type ProofStatus = z.infer<typeof ProofStatusSchema>;

/** Statuses that count toward a day (KTD13). */
export const COUNTING_PROOF_STATUSES: readonly ProofStatus[] = ["accepted", "flagged_accept"];
/** Statuses that are not final yet. */
export const OPEN_PROOF_STATUSES: readonly ProofStatus[] = ["received", "held", "rules", "ai_review"];

export const HELD_REASONS = ["handle_unverified", "extra_proof", "surprise_check", "dispute"] as const;
export const HeldReasonSchema = z.enum(HELD_REASONS);
export type HeldReason = z.infer<typeof HeldReasonSchema>;

/** "not counted (unanswered)" is shown apart from "rejected" (KTD7). */
export const NOT_COUNTED_REASONS = ["unanswered", "removed", "surprise_check_expired", "unresolved_at_settlement"] as const;
export const NotCountedReasonSchema = z.enum(NOT_COUNTED_REASONS);
export type NotCountedReason = z.infer<typeof NotCountedReasonSchema>;

/** KTD14 trust levels. */
export const TRUST_LEVELS = ["rechecked", "agent_attested"] as const;
export const TrustLevelSchema = z.enum(TRUST_LEVELS);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

/** What decided a verdict, so the dashboard can show "no AI call" (KTD7). */
export const DECIDED_BY = [
  "schema",
  "authenticity",
  "rule",
  "ai",
  "referee_dispute",
  "final_check",
  "grace_expired",
  "surprise_check",
  "operator",
] as const;
export const DecidedBySchema = z.enum(DECIDED_BY);
export type DecidedBy = z.infer<typeof DecidedBySchema>;

export const VERDICT_OUTCOMES = ["accept", "reject", "ask_more", "flag", "pending"] as const;
export const VerdictOutcomeSchema = z.enum(VERDICT_OUTCOMES);
export type VerdictOutcome = z.infer<typeof VerdictOutcomeSchema>;

export const RuleMatchSchema = RuleRefSchema.extend({ action: RuleActionSchema });
export type RuleMatch = z.infer<typeof RuleMatchSchema>;

/** Verdict recorded on a proof (KTD7). */
export const VerdictSchema = z.object({
  outcome: VerdictOutcomeSchema,
  decided_by: DecidedBySchema,
  /** The decisive rule, when a rule decided. */
  rule: RuleRefSchema.nullable(),
  /** Every rule that matched, decisive or not. */
  matched_rules: z.array(RuleMatchSchema),
  /** Every rule key and version evaluated. */
  evaluated_rules: z.array(RuleRefSchema),
  contract_version: z.int().min(0),
  ai_calls: z.int().min(0),
  /** True when the AI reviewer decided; an AI rejection is labelled as an AI judgment. */
  ai_judgment: z.boolean(),
  latency_ms: z.int().min(0),
  trust_level: TrustLevelSchema,
  /** A hold_payout match accepts the proof and holds the payout (KTD7, KTD12). */
  payout_hold: z.boolean(),
  /** Lane-rendered reason, or the AI's reason for non-customers packs. Capped. */
  reason: ShortTextSchema,
  /** How to fix (R19). */
  fix: ShortTextSchema,
  cheat_class: z.string().max(48).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  /** GitHub push-event time, information only (KTD14). */
  push_event_time: z.date().nullable().default(null),
  decided_at: z.date(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const ProofHistoryEntrySchema = z.object({
  at: z.date(),
  from: ProofStatusSchema.nullable(),
  to: ProofStatusSchema,
  by: DecidedBySchema.or(z.literal("system")),
  note: z.string().max(200).nullable().default(null),
});
export type ProofHistoryEntry = z.infer<typeof ProofHistoryEntrySchema>;

/**
 * `proofs` collection. Written by U5 (and status changes by U18's tick, disputes and U16's final check).
 * Unique on (challenge_id, player_id, source_key), and on (challenge_id, source_key) where claimed is true (KTD6).
 */
export const ProofSchema = z.object({
  _id: IdSchema,
  challenge_id: IdSchema,
  player_id: IdSchema,
  challenge_type: ChallengeTypeSchema,
  /** Pack's canonical source key: full 40-char lowercase SHA, platform:post id, or calendar event id. */
  source_key: z.string().min(1).max(200),
  /** True only after authenticity passes (KTD6). */
  claimed: z.boolean(),
  /** Minimal payload after the pack's proof-schema parse (KTD15). Never projected. */
  payload: z.record(z.string(), z.unknown()),
  /** Features from the pack extractor. Never projected for Talk to Customers. */
  features: FeaturesSchema.nullable(),
  /** Null until known (for example before the re-check returns the commit date). */
  source_time: z.date().nullable(),
  /** From the source time on the challenge clock (KTD13). Null until the source time is known. */
  day_index: z.int().min(0).nullable(),
  status: ProofStatusSchema,
  held_reason: HeldReasonSchema.nullable(),
  not_counted_reason: NotCountedReasonSchema.nullable(),
  verdict: VerdictSchema.nullable(),
  /** Inbox item this proof answers (extra proof, surprise check), if any. */
  answers_request_id: IdSchema.nullable().default(null),
  history: z.array(ProofHistoryEntrySchema),
  received_at: z.date(),
  updated_at: z.date(),
});
export type Proof = z.infer<typeof ProofSchema>;
