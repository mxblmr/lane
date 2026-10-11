import { z } from "zod";
import type { Pack } from "../../schema/pack";
import { LabelledExampleSchema } from "../../schema/examples";
import { shipWeekContract } from "./contract";
import { extractShipWeekFeatures, summarizeShipWeek } from "./features";
import { SHIP_WEEK_CHEAT_CLASSES, SHIP_WEEK_FEATURES, SHIP_WEEK_SEED_RULES } from "./predicates";
import { recheckCommit, verifyGitHubHandle } from "./recheck";
import examplesJson from "./examples.json";

/**
 * Ship Week pack (U14): R1 counts a meaningful commit on the player's own project on each day.
 * Proof is a repository and a full commit SHA; Lane re-checks it on GitHub (R16, KTD14), binds
 * the GitHub handle through the profile bio (KTD21), and extracts the features the rules read.
 */

export { SHIP_WEEK_CHEAT_CLASSES, SHIP_WEEK_FEATURES, SHIP_WEEK_SEED_RULES } from "./predicates";
export { SHIP_WEEK_DOES_NOT_COUNT, ShipWeekParamsSchema, shipWeekContract } from "./contract";
export { extractShipWeekFeatures, parseCappedDiff, renderCappedDiff, summarizeShipWeek } from "./features";
export { GITHUB_API, GITHUB_TOKEN_ENV, commitToRecheck, recheckCommit, verifyGitHubHandle } from "./recheck";

const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** Accept `owner/name`, a GitHub URL, or either with `.git` or a trailing slash. */
export function normalizeRepo(raw: string): string {
  return raw
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

export const ShipWeekProofSchema = z.object({
  repo: z
    .string()
    .transform(normalizeRepo)
    .refine((r) => {
      const parts = r.split("/");
      return parts.length === 2 && parts.every((p) => REPO_PART.test(p) && p !== "." && p !== "..");
    }, "Send the repository as owner/name."),
  sha: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40}$/, "Send the full 40-character commit SHA, not a short SHA."),
  /** Optional time the agent saw; the re-check's author date wins (KTD13). */
  source_time: z.iso.datetime({ offset: true }).optional(),
});
export type ShipWeekProof = z.infer<typeof ShipWeekProofSchema>;

export const SHIP_WEEK_EXAMPLES = z.array(LabelledExampleSchema).parse(examplesJson);

export const shipWeekPack: Pack<ShipWeekProof> = {
  type: "ship_week",
  title: "Ship Week",
  proofSchema: ShipWeekProofSchema,
  /** The full 40-character lowercase SHA. */
  sourceKey: (proof) => proof.sha,
  sourceTime: (proof, recheck) =>
    recheck?.source?.created_at ?? (proof.source_time ? new Date(proof.source_time) : null),
  handlePlatform: () => "github",
  features: SHIP_WEEK_FEATURES,
  extractFeatures: ({ recheck, openRequests, challenge }) =>
    extractShipWeekFeatures({ recheck, openRequests, challenge }),
  recheck: (proof, _player, handle, ctx) => recheckCommit(proof, handle, ctx),
  verifyHandle: (handle, bindCode, ctx) => verifyGitHubHandle(handle, bindCode, ctx),
  /** Commits are addressed by full SHA and cannot change, so the verdict-time re-check is final. */
  finalCheck: async () => ({ not_counted: [], requests: [] }),
  cheatClasses: SHIP_WEEK_CHEAT_CLASSES,
  scoreUnit: "days",
  contract: shipWeekContract,
  seedRules: SHIP_WEEK_SEED_RULES,
  examples: SHIP_WEEK_EXAMPLES,
  summarize: summarizeShipWeek,
};
