/**
 * A scripted player's GitHub pushes (KTD17). Each player commits to its own public sandbox repo
 * through GitHub's contents API with its own token, so GitHub records the player's login as the
 * commit author and Lane's re-check matches it against the verified handle.
 *
 * Every call goes through an injected `fetch`, so tests never reach the network. The token is
 * sent only to the GitHub API and never printed.
 */

export const GITHUB_API = "https://api.github.com";

export interface GitHubPlayerOptions {
  login: string;
  token: string;
  /** owner/name */
  repo: string;
  fetch?: typeof fetch;
  api?: string;
}

export interface PushedCommit {
  sha: string;
  url: string;
}

export class GitHubError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function unb64(s: string): string {
  return Buffer.from(s.replace(/\n/g, ""), "base64").toString("utf8");
}

export class GitHubPlayer {
  readonly login: string;
  readonly repo: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly api: string;

  constructor(opts: GitHubPlayerOptions) {
    this.login = opts.login;
    this.repo = opts.repo;
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.api = opts.api ?? GITHUB_API;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchFn(`${this.api}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lane-stage-runner",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  private repoPath(): string {
    const [owner = "", name = ""] = this.repo.split("/");
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** The login that owns the token. */
  async whoami(): Promise<string> {
    const { status, json } = await this.call("GET", "/user");
    const login = (json as { login?: unknown } | null)?.login;
    if (status !== 200 || typeof login !== "string") {
      throw new GitHubError(`GitHub rejected the token for ${this.login} (status ${status}).`, status);
    }
    return login;
  }

  /**
   * The token must belong to the player's own login, or GitHub records someone else as the
   * author and Lane's re-check fails (KTD17, KTD21).
   */
  async assertIdentity(): Promise<void> {
    const actual = await this.whoami();
    if (actual.toLowerCase() !== this.login.toLowerCase()) {
      throw new GitHubError(
        `The GitHub token belongs to ${actual}, not ${this.login}. Each scripted player needs a token for its own login.`,
        null,
      );
    }
  }

  async getFile(path: string): Promise<{ sha: string; content: string } | null> {
    const { status, json } = await this.call("GET", `${this.repoPath()}/contents/${path}`);
    if (status === 404) return null;
    const file = json as { sha?: unknown; content?: unknown } | null;
    if (status !== 200 || typeof file?.sha !== "string" || typeof file.content !== "string") {
      throw new GitHubError(`Could not read ${path} in ${this.repo} (status ${status}).`, status);
    }
    return { sha: file.sha, content: unb64(file.content) };
  }

  /** Create or update one file in one commit on the default branch. */
  async putFile(path: string, content: string, message: string, previousSha?: string): Promise<PushedCommit> {
    const { status, json } = await this.call("PUT", `${this.repoPath()}/contents/${path}`, {
      message,
      content: b64(content),
      ...(previousSha ? { sha: previousSha } : {}),
    });
    const commit = (json as { commit?: { sha?: unknown; html_url?: unknown } } | null)?.commit;
    if ((status !== 200 && status !== 201) || typeof commit?.sha !== "string") {
      throw new GitHubError(`Could not push to ${this.repo} (status ${status}).`, status);
    }
    return { sha: commit.sha, url: typeof commit.html_url === "string" ? commit.html_url : "" };
  }

  /** The GitHub login GitHub links to a commit's author, as Lane's re-check reads it. */
  async commitAuthor(sha: string): Promise<string | null> {
    const { status, json } = await this.call("GET", `${this.repoPath()}/commits/${sha}`);
    if (status !== 200) throw new GitHubError(`Could not read commit ${sha.slice(0, 7)} (status ${status}).`, status);
    const login = (json as { author?: { login?: unknown } | null } | null)?.author?.login;
    return typeof login === "string" ? login : null;
  }
}

// ---------------------------------------------------------------- the sandbox file Sam edits

export const STAGE_FILE = "lane-stage/tally.ts";

/** Accumulator names Sam cycles through. None appears elsewhere in the file. */
export const ACCUMULATOR_NAMES = ["total", "sum", "runningTotal", "subtotal", "tally", "accumulator", "amount", "acc"] as const;

export function stageFileContent(name: string, note = "The stage runner renames the accumulator below."): string {
  return [
    `// Lane stage sandbox. ${note}`,
    "export function tallyScores(scores: number[]): number {",
    `  let ${name} = 0;`,
    "  for (const score of scores) {",
    `    ${name} += score;`,
    "  }",
    `  return ${name};`,
    "}",
    "",
  ].join("\n");
}

export function accumulatorName(content: string): string | null {
  return /\blet ([A-Za-z_]\w*) = 0;/.exec(content)?.[1] ?? null;
}

/** Rename the accumulator to the next name: a rename-only change on three lines. */
export function renameAccumulator(content: string): { content: string; from: string; to: string } {
  const from = accumulatorName(content);
  if (!from) throw new Error(`${STAGE_FILE} has no accumulator to rename.`);
  const i = (ACCUMULATOR_NAMES as readonly string[]).indexOf(from);
  const to = ACCUMULATOR_NAMES[(i + 1) % ACCUMULATOR_NAMES.length]!;
  return { content: content.replace(new RegExp(`\\b${from}\\b`, "g"), to), from, to };
}

/** Change only the header comment, for the injection commit. */
export function touchHeader(content: string, note: string): string {
  const lines = content.split("\n");
  lines[0] = `// Lane stage sandbox. ${note}`;
  return lines.join("\n");
}
