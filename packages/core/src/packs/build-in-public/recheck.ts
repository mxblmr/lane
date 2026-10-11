import type { Challenge } from "../../schema/challenges";
import type { NewInboxItem } from "../../schema/inbox";
import type { FinalCheckResult, PackContext, RecheckResult, RecheckSource } from "../../schema/pack";
import { normalizeHandle, type Handle } from "../../schema/players";
import { COUNTING_PROOF_STATUSES, type Proof } from "../../schema/proofs";
import { QUOTE_CAP_CHARS, REAL_GRACE_SEC } from "../../config";
import { graceDeadline } from "../../clock";

/**
 * Build in Public post addressing, re-fetch (R16, KTD14), final check (R27) and handle
 * verification (KTD21).
 *
 * Every network call goes through `ctx.fetch`, so tests pass a fixture double and never reach
 * the network. No call sends a token. What each platform's public endpoint returns without an
 * app token is recorded in this folder's README:
 * - X: `publish.x.com/oembed` returns the post text and the author, so X posts are re-checked.
 * - Instagram and Threads: Meta's oEmbed endpoints confirm that a post exists but return
 *   neither its text nor its author, so those posts stay agent-attested while a deletion is
 *   still caught.
 * - LinkedIn: no public oEmbed endpoint, so posts are agent-attested and the final check asks
 *   the player's Muse for a fresh fetch.
 * A failure never throws: it becomes `pending` (try again), `agent_attested` (Lane could not
 * confirm), or a Muse re-fetch request at the final check.
 */

export const BIP_PLATFORMS = ["x", "instagram", "linkedin", "threads"] as const;
export type BipPlatform = (typeof BIP_PLATFORMS)[number];

export const PLATFORM_NAMES: Record<BipPlatform, string> = {
  x: "X",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  threads: "Threads",
};

export function isBipPlatform(value: unknown): value is BipPlatform {
  return typeof value === "string" && (BIP_PLATFORMS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------ post URLs

export interface ParsedPost {
  platform: BipPlatform;
  /** The platform's own post id: a numeric id (X, LinkedIn) or a case-sensitive shortcode. */
  post_id: string;
  /** Lane's canonical URL for the post, without tracking parameters. */
  canonical_url: string;
}

const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const THREADS_HOSTS = new Set(["threads.net", "www.threads.net", "threads.com", "www.threads.com"]);
/** linkedin.com, www.linkedin.com, and country or mobile subdomains such as ca.linkedin.com. */
const LINKEDIN_HOST = /^(?:[a-z]{2,3}\.)?linkedin\.com$/;

const X_PATH = /^\/(?:i\/web|[A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:\/|$)/;
const INSTAGRAM_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]{5,40})(?:\/|$)/;
const THREADS_PATH = /^\/(?:@[A-Za-z0-9._]{1,30}\/post|t)\/([A-Za-z0-9_-]{5,40})(?:\/|$)/;
const LINKEDIN_FEED_PATH = /^\/(?:embed\/)?feed\/update\/urn:li:(activity|share|ugcPost):(\d{15,22})(?:\/|$)/;
const LINKEDIN_POSTS_PATH = /^\/posts\/[^/]*?-(activity|share|ugcPost)-(\d{15,22})(?:-[A-Za-z0-9_-]*)?(?:\/|$)/;

/**
 * Parse a post URL into its platform, post id and canonical URL, or null when it is not the URL
 * of one post (a profile URL, another site, or a malformed URL). Two URLs for the same post
 * (twitter.com and x.com, a share link with tracking parameters, threads.net and threads.com,
 * a LinkedIn `posts/` slug and its `feed/update` URN) parse to the same post id.
 */
export function parsePostUrl(raw: string): ParsedPost | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (X_HOSTS.has(host)) {
    const m = X_PATH.exec(path);
    if (!m?.[1]) return null;
    const id = BigInt(m[1]).toString();
    return { platform: "x", post_id: id, canonical_url: `https://x.com/i/status/${id}` };
  }
  if (INSTAGRAM_HOSTS.has(host)) {
    const m = INSTAGRAM_PATH.exec(path);
    if (!m?.[1]) return null;
    return { platform: "instagram", post_id: m[1], canonical_url: `https://www.instagram.com/p/${m[1]}/` };
  }
  if (THREADS_HOSTS.has(host)) {
    const m = THREADS_PATH.exec(path);
    if (!m?.[1]) return null;
    return { platform: "threads", post_id: m[1], canonical_url: `https://www.threads.com/t/${m[1]}` };
  }
  if (LINKEDIN_HOST.test(host)) {
    const m = LINKEDIN_FEED_PATH.exec(path) ?? LINKEDIN_POSTS_PATH.exec(path);
    if (!m?.[1] || !m[2]) return null;
    const id = BigInt(m[2]).toString();
    return { platform: "linkedin", post_id: id, canonical_url: `https://www.linkedin.com/feed/update/urn:li:${m[1]}:${id}/` };
  }
  return null;
}

