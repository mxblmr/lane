// Rule engine (U4, KTD7). Evaluates a challenge type's active rules against a
// proof's features with no AI call and reports which rule decided.
//
// Active rules are read from MongoDB on every evaluation with one indexed
// query and are never cached in process, because rule activation and proof
// intake run in different function instances. Rules run in a fixed order:
// reject, then hold_payout, then ask_more, then flag. The first decisive match
// wins, every match is recorded, and the result lists every rule key and
// version evaluated.

import type { Collection, Db, Filter } from "mongodb";
import {
  RULES_COLLECTION,
  type FeatureValue,
  type ProofFeatures,
  type RuleAction,
  type RuleCondition,
  type RuleDecision,
  type RuleDocument,
  type RuleMatch,
  type RuleOutcome,
  type RuleRef,
} from "./_u3-shim";

/** Evaluation order. Earlier actions win over later ones. */
export const ACTION_ORDER: readonly RuleAction[] = ["reject", "hold_payout", "ask_more", "flag"];

const ACTION_PRIORITY: Readonly<Record<RuleAction, number>> = {
  reject: 0,
  hold_payout: 1,
  ask_more: 2,
  flag: 3,
};

const OUTCOME_BY_ACTION: Readonly<Record<RuleAction, RuleOutcome>> = {
  reject: "rejected",
  hold_payout: "accepted",
  ask_more: "held",
  flag: "flagged_accept",
};

/** The fields of a stored rule the engine needs to evaluate it. */
export type EvaluableRule = Pick<RuleDocument, "rule_key" | "version" | "action" | "when">;

/** Result of `RuleEngine.evaluate`: the decision plus where the time went. */
export interface RuleEvaluation extends RuleDecision {
  challenge_type: string;
  timing: { read_ms: number; eval_ms: number };
}

const EVALUABLE_PROJECTION = { _id: 0, rule_key: 1, version: 1, action: 1, when: 1 } as const;

/**
 * Test one condition against a proof's features. Total: a missing feature, a
 * type mismatch or an unknown operator is a non-match, never an error.
 * `matches` is a literal, case-insensitive substring test, never a regex.
 */
export function matchesCondition(condition: RuleCondition, features: ProofFeatures): boolean {
  if (!Object.hasOwn(features, condition.feature)) return false;
  const actual = features[condition.feature];
  const expected = condition.value;

  switch (condition.op) {
    case "eq":
      return !Array.isArray(expected) && actual === expected;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return compareNumbers(condition.op, actual, expected);
    case "in":
      return Array.isArray(expected) && expected.includes(actual as FeatureValue);
    case "matches":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        expected.length > 0 &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    default:
      return false;
  }
}

function compareNumbers(op: "lt" | "lte" | "gt" | "gte", actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  switch (op) {
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
  }
}

function ruleMatches(rule: EvaluableRule, features: ProofFeatures): boolean {
  const when = rule.when as Partial<{ all: RuleCondition[]; any: RuleCondition[] }> | undefined;
  if (when && Array.isArray(when.all)) {
    return when.all.length > 0 && when.all.every((condition) => matchesCondition(condition, features));
  }
  if (when && Array.isArray(when.any)) {
    return when.any.some((condition) => matchesCondition(condition, features));
  }
  return false;
}

function compareRules(a: EvaluableRule, b: EvaluableRule): number {
  const byAction = (ACTION_PRIORITY[a.action] ?? Number.MAX_SAFE_INTEGER) - (ACTION_PRIORITY[b.action] ?? Number.MAX_SAFE_INTEGER);
  if (byAction !== 0) return byAction;
  if (a.rule_key !== b.rule_key) return a.rule_key < b.rule_key ? -1 : 1;
  return b.version - a.version;
}

/**
 * Evaluate already-loaded rules against a proof's features. Pure and
 * synchronous; makes no database or AI call.
 */
export function evaluateRules(rules: readonly EvaluableRule[], features: ProofFeatures): RuleDecision {
  const ordered = [...rules].sort(compareRules);
  const evaluated: RuleRef[] = [];
  const matches: RuleMatch[] = [];

  for (const rule of ordered) {
    evaluated.push({ rule_key: rule.rule_key, version: rule.version });
    if (!Object.hasOwn(ACTION_PRIORITY, rule.action)) continue;
    if (ruleMatches(rule, features)) {
      matches.push({ rule_key: rule.rule_key, version: rule.version, action: rule.action });
    }
  }

  // Matches are already in evaluation order, so the first one decides.
  const decidedBy = matches[0] ?? null;
  return {
    outcome: decidedBy ? OUTCOME_BY_ACTION[decidedBy.action] : "no_decision",
    decided_by: decidedBy,
    payout_hold: decidedBy?.action === "hold_payout",
    matches,
    evaluated,
  };
}

function isDb(source: Db | Collection<RuleDocument>): source is Db {
  return !("collectionName" in source);
}

/**
 * Evaluates proofs against the active rules stored in MongoDB. Takes the
 * database (or the `rules` collection) as a parameter and holds no rule state
 * between calls.
 */
export class RuleEngine {
  private readonly rules: Collection<RuleDocument>;

  constructor(source: Db | Collection<RuleDocument>) {
    this.rules = isDb(source) ? source.collection<RuleDocument>(RULES_COLLECTION) : source;
  }

  /**
   * Load a challenge type's active rules with one query, shaped to use the
   * partial index on challenge type and rule key where status is active.
   */
  async loadActiveRules(challengeType: string): Promise<EvaluableRule[]> {
    const filter: Filter<RuleDocument> = { challenge_type: challengeType, status: "active" };
    return this.rules.find<EvaluableRule>(filter, { projection: EVALUABLE_PROJECTION }).toArray();
  }

  /** Read the active rules fresh from MongoDB and evaluate the proof's features. */
  async evaluate(challengeType: string, features: ProofFeatures): Promise<RuleEvaluation> {
    const readStart = performance.now();
    const rules = await this.loadActiveRules(challengeType);
    const evalStart = performance.now();
    const decision = evaluateRules(rules, features);
    const evalEnd = performance.now();

    return {
      ...decision,
      challenge_type: challengeType,
      timing: { read_ms: evalStart - readStart, eval_ms: evalEnd - evalStart },
    };
  }
}
