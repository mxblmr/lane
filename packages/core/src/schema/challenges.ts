import { z } from "zod";
import { ChallengeTypeSchema, IdSchema, ParamsSchema, ShortTextSchema } from "./common";

export const CHALLENGE_STATUSES = ["draft", "active", "settling", "settled", "cancelled"] as const;
export const ChallengeStatusSchema = z.enum(CHALLENGE_STATUSES);
export type ChallengeStatus = z.infer<typeof ChallengeStatusSchema>;

/** R6: highest verified score takes the pot (ties split), or everyone who reached the goal splits it. */
export const WINNER_RULES = ["top_score", "finishers_split"] as const;
export const WinnerRuleSchema = z.enum(WINNER_RULES);
export type WinnerRule = z.infer<typeof WinnerRuleSchema>;

export const SCORE_UNITS = ["days", "conversations"] as const;
export const ScoreUnitSchema = z.enum(SCORE_UNITS);
export type ScoreUnit = z.infer<typeof ScoreUnitSchema>;

/**
 * Per-challenge clock settings (KTD13). Day `i` covers real time
 * `[start_at + (i - offset_days) * day_length, start_at + (i - offset_days + 1) * day_length)`.
 * The operator advances a challenge by incrementing `offset_days`.
 */
export const ClockSettingsSchema = z.object({
  mode: z.enum(["real", "demo"]),
  start_at: z.date(),
  day_length_sec: z.int().min(10),
  /** Window length in days. Day indexes run from 0 to days - 1. */
  days: z.int().min(1).max(60),
  grace_sec: z.int().min(0),
  offset_days: z.int().min(0),
});
export type ClockSettings = z.infer<typeof ClockSettingsSchema>;

export const PlayerScoreSchema = z.object({
  player_id: IdSchema,
  score: z.int().min(0),
  reached_goal: z.boolean(),
  /** When the player's final counted score was reached; breaks remainder ties (KTD12). */
  final_counted_at: z.date().nullable(),
});
export type PlayerScore = z.infer<typeof PlayerScoreSchema>;

export const ShareSchema = z.object({ player_id: IdSchema, amount: z.int().min(0) });
export type Share = z.infer<typeof ShareSchema>;

/** Results snapshot stored on the challenge and bound by a payout approval (KTD12). */
export const SettlementSnapshotSchema = z.object({
  snapshot_id: IdSchema,
  computed_at: z.date(),
  winner_rule: WinnerRuleSchema,
  unit: ScoreUnitSchema,
  goal: z.int().min(1),
  pot: z.int().min(0),
  scores: z.array(PlayerScoreSchema),
  shares: z.array(ShareSchema),
  refunds: z.array(ShareSchema),
  refund_all: z.boolean(),
  needs_approval: z.boolean(),
  approval_reasons: z.array(z.enum(["over_limit", "payout_hold", "operator"])),
  approval_id: IdSchema.nullable(),
  orchestrator: z.enum(["agreed", "disagreed", "error", "skipped"]),
});
export type SettlementSnapshot = z.infer<typeof SettlementSnapshotSchema>;

export const DraftInfoSchema = z.object({
  /** The creator's sentence, stored capped and only ever sent to agents as quoted data (KTD18). */
  sentence: ShortTextSchema,
  question: ShortTextSchema.nullable(),
  missing_fields: z.array(z.string()),
});
export type DraftInfo = z.infer<typeof DraftInfoSchema>;

/**
 * `challenges` collection. Written by U6 (draft, confirm), the U18 tick (status, clock)
 * and U11 (settlement snapshot).
 * `join_code` is omitted (never null) until confirmation; the unique index is partial on string type.
 */
export const ChallengeSchema = z
  .object({
    _id: IdSchema,
    type: ChallengeTypeSchema,
    status: ChallengeStatusSchema,
    title: z.string().min(1).max(80),
    creator_id: IdSchema,
    join_code: z
      .string()
      .regex(/^[A-Z0-9]{6}$/)
      .optional(),
    stake: z.int().min(1).nullable(),
    winner_rule: WinnerRuleSchema.nullable(),
    /** Goal in the pack's score unit, for example 5 days or 10 conversations. */
    goal: z.int().min(1).nullable(),
    /** Typed contract parameters filled by the orchestrator and validated by the pack template. */
    params: ParamsSchema,
    draft: DraftInfoSchema.nullable(),
    clock: ClockSettingsSchema.nullable(),
    /** Counter incremented to allocate contract versions (KTD10). 0 before the first contract. */
    contract_version: z.int().min(0),
    settlement: SettlementSnapshotSchema.nullable(),
    /** True for the demo stage challenge that reset replaces (KTD22). */
    stage: z.boolean().default(false),
    created_at: z.date(),
    updated_at: z.date(),
    activated_at: z.date().nullable().default(null),
    closed_at: z.date().nullable().default(null),
  })
  .superRefine((c, ctx) => {
    if (c.status !== "draft") {
      for (const key of ["stake", "winner_rule", "goal", "clock"] as const) {
        if (c[key] === null) {
          ctx.addIssue({ code: "custom", path: [key], message: `${key} is required once a challenge is confirmed` });
        }
      }
      if (!c.join_code) {
        ctx.addIssue({ code: "custom", path: ["join_code"], message: "join_code is required once a challenge is confirmed" });
      }
    }
  });
export type Challenge = z.infer<typeof ChallengeSchema>;
