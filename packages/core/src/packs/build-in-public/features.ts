import type { Features, Id } from "../../schema/common";
import type { RecheckResult } from "../../schema/pack";
import type { Proof } from "../../schema/proofs";
import { PLATFORM_NAMES, isBipPlatform, type BipPlatform } from "./recheck";

/**
 * Build in Public feature extractor (U16 approach step 3).
 *
 * Features read the post text Lane re-fetched when the platform returns it (X), and the text
 * the agent sent otherwise. They describe the post only: word count, whether it names something
 * concrete, whether it nearly repeats one of the player's earlier posts, and whether the
 * re-fetch found it. The filler heuristics are deliberately plain and tested against the
 * labelled examples, so a learned rule over them can be gated (KTD9).
 */

// ------------------------------------------------------------------ words

/** A post with fewer words than this and no concrete detail is filler (AE3). */
export const FILLER_MAX_WORDS = 8;

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Words of a post: whitespace-separated tokens that contain a letter or digit. Hashtags and
 * mentions do not count, so a one-line post padded with tags still reads as one line.
 */
export function postWords(text: string): string[] {
  return text
    .split(/\s+/)
    .filter((t) => t !== "" && !t.startsWith("#") && !t.startsWith("@") && HAS_WORD_CHAR.test(t));
}

export function wordCount(text: string): number {
  return postWords(text).length;
}

// ------------------------------------------------------------------ concrete detail

const LINK = /\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|io|dev|app|ai|co|net|org|so|sh|xyz|me|gg|tech|site|page|link|ly)(?:\/\S*)?(?=$|[\s),.!?;:])/i;

const FILE =
  /\b[\w./-]*\w\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|cs|php|vue|svelte|html?|css|scss|sql|sh|ya?ml|json|toml|md|mdx|lock|csv|txt|png|jpe?g|gif|svg|mp4|pdf|ipynb|tf|prisma|graphql|proto)\b/i;

/** Inline code, camelCase or snake_case identifiers, and calls such as `parse()`. */
const CODE = /`[^`\s][^`]*`|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Za-z_]\w*\(\)/;

/**
 * Named product features. Generic words such as "feature", "bug", "stuff", "app" or "code" are
 * left out on purpose: "working on a feature" does not name one.
 */
const FEATURE_TERMS = [
  "api", "apis", "endpoints?", "webhooks?", "sdk", "cli", "dashboard", "onboarding", "sign[ -]?up", "log[ -]?in", "logout",
  "auth", "authentication", "oauth", "sso", "password reset", "checkout", "cart", "pricing", "paywall", "billing", "invoices?",
  "subscriptions?", "payments?", "stripe", "search", "filters?", "sorting", "pagination", "exports?", "imports?", "uploads?",
  "notifications?", "emails?", "newsletter", "landing page", "homepage", "waitlist", "settings page", "profile page", "forms?",
  "modals?", "charts?", "graphs?", "schema", "database", "migrations?", "queries", "query", "cache", "caching", "cron",
  "queue", "workers?", "tests?", "test suite", "e2e", "ci", "pipeline", "deploy", "deployment", "docker", "kubernetes",
  "dark mode", "light mode", "mobile app", "ios", "android", "browser extension", "plugin", "integrations?", "widgets?",
  "components?", "sidebar", "navbar", "editor", "parser", "scraper", "analytics", "metrics", "logging", "error handling",
  "rate limit(?:ing|s)?", "permissions", "roles", "admin panel", "referrals?", "leaderboard", "comments", "calendar",
  "maps?", "thumbnails?", "csv", "pdf", "graphql", "websockets?", "realtime", "offline mode", "backups?",
];
const FEATURE = new RegExp(`\\b(?:${FEATURE_TERMS.join("|")})\\b`, "i");

