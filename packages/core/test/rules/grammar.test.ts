import { describe, expect, it } from "vitest";
import { isSafeMatchesLiteral, validateRule, validateWhen } from "../../src/rules/grammar";
import { getPack } from "../../src/packs/index";
import type { Cond } from "../../src/schema/rule";
import { ruleProposal, shipWeekPack } from "./fixtures";

function issues(candidate: unknown) {
  const result = validateRule(candidate, shipWeekPack);
  return result.ok ? [] : result.issues;
}

function issueCodes(candidate: unknown): string[] {
  return issues(candidate).map((issue) => issue.code);
}

function withConds(conds: unknown[], combinator: "all" | "any" = "all") {
  return { ...ruleProposal(), when: { [combinator]: conds } };
}

describe("validateRule", () => {
  it("accepts a rename-only reject rule built from catalog features", () => {
    const result = validateRule(ruleProposal(), shipWeekPack);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rule_key).toBe("rename_only");
  });

  it("accepts an any-of rule mixing booleans, an in-bound threshold, an in list and a matches literal", () => {
    const candidate = withConds(
      [
        { feature: "whitespace_only", op: "eq", value: true },
        { feature: "code_lines_changed", op: "lte", value: 20 },
        { feature: "code_lines_changed", op: "in", value: [0, 1, 2] },
        { feature: "message_matches", op: "matches", value: "fix typo" },
        { feature: "touched_dirs", op: "in", value: ["docs", "examples"] },
      ],
      "any",
    );
    expect(validateRule({ ...candidate, action: "flag" }, shipWeekPack).ok).toBe(true);
  });

  it("validates the AE1 rename-only rule against the registered Ship Week pack", () => {
    expect(validateRule(ruleProposal(), getPack("ship_week")).ok).toBe(true);
  });

  it("rejects a candidate using a feature missing from the pack's catalog", () => {
    expect(issues(withConds([{ feature: "stars_gained", op: "gt", value: 3 }]))).toEqual([
      expect.objectContaining({ code: "unknown_feature", path: "when.all.0.feature" }),
    ]);
  });

  it("does not treat inherited object keys as catalog features", () => {
    expect(issueCodes(withConds([{ feature: "constructor", op: "eq", value: true }]))).toEqual(["unknown_feature"]);
  });

  it("rejects a threshold above the feature's hard bound", () => {
    expect(issues(withConds([{ feature: "code_lines_changed", op: "lt", value: 25 }]))).toEqual([
      expect.objectContaining({ code: "out_of_bounds", path: "when.all.0.value" }),
    ]);
  });

  it("rejects a threshold below the feature's hard bound", () => {
    expect(issueCodes(withConds([{ feature: "code_lines_changed", op: "gte", value: -1 }]))).toEqual(["out_of_bounds"]);
  });

  it("rejects an in list with any value outside the hard bound", () => {
    expect(issues(withConds([{ feature: "code_lines_changed", op: "in", value: [1, 21] }]))).toEqual([
      expect.objectContaining({ code: "out_of_bounds", path: "when.all.0.value.1" }),
    ]);
  });

  it("enforces only the bound sides a feature declares", () => {
    const pack = {
      type: "ship_week" as const,
      features: { files_changed: { kind: "number" as const, description: "Files.", ops: ["gt" as const], bound: { max: 50 } } },
    };
    expect(validateRule(withConds([{ feature: "files_changed", op: "gt", value: -5 }]), pack).ok).toBe(true);
    expect(validateRule(withConds([{ feature: "files_changed", op: "gt", value: 51 }]), pack).ok).toBe(false);
  });

  it("rejects an empty or oversized in list through U3's schema", () => {
    expect(issues(withConds([{ feature: "code_lines_changed", op: "in", value: [] }]))).toEqual([
      expect.objectContaining({ code: "invalid_shape", path: "when.all.0.value" }),
    ]);
    const tooMany = withConds([{ feature: "code_lines_changed", op: "in", value: Array.from({ length: 21 }, () => 1) }]);
    expect(issueCodes(tooMany)).toContain("invalid_shape");
  });

  it.each(["fix.*", "^wip$", "(rename|typo)", "a+b", "[abc]", "typo\\d", "rename_only", "wip?"])(
    "rejects the matches value %j because it contains regex syntax",
    (value) => {
      expect(issues(withConds([{ feature: "message_matches", op: "matches", value }]))).toEqual([
        expect.objectContaining({ code: "invalid_shape", path: "when.all.0.value" }),
      ]);
      expect(isSafeMatchesLiteral(value)).toBe(false);
    },
  );

  it("rejects a matches value longer than 40 characters and accepts exactly 40", () => {
    const tooLong = withConds([{ feature: "message_matches", op: "matches", value: "a".repeat(41) }]);
    const maxLength = withConds([{ feature: "message_matches", op: "matches", value: "a".repeat(40) }]);
    expect(issueCodes(tooLong)).toContain("invalid_shape");
    expect(validateRule(maxLength, shipWeekPack).ok).toBe(true);
  });

  it("rejects a matches literal with no letter or digit, which U3's pattern allows", () => {
    for (const value of ["   ", "- -", "-"]) {
      expect(issueCodes(withConds([{ feature: "message_matches", op: "matches", value }]))).toEqual([
        "invalid_matches_literal",
      ]);
    }
  });

  it("rejects an empty or non-string matches value through U3's schema", () => {
    for (const value of ["", 5, ["typo"]]) {
      expect(issueCodes(withConds([{ feature: "message_matches", op: "matches", value }]))).toEqual(["invalid_shape"]);
    }
  });

  it("rejects an operator the pack does not allow on the feature", () => {
    expect(issueCodes(withConds([{ feature: "rename_only", op: "gt", value: 0 }]))).toEqual(["op_not_allowed"]);
    expect(issueCodes(withConds([{ feature: "touched_dirs", op: "eq", value: "docs" }]))).toEqual(["op_not_allowed"]);
    // The registered Ship Week pack allows only matches on message_matches.
    const eqMessage = withConds([{ feature: "message_matches", op: "eq", value: "wip" }]);
    expect(validateRule(eqMessage, getPack("ship_week")).ok).toBe(false);
  });

  it("rejects a value whose type does not match the feature", () => {
    expect(issueCodes(withConds([{ feature: "rename_only", op: "eq", value: "true" }]))).toEqual(["value_type_mismatch"]);
    expect(issueCodes(withConds([{ feature: "code_lines_changed", op: "eq", value: true }]))).toEqual([
      "value_type_mismatch",
    ]);
    expect(issueCodes(withConds([{ feature: "code_lines_changed", op: "in", value: [1, "2"] }]))).toEqual([
      "value_type_mismatch",
    ]);
    expect(issueCodes(withConds([{ feature: "touched_dirs", op: "in", value: [3] }]))).toEqual(["value_type_mismatch"]);
  });

  it("rejects a list value on eq through U3's schema", () => {
    expect(issueCodes(withConds([{ feature: "code_lines_changed", op: "eq", value: [1] }]))).toEqual(["invalid_shape"]);
  });

  it("rejects an empty string literal", () => {
    expect(issueCodes(withConds([{ feature: "message_matches", op: "eq", value: "" }]))).toEqual(["invalid_literal"]);
  });

  it("rejects a non-finite threshold", () => {
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(validateRule(withConds([{ feature: "code_lines_changed", op: "lt", value }]), shipWeekPack).ok).toBe(false);
    }
  });

  it("rejects a rule for another challenge type", () => {
    expect(issueCodes(ruleProposal({ challenge_type: "build_in_public" }))).toEqual(["challenge_type_mismatch"]);
  });

  it("rejects more conditions than U3's schema allows (8 per rule)", () => {
    const cond: Cond = { feature: "rename_only", op: "eq", value: true };
    expect(validateRule(withConds(Array.from({ length: 8 }, () => cond)), shipWeekPack).ok).toBe(true);
    expect(issueCodes(withConds(Array.from({ length: 9 }, () => cond)))).toContain("invalid_shape");
  });

  it("reports every bad condition, not just the first", () => {
    const candidate = withConds([
      { feature: "stars_gained", op: "gt", value: 3 },
      { feature: "code_lines_changed", op: "lt", value: 19.5 },
      { feature: "code_lines_changed", op: "lt", value: 99 },
      { feature: "message_matches", op: "matches", value: "- -" },
    ]);
    expect(issueCodes(candidate)).toEqual(["unknown_feature", "out_of_bounds", "invalid_matches_literal"]);
  });

  it("rejects malformed structure: unknown action, unknown op, bad feature name, empty or mixed when", () => {
    expect(issueCodes({ ...ruleProposal(), action: "delete" })).toEqual(["invalid_shape"]);
    expect(issueCodes(withConds([{ feature: "rename_only", op: "regex", value: "x" }]))).toContain("invalid_shape");
    expect(issueCodes(withConds([{ feature: "__proto__", op: "eq", value: true }]))).toContain("invalid_shape");
    expect(issueCodes(withConds([]))).toContain("invalid_shape");
    expect(
      issueCodes({ ...ruleProposal(), when: { all: [{ feature: "rename_only", op: "eq", value: true }], any: [] } }),
    ).toContain("invalid_shape");
    expect(issueCodes({ ...ruleProposal(), rule_key: "ship_week.rename_only" })).toContain("invalid_shape");
    expect(issueCodes(null)).toEqual(["invalid_shape"]);
  });
});

describe("validateWhen", () => {
  it("checks a bare predicate against the pack catalog", () => {
    expect(validateWhen({ all: [{ feature: "rename_only", op: "eq", value: true }] }, shipWeekPack).ok).toBe(true);

    const result = validateWhen({ any: [{ feature: "code_lines_changed", op: "gt", value: 30 }] }, shipWeekPack);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([expect.objectContaining({ code: "out_of_bounds", path: "any.0.value" })]);
    }
    expect(validateWhen({ all: [] }, shipWeekPack).ok).toBe(false);
  });
});

describe("isSafeMatchesLiteral", () => {
  it("accepts letters, digits, spaces and hyphens with at least one letter or digit", () => {
    expect(isSafeMatchesLiteral("fix typo")).toBe(true);
    expect(isSafeMatchesLiteral("WIP-2")).toBe(true);
    expect(isSafeMatchesLiteral("fix.typo")).toBe(false);
    expect(isSafeMatchesLiteral(" - ")).toBe(false);
    expect(isSafeMatchesLiteral("x".repeat(41))).toBe(false);
  });
});
