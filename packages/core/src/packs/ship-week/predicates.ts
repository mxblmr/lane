import type { FeatureCatalog, SeedRule } from "../../schema/pack";

/**
 * Ship Week predicate menu (KTD8). Each feature is something the rule-writer may put in a
 * rule's `when`, with the operators it allows and its hard bound (KTD9). U4 validates every
 * candidate against this catalog. The names are the catalog U3 published; U14 adds
 * `docs_lines_changed`, `lines_added`, `lines_removed` and `has_bind_code`.
 */

const NUMBER_OPS = ["lt", "lte", "gt", "gte", "eq"] as const;

export const SHIP_WEEK_FEATURES: FeatureCatalog = {
  rename_only: {
    kind: "boolean",
    description: "Every changed line only renames an identifier (each removed line maps to an added line that differs by one identifier).",
    ops: ["eq"],
  },
  whitespace_only: { kind: "boolean", description: "Every change is whitespace: indentation, blank lines or trailing spaces.", ops: ["eq"] },
  docs_only: { kind: "boolean", description: "Only documentation files changed (Markdown, reStructuredText, README, LICENSE, CHANGELOG).", ops: ["eq"] },
  typo_only: { kind: "boolean", description: "At most three lines changed, each by at most three characters inside a comment, a string or a docs file.", ops: ["eq"] },
  empty_commit: { kind: "boolean", description: "The commit changes no lines.", ops: ["eq"] },
  backdated: {
    kind: "boolean",
    description: "The commit's author date falls on an earlier challenge day than its committer date.",
    ops: ["eq"],
  },
  injection_text: { kind: "boolean", description: "The message or an added line tries to instruct the reviewer.", ops: ["eq"] },
  code_lines_changed: {
    kind: "number",
    description: "Added plus removed lines in code files.",
    ops: NUMBER_OPS,
    bound: { min: 0, max: 20 },
  },
  docs_lines_changed: {
    kind: "number",
    description: "Added plus removed lines in documentation files.",
    ops: NUMBER_OPS,
    bound: { min: 0, max: 20 },
  },
  lines_added: { kind: "number", description: "Lines added across all files.", ops: NUMBER_OPS, bound: { min: 0, max: 20 } },
  lines_removed: { kind: "number", description: "Lines removed across all files.", ops: NUMBER_OPS, bound: { min: 0, max: 20 } },
  files_changed: { kind: "number", description: "Files touched.", ops: NUMBER_OPS, bound: { min: 0, max: 50 } },
  message_matches: { kind: "string", description: "The commit message, for literal substring tests.", ops: ["matches"] },
  has_open_code: {
    kind: "boolean",
    description: "The message contains the code of an open one-time code request (extra proof or surprise check).",
    ops: ["eq"],
  },
  has_bind_code: {
    kind: "boolean",
    description: "The message contains an open bind code. Information only: a commit never verifies a handle (KTD21).",
    ops: ["eq"],
  },
};

/** Cheat class ids. Each matches a boolean feature name. */
export const SHIP_WEEK_CHEAT_CLASSES = [
  "typo_only",
  "whitespace_only",
  "rename_only",
  "docs_only",
  "empty_commit",
  "backdated",
  "injection_text",
] as const;
export type ShipWeekCheatClass = (typeof SHIP_WEEK_CHEAT_CLASSES)[number];

/**
 * Seed rules (stored as version 1 with source `seed`). They deliberately leave rename_only,
 * whitespace_only, docs_only and typo_only to the learning loop: AE1 needs the first
 * rename-only commit to reach the AI reviewer, and the learned rule must raise the
 * rename_only catch rate by at least 10 points (KTD9).
 */
export const SHIP_WEEK_SEED_RULES: readonly SeedRule[] = [
  {
    rule_key: "sw-empty-commit",
    when: { all: [{ feature: "empty_commit", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "empty_commit",
    reason: "Seed: a commit that changes no lines is not a meaningful commit.",
  },
  {
    rule_key: "sw-backdated",
    when: { all: [{ feature: "backdated", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "backdated",
    reason: "Seed: a commit authored on an earlier day than it was committed does not count for that earlier day.",
  },
  {
    rule_key: "sw-injection",
    when: { all: [{ feature: "injection_text", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "injection_text",
    reason: "Seed: a commit that tries to instruct the reviewer does not count (KTD18).",
  },
];
