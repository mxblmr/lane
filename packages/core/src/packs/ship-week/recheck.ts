import { z } from "zod";
import type { PackContext, RecheckResult, RecheckSource } from "../../schema/pack";
import { normalizeHandle, type Handle } from "../../schema/players";
import { QUOTE_CAP_CHARS } from "../../config";
import { containsCode, renderCappedDiff, type CommitFile } from "./features";

/**
 * Ship Week GitHub re-check (R16, KTD14, KTD17) and handle verification (KTD21).
 *
 * Every call goes through `ctx.fetch`, so tests pass a fixture double and never reach the
 * network. The server token comes from `ctx.githubToken`; when the caller leaves it undefined,
 * the `GITHUB_VERIFIER_TOKEN` environment variable is read. The token is sent only to
 * api.github.com and never logged or returned.
 */

export const GITHUB_API = "https://api.github.com";
export const GITHUB_TOKEN_ENV = "GITHUB_VERIFIER_TOKEN";
const COMMIT_TIMEOUT_MS = 8_000;
const USER_TIMEOUT_MS = 8_000;
const EVENTS_TIMEOUT_MS = 3_000;

/** GitHub usernames: letters, digits and single inner hyphens, at most 39 characters. */
export const GITHUB_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;

export function githubToken(ctx: Pick<PackContext, "githubToken">): string | null {
  if (ctx.githubToken !== undefined) return ctx.githubToken || null;
  const env = typeof process !== "undefined" ? process.env : undefined;
  return env?.[GITHUB_TOKEN_ENV] || null;
}

type GitHubGet = { ok: true; body: unknown } | { ok: false; status: number | null; transient: boolean };

