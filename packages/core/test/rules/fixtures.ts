// Test fixtures for the rule grammar and engine, built on U3's types. The
// catalog mirrors the Ship Week examples from the plan's rule grammar plus an
// `in`-capable number and a string_list feature, so grammar mechanics are
// tested independently of the real pack (U14 replaces it).

import type { GrammarPack } from "../../src/rules/grammar";
import { newId } from "../../src/schema/common";
import type { FeatureCatalog } from "../../src/schema/pack";
import type { RuleProposal } from "../../src/schema/rule";
import { RuleSchema, type Rule } from "../../src/schema/rules";

export const SHIP_WEEK = "ship_week";

export const shipWeekFeatures: FeatureCatalog = {
  rename_only: { kind: "boolean", description: "Every change only renames identifiers.", ops: ["eq"] },
  whitespace_only: { kind: "boolean", description: "Every change is whitespace.", ops: ["eq"] },
  docs_only: { kind: "boolean", description: "Only documentation files changed.", ops: ["eq"] },
  code_lines_changed: {
    kind: "number",
    description: "Added plus removed lines in code files.",
    ops: ["eq", "lt", "lte", "gt", "gte", "in"],
    bound: { min: 0, max: 20 },
  },
  message_matches: { kind: "string", description: "The commit message.", ops: ["eq", "in", "matches"] },
  touched_dirs: { kind: "string_list", description: "Top-level directories touched.", ops: ["in", "matches"] },
};

export const shipWeekPack: GrammarPack = { type: SHIP_WEEK, features: shipWeekFeatures };

/** A rule-writer proposal. Not parsed, so grammar tests can build invalid candidates. */
export function ruleProposal(overrides: Partial<RuleProposal> = {}): RuleProposal {
  return {
    challenge_type: SHIP_WEEK,
    parent: null,
    rule_key: "rename_only",
    when: { all: [{ feature: "rename_only", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "rename_only",
    reason: "Rename-only commits do not count.",
    source: "ai_judgment",
    evidence: { proof_ids: ["prf_1"], example_keys: [], dispute_ids: [] },
    ...overrides,
  };
}

/** A stored `rules` document, parsed with U3's RuleSchema so fixtures stay valid. */
export function ruleDocument(overrides: Partial<Rule> = {}): Rule {
  const now = new Date("2026-10-11T12:00:00.000Z");
  return RuleSchema.parse({
    _id: newId("rule"),
    rule_key: "rename_only",
    version: 1,
    parent_version: null,
    challenge_type: SHIP_WEEK,
    when: { all: [{ feature: "rename_only", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "rename_only",
    reason: "Rename-only commits do not count.",
    source: "ai_judgment",
    evidence: { proof_ids: ["prf_1"], example_keys: [], dispute_ids: [] },
    status: "active",
    test_results: null,
    approval_id: null,
    created_at: now,
    updated_at: now,
    activated_at: now,
    retired_at: null,
    ...overrides,
  });
}