/** The post id alone, or null when the URL is not one post's URL. */
export function postIdFromUrl(url: string): string | null {
  return parsePostUrl(url)?.post_id ?? null;
}

/** X ids since November 2010 are snowflakes: the top bits are milliseconds since this epoch. */
const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657;
/** Below this, an X id predates snowflakes and carries no time. */
const X_FIRST_SNOWFLAKE = 300_000_000_000_000n;
const EARLIEST_POST_MS = Date.UTC(2010, 10, 4);
const LATEST_POST_MS = Date.UTC(2100, 0, 1);

/**
 * When the post was created, read from its id where the platform encodes it: X snowflake ids
 * and LinkedIn activity, share and ugcPost ids carry a millisecond timestamp in their top bits.
 * The agent cannot change this time, so it outranks the agent's `source_time`. Null otherwise.
 */
export function postTimeFromId(platform: BipPlatform, postId: string): Date | null {
  if (!/^\d{1,22}$/.test(postId)) return null;
  const id = BigInt(postId);
  let ms: number;
  if (platform === "x") {
    if (id < X_FIRST_SNOWFLAKE) return null;
    ms = Number(id >> 22n) + X_SNOWFLAKE_EPOCH_MS;
  } else if (platform === "linkedin") {
    ms = Number(id >> 22n);
  } else {
    return null;
  }
  return ms >= EARLIEST_POST_MS && ms < LATEST_POST_MS ? new Date(ms) : null;
}

// ------------------------------------------------------------------ public endpoints

export const X_OEMBED = "https://publish.x.com/oembed";
export const INSTAGRAM_OEMBED = "https://graph.facebook.com/v25.0/instagram_oembed";
export const THREADS_OEMBED = "https://graph.threads.net/v1.0/oembed";
const OEMBED_TIMEOUT_MS = 8_000;
/** Meta's Graph API error code for media that does not exist or cannot be embedded. */
const META_MEDIA_NOT_FOUND = 24;

/** Platforms whose public endpoint returns the post text and author. */
export const TEXT_REFETCH_PLATFORMS: readonly BipPlatform[] = ["x"];
/** Platforms whose public endpoint confirms only that the post still exists. */
export const EXISTENCE_REFETCH_PLATFORMS: readonly BipPlatform[] = ["instagram", "threads"];

export function oembedUrl(post: ParsedPost): string | null {
  const target = encodeURIComponent(post.canonical_url);
  switch (post.platform) {
    case "x":
      return `${X_OEMBED}?url=${target}&omit_script=true&dnt=true`;
    case "instagram":
      return `${INSTAGRAM_OEMBED}?url=${target}`;
    case "threads":
      return `${THREADS_OEMBED}?url=${target}`;
    case "linkedin":
      return null;
  }
}

/**
 * - found: the endpoint returned the post.
 * - not_found: the endpoint answered that the post does not exist (deleted, private or wrong).
 * - unavailable: the endpoint gave no usable answer that will change on retry (it wants a token,
 *   or returned an unexpected status or body), so Lane cannot confirm the post either way.
 * - transient: a timeout, network error, rate limit or server error; try again later.
 */
export type Refetch =
  | { kind: "found"; body: Record<string, unknown> }
  | { kind: "not_found"; status: number }
  | { kind: "unavailable"; detail: string }
  | { kind: "transient"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function metaErrorCode(body: unknown): { code: number | null; transient: boolean } {
  const err = isRecord(body) && isRecord(body.error) ? body.error : null;
  return { code: typeof err?.code === "number" ? err.code : null, transient: err?.is_transient === true };
}

/** Fetch a post's public oEmbed and classify the answer. Never throws. */
export async function fetchOembed(post: ParsedPost, ctx: PackContext): Promise<Refetch> {
  const url = oembedUrl(post);
  if (!url) return { kind: "unavailable", detail: "no public endpoint" };
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "lane-verifier" },
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "error";
    return { kind: "transient", detail: name === "TimeoutError" ? "timeout" : "network error" };
  }
  if (res.status === 429 || res.status >= 500) return { kind: "transient", detail: `status ${res.status}` };
  const body = await readJson(res);
  if (res.ok) {
    return isRecord(body) && typeof body.html === "string"
      ? { kind: "found", body }
      : { kind: "unavailable", detail: "unexpected body" };
  }
  if (post.platform === "x") {
    return res.status === 404 ? { kind: "not_found", status: 404 } : { kind: "unavailable", detail: `status ${res.status}` };
  }
  const meta = metaErrorCode(body);
  if (meta.transient) return { kind: "transient", detail: `status ${res.status}` };
  if (meta.code === META_MEDIA_NOT_FOUND) return { kind: "not_found", status: res.status };
  return { kind: "unavailable", detail: `status ${res.status}${meta.code !== null ? ` code ${meta.code}` : ""}` };
}

