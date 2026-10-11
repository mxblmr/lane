// TEMPORARY: U3-owned types and schemas, held here only until U3 (shared
// schema, interfaces, pack registry) merges. Transcribed from the Lane MVP
// plan's High-Level Technical Design (rule grammar, rule lifecycle and data
// model). When U3 lands, delete this file and point the imports in
// grammar.ts, engine.ts and the rules tests at U3's `schema/` modules.
// Nothing outside packages/core/src/rules and packages/core/test/rules may
// import this file.

import { z } from "zod";

// Rule grammar vocabulary.

export const RULE_OPS = ["eq", "lt", "lte", "gt", "gte", "in", "matches"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const RULE_ACTIONS = ["flag", "ask_more", "reject", "hold_payout"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const RULE_SOURCES = ["seed", "dispute", "ai_judgment", "live_cheat", "red_team"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export const RULE_STATUSES = [
  "candidate",
  "pending_approval",
  "active",
  "rejected",
  "superseded",
  "retired",
  "rolled_back",
] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

// Proof features: the output of a pack's feature extractor, keyed by the
// feature names in that pack's catalog.

export const FeatureValueSchema = z.union([z.boolean(), z.number(), z.string()]);
export type FeatureValue = z.infer<typeof FeatureValueSchema>;
export type ProofFeatures = Readonly<Record<string, FeatureValue>>;

// Rule document (structure only; pack-specific checks live in grammar.ts).

export const RuleConditionSchema = z.strictObject({
  feature: z.string().min(1),
  op: z.enum(RULE_OPS),
  value: z.union([FeatureValueSchema, z.array(FeatureValueSchema)]),
});
export type RuleCondition = z.infer<typeof RuleConditionSchema>;

export const RuleWhenSchema = z.union([
  z.strictObject({ all: z.array(RuleConditionSchema).min(1) }),
  z.strictObject({ any: z.array(RuleConditionSchema).min(1) }),
]);
export type RuleWhen = z.infer<typeof RuleWhenSchema>;

export const RuleDefinitionSchema = z.object({
  rule_key: z.string().min(1).max(80),
  version: z.int().min(1),
  parent_version: z.int().min(1).nullable(),
  challenge_type: z.string().min(1),
  when: RuleWhenSchema,
  action: z.enum(RULE_ACTIONS),
  reason: z.string().min(1),
  source: z.enum(RULE_SOURCES),
  evidence: z.array(z.string()),
});
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

// Stored shape in the `rules` collection (data model: rule key, version,
// parent, challenge type, when, action, status, source, evidence, test
// results, approval id).
export interface RuleDocument extends RuleDefinition {
  status: RuleStatus;
  test_results?: Record<string, unknown>;
  approval_id?: string | null;
}

// Pack feature catalog with hard bounds. Each challenge pack owns its menu of
// features (KTD8); number features carry the hard bound every rule parameter
// must stay inside (for example, code_lines_changed never above 20).

export type FeatureType = "boolean" | "number" | "string";

export interface NumberBounds {
  min: number;
  max: number;
}

export type FeatureSpec =
  | { type: "boolean"; description?: string }
  | { type: "number"; bounds: NumberBounds; description?: string }
  | { type: "string"; description?: string };

export type FeatureCatalog = Readonly<Record<string, FeatureSpec>>;

export interface PackRuleCatalog {
  challenge_type: string;
  features: FeatureCatalog;
}

// Verdict result shapes for the rule step of the KTD7 pipeline. Outcome names
// follow the proof state diagram: rejected, held (ask_more), flagged_accept,
// accepted (hold_payout, with a payout hold), or no_decision (go to AI review).

export interface RuleRef {
  rule_key: string;
  version: number;
}

export interface RuleMatch extends RuleRef {
  action: RuleAction;
}

export type RuleOutcome = "rejected" | "held" | "flagged_accept" | "accepted" | "no_decision";

export interface RuleDecision {
  outcome: RuleOutcome;
  decided_by: RuleMatch | null;
  payout_hold: boolean;
  matches: RuleMatch[];
  evaluated: RuleRef[];
}

// Storage contract. U3 creates this index at startup ("rules on challenge
// type and rule key where status is active"); the engine's active-rule query
// is shaped to use it.

export const RULES_COLLECTION = "rules";

export const RULES_ACTIVE_INDEX = {
  key: { challenge_type: 1, rule_key: 1 },
  options: {
    name: "rules_active_challenge_type_rule_key",
    unique: true,
    partialFilterExpression: { status: "active" },
  },
} as const;
