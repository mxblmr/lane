import type { Features } from "../schema/common";
import type { Example } from "../schema/examples";
import type { RuleAction, When } from "../schema/rule";
import type { GateResult, GateThresholds } from "../schema/rules";
import { evaluateRules, type EvaluableRule } from "./engine";
import { validateWhen, type GrammarPack } from "./grammar";

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
 * Matching is U4's pure `evaluateRules`, the same code the `engine` service runs on live
 * proofs, applied to in-memory rule sets. Hard bounds are U4's `validateWhen` against the pack.
 */

/** Tolerance for rate comparisons, so exactly 10 points counts as 10 points. */
const EPSILON = 1e-9;

export interface GateRule {
  rule_key: string;
  /** Version, when known; only used to label the rule for the engine. */
  version?: number;
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
  /** The pack's type and feature catalog, for the hard-bound check. */
  pack: GrammarPack;
  thresholds: GateThresholds;
  now: Date;
}

// ---------------------------------------------------------------- matching and bounds

function toEvaluable(rule: GateRule): EvaluableRule {
  return { rule_key: rule.rule_key, version: rule.version ?? 1, action: rule.action, when: rule.when };
}

/** True when any rule in the set matches the features (U4's engine, any action). */
export function setCatches(rules: readonly GateRule[], features: Features): boolean {
  if (rules.length === 0) return false;
  return evaluateRules(rules.map(toEvaluable), features).matched.length > 0;
}

/** Hard-limit and catalog problems for a rule's `when` (U4's grammar, KTD8, KTD9). Empty when it is valid. */
export function boundViolations(when: When, pack: GrammarPack): string[] {
  const res = validateWhen(when, pack);
  return res.ok ? [] : res.issues.map((issue) => issue.message);
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
  const violations = boundViolations(candidate.when, input.pack);

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