// ------------------------------------------------------------------ X embed parsing

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  hellip: "...",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * The post text from X's embed HTML: the first paragraph of the blockquote, with line breaks
 * kept, tags dropped (a link keeps its visible text) and entities decoded. Lane never stores or
 * renders the HTML itself (KTD16). Null when the HTML has no paragraph.
 */
export function xTextFromEmbedHtml(html: string): string | null {
  const m = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (!m) return null;
  const text = (m[1] ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "");
  return decodeEntities(text).replace(/[ \t]+\n/g, "\n").trim();
}

const X_HANDLE = /^[a-z0-9_]{1,15}$/;

/** The author handle from the oEmbed `author_url`, normalized, or null. */
export function xAuthorFromOembed(body: Record<string, unknown>): string | null {
  if (typeof body.author_url !== "string") return null;
  try {
    const u = new URL(body.author_url);
    if (!X_HOSTS.has(u.hostname.toLowerCase())) return null;
    const handle = normalizeHandle(u.pathname.split("/").filter(Boolean)[0] ?? "");
    return X_HANDLE.test(handle) ? handle : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ verdict-time re-check

export interface BuildInPublicRecheckProof {
  post_url: string;
  platform: BipPlatform;
}

function result(
  status: RecheckResult["status"],
  reason: string | null,
  source: RecheckSource | null = null,
  info: RecheckResult["info"] = {},
): RecheckResult {
  return { status, source, reason, info };
}

function notFoundReason(platform: BipPlatform): string {
  return (
    `Lane could not find this post on ${PLATFORM_NAMES[platform]}. It may be deleted or private, or the URL may be wrong. ` +
    "Send the URL of a public post the player published."
  );
}

/**
 * Re-fetch the post from the platform's public endpoint (R16, KTD14) and return the post text
 * with the result where the platform gives it.
 * - X: `rechecked` with the post text when the author is the player's bound X handle, `failed`
 *   when it is someone else, and `agent_attested` with the fetched text when the bound handle
 *   is on another platform, because Lane then cannot tie the post to the player.
 * - Instagram and Threads: `agent_attested` once the post is confirmed to exist (the endpoint
 *   returns no text or author).
 * - LinkedIn: `agent_attested` with no call.
 * A post the platform says does not exist is `failed` with `info.found` false, which the
 * extractor reads as `post_missing`. Timeouts and server errors are `pending`.
 */
export async function recheckPost(
  proof: BuildInPublicRecheckProof,
  handle: Handle | null,
  ctx: PackContext,
): Promise<RecheckResult> {
  const post = parsePostUrl(proof.post_url);
  if (!post || post.platform !== proof.platform) {
    return result("failed", "Send the post's own URL on the platform you name, not a profile URL.");
  }
  const name = PLATFORM_NAMES[post.platform];
  if (post.platform === "linkedin") return result("agent_attested", null, null, { found: null, refetch: "unsupported" });

  const res = await fetchOembed(post, ctx);
  if (res.kind === "transient") {
    return result("pending", `${name} did not answer the re-fetch. Lane will try again.`, null, { refetch: res.detail });
  }
  if (res.kind === "not_found") return result("failed", notFoundReason(post.platform), null, { found: false });
  if (res.kind === "unavailable") return result("agent_attested", null, null, { found: null, refetch: res.detail });

  if (post.platform !== "x") return result("agent_attested", null, null, { found: true, text_checked: false });

  const text = xTextFromEmbedHtml(res.body.html as string);
  if (text === null) return result("agent_attested", null, null, { found: true, text_checked: false });
  const author = xAuthorFromOembed(res.body);
  const source: RecheckSource = {
    kind: "post",
    text: text.slice(0, QUOTE_CAP_CHARS),
    diff: null,
    author,
    stats: null,
    created_at: postTimeFromId("x", post.post_id),
    fetched_at: ctx.now,
  };
  const info: RecheckResult["info"] = { found: true, text_checked: true, author_handle: author, author_checked: false };
  if (!handle || handle.platform !== "x") return result("agent_attested", null, source, info);
  info.author_checked = true;
  if (!author || author !== normalizeHandle(handle.handle)) {
    return result(
      "failed",
      "The post's author on X is not the player's bound X handle. Only posts the player published count.",
      source,
      info,
    );
  }
  return result("rechecked", null, source, info);
}

// ------------------------------------------------------------------ final check (R27)

/** Parallel re-fetches at the final check; each has its own timeout. */
export const FINAL_CHECK_CONCURRENCY = 6;

type FinalOutcome = "present" | "missing" | "unconfirmed";

async function finalRefetch(post: ParsedPost, ctx: PackContext): Promise<FinalOutcome> {
  if (post.platform === "linkedin") return "unconfirmed";
  let res = await fetchOembed(post, ctx);
  if (res.kind === "transient") res = await fetchOembed(post, ctx);
  if (res.kind === "found") return "present";
  if (res.kind === "not_found") return "missing";
  return "unconfirmed";
}

/** Run `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function refetchRequest(challenge: Challenge, proof: Proof, post: ParsedPost | null, now: Date): NewInboxItem {
  const name = post ? PLATFORM_NAMES[post.platform] : "build-log";
  const day = proof.day_index !== null ? ` for day ${proof.day_index + 1}` : "";
  const where = post ? `Open ${post.canonical_url}, fetch the post again` : "Find the post again";
  return {
    player_id: proof.player_id,
    challenge_id: challenge._id,
    kind: "refetch",
    actor: "agent",
    instruction:
      `Lane could not re-fetch your ${name} post${day} at the final check. ${where} and answer this request with ` +
      "lane_submit_proof, sending post_url, platform and the post's current text. If the post is gone, send nothing.",
    answer_tool: "lane_submit_proof",
    answer_args: post
      ? { challenge_id: challenge._id, post_url: post.canonical_url, platform: post.platform }
      : { challenge_id: challenge._id },
    day_index: proof.day_index,
    subject_proof_id: proof._id,
    slot: null,
    code: null,
    release_at: null,
    due_at: challenge.clock ? graceDeadline(challenge.clock, now) : new Date(now.getTime() + REAL_GRACE_SEC * 1000),
  };
}

/**
 * R27 final check: re-fetch every counted post in the challenge. A post the platform says is
 * gone becomes not counted (`removed`, AE3). A post Lane cannot re-fetch (LinkedIn, an endpoint
 * that wants a token, a timeout that persists after one retry, an unreadable payload) gets a
 * Muse re-fetch request instead of a failure. Proofs that do not count are skipped. Never throws.
 */
export async function finalCheckPosts(
  challenge: Challenge,
  proofs: readonly Proof[],
  ctx: PackContext,
  readProof: (payload: Proof["payload"]) => BuildInPublicRecheckProof | null,
): Promise<FinalCheckResult> {
  const counting = proofs.filter((p) => p.challenge_id === challenge._id && COUNTING_PROOF_STATUSES.includes(p.status));
  const checked = await mapLimit(counting, FINAL_CHECK_CONCURRENCY, async (proof) => {
    const fields = readProof(proof.payload);
    const post = fields ? parsePostUrl(fields.post_url) : null;
    if (!post || post.platform !== fields?.platform) return { proof, post: null, outcome: "unconfirmed" as const };
    try {
      return { proof, post, outcome: await finalRefetch(post, ctx) };
    } catch {
      // fetchOembed never throws; this guards a misbehaving fetch double or runtime.
      return { proof, post, outcome: "unconfirmed" as const };
    }
  });
  const result: FinalCheckResult = { not_counted: [], requests: [] };
  for (const { proof, post, outcome } of checked) {
    if (outcome === "missing") result.not_counted.push({ proof_id: proof._id, reason: "removed" });
    else if (outcome === "unconfirmed") result.requests.push(refetchRequest(challenge, proof, post, ctx.now));
  }
  return result;
}

// ------------------------------------------------------------------ handle verification

const HANDLE_PATTERN = /^[a-z0-9._-]{1,64}$/;

/**
 * KTD21 asks Lane to verify a Build in Public handle by reading the bind code from the
 * platform's public profile bio. None of X, Instagram, LinkedIn or Threads serves a profile bio
 * without an app token (see README), so this fails closed with an honest reason and makes no
 * call. Proofs from the handle stay held until a verification route is decided. Scripted
 * players are seeded as verified, so the demo path does not depend on this.
 */
export async function verifyPostHandle(
  handle: string,
  bindCode: string,
  _ctx: PackContext,
): Promise<{ verified: boolean; reason: string | null }> {
  const normalized = normalizeHandle(handle);
  if (!HANDLE_PATTERN.test(normalized)) {
    return { verified: false, reason: "That is not a valid handle. Send the handle without the @." };
  }
  if (!bindCode.trim()) return { verified: false, reason: "There is no open bind code for this handle." };
  return {
    verified: false,
    reason:
      "Lane cannot read X, Instagram, LinkedIn or Threads profile bios without an app token yet, so it cannot confirm " +
      "this handle automatically. Proofs stay held until the Lane team verifies it.",
  };
}
