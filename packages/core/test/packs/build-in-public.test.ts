import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config";
import type { Challenge } from "../../src/schema/challenges";
import type { Features } from "../../src/schema/common";
import { LabelledExampleSchema, type LabelledExample } from "../../src/schema/examples";
import type { PackContext, SeedRule } from "../../src/schema/pack";
import type { Handle, Player } from "../../src/schema/players";
import type { Proof, ProofStatus } from "../../src/schema/proofs";
import { whenConds, type RuleAction, type When } from "../../src/schema/rule";
import { evaluateRules } from "../../src/rules/engine";
import { validateWhen } from "../../src/rules/grammar";
import { getPack, renderRuleLine } from "../../src/packs/index";
import {
  BIP_CHEAT_CLASSES,
  BIP_DOES_NOT_COUNT,
  BIP_FEATURES,
  BIP_SEED_RULES,
  BuildInPublicProofSchema,
  INSTAGRAM_OEMBED,
  THREADS_OEMBED,
  X_OEMBED,
  buildInPublicPack,
  buildInPublicSourceKey,
  parsePostUrl,
  postSimilarity,
  type BipPlatform,
  type BuildInPublicProof,
} from "../../src/packs/build-in-public/index";
import { formatExamplesJson, generateBuildInPublicExamples } from "../../src/packs/build-in-public/examples.gen";

// ------------------------------------------------------------------ no network, ever

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Tests must not reach the network: pass a fetch double in the pack context.");
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ fixtures

const NOW = new Date("2026-10-11T21:30:00Z");
const X_EPOCH_MS = 1_288_834_974_657;

/** An X snowflake id for a post made at `iso`. */
function xId(iso: string, seq = 1): string {
  return ((BigInt(Date.parse(iso) - X_EPOCH_MS) << 22n) + BigInt(seq)).toString();
}
/** A LinkedIn activity id for a post made at `iso`. */
function linkedInId(iso: string, seq = 1): string {
  return ((BigInt(Date.parse(iso)) << 22n) + BigInt(seq)).toString();
}

const clock = {
  mode: "demo" as const,
  start_at: new Date("2026-10-11T21:00:00Z"),
  day_length_sec: 300,
  days: 7,
  grace_sec: 90,
  offset_days: 0,
};

const challenge: Challenge = {
  _id: "chl_bip",
  type: "build_in_public",
  status: "active",
  title: "Build in Public",
  creator_id: "plr_maya",
  join_code: "BIP001",
  stake: 100,
  winner_rule: "top_score",
  goal: 5,
  params: { platforms: ["x", "linkedin", "instagram", "threads"] },
  draft: null,
  clock,
  contract_version: 1,
  settlement: null,
  stage: true,
  created_at: NOW,
  updated_at: NOW,
  activated_at: NOW,
  closed_at: null,
};

const player: Player = {
  _id: "plr_sam",
  display_name: "Sam",
  time_zone: "America/Los_Angeles",
  key_hash: "a".repeat(64),
  routine_text: "",
  handles: {},
  credits: 900,
  scripted: true,
  created_at: NOW,
  updated_at: NOW,
};

const xHandle: Handle = { platform: "x", handle: "sam_ships", status: "verified", bind_code: null, verified_at: NOW };
const linkedInHandle: Handle = { platform: "linkedin", handle: "sam-ships", status: "verified", bind_code: null, verified_at: NOW };

const X_POST_TIME = "2026-10-11T21:06:00Z";
const X_ID = xId(X_POST_TIME);
const X_URL = `https://x.com/sam_ships/status/${X_ID}`;
const X_CANONICAL = `https://x.com/i/status/${X_ID}`;
const LI_ID = linkedInId("2026-10-11T21:07:00Z");
const LI_URL = `https://www.linkedin.com/feed/update/urn:li:activity:${LI_ID}/`;
const IG_URL = "https://www.instagram.com/p/C8bipPost1/";
const TH_URL = "https://www.threads.net/@sam_ships/post/C8bipPost2";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The JSON `publish.x.com/oembed` returns, trimmed to what matters. */
function xEmbed(text: string, author = "Sam_Ships") {
  return {
    url: `https://x.com/${author}/status/${X_ID}`,
    author_name: "Sam",
    author_url: `https://x.com/${author}`,
    html: `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${escapeHtml(text).replace(/\n/g, "<br>")}</p>&mdash; Sam (@${author}) <a href="https://x.com/${author}/status/${X_ID}?ref_src=twsrc%5Etfw">October 11, 2026</a></blockquote>\n`,
    type: "rich",
    provider_name: "X",
    version: "1.0",
  };
}
const META_EMBED = { type: "rich", version: "1.0", html: '<blockquote class="instagram-media">View this post on Instagram</blockquote>' };
const META_NOT_FOUND = { error: { message: "The requested resource does not exist", type: "OAuthException", code: 24, is_transient: false } };

