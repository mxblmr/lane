import { z } from "zod";
import type { HandlePlatform } from "../../schema/common";
import type { Pack } from "../../schema/pack";
import type { Proof } from "../../schema/proofs";
import { LabelledExampleSchema } from "../../schema/examples";
import { buildInPublicContract } from "./contract";
import { extractBuildInPublicFeatures, summarizeBuildInPublic } from "./features";
import { BIP_CHEAT_CLASSES, BIP_FEATURES, BIP_SEED_RULES } from "./predicates";
import {
  BIP_PLATFORMS,
  PLATFORM_NAMES,
  TEXT_REFETCH_PLATFORMS,
  finalCheckPosts,
  isBipPlatform,
  parsePostUrl,
  postTimeFromId,
  recheckPost,
  verifyPostHandle,
  type BipPlatform,
} from "./recheck";
import examplesJson from "./examples.json";

/**
 * Build in Public pack (U16): R3 counts a real build-log post on each day of the window.
 * Proof is the post URL, platform and text. Lane re-fetches the post where the platform's
 * public endpoint allows it (R16, KTD14), re-fetches every counted post at the final check and
 * stops counting deleted ones (R27, AE3), and extracts the features the rules read. What each
 * platform's endpoint returns is recorded in this folder's README.
 */

export { BIP_CHEAT_CLASSES, BIP_FEATURES, BIP_SEED_RULES } from "./predicates";
export { BIP_DOES_NOT_COUNT, BuildInPublicParamsSchema, buildInPublicContract, platformList } from "./contract";
export {
  FILLER_MAX_WORDS,
  NEAR_DUPLICATE_SIMILARITY,
  extractBuildInPublicFeatures,
  hasConcreteDetail,
  isNearDuplicate,
  postSimilarity,
  postWords,
  summarizeBuildInPublic,
  wordCount,
} from "./features";
export {
  BIP_PLATFORMS,
  EXISTENCE_REFETCH_PLATFORMS,
  INSTAGRAM_OEMBED,
  PLATFORM_NAMES,
  TEXT_REFETCH_PLATFORMS,
  THREADS_OEMBED,
  X_OEMBED,
  fetchOembed,
  finalCheckPosts,
  parsePostUrl,
  postIdFromUrl,
  postTimeFromId,
  recheckPost,
  verifyPostHandle,
  xTextFromEmbedHtml,
  type BipPlatform,
  type ParsedPost,
} from "./recheck";

/** Agents write "twitter" or "X"; Lane stores the lowercase platform id. */
const PLATFORM_ALIASES: Record<string, BipPlatform> = { twitter: "x", ig: "instagram" };

function normalizePlatform(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  return PLATFORM_ALIASES[v] ?? v;
}

/**
 * The proof parse keeps only what the referee needs (KTD15): the post URL reduced to Lane's
 * canonical form (tracking parameters dropped), the platform, the post text capped at 4,000
 * characters, and the optional time the agent saw.
 */
export const BuildInPublicProofSchema = z
  .object({
    post_url: z.string().trim().max(500, "Send the post's own URL."),
    platform: z.preprocess(
      normalizePlatform,
      z.enum(BIP_PLATFORMS, { message: "Send the platform as x, instagram, linkedin or threads." }),
    ),
    post_text: z.string().max(4000).default("").transform((t) => t.trim()),
    /** Optional time the agent saw; a time read from the post id or the re-fetch wins (KTD13). */
    source_time: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((p, ctx) => {
    const post = parsePostUrl(p.post_url);
    if (!post) {
      ctx.addIssue({
        code: "custom",
        path: ["post_url"],
        message: "Send the post's own URL on X, Instagram, LinkedIn or Threads, not a profile URL.",
      });
    } else if (post.platform !== p.platform) {
      ctx.addIssue({
        code: "custom",
        path: ["platform"],
        message: `This URL is a ${PLATFORM_NAMES[post.platform]} post. Send platform ${post.platform}.`,
      });
    }
  })
  .transform((p) => ({ ...p, post_url: parsePostUrl(p.post_url)?.canonical_url ?? p.post_url }));
export type BuildInPublicProof = z.infer<typeof BuildInPublicProofSchema>;

/** `platform:post_id`, so two URLs for the same post share one key. */
export function buildInPublicSourceKey(proof: Pick<BuildInPublicProof, "post_url" | "platform">): string {
  const post = parsePostUrl(proof.post_url);
  return `${proof.platform}:${post?.post_id ?? proof.post_url}`;
}

function payloadProof(payload: Proof["payload"]): BuildInPublicProof | null {
  const parsed = BuildInPublicProofSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export const BIP_EXAMPLES = z.array(LabelledExampleSchema).parse(examplesJson);

export const buildInPublicPack: Pack<BuildInPublicProof> = {
  type: "build_in_public",
  title: "Build in Public",
  proofSchema: BuildInPublicProofSchema,
  sourceKey: buildInPublicSourceKey,
  /** The re-fetch's post time, else the time encoded in the post id, else the agent's time. */
  sourceTime: (proof, recheck) => {
    if (recheck?.source?.created_at) return recheck.source.created_at;
    const post = parsePostUrl(proof.post_url);
    const fromId = post ? postTimeFromId(post.platform, post.post_id) : null;
    return fromId ?? (proof.source_time ? new Date(proof.source_time) : null);
  },
  /**
   * KTD21: bind the handle on a platform where Lane can check a post's author (X) when the
   * challenge allows one, otherwise on the challenge's first platform.
   */
  handlePlatform: (challenge): HandlePlatform => {
    const raw = challenge.params.platforms;
    const list = (Array.isArray(raw) ? raw : [raw]).filter(isBipPlatform);
    return list.find((p) => TEXT_REFETCH_PLATFORMS.includes(p)) ?? list[0] ?? "x";
  },
  features: BIP_FEATURES,
  extractFeatures: ({ proof, recheck, earlierProofs, player_id }) =>
    extractBuildInPublicFeatures({ proof, sourceKey: buildInPublicSourceKey(proof), recheck, earlierProofs, player_id }),
  recheck: (proof, _player, handle, ctx) => recheckPost(proof, handle, ctx),
  verifyHandle: (handle, bindCode, ctx) => verifyPostHandle(handle, bindCode, ctx),
  finalCheck: (challenge, proofs, ctx) => finalCheckPosts(challenge, proofs, ctx, payloadProof),
  cheatClasses: BIP_CHEAT_CLASSES,
  scoreUnit: "days",
  contract: buildInPublicContract,
  seedRules: BIP_SEED_RULES,
  examples: BIP_EXAMPLES,
  summarize: summarizeBuildInPublic,
};
