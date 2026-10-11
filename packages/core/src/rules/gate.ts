import type { Features, FeatureValue } from "../schema/common";
import type { Example } from "../schema/examples";
import type { FeatureCatalog } from "../schema/pack";
import { MATCHES_VALUE_PATTERN, whenConds, type Cond, type RuleAction, type When } from "../schema/rule";
import type { GateResult, GateThresholds } from "../schema/rules";

/**
 * The test gate (R21, KTD9, U9 approach step 2).
 *
 * A candidate is tested together with the current active set over the challenge type's
 * labelled examples. It passes when, with the thresholds from `settings`:
 * - catch rate on its target cheat class rises by at least `min_catch_gain`,
 * - false alarms on seed honest examples stay at or below `max_false_alarm_rule` for the
 *   candidate alone and `max_false_alarm_set` for the active set with the candidate,
 * - no other cheat class drops by more than `max_other_class_drop`,
 * - every parameter stays inside its predicate's hard bound.
 *
 * "Caught" means any rule in the set matches the example, whatever its action, because a flag,
 * an ask-more and a reject all stop a cheat from counting silently. The candidate replaces any
 * active version with the same rule key (its parent) in the "after" set.
 *
 * The gate evaluates candidate sets in memory, which the `engine` service (active rules read
 * from MongoDB) cannot do. The pure matcher and bound check below mirror U4's ported engine
 * (`evaluateRules`, `matchesCondition`) and grammar (`validateWhen`) exactly. Follow-up once
 * this branch is rebased onto the port: call those directly here so the gate and live
 * evaluation share one implementation.
 */

/** Tolerance for rate comparisons, so exactly 10 points counts as 10 points. */
const EPSILON = 1e-9;

export interface GateRule {
  rule_key: string;
  when: When;
  action: RuleAction;
}

export interface GateCandidate extends GateRule {
  cheat_class: string | null;
}

export type GateExample = Pick<Example, "label" | "cheat_class" | "features" | "source">;

export interface GateInput {
  candidate: GateCandidate;
  /** The challenge type's active rules. */
  active: GateRule[];
  examples: GateExample[];
  catalog: FeatureCatalog;
  thresholds: GateThresholds;
  now: Date;
}

// ---------------------------------------------------------------- matching

