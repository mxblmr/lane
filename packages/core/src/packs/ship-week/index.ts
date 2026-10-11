import { z } from "zod";
import type { Features } from "../../schema/common";
import type { FeatureCatalog, Pack, RecheckResult } from "../../schema/pack";
import { genericValue } from "../../schema/pack";

/**
 * STUB Ship Week pack (U3). U14 replaces this folder with the real features, predicates,
 * GitHub re-check, contract text, seed rules and labelled examples. Keep the export name.
 * The feature names below are the agreed catalog other units code against.
 */

export const ShipWeekProofSchema = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Send the repository as owner/name."),
  sha: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40}$/, "Send the full 40-character commit SHA, not a short SHA."),
  source_time: z.iso.datetime({ offset: true }).optional(),
});
export type ShipWeekProof = z.infer<typeof ShipWeekProofSchema>;

export const SHIP_WEEK_FEATURES: FeatureCatalog = {
  rename_only: { kind: "boolean", description: "Every change only renames identifiers.", ops: ["eq"] },
  whitespace_only: { kind: "boolean", description: "Every change is whitespace.", ops: ["eq"] },
  docs_only: { kind: "boolean", description: "Only documentation files changed.", ops: ["eq"] },
  typo_only: { kind: "boolean", description: "Only a few characters changed in comments or strings.", ops: ["eq"] },
  empty_commit: { kind: "boolean", description: "The commit changes no lines.", ops: ["eq"] },
  backdated: { kind: "boolean", description: "Commit date is before the challenge day it claims.", ops: ["eq"] },
  injection_text: { kind: "boolean", description: "The message tries to instruct the reviewer.", ops: ["eq"] },
  code_lines_changed: {
    kind: "number",
    description: "Added plus removed lines in code files.",
    ops: ["lt", "lte", "gt", "gte", "eq"],
    bound: { min: 0, max: 20 },
  },
  files_changed: { kind: "number", description: "Files touched.", ops: ["lt", "lte", "gt", "gte", "eq"], bound: { min: 0, max: 50 } },
  message_matches: { kind: "string", description: "The commit message, for literal substring tests.", ops: ["matches"] },
  has_open_code: { kind: "boolean", description: "The message contains an open one-time code.", ops: ["eq"] },
};

export const SHIP_WEEK_CHEAT_CLASSES = [
  "typo_only",
  "whitespace_only",
  "rename_only",
  "docs_only",
  "empty_commit",
  "backdated",
  "injection_text",
] as const;

const ShipWeekParamsSchema = z.object({});

function stubFeatures(recheck: RecheckResult | null): Features {
  const stats = recheck?.source?.stats ?? null;
  const lines = stats ? stats.additions + stats.deletions : 0;
  return {
    rename_only: false,
    whitespace_only: false,
    docs_only: false,
    typo_only: false,
    empty_commit: stats ? lines === 0 : false,
    backdated: false,
    injection_text: false,
    code_lines_changed: lines,
    files_changed: stats?.files ?? 0,
    message_matches: recheck?.source?.text.slice(0, 500) ?? "",
    has_open_code: false,
  };
}

export const shipWeekPack: Pack<ShipWeekProof> = {
  type: "ship_week",
  title: "Ship Week",
  proofSchema: ShipWeekProofSchema,
  sourceKey: (proof) => proof.sha,
  sourceTime: (proof, recheck) =>
    recheck?.source?.created_at ?? (proof.source_time ? new Date(proof.source_time) : null),
  handlePlatform: () => "github",
  features: SHIP_WEEK_FEATURES,
  extractFeatures: ({ recheck }) => stubFeatures(recheck),
  recheck: async () => ({
    status: "pending",
    source: null,
    reason: "Ship Week re-check is not implemented yet (U14).",
    info: {},
  }),
  verifyHandle: async () => ({ verified: false, reason: "Handle verification is not implemented yet (U14)." }),
  finalCheck: async () => ({ not_counted: [], requests: [] }),
  cheatClasses: SHIP_WEEK_CHEAT_CLASSES,
  scoreUnit: "days",
  contract: {
    paramsSchema: ShipWeekParamsSchema,
    requiredDraftFields: [],
    render: ({ goal, days }) => ({
      send: ["For each day, the repository (owner/name) and the full 40-character SHA of one commit you made that day."],
      scoring: `One meaningful commit on your own project counts for that day. Reach ${goal} of ${days} days.`,
      extra_proof: ["A one-time code in your next commit message."],
      agent_instructions:
        "Each day, find the player's commit on their own project and call lane_submit_proof with repo and sha. " +
        "Relay one-time code requests to the player; you cannot write the commit yourself.",
    }),
    doesNotCount: {
      rename_only: () => "the commit only renames identifiers",
      whitespace_only: () => "the commit only changes whitespace",
      docs_only: () => "the commit only changes documentation",
      typo_only: () => "the commit only fixes a typo",
      empty_commit: () => "the commit changes no lines",
      backdated: () => "the commit is backdated",
      injection_text: () => "the commit message tries to instruct the reviewer",
      code_lines_changed: (c) => `the commit changes ${c.op === "lt" || c.op === "lte" ? "at most" : "at least"} ${genericValue(c)} code lines`,
      message_matches: (c) => `the commit message contains ${genericValue(c)}`,
    },
  },
  seedRules: [],
  examples: [],
  summarize: (f) => `commit, ${Number(f.files_changed ?? 0)} files, ${Number(f.code_lines_changed ?? 0)} lines`,
};
