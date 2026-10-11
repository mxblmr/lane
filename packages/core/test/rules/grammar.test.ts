import { describe, expect, it } from "vitest";
import { isSafeMatchesLiteral, MAX_CONDITIONS, MAX_IN_VALUES, validateRule } from "../../src/rules/grammar";
import { ruleDefinition, shipWeekCatalog } from "./fixtures";

function issueCodes(candidate: unknown): string[] {
  const result = validateRule(candidate, shipWeekCatalog);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("validateRule", () => {
  it("accepts a rename-only reject rule built from catalog features", () => {
    const result = validateRule(ruleDefinition(), shipWeekCatalog);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.rule_key).toBe("ship_week.rename_only");
  });

  it("accepts an any-of rule mixing booleans, an in-bound threshold and a matches literal", () => {
    const candidate = ruleDefinition({
      when: {
        any: [
          { feature: "whitespace_only", op: "eq", value: true },
          { feature: "code_lines_changed", op: "lte", value: 20 },
          { feature: "code_lines_changed", op: "in", value: [0, 1, 2] },
          { feature: "message_matches", op: "matches", value: "fix typo" },
        ],
      },
      action: "flag",
    });
    expect(validateRule(candidate, shipWeekCatalog).ok).toBe(true);
  });

  it("rejects a candidate using a feature missing from the pack's catalog", () => {
    const candidate = ruleDefinition({ when: { all: [{ feature: "stars_gained", op: "gt", value: 3 }] } });
    const result = validateRule(candidate, shipWeekCatalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: "unknown_feature", path: "when.all.0.feature" })]);
    }
  });

  it("does not treat inherited object keys as catalog features", () => {
    const candidate = ruleDefinition({ when: { all: [{ feature: "constructor", op: "eq", value: true }] } });
    expect(issueCodes(candidate)).toEqual(["unknown_feature"]);
  });

  it("rejects a threshold above the feature's hard bound", () => {
    const candidate = ruleDefinition({ when: { all: [{ feature: "code_lines_changed", op: "lt", value: 25 }] } });
    const result = validateRule(candidate, shipWeekCatalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: "out_of_bounds", path: "when.all.0.value" })]);
    }
  });

  it("rejects a threshold below the feature's hard bound", () => {
    const candidate = ruleDefinition({ when: { all: [{ feature: "code_lines_changed", op: "gte", value: -1 }] } });
    expect(issueCodes(candidate)).toEqual(["out_of_bounds"]);
  });

  it("rejects an in list with any value outside the hard bound", () => {
    const candidate = ruleDefinition({ when: { all: [{ feature: "code_lines_changed", op: "in", value: [1, 21] }] } });
    const result = validateRule(candidate, shipWeekCatalog);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: "out_of_bounds", path: "when.all.0.value.1" })]);
    }
  });

  it("rejects an empty or oversized in list", () => {
    const empty = ruleDefinition({ when: { all: [{ feature: "code_lines_changed", op: "in", value: [] }] } });
    const tooMany = ruleDefinition({
      when: {
        all: [{ feature: "code_lines_changed", op: "in", value: Array.from({ length: MAX_IN_VALUES + 1 }, () => 1) }],
      },
    });
    expect(issueCodes(empty)).toEqual(["invalid_list"]);
    expect(issueCodes(tooMany)).toEqual(["invalid_list"]);
  });

  it.each(["fix.*", "^wip$", "(rename|typo)", "a+b", "[abc]", "typo\\d", "rename_only", "wip?"])(
    "rejects the matches value %j because it contains regex syntax",
    (value) => {
      const candidate = ruleDefinition({ when: { all: [{ feature: "message_matches", op: "matches", value }] } });
      expect(issueCodes(candidate)).toEqual(["invalid_matches_literal"]);
    },
  );

  it("rejects a matches value longer than 40 characters and accepts exactly 40", () => {
    const tooLong = ruleDefinition({ when: { all: [{ feature: "message_matches", op: "matches", value: "a".repeat(41) }] } });
    const maxLength = ruleDefinition({ when: { all: [{ feature: "message_matches", op: "matches", value: "a".repeat(40) }] } });
    expect(issueCodes(tooLong)).toEqual(["invalid_matches_literal"]);
    expect(validateRule(maxLength, shipWeekCatalog).ok).toBe(true);
  });

  it("rejects a blank or non-string matches value", () => {
    for (const value of ["", "   ", "- -", 5, ["typo"]]) {
      const candidate = ruleDefinition({ when: { all: [{ feature: "message_matches", op: "matches", value }] } });
      expect(issueCodes(candidate)).toEqual(["invalid_matches_literal"]);
    }
  });

  it("rejects an operator that does not fit the feature type", () => {
    const boolGt = ruleDefinition({ when: { all: [{ feature: "rename_only", op: "gt", value: 0 }] } });
    const numberMatches = ruleDefinition({
      when: { all: [{ feature: "code_lines_changed", op: "matches", value: "10" }] },
    });
    expect(issueCodes(boolGt)).toEqual(["op_not_allowed"]);
    expect(issueCodes(numberMatches)).toEqual(["op_not_allowed"]);
  });

  it("rejects a value whose type does not match the feature", () => {
    const stringForBool = ruleDefinition({ when: { all: [{ feature: "rename_only", op: "eq", value: "true" }] } });
    const listForEq = ruleDefinition({ when: { all: [{ feature: "code_lines_changed", op: "eq", value: [1] }] } });
    expect(issueCodes(stringForBool)).toEqual(["value_type_mismatch"]);
    expect(issueCodes(listForEq)).toEqual(["value_type_mismatch"]);
  });

  it("rejects a non-finite threshold", () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const candidate = ruleDefinition({ when: { all: [{ feature: "code_lines_changed", op: "lt", value }] } });
      expect(validateRule(candidate, shipWeekCatalog).ok).toBe(false);
    }
  });

  it("rejects a rule for another challenge type", () => {
    expect(issueCodes(ruleDefinition({ challenge_type: "build_in_public" }))).toEqual(["challenge_type_mismatch"]);
  });

  it("rejects more conditions than the grammar allows", () => {
    const conditions = Array.from({ length: MAX_CONDITIONS + 1 }, () => ({
      feature: "rename_only",
      op: "eq" as const,
      value: true,
    }));
    expect(issueCodes(ruleDefinition({ when: { all: conditions } }))).toEqual(["too_many_conditions"]);
  });

  it("reports every bad condition, not just the first", () => {
    const candidate = ruleDefinition({
      when: {
        all: [
          { feature: "stars_gained", op: "gt", value: 3 },
          { feature: "code_lines_changed", op: "lt", value: 99 },
          { feature: "message_matches", op: "matches", value: ".*" },
        ],
      },
    });
    expect(issueCodes(candidate)).toEqual(["unknown_feature", "out_of_bounds", "invalid_matches_literal"]);
  });

  it("rejects malformed structure: unknown action, unknown op, empty or mixed when", () => {
    expect(issueCodes({ ...ruleDefinition(), action: "delete" })).toEqual(["invalid_shape"]);
    expect(
      issueCodes({ ...ruleDefinition(), when: { all: [{ feature: "rename_only", op: "regex", value: "x" }] } }),
    ).toContain("invalid_shape");
    expect(issueCodes({ ...ruleDefinition(), when: { all: [] } })).toContain("invalid_shape");
    expect(
      issueCodes({
        ...ruleDefinition(),
        when: { all: [{ feature: "rename_only", op: "eq", value: true }], any: [] },
      }),
    ).toContain("invalid_shape");
    expect(issueCodes(null)).toEqual(["invalid_shape"]);
  });
});

describe("isSafeMatchesLiteral", () => {
  it("accepts letters, digits, spaces and hyphens only", () => {
    expect(isSafeMatchesLiteral("fix typo")).toBe(true);
    expect(isSafeMatchesLiteral("WIP-2")).toBe(true);
    expect(isSafeMatchesLiteral("fix.typo")).toBe(false);
    expect(isSafeMatchesLiteral("x".repeat(41))).toBe(false);
  });
});
