/**
 * An in-memory GitHub for tests: users by token, public repos with files and commits, and the
 * REST routes the stage runner and Ship Week's re-check call. Any other URL throws, so tests
 * never reach the network. Test helper only.
 */
import { randomBytes } from "node:crypto";

export const FAKE_GITHUB_API = "https://api.github.com";

interface FileRec {
  content: string;
  sha: string;
}

interface CommitRec {
  sha: string;
  author_login: string;
  message: string;
  date: string;
  files: { filename: string; status: string; additions: number; deletions: number; patch: string }[];
}

interface RepoRec {
  owner: string;
  files: Map<string, FileRec>;
  commits: Map<string, CommitRec>;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A unified diff of two versions with matching line counts (or a full replace otherwise). */
export function unifiedPatch(before: string | null, after: string): { patch: string; additions: number; deletions: number } {
  const a = before === null ? [] : before.split("\n");
  const b = after.split("\n");
  if (a.length === b.length) {
    const out: string[] = [`@@ -1,${a.length} +1,${b.length} @@`];
    let additions = 0;
    let deletions = 0;
    let i = 0;
    while (i < a.length) {
      if (a[i] === b[i]) {
        out.push(` ${a[i]}`);
        i++;
        continue;
      }
      // Group a run of changed lines as removals followed by additions, like git.
      let j = i;
      while (j < a.length && a[j] !== b[j]) j++;
      for (let k = i; k < j; k++) out.push(`-${a[k]}`);
      for (let k = i; k < j; k++) out.push(`+${b[k]}`);
      deletions += j - i;
      additions += j - i;
      i = j;
    }
    return { patch: out.join("\n"), additions, deletions };
  }
  return {
    patch: [`@@ -${a.length ? 1 : 0},${a.length} +1,${b.length} @@`, ...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join("\n"),
    additions: b.length,
    deletions: a.length,
  };
}

export class FakeGitHub {
  readonly users = new Map<string, string>();
  readonly repos = new Map<string, RepoRec>();
  /** Every request, in order, with the login its token belongs to. */
  readonly calls: { method: string; path: string; as: string | null }[] = [];
  /** Optional shared timeline for ordering assertions. */
  timeline: string[] | null = null;

  addUser(login: string, token: string): void {
    this.users.set(token, login);
  }

  addRepo(fullName: string): void {
    const [owner = ""] = fullName.split("/");
    this.repos.set(fullName.toLowerCase(), { owner, files: new Map(), commits: new Map() });
  }

  commitsBy(fullName: string): CommitRec[] {
    return [...(this.repos.get(fullName.toLowerCase())?.commits.values() ?? [])];
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.origin !== FAKE_GITHUB_API) throw new Error(`Network blocked in tests: ${url.origin}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const as = token ? (this.users.get(token) ?? null) : null;
    this.calls.push({ method, path: url.pathname, as });
    this.timeline?.push(`github ${method} ${url.pathname}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/user") {
      return as ? json(200, { login: as, bio: null }) : json(401, { message: "Bad credentials" });
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(contents|commits|events)(?:\/(.+))?$/.exec(url.pathname);
    if (!m) return json(404, { message: "Not Found" });
    const full = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
    const repo = this.repos.get(full.toLowerCase());
    if (!repo) return json(404, { message: "Not Found" });
    const kind = m[3]!;
    const rest = m[4] ? decodeURIComponent(m[4]) : "";

    if (kind === "events") return json(200, []);

    if (kind === "contents") {
      const file = repo.files.get(rest);
      if (method === "GET") {
        if (!file) return json(404, { message: "Not Found" });
        return json(200, { sha: file.sha, content: Buffer.from(file.content).toString("base64"), encoding: "base64" });
      }
      if (method === "PUT") {
        if (!as) return json(401, { message: "Bad credentials" });
        if (as.toLowerCase() !== repo.owner.toLowerCase()) return json(403, { message: "Resource not accessible" });
        const body = JSON.parse(String(init?.body ?? "{}")) as { message: string; content: string; sha?: string };
        if (file && body.sha !== file.sha) return json(409, { message: "sha does not match" });
        if (!file && body.sha) return json(422, { message: "sha given for a new file" });
        const content = Buffer.from(body.content, "base64").toString("utf8");
        const diff = unifiedPatch(file?.content ?? null, content);
        const commit: CommitRec = {
          sha: hex(20),
          author_login: as,
          message: body.message,
          date: new Date().toISOString(),
          files: [{ filename: rest, status: file ? "modified" : "added", additions: diff.additions, deletions: diff.deletions, patch: diff.patch }],
        };
        repo.commits.set(commit.sha, commit);
        repo.files.set(rest, { content, sha: hex(20) });
        return json(file ? 200 : 201, {
          content: { path: rest, sha: repo.files.get(rest)!.sha },
          commit: { sha: commit.sha, html_url: `https://github.com/${full}/commit/${commit.sha}`, message: body.message },
        });
      }
    }

    if (kind === "commits" && method === "GET") {
      const commit = repo.commits.get(rest.toLowerCase());
      if (!commit) return json(404, { message: "Not Found" });
      const additions = commit.files.reduce((n, f) => n + f.additions, 0);
      const deletions = commit.files.reduce((n, f) => n + f.deletions, 0);
      return json(200, {
        sha: commit.sha,
        commit: { message: commit.message, author: { date: commit.date }, committer: { date: commit.date } },
        author: { login: commit.author_login },
        stats: { additions, deletions, total: additions + deletions },
        files: commit.files,
      });
    }
    return json(405, { message: "Method not allowed" });
  };
}
