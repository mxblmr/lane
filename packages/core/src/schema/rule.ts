import { z } from "zod";
import { ChallengeTypeSchema, IdSchema, ShortTextSchema } from "./common";

/**
 * Rule grammar (High-Level Technical Design, KTD8).
 *
 * rule   := { rule_key, version, parent_version, challenge_type, when, action, reason, source, evidence }
 * when   := { all: [cond...] } | { any: [cond...] }
 * cond   := { feature, op, value }
 * op     := eq | lt | lte | gt | gte | in | matches
 * action := flag | ask_more | reject | hold_payout
 *
 * Schema validation here is structural. U4's `rules/grammar.ts` additionally checks the
 * feature against the pack's catalog and the value against the feature's hard bound.
 */

export const OPS = ["eq", "lt", "lte", "gt", "gte", "in", "matches"] as const;
export const OpSchema = z.enum(OPS);
export type Op = z.infer<typeof OpSchema>;

/** Evaluation order is fixed: reject, hold_payout, ask_more, flag (U4). */
export const RULE_ACTIONS = ["reject", "hold_payout", "ask_more", "flag"] as const;
export const RuleActionSchema = z.enum(RULE_ACTIONS);
export type RuleAction = z.infer<typeof RuleActionSchema>;

/** Actions that need human approval before activation (R22). */
export const APPROVAL_ACTIONS: readonly RuleAction[] = ["reject", "hold_payout"];
export function actionNeedsApproval(action: RuleAction): boolean {
  return APPROVAL_ACTIONS.includes(action);
}

export const RULE_SOURCES = ["seed", "dispute", "ai_judgment", "live_cheat", "red_team"] as const;
export const RuleSourceSchema = z.enum(RULE_SOURCES);
export type RuleSource = z.infer<typeof RuleSourceSchema>;

export const RULE_STATUSES = [
  "candidate",
  "pending_approval",
  "active",
  "rejected",
  "superseded",
  "retired",
  "rolled_back",
] as const;
export const RuleStatusSchema = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

export const FEATURE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
export const FeatureNameSchema = z.string().regex(FEATURE_NAME_PATTERN);

/** `matches` is a literal, case-insensitive substring test: at most 40 letters, digits, spaces or hyphens. */
export const MATCHES_VALUE_PATTERN = /^[A-Za-z0-9 -]{1,40}$/;

export const CondValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string().max(40),
  z.array(z.union([z.string().max(40), z.number()])).max(20),
]);

export const CondSchema = z
  .strictObject({
    feature: FeatureNameSchema,
    op: OpSchema,
    value: CondValueSchema,
  })
  .superRefine((c, ctx) => {
    const v = c.value;
    switch (c.op) {
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          ctx.addIssue({ code: "custom", path: ["value"], message: `${c.op} needs a finite number` });
        }
        break;
      case "in":
        if (!Array.isArray(v) || v.length === 0) {
          ctx.addIssue({ code: "custom", path: ["value"], message: "in needs a non-empty list" });
        }
        break;
      case "matches":
        if (typeof v !== "string" || !MATCHES_VALUE_PATTERN.test(v)) {
          ctx.addIssue({
            code: "custom",
            path: ["value"],
            message: "matches needs a literal of at most 40 letters, digits, spaces or hyphens",
          });
        }
        break;
      case "eq":
        if (Array.isArray(v)) {
          ctx.addIssue({ code: "custom", path: ["value"], message: "eq needs a single value" });
        }
        break;
    }
  });
export type Cond = z.infer<typeof CondSchema>;

export const WhenSchema = z.union([
  z.strictObject({ all: z.array(CondSchema).min(1).max(8) }),
  z.strictObject({ any: z.array(CondSchema).min(1).max(8) }),
]);
export type When = z.infer<typeof WhenSchema>;

export function whenConds(when: When): Cond[] {
  return "all" in when ? when.all : when.any;
}

export const RULE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const RuleKeySchema = z.string().regex(RULE_KEY_PATTERN);

export const RuleEvidenceSchema = z.object({
  proof_ids: z.array(IdSchema).default([]),
  example_keys: z.array(z.string()).default([]),
  dispute_ids: z.array(IdSchema).default([]),
});
export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

/** What the rule-writer proposes (rule-lab's propose call). Lane assigns key, version and status. */
export const RuleProposalSchema = z.object({
  challenge_type: ChallengeTypeSchema,
  /** Set to change an existing rule; omitted for a brand-new key. */
  parent: z.object({ rule_key: RuleKeySchema, version: z.int().min(1) }).nullable(),
  /** New key when `parent` is null. */
  rule_key: RuleKeySchema.optional(),
  when: WhenSchema,
  action: RuleActionSchema,
  /** The cheat class this rule targets. Cheat class ids match feature names. */
  cheat_class: FeatureNameSchema,
  /** Rule-writer's reason. Never rendered to players (KTD15). */
  reason: ShortTextSchema,
  source: RuleSourceSchema,
  evidence: RuleEvidenceSchema,
});
export type RuleProposal = z.infer<typeof RuleProposalSchema>;
