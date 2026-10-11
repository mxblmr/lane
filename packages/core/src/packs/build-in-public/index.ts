import { z } from "zod";
import type { FeatureCatalog, Pack } from "../../schema/pack";
import { genericValue } from "../../schema/pack";

/**
 * STUB Build in Public pack (U3). U16 replaces this folder (including the oEmbed re-check and
 * the final re-fetch). Keep the export name.
 */

export const BIP_PLATFORMS = ["x", "instagram", "linkedin", "threads"] as const;

/** Post id from a post URL: the last path segment of digits or word characters. */
export function postIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const id = [...segments].reverse().find((s) => /^[A-Za-z0-9_-]{5,}$/.test(s));
    return id ?? null;
  } catch {
    return null;
  }
}

export const BuildInPublicProofSchema = z
  .object({
    post_url: z.url({ message: "Send the full post URL." }),
    platform: z.enum(BIP_PLATFORMS),
    post_text: z.string().max(4000).default(""),
    source_time: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((p) => postIdFromUrl(p.post_url) !== null, { message: "Send the post's own URL, not a profile URL.", path: ["post_url"] });
export type BuildInPublicProof = z.infer<typeof BuildInPublicProofSchema>;

export const BIP_FEATURES: FeatureCatalog = {
  word_count: { kind: "number", description: "Words in the post.", ops: ["lt", "lte", "gt", "gte"], bound: { min: 0, max: 30 } },
  has_concrete_detail: { kind: "boolean", description: "Names a file, feature, number or link.", ops: ["eq"] },
  filler: { kind: "boolean", description: "Short post with no concrete detail.", ops: ["eq"] },
  near_duplicate: { kind: "boolean", description: "Nearly identical to an earlier post.", ops: ["eq"] },
  post_missing: { kind: "boolean", description: "The re-fetch did not find the post.", ops: ["eq"] },
  platform: { kind: "string", description: "Platform of the post.", ops: ["eq", "in"] },
};

export const BIP_CHEAT_CLASSES = ["filler", "near_duplicate", "post_missing"] as const;

export const buildInPublicPack: Pack<BuildInPublicProof> = {
  type: "build_in_public",
  title: "Build in Public",
  proofSchema: BuildInPublicProofSchema,
  sourceKey: (proof) => `${proof.platform}:${postIdFromUrl(proof.post_url)}`,
  sourceTime: (proof, recheck) =>
    recheck?.source?.created_at ?? (proof.source_time ? new Date(proof.source_time) : null),
  handlePlatform: (challenge) => {
    const platforms = challenge.params.platforms;
    const first = Array.isArray(platforms) ? platforms[0] : typeof platforms === "string" ? platforms : null;
    return first === "x" || first === "instagram" || first === "linkedin" || first === "threads" ? first : "x";
  },
  features: BIP_FEATURES,
  extractFeatures: ({ proof }) => {
    const words = proof.post_text.trim().split(/\s+/).filter(Boolean).length;
    const concrete = /\d|https?:\/\/|\.\w{1,4}\b/.test(proof.post_text);
    return {
      word_count: words,
      has_concrete_detail: concrete,
      filler: words < 8 && !concrete,
      near_duplicate: false,
      post_missing: false,
      platform: proof.platform,
    };
  },
  recheck: async () => ({ status: "agent_attested", source: null, reason: null, info: {} }),
  verifyHandle: async () => ({ verified: false, reason: "Handle verification is not implemented yet (U16)." }),
  finalCheck: async () => ({ not_counted: [], requests: [] }),
  cheatClasses: BIP_CHEAT_CLASSES,
  scoreUnit: "days",
  contract: {
    paramsSchema: z.object({ platforms: z.array(z.enum(BIP_PLATFORMS)).min(1) }),
    requiredDraftFields: ["platforms"],
    render: ({ goal, days, params }) => ({
      send: [`For each day, the URL, platform and text of one build-log post on ${(params.platforms as string[] | undefined)?.join(", ") ?? "an agreed platform"}.`],
      scoring: `One real build-log post counts for that day. Reach ${goal} of ${days} days.`,
      extra_proof: ["A fresh re-fetch of the post."],
      agent_instructions: "Each day, find the player's build-log post and call lane_submit_proof with post_url, platform and post_text.",
    }),
    doesNotCount: {
      filler: () => "the post is short filler with no concrete detail",
      near_duplicate: () => "the post repeats an earlier post",
      post_missing: () => "the post can no longer be found",
      word_count: (c) => `the post has ${c.op === "lt" || c.op === "lte" ? "at most" : "at least"} ${genericValue(c)} words`,
      platform: (c) => `the post is on ${genericValue(c)}`,
    },
  },
  seedRules: [],
  examples: [],
  summarize: (f) => `post on ${String(f.platform ?? "a platform")}, ${Number(f.word_count ?? 0)} words`,
};