async function githubGet(ctx: PackContext, path: string, timeoutMs: number): Promise<GitHubGet> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lane-verifier",
  };
  const token = githubToken(ctx);
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await ctx.fetch(`${GITHUB_API}${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, body: await res.json() };
    // 404, 409 (empty repository) and 422 (no such commit) are answers; anything else may pass.
    const definitive = res.status === 404 || res.status === 409 || res.status === 422;
    return { ok: false, status: res.status, transient: !definitive };
  } catch {
    return { ok: false, status: null, transient: true };
  }
}

// ------------------------------------------------------------------ commit re-check

/** The fields Lane reads from GitHub's `GET /repos/{owner}/{repo}/commits/{sha}`. */
export const GitHubCommitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z.object({ date: z.string().nullish() }).nullish(),
    committer: z.object({ date: z.string().nullish() }).nullish(),
  }),
  /** The GitHub account linked to the author email; null when none is. */
  author: z.object({ login: z.string() }).nullish(),
  stats: z.object({ additions: z.number(), deletions: z.number() }).nullish(),
  files: z
    .array(
      z.object({
        filename: z.string(),
        previous_filename: z.string().nullish(),
        status: z.string(),
        additions: z.number(),
        deletions: z.number(),
        patch: z.string().nullish(),
      }),
    )
    .nullish(),
});
export type GitHubCommit = z.infer<typeof GitHubCommitSchema>;

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Turn GitHub's commit into the re-check source: the message (capped), the capped diff, the
 * author login, line stats and the author date. The committer date travels in `info` because
 * the backdating feature compares it with the author date.
 */
export function commitToRecheck(commit: GitHubCommit, now: Date): { source: RecheckSource; committed_at: Date | null } {
  const files: CommitFile[] = commit.files ?? [];
  const additions = commit.stats?.additions ?? files.reduce((n, f) => n + f.additions, 0);
  const deletions = commit.stats?.deletions ?? files.reduce((n, f) => n + f.deletions, 0);
  return {
    source: {
      kind: "commit",
      text: commit.commit.message.slice(0, QUOTE_CAP_CHARS),
      diff: renderCappedDiff(files, { additions, deletions }),
      author: commit.author?.login ? normalizeHandle(commit.author.login) : null,
      stats: { files: files.length, additions, deletions },
      created_at: parseDate(commit.commit.author?.date),
      fetched_at: now,
    },
    committed_at: parseDate(commit.commit.committer?.date),
  };
}

const PushEventsSchema = z.array(
  z.object({
    type: z.string().nullish(),
    created_at: z.string().nullish(),
    payload: z
      .object({
        head: z.string().nullish(),
        commits: z.array(z.object({ sha: z.string() })).nullish(),
      })
      .nullish(),
  }),
);

/** When the commit was pushed, from the repository's public events. Information only (KTD14). */
async function pushEventTime(ctx: PackContext, repoPath: string, sha: string): Promise<string | null> {
  const res = await githubGet(ctx, `${repoPath}/events?per_page=30`, EVENTS_TIMEOUT_MS);
  if (!res.ok) return null;
  const events = PushEventsSchema.safeParse(res.body);
  if (!events.success) return null;
  const hit = events.data.find(
    (e) => e.type === "PushEvent" && (e.payload?.head === sha || e.payload?.commits?.some((c) => c.sha === sha)),
  );
  return hit?.created_at ?? null;
}

export interface ShipWeekRecheckProof {
  repo: string;
  sha: string;
}

function result(status: RecheckResult["status"], reason: string | null, source: RecheckSource | null = null, info: RecheckResult["info"] = {}): RecheckResult {
  return { status, source, reason, info };
}

/**
 * Fetch the commit from GitHub's public API with the server token, confirm its author is the
 * player's bound GitHub handle, and return the commit message and capped diff with the result.
 * Transient GitHub failures return `pending` so the pipeline can retry; a missing commit or a
 * different author returns `failed`.
 */
export async function recheckCommit(proof: ShipWeekRecheckProof, handle: Handle | null, ctx: PackContext): Promise<RecheckResult> {
  if (!handle || handle.platform !== "github") {
    return result("failed", "Bind your GitHub handle to Lane before sending commits.");
  }
  const [owner = "", name = ""] = proof.repo.split("/");
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const res = await githubGet(ctx, `${repoPath}/commits/${encodeURIComponent(proof.sha)}`, COMMIT_TIMEOUT_MS);
  if (!res.ok) {
    return res.transient
      ? result("pending", "GitHub did not answer the re-check. Lane will try again.")
      : result(
          "failed",
          "Lane could not find this commit on GitHub. Send a commit from a public repository, with the repository as owner/name and the full 40-character SHA.",
        );
  }
  const parsed = GitHubCommitSchema.safeParse(res.body);
  if (!parsed.success) return result("pending", "GitHub returned an unexpected answer. Lane will try again.");
  if (parsed.data.sha.toLowerCase() !== proof.sha.toLowerCase()) {
    return result("failed", "GitHub returned a different commit for this SHA. Send the full 40-character SHA.");
  }
  const { source, committed_at } = commitToRecheck(parsed.data, ctx.now);
  const info: RecheckResult["info"] = {
    committed_at: committed_at?.toISOString() ?? null,
    author_login: source.author,
    push_event_at: null,
  };
  if (!source.author || source.author !== normalizeHandle(handle.handle)) {
    return result(
      "failed",
      "The commit's GitHub author is not the player's bound GitHub handle. Only commits the player authored on GitHub count.",
      source,
      info,
    );
  }
  info.push_event_at = await pushEventTime(ctx, repoPath, parsed.data.sha);
  return result("rechecked", null, source, info);
}

// ------------------------------------------------------------------ handle verification

const GitHubUserSchema = z.object({ login: z.string(), bio: z.string().nullish() });

/**
 * KTD21: fetch the claimed user's public profile and look for the open bind code in the bio.
 * Only the bio verifies a handle. A commit carrying the bind code never does, because anyone
 * can author a commit under another person's email.
 */
export async function verifyGitHubHandle(
  handle: string,
  bindCode: string,
  ctx: PackContext,
): Promise<{ verified: boolean; reason: string | null }> {
  const login = normalizeHandle(handle);
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    return { verified: false, reason: "That is not a valid GitHub username. Send the handle without the @." };
  }
  if (!bindCode.trim()) return { verified: false, reason: "There is no open bind code for this handle." };
  const res = await githubGet(ctx, `/users/${encodeURIComponent(login)}`, USER_TIMEOUT_MS);
  if (!res.ok) {
    return res.transient
      ? { verified: false, reason: "GitHub did not answer. Lane will check the bio again at the next check-in." }
      : { verified: false, reason: "Lane found no GitHub user with that handle." };
  }
  const user = GitHubUserSchema.safeParse(res.body);
  if (!user.success || normalizeHandle(user.data.login) !== login) {
    return { verified: false, reason: "GitHub returned an unexpected profile. Lane will check again at the next check-in." };
  }
  if (!user.data.bio || !containsCode(user.data.bio, bindCode)) {
    return {
      verified: false,
      reason: "The bind code is not in the GitHub profile bio yet. Ask the player to add it to their bio, then check in again.",
    };
  }
  return { verified: true, reason: null };
}