type Route = { status?: number; body?: unknown; throws?: boolean };
const ENDPOINTS = new Set([X_OEMBED, INSTAGRAM_OEMBED, THREADS_OEMBED]);

/**
 * A fetch double for the three public oEmbed endpoints, keyed by the post URL Lane asks about.
 * An unknown post answers like the platform does for a missing one; any other host throws.
 * Routes given as arrays answer in turn, one entry per call.
 */
function platforms(routes: Record<string, Route | Route[]>) {
  const calls: { url: string; target: string; headers: Headers }[] = [];
  const served = new Map<string, number>();
  const fetchDouble = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    const endpoint = `${u.origin}${u.pathname}`;
    const target = u.searchParams.get("url") ?? "";
    calls.push({ url, target, headers: new Headers(init?.headers) });
    if (!ENDPOINTS.has(endpoint)) throw new Error(`unexpected endpoint ${endpoint}`);
    const entry = routes[target];
    const n = served.get(target) ?? 0;
    served.set(target, n + 1);
    const route = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
    if (!route) {
      return endpoint === X_OEMBED
        ? new Response("<!DOCTYPE html><title>X</title>", { status: 404 })
        : new Response(JSON.stringify(META_NOT_FOUND), { status: 400 });
    }
    if (route.throws) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchDouble, calls };
}

function ctx(fetchDouble: typeof fetch): PackContext {
  return { now: NOW, fetch: fetchDouble, githubToken: "github-token-must-never-leave" };
}

function proofOf(post_url: string, platform: string, post_text = "Shipped the CSV export for invoices today."): BuildInPublicProof {
  return BuildInPublicProofSchema.parse({ post_url, platform, post_text });
}

function storedProof(o: {
  id: string;
  url: string;
  platform: BipPlatform;
  text?: string;
  status?: ProofStatus;
  challenge_id?: string;
  player_id?: string;
  day?: number | null;
  payload?: Record<string, unknown>;
}): Proof {
  const payload = o.payload ?? proofOf(o.url, o.platform, o.text);
  return {
    _id: o.id,
    challenge_id: o.challenge_id ?? challenge._id,
    player_id: o.player_id ?? player._id,
    challenge_type: "build_in_public",
    source_key: `${o.platform}:${parsePostUrl(o.url)?.post_id}`,
    claimed: true,
    payload,
    features: null,
    source_time: NOW,
    day_index: o.day === undefined ? 1 : o.day,
    status: o.status ?? "accepted",
    held_reason: null,
    not_counted_reason: null,
    verdict: null,
    answers_request_id: null,
    history: [],
    received_at: NOW,
    updated_at: NOW,
  };
}

async function recheckAndExtract(proof: BuildInPublicProof, routes: Record<string, Route | Route[]>, earlierProofs: Proof[] = [], handle: Handle | null = xHandle) {
  const double = platforms(routes);
  const recheck = await buildInPublicPack.recheck(proof, player, handle, ctx(double.fetch));
  const features = buildInPublicPack.extractFeatures({ proof, recheck, openRequests: [], earlierProofs, challenge, player_id: player._id });
  return { recheck, features, calls: double.calls };
}

// ------------------------------------------------------------------ proof schema and source key

