// Test fixtures for the rule grammar and engine. The catalog mirrors the Ship
// Week examples from the plan's rule grammar; it is not the real pack (U14).

import type { PackRuleCatalog, RuleDefinition, RuleDocument } from "../../src/rules/_u3-shim";

export const SHIP_WEEK = "ship_week";

export const shipWeekCatalog: PackRuleCatalog = {
  challenge_type: SHIP_WEEK,
  features: {
    rename_only: { type: "boolean" },
    whitespace_only: { type: "boolean" },
    docs_only: { type: "boolean" },
    code_lines_changed: { type: "number", bounds: { min: 0, max: 20 } },
    message_matches: { type: "string" },
  },
};

export function ruleDefinition(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    rule_key: "ship_week.rename_only",
    version: 1,
    parent_version: null,
    challenge_type: SHIP_WEEK,
    when: { all: [{ feature: "rename_only", op: "eq", value: true }] },
    action: "reject",
    reason: "Rename-only commits do not count.",
    source: "ai_judgment",
    evidence: ["proof_1"],
    ...overrides,
  };
}

export function ruleDocument(overrides: Partial<RuleDocument> = {}): RuleDocument {
  return { ...ruleDefinition(), status: "active", ...overrides };
}