/** Day counters and tags are not concrete detail: "Day 3", "day 3/30", "week 2", "#100DaysOfCode". */
const NOT_A_DETAIL = [
  /[#@][\w-]+/g,
  /\bday\s*#?\s*\d+(?:\s*(?:\/|of)\s*\d+)?\b/gi,
  /\b\d+\s*(?:\/|of)\s*\d+\s*days?\b/gi,
  /\b\d+(?:st|nd|rd|th)\s+day\b/gi,
  /\bweek\s*#?\s*\d+\b/gi,
  /\b\d+\s*days?\s+of\s+\w+/gi,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
];

/** Whether the post names something concrete: a link, a file, code, a number or a named feature. */
export function hasConcreteDetail(text: string): boolean {
  if (LINK.test(text) || FILE.test(text)) return true;
  const stripped = NOT_A_DETAIL.reduce((t, re) => t.replace(re, " "), text);
  return CODE.test(stripped) || /\d/.test(stripped) || FEATURE.test(stripped);
}

// ------------------------------------------------------------------ near-duplicates

/** Similarity at or above this to an earlier post of the same player is a near-duplicate. */
export const NEAR_DUPLICATE_SIMILARITY = 0.85;
const SIMILARITY_CAP_CHARS = 1_000;

/** Lowercase, tags and links dropped, digits collapsed (so "Day 3" equals "Day 4"), punctuation to spaces. */
export function normalizeForSimilarity(text: string): string {
  return text
    .slice(0, SIMILARITY_CAP_CHARS)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\w-]+/g, " ")
    .replace(/\d+/g, "0")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams of the normalized texts, from 0 to 1. */
export function postSimilarity(a: string, b: string): number {
  const x = normalizeForSimilarity(a);
  const y = normalizeForSimilarity(b);
  if (x.length < 2 || y.length < 2) return 0;
  if (x === y) return 1;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  for (const [g, n] of bx) shared += Math.min(n, by.get(g) ?? 0);
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

export function isNearDuplicate(text: string, earlierTexts: readonly string[]): boolean {
  return earlierTexts.some((t) => postSimilarity(text, t) >= NEAR_DUPLICATE_SIMILARITY);
}

// ------------------------------------------------------------------ extractor

export interface BuildInPublicFeatureInput {
  proof: { post_text: string; platform: BipPlatform };
  /** Source key of this proof, so a re-submission of the same post never reads as a repeat. */
  sourceKey: string;
  recheck: RecheckResult | null;
  earlierProofs: readonly Pick<Proof, "player_id" | "source_key" | "payload">[];
  player_id: Id;
}

/** The text features read: Lane's re-fetched text when there is one, else the agent's. */
export function featureText(proof: { post_text: string }, recheck: RecheckResult | null): string {
  const source = recheck?.source;
  return source?.kind === "post" && source.text.trim() !== "" ? source.text : proof.post_text;
}

/** Features of one post. */
export function extractBuildInPublicFeatures(input: BuildInPublicFeatureInput): Features {
  const text = featureText(input.proof, input.recheck);
  const words = wordCount(text);
  const concrete = hasConcreteDetail(text);
  const earlier = input.earlierProofs
    .filter((p) => p.player_id === input.player_id && p.source_key !== input.sourceKey)
    .map((p) => (typeof p.payload.post_text === "string" ? p.payload.post_text : ""));
  return {
    word_count: words,
    has_concrete_detail: concrete,
    filler: words < FILLER_MAX_WORDS && !concrete,
    near_duplicate: isNearDuplicate(text, earlier),
    post_missing: input.recheck?.info?.found === false,
    platform: input.proof.platform,
  };
}

/** Lane-built feed line from features, for example "X post, 12 words" (KTD15). */
export function summarizeBuildInPublic(features: Features): string {
  const platform = isBipPlatform(features.platform) ? PLATFORM_NAMES[features.platform] : "Build in Public";
  const words = Number(features.word_count ?? 0);
  return `${platform} post, ${words} ${words === 1 ? "word" : "words"}`;
}
