// Rule grammar validation (U4, KTD8). Checks a rule against its pack's feature
// catalog and hard bounds before it can be tested, stored or activated.
// Structure (operators, actions, value shapes, list and literal lengths, the
// `matches` literal pattern, condition count) comes from U3's rule schema in
// `schema/rule.ts`. This module adds the pack-specific checks: the rule is for
// this pack, every feature is in the pack's catalog, every operator is one the
// catalog allows for that feature, values have the feature's type, numbers stay
// inside the feature's hard bound, and `matches` literals contain at least one
// letter or digit so a blank literal cannot match every proof.

import type { z } from "zod";
import type { AnyPack, FeatureCatalog, FeatureKind, FeatureSpec } from "../schema/pack";
import {
  MATCHES_VALUE_PATTERN,
  RuleProposalSchema,
  WhenSchema,
  whenConds,
  type Cond,
  type RuleProposal,
  type When,
} from "../schema/rule";

/** The parts of a pack the grammar reads. */
export type GrammarPack = Pick<AnyPack, "type" | "features">;

const HAS_ALNUM = /[A-Za-z0-9]/;

/** Scalar type each feature kind takes in a condition value. A string_list takes string values. */
const SCALAR_TYPE_BY_KIND: Readonly<Record<FeatureKind, "boolean" | "number" | "string">> = {
  boolean: "boolean",
  number: "number",
  string: "string",
  string_list: "string",
};

export type RuleValidationCode =
  | "invalid_shape"
  | "challenge_type_mismatch"
  | "unknown_feature"
  | "op_not_allowed"
  | "value_type_mismatch"
  | "out_of_bounds"
  | "invalid_matches_literal"
  | "invalid_literal";

export interface RuleValidationIssue {
  path: string;
  code: RuleValidationCode;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: RuleValidationIssue[] };

/**
 * True when `value` is a safe `matches` literal: U3's pattern (1 to 40 letters,
 * digits, spaces or hyphens) plus at least one letter or digit.
 */
export function isSafeMatchesLiteral(value: unknown): value is string {
  return typeof value === "string" && MATCHES_VALUE_PATTERN.test(value) && HAS_ALNUM.test(value);
}

/**
 * Validate a rule-writer's proposal (U3 `RuleProposal`) against its pack's
 * feature catalog and hard bounds. Returns the parsed proposal on success, or
 * every issue found.
 */
export function validateRule(candidate: unknown, pack: GrammarPack): ValidationResult<RuleProposal> {
  const parsed = RuleProposalSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(shapeIssue) };

  const proposal = parsed.data;
  const issues: RuleValidationIssue[] = [];
  if (proposal.challenge_type !== pack.type) {
    issues.push({
      path: "challenge_type",
      code: "challenge_type_mismatch",
      message: `rule is for "${proposal.challenge_type}" but the pack is "${pack.type}"`,
    });
  }
  issues.push(...checkWhen(proposal.when, pack, "when"));
  return issues.length === 0 ? { ok: true, value: proposal } : { ok: false, issues };
}

/**
 * Validate a predicate alone (for example a pack's seed rule or a stored rule's
 * `when`) against the pack's feature catalog and hard bounds.
 */
export function validateWhen(when: unknown, pack: GrammarPack): ValidationResult<When> {
  const parsed = WhenSchema.safeParse(when);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map(shapeIssue) };
  const issues = checkWhen(parsed.data, pack, "");
  return issues.length === 0 ? { ok: true, value: parsed.data } : { ok: false, issues };
}

function checkWhen(when: When, pack: GrammarPack, prefix: string): RuleValidationIssue[] {
  const combinator = "all" in when ? "all" : "any";
  const base = prefix ? `${prefix}.${combinator}` : combinator;
  return whenConds(when).flatMap((cond, index) => checkCond(cond, pack, `${base}.${index}`));
}

function checkCond(cond: Cond, pack: GrammarPack, path: string): RuleValidationIssue[] {
  const catalog: FeatureCatalog = pack.features;
  const spec = Object.hasOwn(catalog, cond.feature) ? catalog[cond.feature] : undefined;
  if (!spec) {
    return [
      {
        path: `${path}.feature`,
        code: "unknown_feature",
        message: `feature "${cond.feature}" is not in the ${pack.type} feature catalog`,
      },
    ];
  }

  if (!spec.ops.includes(cond.op)) {
    return [
      {
        path: `${path}.op`,
        code: "op_not_allowed",
        message: `operator "${cond.op}" is not allowed on feature "${cond.feature}"`,
      },
    ];
  }

  const valuePath = `${path}.value`;

  if (cond.op === "matches") {
    if (SCALAR_TYPE_BY_KIND[spec.kind] !== "string") {
      return [typeMismatch(valuePath, cond.feature, spec, cond.value)];
    }
    if (!isSafeMatchesLiteral(cond.value)) {
      return [
        {
          path: valuePath,
          code: "invalid_matches_literal",
          message: "a matches value must contain at least one letter or digit",
        },
      ];
    }
    return [];
  }

  // U3's schema guarantees `in` carries a non-empty list and every other
  // operator a single value.
  if (Array.isArray(cond.value)) {
    return cond.value.flatMap((item, index) => checkScalar(item, spec, cond.feature, `${valuePath}.${index}`));
  }
  return checkScalar(cond.value, spec, cond.feature, valuePath);
}

function checkScalar(value: unknown, spec: FeatureSpec, feature: string, path: string): RuleValidationIssue[] {
  const expected = SCALAR_TYPE_BY_KIND[spec.kind];
  if (typeof value !== expected || (typeof value === "number" && !Number.isFinite(value))) {
    return [typeMismatch(path, feature, spec, value)];
  }

  if (typeof value === "number" && spec.bound) {
    const { min, max } = spec.bound;
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      return [
        {
          path,
          code: "out_of_bounds",
          message: `feature "${feature}" must stay within its hard bound ${min ?? "-inf"} to ${max ?? "inf"}, got ${value}`,
        },
      ];
    }
  }

  if (typeof value === "string" && value.length === 0) {
    return [{ path, code: "invalid_literal", message: "string values must not be empty" }];
  }

  return [];
}

function typeMismatch(path: string, feature: string, spec: FeatureSpec, value: unknown): RuleValidationIssue {
  return {
    path,
    code: "value_type_mismatch",
    message: `feature "${feature}" is a ${spec.kind} feature and does not take ${JSON.stringify(value)}`,
  };
}

function shapeIssue(issue: z.core.$ZodIssue): RuleValidationIssue {
  return { path: issue.path.map(String).join("."), code: "invalid_shape", message: issue.message };
}