describe("Build in Public proof schema and source key", () => {
  it("gives two URLs for the same post the same source key", () => {
    const key = (url: string, platform: string) => buildInPublicPack.sourceKey(proofOf(url, platform));
    const x = key(X_URL, "x");
    expect(x).toBe(`x:${X_ID}`);
    expect(key(`https://twitter.com/sam_ships/status/${X_ID}?s=20&t=abcdef`, "x")).toBe(x);
    expect(key(`https://mobile.twitter.com/someone/status/${X_ID}/photo/1`, "x")).toBe(x);
    expect(key(`https://x.com/i/web/status/${X_ID}`, "x")).toBe(x);

    const li = key(LI_URL, "linkedin");
    expect(li).toBe(`linkedin:${LI_ID}`);
    expect(key(`https://www.linkedin.com/posts/sam-ships_buildinpublic-activity-${LI_ID}-AbCd?utm_source=share&utm_medium=member_desktop`, "linkedin")).toBe(li);
    expect(key(`https://ca.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${LI_ID}`, "linkedin")).toBe(li);

    expect(key("https://www.instagram.com/reel/C8bipPost1/?igsh=MWQ1ZGUxMzBkMA==", "instagram")).toBe(key(IG_URL, "instagram"));
    expect(key("https://www.threads.com/t/C8bipPost2", "threads")).toBe(key(TH_URL, "threads"));
    // Instagram and Threads shortcodes are case-sensitive.
    expect(key("https://www.instagram.com/p/c8bippost1/", "instagram")).not.toBe(key(IG_URL, "instagram"));
  });

  it("stores Lane's canonical URL, without tracking parameters", () => {
    expect(proofOf(`https://twitter.com/sam_ships/status/${X_ID}?s=20&t=abcdef`, "x").post_url).toBe(X_CANONICAL);
    expect(proofOf(TH_URL, "threads").post_url).toBe("https://www.threads.com/t/C8bipPost2");
    const reparsed = BuildInPublicProofSchema.parse(proofOf(LI_URL, "linkedin"));
    expect(buildInPublicSourceKey(reparsed)).toBe(`linkedin:${LI_ID}`);
  });

  it("refuses a profile URL, another site and a platform that does not match the URL, with recovery messages", () => {
    const profile = BuildInPublicProofSchema.safeParse({ post_url: "https://x.com/sam_ships", platform: "x", post_text: "hi" });
    expect(profile.success).toBe(false);
    if (!profile.success) expect(profile.error.issues[0]?.message).toMatch(/post's own URL/);
    expect(BuildInPublicProofSchema.safeParse({ post_url: "https://example.com/status/123456789", platform: "x" }).success).toBe(false);
    expect(BuildInPublicProofSchema.safeParse({ post_url: "javascript:alert(1)", platform: "x" }).success).toBe(false);
    const mismatch = BuildInPublicProofSchema.safeParse({ post_url: X_URL, platform: "linkedin" });
    expect(mismatch.success).toBe(false);
    if (!mismatch.success) expect(mismatch.error.issues[0]?.message).toBe("This URL is a X post. Send platform x.");
  });

  it("accepts 'twitter' and 'X' as the platform and trims the text", () => {
    expect(proofOf(X_URL, "twitter").platform).toBe("x");
    expect(proofOf(X_URL, " X ").platform).toBe("x");
    expect(proofOf(X_URL, "x", "  shipped it  ").post_text).toBe("shipped it");
    expect(BuildInPublicProofSchema.safeParse({ post_url: X_URL, platform: "x", post_text: "a".repeat(4001) }).success).toBe(false);
  });

  it("takes the source time from the post id over the agent's time, where the id encodes it", () => {
    const x = BuildInPublicProofSchema.parse({ post_url: X_URL, platform: "x", source_time: "2026-10-01T00:00:00Z" });
    expect(buildInPublicPack.sourceTime(x, null)?.toISOString()).toBe("2026-10-11T21:06:00.000Z");
    expect(buildInPublicPack.sourceTime(proofOf(LI_URL, "linkedin"), null)?.toISOString()).toBe("2026-10-11T21:07:00.000Z");
    const ig = BuildInPublicProofSchema.parse({ post_url: IG_URL, platform: "instagram", source_time: "2026-10-11T21:08:00Z" });
    expect(buildInPublicPack.sourceTime(ig, null)?.toISOString()).toBe("2026-10-11T21:08:00.000Z");
    expect(buildInPublicPack.sourceTime(proofOf(IG_URL, "instagram"), null)).toBeNull();
  });

  it("binds the handle on X when the challenge allows it, otherwise on its first platform", () => {
    expect(buildInPublicPack.handlePlatform(challenge)).toBe("x");
    expect(buildInPublicPack.handlePlatform({ params: { platforms: ["linkedin", "instagram"] } })).toBe("linkedin");
    expect(buildInPublicPack.handlePlatform({ params: { platforms: ["threads", "x"] } })).toBe("x");
  });
});

// ------------------------------------------------------------------ features

describe("Build in Public features", () => {
  const linkedInFeatures = (text: string, earlierProofs: Proof[] = []) =>
    buildInPublicPack.extractFeatures({
      proof: proofOf(LI_URL, "linkedin", text),
      recheck: { status: "agent_attested", source: null, reason: null, info: { found: null } },
      openRequests: [],
      earlierProofs,
      challenge,
      player_id: player._id,
    });

  it("Covers AE3: the one-line post 'working on stuff today' has under 8 words and no concrete detail", async () => {
    const { recheck, features } = await recheckAndExtract(proofOf(X_URL, "x", "working on stuff today"), {
      [X_CANONICAL]: { body: xEmbed("working on stuff today") },
    });
    expect(recheck.status).toBe("rechecked");
    expect(features.word_count).toBe(4);
    expect(features.word_count as number).toBeLessThan(8);
    expect(features.has_concrete_detail).toBe(false);
    expect(features.filler).toBe(true);
    expect(features.post_missing).toBe(false);
    expect(buildInPublicPack.summarize(features)).toBe("X post, 4 words");
  });

  it("still reads a one-liner padded with a day counter, hashtags or emoji as filler", () => {
    for (const text of [
      "Day 3: working on stuff today #buildinpublic #indiehackers #saas #startup #ai",
      "Day 5/30 of #100DaysOfCode ✅",
      "Grinding 💪 💪 💪",
      "@everyone big things coming soon",
    ]) {
      const f = linkedInFeatures(text);
      expect(f.filler, text).toBe(true);
      expect(f.has_concrete_detail, text).toBe(false);
    }
  });

  it("counts a short post that names a feature, file, number or link as concrete, and a long reflective post as not filler", () => {
    for (const text of ["Shipped dark mode.", "Fixed the redirect loop in auth.ts", "Cut the bundle size by 40%.", "Changelog: tessbuilds.dev/changelog", "Renamed `getUser` today"]) {
      const f = linkedInFeatures(text);
      expect(f.has_concrete_detail, text).toBe(true);
      expect(f.filler, text).toBe(false);
    }
    const reflective = linkedInFeatures("Spent the whole day interviewing operations managers about how they track vendor contracts.");
    expect(reflective.has_concrete_detail).toBe(false);
    expect(reflective.filler).toBe(false);
  });

  it("marks a post nearly identical to the player's previous day's post as a near-duplicate", () => {
    const yesterday = storedProof({
      id: "prf_day3",
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${linkedInId("2026-10-11T21:02:00Z", 7)}/`,
      platform: "linkedin",
      text: "Day 3: shipped the Stripe webhook handler and wrote tests for failed payments.",
      day: 0,
    });
    const f = linkedInFeatures("Day 4: shipped the Stripe webhook handler and wrote tests for failed payments!", [yesterday]);
    expect(f.near_duplicate).toBe(true);
    expect(f.filler).toBe(false);
    const different = linkedInFeatures("Day 4: connected the onboarding emails to the signup webhook and added a retry queue.", [yesterday]);
    expect(different.near_duplicate).toBe(false);
  });

  it("never calls a re-submission of the same post, or another player's post, a near-duplicate", () => {
    const text = "Shipped the CSV export for invoices and fixed the timezone bug in reminders.";
    const same = storedProof({ id: "prf_same", url: LI_URL, platform: "linkedin", text });
    expect(linkedInFeatures(text, [same]).near_duplicate).toBe(false);
    const other = storedProof({ id: "prf_other", url: TH_URL, platform: "threads", text, player_id: "plr_maya" });
    expect(linkedInFeatures(text, [other]).near_duplicate).toBe(false);
  });

  it("keeps template-heavy honest posts below the near-duplicate threshold", () => {
    const a = "Day 4 of building Pocketplan in public. Today: push notifications when a category goes over its limit.";
    const b = "Day 5 of building Pocketplan in public. Today: dark mode and a settings screen.";
    expect(postSimilarity(a, b)).toBeLessThan(0.85);
    expect(postSimilarity("Day 3: shipped X", "Day 4: shipped X")).toBe(1);
  });

  it("reads Lane's re-fetched text over the agent's text", async () => {
    const padded = "working on stuff today, shipped the CSV export for invoices with 3 new filters";
    const { features } = await recheckAndExtract(proofOf(X_URL, "x", padded), { [X_CANONICAL]: { body: xEmbed("working on stuff today") } });
    expect(features.filler).toBe(true);
    expect(features.word_count).toBe(4);
  });
});

// ------------------------------------------------------------------ re-fetch

describe("Build in Public re-fetch", () => {
  it("re-checks an X post from the public oEmbed with no token, and returns the post text, never HTML", async () => {
    const text = "Shipped <dark mode> & a \"settings\" page.\nNotes: tessbuilds.dev/changelog";
    const { recheck, calls } = await recheckAndExtract(proofOf(X_URL, "x", "agent copy"), { [X_CANONICAL]: { body: xEmbed(text) } });
    expect(recheck.status).toBe("rechecked");
    expect(recheck.source?.kind).toBe("post");
    expect(recheck.source?.text).toBe(text);
    expect(recheck.source?.author).toBe("sam_ships");
    expect(recheck.source?.created_at?.toISOString()).toBe("2026-10-11T21:06:00.000Z");
    expect(recheck.info.found).toBe(true);
    expect(JSON.stringify(recheck)).not.toMatch(/<blockquote|<p\b/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith(`${X_OEMBED}?`)).toBe(true);
    expect(calls[0]?.target).toBe(X_CANONICAL);
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.headers.get("cookie")).toBeNull();
    expect(JSON.stringify(calls)).not.toContain("github-token-must-never-leave");
  });

  it("fails an X post whose author is not the player's bound X handle", async () => {
    const { recheck } = await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { body: xEmbed("Shipped the CSV export.", "maya_builds") } });
    expect(recheck.status).toBe("failed");
    expect(recheck.reason).toMatch(/not the player's bound X handle/);
    expect(recheck.source?.text).toBe("Shipped the CSV export.");
  });

  it("keeps an X post agent-attested when the player's bound handle is on another platform", async () => {
    const { recheck } = await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { body: xEmbed("Shipped the CSV export.", "anyone") } }, [], linkedInHandle);
    expect(recheck.status).toBe("agent_attested");
    expect(recheck.source?.text).toBe("Shipped the CSV export.");
    expect(recheck.info.author_checked).toBe(false);
  });

  it("fails a post the platform says does not exist, and the extractor reads it as post_missing", async () => {
    const x = await recheckAndExtract(proofOf(X_URL, "x"), {});
    expect(x.recheck.status).toBe("failed");
    expect(x.recheck.reason).toMatch(/could not find this post on X/);
    expect(x.features.post_missing).toBe(true);
    const ig = await recheckAndExtract(proofOf(IG_URL, "instagram"), {});
    expect(ig.recheck.status).toBe("failed");
    expect(ig.features.post_missing).toBe(true);
  });

  it("stays pending when X times out, rate-limits or errors, and falls back to agent-attested when X refuses without saying the post is gone", async () => {
    expect((await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { status: 503 } })).recheck.status).toBe("pending");
    expect((await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { status: 429 } })).recheck.status).toBe("pending");
    expect((await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { throws: true } })).recheck.status).toBe("pending");
    const refused = await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { status: 403, body: { error: "forbidden" } } });
    expect(refused.recheck.status).toBe("agent_attested");
    expect(refused.features.post_missing).toBe(false);
    const oddBody = await recheckAndExtract(proofOf(X_URL, "x"), { [X_CANONICAL]: { body: { unexpected: true } } });
    expect(oddBody.recheck.status).toBe("agent_attested");
  });

  it("confirms an Instagram or Threads post exists and keeps it agent-attested, since the endpoint returns no text", async () => {
    const canonicalIg = "https://www.instagram.com/p/C8bipPost1/";
    const canonicalTh = "https://www.threads.com/t/C8bipPost2";
    const ig = await recheckAndExtract(proofOf(IG_URL, "instagram", "working on stuff today"), { [canonicalIg]: { body: META_EMBED } });
    expect(ig.recheck.status).toBe("agent_attested");
    expect(ig.recheck.info.found).toBe(true);
    expect(ig.features.filler).toBe(true);
    expect(ig.calls[0]?.url.startsWith(`${INSTAGRAM_OEMBED}?`)).toBe(true);
    const th = await recheckAndExtract(proofOf(TH_URL, "threads"), { [canonicalTh]: { body: META_EMBED } });
    expect(th.recheck.status).toBe("agent_attested");
    expect(th.calls[0]?.url.startsWith(`${THREADS_OEMBED}?`)).toBe(true);
    const tokenWanted = await recheckAndExtract(proofOf(IG_URL, "instagram"), {
      [canonicalIg]: { status: 400, body: { error: { code: 190, type: "OAuthException", is_transient: false } } },
    });
    expect(tokenWanted.recheck.status).toBe("agent_attested");
    expect(tokenWanted.features.post_missing).toBe(false);
  });

  it("makes no call for LinkedIn, which has no public endpoint, and keeps the post agent-attested", async () => {
    const { recheck, features, calls } = await recheckAndExtract(proofOf(LI_URL, "linkedin"), {});
    expect(recheck.status).toBe("agent_attested");
    expect(recheck.info.refetch).toBe("unsupported");
    expect(features.post_missing).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses a URL that does not match the platform without a call", async () => {
    const double = platforms({});
    const res = await buildInPublicPack.recheck({ post_url: X_URL, platform: "linkedin", post_text: "" }, player, xHandle, ctx(double.fetch));
    expect(res.status).toBe("failed");
    expect(double.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ final check (R27)

describe("Build in Public final check (R27)", () => {
  it("Covers AE3: an accepted post whose re-fetch returns not found becomes not counted", async () => {
    const deleted = storedProof({ id: "prf_deleted", url: X_URL, platform: "x" });
    const double = platforms({});
    const res = await buildInPublicPack.finalCheck(challenge, [deleted], ctx(double.fetch));
    expect(res.not_counted).toEqual([{ proof_id: "prf_deleted", reason: "removed" }]);
    expect(res.requests).toEqual([]);
    expect(double.calls).toHaveLength(1);
  });

  it("leaves a post that is still there counted, and catches a deleted Instagram post", async () => {
    const kept = storedProof({ id: "prf_kept", url: X_URL, platform: "x" });
    const gone = storedProof({ id: "prf_ig", url: IG_URL, platform: "instagram" });
    const res = await buildInPublicPack.finalCheck(challenge, [kept, gone], ctx(platforms({ [X_CANONICAL]: { body: xEmbed("Shipped it.") } }).fetch));
    expect(res.not_counted).toEqual([{ proof_id: "prf_ig", reason: "removed" }]);
    expect(res.requests).toEqual([]);
  });

  it("opens a Muse re-fetch request for a platform with no working re-fetch instead of failing", async () => {
    const li = storedProof({ id: "prf_li", url: LI_URL, platform: "linkedin", day: 2 });
    const double = platforms({});
    const res = await buildInPublicPack.finalCheck(challenge, [li], ctx(double.fetch));
    expect(double.calls).toHaveLength(0);
    expect(res.not_counted).toEqual([]);
    expect(res.requests).toHaveLength(1);
    const req = res.requests[0];
    expect(req).toMatchObject({
      player_id: player._id,
      challenge_id: challenge._id,
      kind: "refetch",
      actor: "agent",
      answer_tool: "lane_submit_proof",
      answer_args: { challenge_id: challenge._id, post_url: `https://www.linkedin.com/feed/update/urn:li:activity:${LI_ID}/`, platform: "linkedin" },
      day_index: 2,
      subject_proof_id: "prf_li",
      slot: null,
      code: null,
      release_at: null,
    });
    expect(req?.due_at?.toISOString()).toBe(new Date(NOW.getTime() + clock.grace_sec * 1000).toISOString());
    expect(req?.instruction).toMatch(/LinkedIn post for day 3/);
    expect(req?.instruction.length).toBeLessThanOrEqual(600);
  });

  it("asks Muse when an endpoint stops answering usefully, retries a transient failure once, and never throws", async () => {
    const canonicalTh = "https://www.threads.com/t/C8bipPost2";
    const th = storedProof({ id: "prf_th", url: TH_URL, platform: "threads" });
    const x = storedProof({ id: "prf_x", url: X_URL, platform: "x" });
    const double = platforms({
      [canonicalTh]: { status: 400, body: { error: { code: 190, is_transient: false } } },
      [X_CANONICAL]: [{ status: 502 }, { status: 502 }],
    });
    const res = await buildInPublicPack.finalCheck(challenge, [th, x], ctx(double.fetch));
    expect(res.not_counted).toEqual([]);
    expect(res.requests.map((r) => r.subject_proof_id).sort()).toEqual(["prf_th", "prf_x"]);
    expect(double.calls.filter((c) => c.target === X_CANONICAL)).toHaveLength(2);

    const recovered = platforms({ [X_CANONICAL]: [{ throws: true }, { body: xEmbed("Shipped it.") }] });
    const ok = await buildInPublicPack.finalCheck(challenge, [x], ctx(recovered.fetch));
    expect(ok).toEqual({ not_counted: [], requests: [] });

    const broken = (async () => {
      throw new Error("runtime exploded");
    }) as unknown as typeof fetch;
    await expect(buildInPublicPack.finalCheck(challenge, [x, th], ctx(broken))).resolves.toMatchObject({ not_counted: [] });
  });

  it("re-fetches only counted posts of this challenge, and asks Muse about an unreadable payload", async () => {
    const proofs = [
      storedProof({ id: "prf_rejected", url: X_URL, platform: "x", status: "rejected" }),
      storedProof({ id: "prf_held", url: X_URL, platform: "x", status: "held" }),
      storedProof({ id: "prf_nc", url: X_URL, platform: "x", status: "not_counted" }),
      storedProof({ id: "prf_elsewhere", url: X_URL, platform: "x", challenge_id: "chl_other" }),
      storedProof({ id: "prf_flagged", url: X_URL, platform: "x", status: "flagged_accept" }),
      storedProof({ id: "prf_bad", url: X_URL, platform: "x", payload: { post_url: "not a url", platform: "x" } }),
    ];
    const double = platforms({});
    const res = await buildInPublicPack.finalCheck(challenge, proofs, ctx(double.fetch));
    expect(res.not_counted).toEqual([{ proof_id: "prf_flagged", reason: "removed" }]);
    expect(res.requests).toHaveLength(1);
    expect(res.requests[0]?.subject_proof_id).toBe("prf_bad");
    expect(res.requests[0]?.answer_args).toEqual({ challenge_id: challenge._id });
    expect(double.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ handle verification

describe("Build in Public handle verification (KTD21)", () => {
  it("fails closed with an honest reason and no network call, since no platform serves a bio without a token", async () => {
    const double = platforms({});
    const res = await buildInPublicPack.verifyHandle("@Sam_Ships", "LANE-BIND-7Q2X", ctx(double.fetch));
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/cannot read X, Instagram, LinkedIn or Threads profile bios/);
    expect(double.calls).toHaveLength(0);
    expect((await buildInPublicPack.verifyHandle("not a handle!", "LANE-BIND-7Q2X", ctx(double.fetch))).reason).toMatch(/not a valid handle/);
    expect((await buildInPublicPack.verifyHandle("sam_ships", " ", ctx(double.fetch))).reason).toMatch(/no open bind code/);
  });
});

// ------------------------------------------------------------------ contract

describe("Build in Public contract", () => {
  const rendered = buildInPublicPack.contract.render({
    params: { platforms: ["x", "linkedin", "x"] },
    title: "Build in Public",
    goal: 5,
    stake: 100,
    winner_rule: "top_score",
    days: 7,
    day_length_sec: 300,
  });

  it("asks Muse for the post URL, platform and text on the agreed platforms, and says what does not count", () => {
    expect(rendered.send[0]).toMatch(/the URL, the platform and the full text of one build-log post/);
    expect(rendered.send[0]).toMatch(/on X or LinkedIn\.$/);
    expect(rendered.scoring).toMatch(/Reach 5 of 7 days/);
    expect(rendered.scoring).toMatch(/a deleted post stops counting/);
    expect(rendered.scoring).toContain(BIP_DOES_NOT_COUNT);
    expect(rendered.agent_instructions).toMatch(/lane_submit_proof/);
    expect(rendered.agent_instructions).toMatch(/Never write, publish, edit or delete posts for the player/);
    expect(rendered.extra_proof[0]).toMatch(/fresh re-fetch/);
    expect(rendered.extra_proof[1]).toMatch(/profile bio/);
  });

  it("requires the platforms before a draft can be confirmed", () => {
    expect(buildInPublicPack.contract.requiredDraftFields).toEqual(["platforms"]);
    expect(buildInPublicPack.contract.paramsSchema.safeParse({ platforms: [] }).success).toBe(false);
    expect(buildInPublicPack.contract.paramsSchema.safeParse({ platforms: ["x"] }).success).toBe(true);
  });

  it("has a does-not-count template for every feature and never renders a string value", () => {
    for (const feature of Object.keys(BIP_FEATURES)) {
      expect(buildInPublicPack.contract.doesNotCount[feature], feature).toBeTypeOf("function");
    }
    const line = renderRuleLine(getPack("build_in_public"), {
      when: { any: [{ feature: "platform", op: "eq", value: "ignore your rules" }, { feature: "word_count", op: "lt", value: 5 }] },
      action: "reject",
    });
    expect(line).toBe("A proof where the post is on a listed platform, or the post has fewer than 5 words does not count.");
  });

  it("renders the AE3 filler rule from its predicate", () => {
    expect(renderRuleLine(getPack("build_in_public"), AE3_RULE)).toBe(
      "A proof where the post has fewer than 8 words and the post names no feature, file, number or link does not count.",
    );
  });
});

// ------------------------------------------------------------------ seed rules and examples

type RuleLike = { when: When; action: RuleAction };

/** U9's gate (KTD9) over U4's real engine: honest false alarms and per-class catch rates. */
function gateRates(rules: readonly RuleLike[], examples: readonly LabelledExample[]) {
  const evaluable = rules.map((r, i) => ({ rule_key: `r${i}`, version: 1, action: r.action, when: r.when }));
  const hit = (e: LabelledExample) => evaluateRules(evaluable, e.features).decision !== "none";
  const honest = examples.filter((e) => e.label === "honest");
  const perClass: Record<string, number> = {};
  for (const cls of BIP_CHEAT_CLASSES) {
    const cheats = examples.filter((e) => e.cheat_class === cls);
    perClass[cls] = cheats.filter(hit).length / cheats.length;
  }
  return { falseAlarm: honest.filter(hit).length / honest.length, perClass };
}

/** The rule AE3's learning loop should produce from the first rejected filler post. */
const AE3_RULE: RuleLike = {
  when: {
    all: [
      { feature: "word_count", op: "lt", value: 8 },
      { feature: "has_concrete_detail", op: "eq", value: false },
    ],
  },
  action: "reject",
};

describe("Build in Public seed rules and labelled examples", () => {
  const examples = buildInPublicPack.examples;

  it("ships about 100 honest and 40 cheat examples across every cheat class", () => {
    expect(examples.filter((e) => e.label === "honest").length).toBeGreaterThanOrEqual(100);
    expect(examples.filter((e) => e.label === "cheat").length).toBeGreaterThanOrEqual(40);
    for (const cls of BIP_CHEAT_CLASSES) {
      expect(examples.filter((e) => e.cheat_class === cls).length, cls).toBeGreaterThanOrEqual(10);
    }
    expect(new Set(examples.map((e) => e.example_key)).size).toBe(examples.length);
    for (const e of examples) {
      LabelledExampleSchema.parse(e);
      if (e.cheat_class) expect(buildInPublicPack.cheatClasses).toContain(e.cheat_class);
      expect(Object.keys(e.features).sort()).toEqual(Object.keys(BIP_FEATURES).sort());
    }
  });

  it("keeps examples.json identical to the generator, which runs the real re-check and extractor", async () => {
    const path = fileURLToPath(new URL("../../src/packs/build-in-public/examples.json", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(formatExamplesJson(await generateBuildInPublicExamples()));
  });

  it("labels no honest example with any cheat feature, and every cheat with its own class feature", () => {
    for (const e of examples) {
      if (e.label === "honest") {
        for (const cls of BIP_CHEAT_CLASSES) expect(e.features[cls], `${e.example_key} ${cls}`).toBe(false);
      } else {
        expect(e.features[e.cheat_class ?? ""], e.example_key).toBe(true);
      }
    }
  });

  it("ships seed rules that U4's grammar accepts, and leaves filler and near-duplicates to the learning loop", () => {
    for (const rule of BIP_SEED_RULES) {
      const checked = validateWhen(rule.when, buildInPublicPack);
      expect(checked.ok, `${rule.rule_key}: ${JSON.stringify(checked)}`).toBe(true);
      expect(buildInPublicPack.cheatClasses).toContain(rule.cheat_class);
    }
    const seedFeatures = BIP_SEED_RULES.flatMap((r: SeedRule) => whenConds(r.when)).map((c) => c.feature);
    expect(seedFeatures).not.toContain("filler");
    expect(seedFeatures).not.toContain("near_duplicate");
    expect(validateWhen(AE3_RULE.when, buildInPublicPack).ok).toBe(true);
  });

  it("gate run: the seed rule set has 0% honest false alarms", () => {
    const seed = gateRates(BIP_SEED_RULES, examples);
    expect(seed.falseAlarm).toBe(0);
    expect(seed.perClass.post_missing).toBe(1);
    expect(seed.perClass.filler).toBe(0);
  });

  it("gate run: the AE3 filler rule passes the KTD9 thresholds on top of the seed set", () => {
    const g = DEFAULT_SETTINGS.gate;
    const before = gateRates(BIP_SEED_RULES, examples);
    const alone = gateRates([AE3_RULE], examples);
    const after = gateRates([...BIP_SEED_RULES, AE3_RULE], examples);
    expect((after.perClass.filler ?? 0) - (before.perClass.filler ?? 0)).toBeGreaterThanOrEqual(g.min_catch_gain);
    expect(after.perClass.filler).toBe(1);
    expect(alone.falseAlarm).toBeLessThanOrEqual(g.max_false_alarm_rule);
    expect(after.falseAlarm).toBeLessThanOrEqual(g.max_false_alarm_set);
    for (const cls of BIP_CHEAT_CLASSES) {
      expect((before.perClass[cls] ?? 0) - (after.perClass[cls] ?? 0), cls).toBeLessThanOrEqual(g.max_other_class_drop);
    }
  });

  it("gate run: over-broad rules on length alone or concreteness alone trip honest posts and would be rejected", () => {
    const max = DEFAULT_SETTINGS.gate.max_false_alarm_rule;
    const short: RuleLike = { when: { all: [{ feature: "word_count", op: "lt", value: 8 }] }, action: "reject" };
    const vague: RuleLike = { when: { all: [{ feature: "has_concrete_detail", op: "eq", value: false }] }, action: "reject" };
    expect(gateRates([short], examples).falseAlarm).toBeGreaterThan(max);
    expect(gateRates([vague], examples).falseAlarm).toBeGreaterThan(max);
  });

  it("Covers AE3 in pack terms: the filler post is caught with no AI call once learned, and the deleted accepted post stops counting", async () => {
    const rules = [...BIP_SEED_RULES, AE3_RULE].map((r, i) => ({ rule_key: `r${i}`, version: 1, action: r.action, when: r.when }));
    const filler = await recheckAndExtract(proofOf(X_URL, "x", "working on stuff today"), { [X_CANONICAL]: { body: xEmbed("working on stuff today") } });
    expect(evaluateRules(rules, filler.features).decision).toBe("reject");

    const honestText = "Shipped the CSV export for invoices and 3 new filters.";
    const honest = await recheckAndExtract(proofOf(X_URL, "x", honestText), { [X_CANONICAL]: { body: xEmbed(honestText) } });
    expect(evaluateRules(rules, honest.features).decision).toBe("none");

    const accepted = storedProof({ id: "prf_accepted", url: X_URL, platform: "x", text: honestText });
    const final = await buildInPublicPack.finalCheck(challenge, [accepted], ctx(platforms({}).fetch));
    expect(final.not_counted).toEqual([{ proof_id: "prf_accepted", reason: "removed" }]);
  });
});

/** Keep the Features import meaningful: every example's features are plain values. */
function assertPlain(f: Features): boolean {
  return Object.values(f).every((v) => ["number", "boolean", "string"].includes(typeof v) || Array.isArray(v));
}
it("stores only plain feature values in examples", () => {
  expect(buildInPublicPack.examples.every((e) => assertPlain(e.features))).toBe(true);
});