function matchesScalar(cond: Cond, actual: string | number | boolean): boolean {
  const expected: unknown = cond.value;
  switch (cond.op) {
    case "eq":
      return !Array.isArray(expected) && actual === expected;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (typeof actual !== "number" || typeof expected !== "number") return false;
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
      if (cond.op === "lt") return actual < expected;
      if (cond.op === "lte") return actual <= expected;
      if (cond.op === "gt") return actual > expected;
      return actual >= expected;
    }
    case "in":
      return Array.isArray(expected) && (expected as unknown[]).includes(actual);
    case "matches":
      // Literal, case-insensitive substring test, never a regex.
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

/**
 * One condition against a proof's features. A missing feature or a type mismatch is a
 * non-match. A list feature (for example attendee domains) matches when any item passes.
 */
export function condMatches(cond: Cond, features: Features): boolean {
  if (!Object.hasOwn(features, cond.feature)) return false;
  const actual = features[cond.feature] as FeatureValue | undefined;
  if (actual === undefined) return false;
  if (Array.isArray(actual)) return actual.some((item) => matchesScalar(cond, item));
  return matchesScalar(cond, actual);
}

/** A rule's `when` against a proof's features. */
export function whenMatches(when: When, features: Features): boolean {
  if ("all" in when) return when.all.length > 0 && when.all.every((c) => condMatches(c, features));
  return when.any.some((c) => condMatches(c, features));
}

/** True when any rule in the set matches. */
export function setCatches(rules: readonly Pick<GateRule, "when">[], features: Features): boolean {
  return rules.some((r) => whenMatches(r.when, features));
}

// ---------------------------------------------------------------- hard bounds

const HAS_ALNUM = /[A-Za-z0-9]/;

/** Hard-limit checks against the pack's feature catalog (KTD8, KTD9). Empty when the rule is inside every bound. */
export function boundViolations(when: When, catalog: FeatureCatalog): string[] {
  const out: string[] = [];
  for (const cond of whenConds(when)) {
    const spec = Object.hasOwn(catalog, cond.feature) ? catalog[cond.feature] : undefined;
    if (!spec) {
      out.push(`unknown feature ${cond.feature}`);
      continue;
    }
    if (!spec.ops.includes(cond.op)) {
      out.push(`operator ${cond.op} is not allowed on ${cond.feature}`);
      continue;
    }
    const values = Array.isArray(cond.value) ? cond.value : [cond.value];
    if (cond.op === "matches") {
      const v = cond.value;
      if (typeof v !== "string" || !MATCHES_VALUE_PATTERN.test(v) || !HAS_ALNUM.test(v)) {
        out.push(`${cond.feature} matches needs a literal of 1 to 40 letters, digits, spaces or hyphens`);
      }
      continue;
    }
    if (cond.op === "in" && (!Array.isArray(cond.value) || cond.value.length === 0)) {
      out.push(`${cond.feature} in needs a non-empty list`);
      continue;
    }
    for (const v of values) {
      const typeOk =
        (spec.kind === "boolean" && typeof v === "boolean") ||
        (spec.kind === "number" && typeof v === "number" && Number.isFinite(v)) ||
        ((spec.kind === "string" || spec.kind === "string_list") && typeof v === "string");
      if (!typeOk) {
        out.push(`${cond.feature} takes a ${spec.kind} value`);
        break;
      }
      if (typeof v === "string" && v.length === 0) {
        out.push(`${cond.feature} string values must not be empty`);
        break;
      }
      if (spec.kind === "number" && typeof v === "number" && spec.bound) {
        const { min, max } = spec.bound;
        if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
          out.push(`${cond.feature} value ${v} is outside its hard bound ${min ?? "-inf"} to ${max ?? "inf"}`);
          break;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the gate

function rate(hit: number, total: number): number {
  return total === 0 ? 0 : hit / total;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pts(x: number): string {
  return (x * 100).toFixed(1);
}

/** Run the gate. Pure: no database, no AI call. */
export function runGate(input: GateInput): GateResult {
  const { candidate, active, examples, thresholds } = input;
  const target = candidate.cheat_class ?? "unknown";

  // KTD9: honest examples come only from seed data.
  const honest = examples.filter((e) => e.label === "honest" && e.source === "seed");
  const cheats = examples.filter((e) => e.label === "cheat" && e.cheat_class);

  const before: GateRule[] = active;
  const after: GateRule[] = [...active.filter((r) => r.rule_key !== candidate.rule_key), candidate];

  const classes = [...new Set([target, ...cheats.map((e) => e.cheat_class as string)])].sort();
  const perBefore: Record<string, number> = {};
  const perAfter: Record<string, number> = {};
  for (const cls of classes) {
    const ofClass = cheats.filter((e) => e.cheat_class === cls);
    perBefore[cls] = rate(ofClass.filter((e) => setCatches(before, e.features)).length, ofClass.length);
    perAfter[cls] = rate(ofClass.filter((e) => setCatches(after, e.features)).length, ofClass.length);
  }

  const falseAlarmRule = rate(honest.filter((e) => setCatches([candidate], e.features)).length, honest.length);
  const falseAlarmSet = rate(honest.filter((e) => setCatches(after, e.features)).length, honest.length);
  const violations = boundViolations(candidate.when, input.catalog);

  const catchBefore = perBefore[target] ?? 0;
  const catchAfter = perAfter[target] ?? 0;
  const targetCount = cheats.filter((e) => e.cheat_class === target).length;

  const reasons: string[] = [];
  if (violations.length > 0) reasons.push(`breaks a hard limit: ${violations.join("; ")}`.slice(0, 200));
  if (targetCount === 0) reasons.push(`no labelled cheat examples for ${target}`.slice(0, 200));
  if (honest.length === 0) reasons.push("no honest seed examples to measure false alarms");
  const gain = catchAfter - catchBefore;
  if (gain + EPSILON < thresholds.min_catch_gain) {
    reasons.push(`catch rate for ${target} rose ${pts(gain)} points, needs ${pts(thresholds.min_catch_gain)}`.slice(0, 200));
  }
  if (falseAlarmRule > thresholds.max_false_alarm_rule + EPSILON) {
    reasons.push(`false alarms ${pct(falseAlarmRule)} > ${pct(thresholds.max_false_alarm_rule)}`);
  }
  if (falseAlarmSet > thresholds.max_false_alarm_set + EPSILON) {
    reasons.push(`false alarms across the active set ${pct(falseAlarmSet)} > ${pct(thresholds.max_false_alarm_set)}`);
  }
  for (const cls of classes) {
    if (cls === target) continue;
    const drop = (perBefore[cls] ?? 0) - (perAfter[cls] ?? 0);
    if (drop > thresholds.max_other_class_drop + EPSILON) {
      reasons.push(`catch rate for ${cls} dropped ${pts(drop)} points, limit ${pts(thresholds.max_other_class_drop)}`.slice(0, 200));
    }
  }

  return {
    passed: reasons.length === 0,
    target_class: target,
    catch_rate_before: catchBefore,
    catch_rate_after: catchAfter,
    per_class_before: perBefore,
    per_class_after: perAfter,
    false_alarm_rule: falseAlarmRule,
    false_alarm_set: falseAlarmSet,
    bound_violations: violations,
    honest_count: honest.length,
    cheat_count: cheats.length,
    thresholds: { ...thresholds },
    reasons,
    tested_at: input.now,
  };
}
