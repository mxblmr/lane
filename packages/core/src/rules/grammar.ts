// Rule grammar validation (U4, KTD8). Checks a candidate rule against its
// pack's feature catalog and hard bounds before it can be tested, stored or
// activated. Structure comes from the shared rule schema; this module adds the
// pack-specific checks: known features, operators that fit the feature type,
// values of the right type, numbers inside the hard bound, and `matches`
// values that are short safe literals, never regex.

import type { z } from "zod";
import {
  RuleDefinitionSchema,
  type FeatureSpec,
  type FeatureType,
  type FeatureValue,
  type PackRuleCatalog,
  type RuleCondition,
  type RuleDefinition,
  type RuleOp,
} from "./_u3-shim";

/** Longest `matches` literal, and longest string value for `eq` or `in`. */
export const MAX_LITERAL_LENGTH = 40;
/** Most conditions one rule may combine. */
export const MAX_CONDITIONS = 10;
/** Most values one `in` list may hold. */
export const MAX_IN_VALUES = 20;

/** Operators each feature type accepts. */
export const OPS_BY_FEATURE_TYPE: Readonly<Record<FeatureType, readonly RuleOp[]>> = {
  boolean: ["eq"],
  number: ["eq", "lt", "lte", "gt", "gte", "in"],
  string: ["eq", "in", "matches"],
};

// Letters, digits, spaces or hyphens only, 1 to 40 characters, with at least
// one letter or digit so a blank literal cannot match every proof.
const MATCHES_LITERAL = /^[A-Za-z0-9 -]{1,40}$/;
const HAS_ALNUM = /[A-Za-z0-9]/;

export type RuleValidationCode =
  | "invalid_shape"
  | "challenge_type_mismatch"
  | "too_many_conditions"
  | "unknown_feature"
  | "op_not_allowed"
  | "value_type_mismatch"
  | "out_of_bounds"
  | "invalid_matches_literal"
  | "invalid_literal"
  | "invalid_list";

export interface RuleValidationIssue {
  path: string;
  code: RuleValidationCode;
  message: string;
}

export type RuleValidationResult =
  | { ok: true; rule: RuleDefinition }
  | { ok: false; issues: RuleValidationIssue[] };

/** True when `value` is a valid `matches` literal: 1 to 40 letters, digits, spaces or hyphens. */
export function isSafeMatchesLiteral(value: unknown): value is string {
  return typeof value === "string" && MATCHES_LITERAL.test(value) && HAS_ALNUM.test(value);
}

/**
 * Validate a candidate rule against its pack's feature catalog and hard
 * bounds. Returns the parsed rule on success, or every issue found.
 */
export function validateRule(candidate: unknown, catalog: PackRuleCatalog): RuleValidationResult {
  const parsed = RuleDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(shapeIssue) };
  }

  const rule = parsed.data;
  const issues: RuleValidationIssue[] = [];

  if (rule.challenge_type !== catalog.challenge_type) {
    issues.push({
      path: "challenge_type",
      code: "challenge_type_mismatch",
      message: `rule is for "${rule.challenge_type}" but the catalog is for "${catalog.challenge_type}"`,
    });
  }

  const [combinator, conditions] = "all" in rule.when ? (["all", rule.when.all] as const) : (["any", rule.when.any] as const);

  if (conditions.length > MAX_CONDITIONS) {
    issues.push({
      path: `when.${combinator}`,
      code: "too_many_conditions",
      message: `a rule may combine at most ${MAX_CONDITIONS} conditions, got ${conditions.length}`,
    });
  }

  conditions.forEach((condition, index) => {
    issues.push(...validateCondition(condition, catalog, `when.${combinator}.${index}`));
  });

  return issues.length === 0 ? { ok: true, rule } : { ok: false, issues };
}

function validateCondition(condition: RuleCondition, catalog: PackRuleCatalog, path: string): RuleValidationIssue[] {
  const spec = Object.hasOwn(catalog.features, condition.feature) ? catalog.features[condition.feature] : undefined;
  if (!spec) {
    return [
      {
        path: `${path}.feature`,
        code: "unknown_feature",
        message: `feature "${condition.feature}" is not in the ${catalog.challenge_type} feature catalog`,
      },
    ];
  }

  if (!OPS_BY_FEATURE_TYPE[spec.type].includes(condition.op)) {
    return [
      {
        path: `${path}.op`,
        code: "op_not_allowed",
        message: `operator "${condition.op}" does not apply to ${spec.type} feature "${condition.feature}"`,
      },
    ];
  }

  const valuePath = `${path}.value`;

  if (condition.op === "matches") {
    if (!isSafeMatchesLiteral(condition.value)) {
      return [
        {
          path: valuePath,
          code: "invalid_matches_literal",
          message: `a matches value must be 1 to ${MAX_LITERAL_LENGTH} letters, digits, spaces or hyphens`,
        },
      ];
    }
    return [];
  }

  if (condition.op === "in") {
    if (!Array.isArray(condition.value) || condition.value.length === 0 || condition.value.length > MAX_IN_VALUES) {
      return [
        {
          path: valuePath,
          code: "invalid_list",
          message: `an in value must be a list of 1 to ${MAX_IN_VALUES} values`,
        },
      ];
    }
    return condition.value.flatMap((item, index) => validateScalar(item, spec, condition.feature, `${valuePath}.${index}`));
  }

  if (Array.isArray(condition.value)) {
    return [
      {
        path: valuePath,
        code: "value_type_mismatch",
        message: `operator "${condition.op}" takes a single value, not a list`,
      },
    ];
  }

  return validateScalar(condition.value, spec, condition.feature, valuePath);
}

function validateScalar(value: FeatureValue, spec: FeatureSpec, feature: string, path: string): RuleValidationIssue[] {
  if (typeof value !== spec.type || (typeof value === "number" && !Number.isFinite(value))) {
    return [
      {
        path,
        code: "value_type_mismatch",
        message: `feature "${feature}" takes a ${spec.type} value, got ${JSON.stringify(value)}`,
      },
    ];
  }

  if (spec.type === "number" && typeof value === "number") {
    const { min, max } = spec.bounds;
    if (value < min || value > max) {
      return [
        {
          path,
          code: "out_of_bounds",
          message: `feature "${feature}" must stay within its hard bound ${min} to ${max}, got ${value}`,
        },
      ];
    }
  }

  if (spec.type === "string" && typeof value === "string" && (value.length === 0 || value.length > MAX_LITERAL_LENGTH)) {
    return [
      {
        path,
        code: "invalid_literal",
        message: `string values must be 1 to ${MAX_LITERAL_LENGTH} characters`,
      },
    ];
  }

  return [];
}

function shapeIssue(issue: z.core.$ZodIssue): RuleValidationIssue {
  return {
    path: issue.path.map(String).join("."),
    code: "invalid_shape",
    message: issue.message,
  };
}
