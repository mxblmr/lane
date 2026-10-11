// Rule engine (U4, KTD7). Evaluates a challenge type's active rules against a
// proof's features with no AI call and reports which rule decided. Implements
// U3's `engine` service (`interfaces.ts`); the composition root wires it with
// `provideServices({ engine: engineService })`.
//
// Active rules are read from MongoDB on every evaluation with one indexed
// query and are never cached in process, because rule activation and proof
// intake run in different function instances. Rules run in U3's fixed action
// order (`RULE_ACTIONS`): reject, then hold_payout, then ask_more, then flag.
// The first decisive match wins, every match is recorded, and the result lists
// every rule key and version evaluated.

import type { ClientSession, Db, Filter } from "mongodb";
import type { EvaluateInput, EvaluateResult, LaneServices } from "../interfaces";
import { collections } from "../schema/collections";
import type { ChallengeType, FeatureValue, Features, RuleRef } from "../schema/common";
import type { RuleMatch, VerdictOutcome } from "../schema/proofs";
import { RULE_ACTIONS, type Cond } from "../schema/rule";
import type { Rule } from "../schema/rules";

/** The fields of a stored rule the engine reads to evaluate it. */
export type EvaluableRule = Pick<Rule, "rule_key" | "version" | "action" | "when">;

/** The engine's decision: the deciding rule's action, or "none". */
export type EngineDecision = EvaluateResult["decision"];

const ACTION_PRIORITY = new Map<string, number>(RULE_ACTIONS.map((action, index) => [action, index]));

const EVALUABLE_PROJECTION = { _id: 0, rule_key: 1, version: 1, action: 1, when: 1 } as const;

/**
 * Test one condition against a proof's features. Total: a missing feature, a
 * type mismatch or an unknown operator is a non-match, never an error.
 * `matches` is a literal, case-insensitive substring test, never a regex. A
 * list feature (string_list) matches when any of its items passes the test.
 */
export function matchesCondition(cond: Cond, features: Features): boolean {
  if (!Object.hasOwn(features, cond.feature)) return false;
  const actual: FeatureValue = features[cond.feature] as FeatureValue;
  if (Array.isArray(actual)) {
    return actual.some((item) => matchesScalar(cond, item));
  }
  return matchesScalar(cond, actual);
}

function matchesScalar(cond: Cond, actual: string | number | boolean): boolean {
  const expected: unknown = cond.value;
  switch (cond.op) {
    case "eq":
      return !Array.isArray(expected) && actual === expected;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return compareNumbers(cond.op, actual, expected);
    case "in":
      return Array.isArray(expected) && (expected as unknown[]).includes(actual);
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

function ruleMatches(rule: EvaluableRule, features: Features): boolean {
  // Stored documents are read without a schema parse, so guard the shape.
  const when = rule.when as Partial<{ all: Cond[]; any: Cond[] }> | undefined;
  if (when && Array.isArray(when.all)) {
    return when.all.length > 0 && when.all.every((cond) => matchesCondition(cond, features));
  }
  if (when && Array.isArray(when.any)) {
    return when.any.some((cond) => matchesCondition(cond, features));
  }
  return false;
}

function priority(action: string): number {
  return ACTION_PRIORITY.get(action) ?? Number.MAX_SAFE_INTEGER;
}

function compareRules(a: EvaluableRule, b: EvaluableRule): number {
  const byAction = priority(a.action) - priority(b.action);
  if (byAction !== 0) return byAction;
  if (a.rule_key !== b.rule_key) return a.rule_key < b.rule_key ? -1 : 1;
  return b.version - a.version;
}

/**
 * Evaluate already-loaded rules against a proof's features. Pure and
 * synchronous; makes no database or AI call. A stored rule with an unknown
 * action or a malformed `when` is listed as evaluated and never matches.
 */
export function evaluateRules(rules: readonly EvaluableRule[], features: Features): EvaluateResult {
  const ordered = [...rules].sort(compareRules);
  const evaluated: RuleRef[] = [];
  const matched: RuleMatch[] = [];

  for (const rule of ordered) {
    evaluated.push({ rule_key: rule.rule_key, version: rule.version });
    if (!ACTION_PRIORITY.has(rule.action)) continue;
    if (ruleMatches(rule, features)) {
      matched.push({ rule_key: rule.rule_key, version: rule.version, action: rule.action });
    }
  }

  // Matches are already in evaluation order, so the first one decides.
  const decisive = matched[0] ?? null;
  return {
    decision: decisive ? decisive.action : "none",
    rule: decisive ? { rule_key: decisive.rule_key, version: decisive.version } : null,
    matched,
    evaluated,
  };
}

/**
 * Load a challenge type's active rules with one `find` on the `rules`
 * collection, served by U3's rules indexes (`schema/indexes.ts`).
 */
export async function loadActiveRules(
  db: Db,
  challengeType: ChallengeType,
  options: { session?: ClientSession } = {},
): Promise<EvaluableRule[]> {
  const filter: Filter<Rule> = { challenge_type: challengeType, status: "active" };
  return collections(db)
    .rules.find<EvaluableRule>(filter, { projection: EVALUABLE_PROJECTION, session: options.session })
    .toArray();
}

/** Read the active rules fresh from MongoDB and evaluate the proof's features. */
export async function evaluate(db: Db, input: EvaluateInput): Promise<EvaluateResult> {
  const rules = await loadActiveRules(db, input.challenge_type, { session: input.session });
  return evaluateRules(rules, input.features);
}

/** U4's implementation of the `engine` service in `interfaces.ts`. */
export const engineService: LaneServices["engine"] = { evaluate };

/**
 * What a rule decision means for the proof's verdict (KTD7, KTD12): reject
 * rejects, hold_payout accepts with the payout held, ask_more asks for extra
 * proof, flag accepts with a flag. Returns null for "none" (the proof goes to
 * AI review).
 */
export function verdictForDecision(
  decision: EngineDecision,
): { outcome: Exclude<VerdictOutcome, "pending">; payout_hold: boolean } | null {
  switch (decision) {
    case "reject":
      return { outcome: "reject", payout_hold: false };
    case "hold_payout":
      return { outcome: "accept", payout_hold: true };
    case "ask_more":
      return { outcome: "ask_more", payout_hold: false };
    case "flag":
      return { outcome: "flag", payout_hold: false };
    case "none":
      return null;
  }
}
