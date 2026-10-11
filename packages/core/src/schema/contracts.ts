import { z } from "zod";
import { ChallengeTypeSchema, IdSchema, LineSchema, ParamsSchema, RuleRefSchema } from "./common";
import { ScoreUnitSchema, WinnerRuleSchema } from "./challenges";

export const QuietHoursSchema = z.object({
  /** Local wall-clock "HH:MM" in the player's time zone. */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const CheckInTermsSchema = z.object({
  interval_min: z.int().min(1),
  surprise_checks_per_day: z.int().min(0),
  quiet_hours: QuietHoursSchema,
  grace_sec: z.int().min(0),
});
export type CheckInTerms = z.infer<typeof CheckInTermsSchema>;

/** R8: what Muse must fetch and send, scoring, what does not count, extra proof, window and check-in terms. */
export const ContractFieldsSchema = z.object({
  challenge_type: ChallengeTypeSchema,
  title: z.string().min(1).max(80),
  goal: z.int().min(1),
  score_unit: ScoreUnitSchema,
  window: z.object({
    start_at: z.date(),
    end_at: z.date(),
    days: z.int().min(1),
    day_length_sec: z.int().min(10),
  }),
  stake: z.int().min(1),
  winner_rule: WinnerRuleSchema,
  /** Always "play credits (no real money)" (R7). */
  credit_label: z.string(),
  checkin: CheckInTermsSchema,
  /** What Muse must fetch and send, rendered from the pack template. */
  send: z.array(LineSchema),
  scoring: LineSchema,
  extra_proof: z.array(LineSchema),
  params: ParamsSchema,
});
export type ContractFields = z.infer<typeof ContractFieldsSchema>;

/** A "does not count" line rendered from a rule's predicate by the pack template, never from the rule's reason (KTD15). */
export const DoesNotCountLineSchema = z.object({
  rule_key: z.string(),
  rule_version: z.int().min(1),
  line: LineSchema,
});
export type DoesNotCountLine = z.infer<typeof DoesNotCountLineSchema>;

/** `contracts` collection. Written by U6 only. Unique on challenge and version. */
export const ContractSchema = z.object({
  _id: IdSchema,
  challenge_id: IdSchema,
  version: z.int().min(1),
  fields: ContractFieldsSchema,
  /** Agent instructions come only from the pack template (KTD15). */
  agent_instructions: z.string().max(4000),
  does_not_count: z.array(DoesNotCountLineSchema),
  /** The active rule versions this contract was built from. */
  built_from_rules: z.array(RuleRefSchema),
  /** Why this version exists, for example "created", "rule_activated", "rule_rolled_back". */
  reason: z.string().max(64),
  /** Lane-rendered summary of what changed since the previous version, sent at check-in (R9). */
  changes: z.array(LineSchema),
  created_at: z.date(),
});
export type Contract = z.infer<typeof ContractSchema>;
