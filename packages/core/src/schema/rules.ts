import { z } from "zod";
import { ChallengeTypeSchema, IdSchema, ShortTextSchema } from "./common";
import {
  FeatureNameSchema,
  RuleActionSchema,
  RuleEvidenceSchema,
  RuleKeySchema,
  RuleSourceSchema,
  RuleStatusSchema,
  WhenSchema,
} from "./rule";

/** KTD9 thresholds, copied from `settings` onto each gate result so it is self-describing. */
export const GateThresholdsSchema = z.object({
  /** Minimum rise in target-class catch rate, as a fraction (0.10 = 10 points). */
  min_catch_gain: z.number().min(0).max(1),
  /** Max false-alarm rate on honest examples for the candidate alone. */
  max_false_alarm_rule: z.number().min(0).max(1),
  /** Max false-alarm rate on honest examples for the active set plus the candidate. */
  max_false_alarm_set: z.number().min(0).max(1),
  /** Max drop in catch rate for any other cheat class, as a fraction. */
  max_other_class_drop: z.number().min(0).max(1),
});
export type GateThresholds = z.infer<typeof GateThresholdsSchema>;

/** Test-gate result stored on a candidate (R21, R23). Rates are fractions from 0 to 1. */
export const GateResultSchema = z.object({
  passed: z.boolean(),
  target_class: FeatureNameSchema,
  catch_rate_before: z.number().min(0).max(1),
  catch_rate_after: z.number().min(0).max(1),
  per_class_before: z.record(z.string(), z.number().min(0).max(1)),
  per_class_after: z.record(z.string(), z.number().min(0).max(1)),
  false_alarm_rule: z.number().min(0).max(1),
  false_alarm_set: z.number().min(0).max(1),
  bound_violations: z.array(z.string()),
  honest_count: z.int().min(0),
  cheat_count: z.int().min(0),
  thresholds: GateThresholdsSchema,
  /** Lane-rendered reasons for a failure, for example "false alarms 3.0% > 1.0%". */
  reasons: z.array(z.string().max(200)),
  tested_at: z.date(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

/**
 * `rules` collection. Written by U9 only. Each version is its own document.
 * Unique: one active version per (challenge_type, rule_key); one document per (challenge_type, rule_key, version).
 */
export const RuleSchema = z.object({
  _id: IdSchema,
  rule_key: RuleKeySchema,
  version: z.int().min(1),
  parent_version: z.int().min(1).nullable(),
  challenge_type: ChallengeTypeSchema,
  when: WhenSchema,
  action: RuleActionSchema,
  cheat_class: FeatureNameSchema.nullable(),
  /** Rule-writer's reason. Never rendered to players or projected (KTD15). */
  reason: ShortTextSchema,
  source: RuleSourceSchema,
  evidence: RuleEvidenceSchema,
  status: RuleStatusSchema,
  test_results: GateResultSchema.nullable(),
  approval_id: IdSchema.nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  activated_at: z.date().nullable(),
  retired_at: z.date().nullable(),
});
export type Rule = z.infer<typeof RuleSchema>;
