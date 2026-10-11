import type { Features } from "../../schema/common";
import type { Challenge } from "../../schema/challenges";
import type { InboxItem } from "../../schema/inbox";
import type { RecheckResult } from "../../schema/pack";
import { dayIndexAt, dayLengthMs } from "../../clock";
import { DIFF_CAP_CHARS } from "../../config";

/**
 * Ship Week feature extractor (U14 approach step 2).
 *
 * The re-check turns GitHub's commit into a capped, plain-text diff (`renderCappedDiff`). That
 * text is what the referee reads as quoted data, and it is also what this extractor parses
 * back (`parseCappedDiff`), so features always describe exactly what Lane fetched. Line-level
 * features (rename, whitespace, typo) are claimed only when the whole diff is visible; a
 * truncated or patch-less diff never reads as junk.
 */

// ------------------------------------------------------------------ capped diff text

/** One file of a GitHub commit, as the commits API returns it. */
export interface CommitFile {
  filename: string;
  previous_filename?: string | null;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunks. GitHub omits it for binary or very large files. */
  patch?: string | null;
}

export const MANIFEST_MAX_FILES = 40;
export const TRUNCATED_MARKER = "[diff truncated]";
const SECTION_PREFIX = "=== ";
const NO_PATCH_SUFFIX = " (no patch)";
const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  removed: "D",
  renamed: "R",
  copied: "C",
  changed: "T",
  unchanged: "U",
};

/** File names are player-controlled: strip control characters so they cannot fake structure. */
function cleanPath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 200);
}

/**
 * Render a commit's files as capped plain text: a summary line, a manifest of up to 40 files
 * with their line counts, then each file's hunks under a `=== path` header. Patch lines always
 * start with a space, `+`, `-`, `@` or `\`, so a header can never be forged from inside a patch.
 */
export function renderCappedDiff(
  files: readonly CommitFile[],
  totals: { additions: number; deletions: number },
  cap: number = DIFF_CAP_CHARS,
): string {
  const lines: string[] = [
    `${files.length} ${files.length === 1 ? "file" : "files"} changed, +${totals.additions} -${totals.deletions}`,
  ];
  for (const f of files.slice(0, MANIFEST_MAX_FILES)) {
    const letter = STATUS_LETTER[f.status] ?? "M";
    const name =
      (letter === "R" || letter === "C") && f.previous_filename
        ? `${cleanPath(f.previous_filename)} -> ${cleanPath(f.filename)}`
        : cleanPath(f.filename);
    lines.push(`${letter} ${name} +${f.additions} -${f.deletions}`);
  }
  if (files.length > MANIFEST_MAX_FILES) lines.push(`... and ${files.length - MANIFEST_MAX_FILES} more files`);
  for (const f of files) {
    if (!f.patch) {
      if (f.additions + f.deletions > 0) lines.push(`${SECTION_PREFIX}${cleanPath(f.filename)}${NO_PATCH_SUFFIX}`);
      continue;
    }
    lines.push(`${SECTION_PREFIX}${cleanPath(f.filename)}`);
    for (const line of f.patch.split("\n")) lines.push(line.replace(/\r$/, ""));
  }
  const full = lines.join("\n");
  if (full.length <= cap) return full;
  const room = cap - TRUNCATED_MARKER.length - 1;
  const cut = full.lastIndexOf("\n", room);
  return `${full.slice(0, cut > 0 ? cut : room)}\n${TRUNCATED_MARKER}`;
}

export interface DiffFile {
  status: string;
  filename: string;
  additions: number;
  deletions: number;
  /** Patch lines, or null when the diff shows none for this file. */
  patch: string[] | null;
}

export interface ParsedDiff {
  totalFiles: number;
  additions: number;
  deletions: number;
  files: DiffFile[];
  /** Every file is listed in the manifest. */
  manifestComplete: boolean;
  /** The text was cut at the cap. */
  truncated: boolean;
}

const HEAD_LINE = /^(\d+) files? changed, \+(\d+) -(\d+)$/;
const MANIFEST_LINE = /^([AMDRCTU]) (.+) \+(\d+) -(\d+)$/;
const MORE_FILES_LINE = /^\.\.\. and \d+ more files$/;

/** Inverse of `renderCappedDiff`. Returns null for text it did not render. */
export function parseCappedDiff(diff: string): ParsedDiff | null {
  const lines = diff.split("\n");
  const head = HEAD_LINE.exec(lines[0] ?? "");
  if (!head) return null;
  const files: DiffFile[] = [];
  let more = false;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith(SECTION_PREFIX) || line === TRUNCATED_MARKER) break;
    if (MORE_FILES_LINE.test(line)) {
      more = true;
      continue;
    }
    const m = MANIFEST_LINE.exec(line);
    if (!m) continue;
    let name = m[2] ?? "";
    if (m[1] === "R" || m[1] === "C") {
      const arrow = name.lastIndexOf(" -> ");
      if (arrow >= 0) name = name.slice(arrow + 4);
    }
    files.push({ status: m[1] ?? "M", filename: name, additions: Number(m[3]), deletions: Number(m[4]), patch: null });
  }
  const byName = new Map(files.map((f) => [f.filename, f]));
  let current: DiffFile | null = null;
  let truncated = false;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === TRUNCATED_MARKER && i === lines.length - 1) {
      truncated = true;
      break;
    }
    if (line.startsWith(SECTION_PREFIX)) {
      let name = line.slice(SECTION_PREFIX.length);
      const noPatch = name.endsWith(NO_PATCH_SUFFIX);
      if (noPatch) name = name.slice(0, -NO_PATCH_SUFFIX.length);
      current = noPatch ? null : (byName.get(name) ?? null);
      if (current) current.patch = current.patch ?? [];
      continue;
    }
    current?.patch?.push(line);
  }
  const totalFiles = Number(head[1]);
  return {
    totalFiles,
    additions: Number(head[2]),
    deletions: Number(head[3]),
    files,
    manifestComplete: !more && files.length === totalFiles,
    truncated,
  };
}

// ------------------------------------------------------------------ line analysis

const DOC_EXTENSIONS = /\.(md|mdx|markdown|rst|adoc|asciidoc)$/i;
const DOC_NAMES = /^(readme|license|licence|changelog|changes|contributing|authors|notice|code_of_conduct|history|security)(\.[a-z]+)?$/i;
const DOCS_DIR_TEXT = /(^|\/)docs?\/.+\.txt$/i;

/** Documentation files: Markdown and friends, README/LICENSE/CHANGELOG, and text files under docs/. */
export function isDocsFile(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  return DOC_EXTENSIONS.test(filename) || DOC_NAMES.test(base) || DOCS_DIR_TEXT.test(filename);
}

interface ChangeBlock {
  file: DiffFile;
  removed: string[];
  added: string[];
}

/** Consecutive removed and added lines, split at context and hunk lines. */
function changeBlocks(file: DiffFile): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let cur: ChangeBlock | null = null;
  for (const line of file.patch ?? []) {
    const c = line[0];
    if (c === "-" || c === "+") {
      cur ??= { file, removed: [], added: [] };
      (c === "-" ? cur.removed : cur.added).push(line.slice(1));
    } else if (c === "\\") {
      continue; // "\ No newline at end of file"
    } else {
      if (cur) blocks.push(cur);
      cur = null;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

const squash = (s: string): string => s.replace(/\s+/g, "");

function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, k) => v === y[k]);
}

/** Pair each non-blank removed line with the non-blank added line in the same position, or null. */
function linePairs(block: ChangeBlock): [string, string][] | null {
  const removed = block.removed.filter((l) => l.trim() !== "");
  const added = block.added.filter((l) => l.trim() !== "");
  if (removed.length !== added.length) return null;
  return removed.map((r, k) => [r, added[k] ?? ""]);
}

const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*|\d[\d_.]*|\S/g;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Words that look like identifiers but change meaning, so swapping them is never a rename. */
const KEYWORDS = new Set(
  (
    "abstract and as async await break case catch class const continue def default defer del delete do elif else enum " +
    "except export extends false False final finally fn for from func function go if impl implements import in instanceof " +
    "interface is let match mod mut new nil None not null or package pass private protected pub public raise return self " +
    "static struct super switch this throw throws true True try type typeof undefined unless until use var void while with yield"
  ).split(" "),
);

function isIdentifier(token: string): boolean {
  return IDENTIFIER.test(token) && !KEYWORDS.has(token);
}

/**
 * Rename-only: every removed line maps to an added line that differs only by one identifier
 * (possibly several occurrences of it), each identifier is renamed consistently across the
 * commit, and each rename touches at least two places, as a declaration and its uses do. A
 * single identifier swapped once, such as `isAdmin` to `isOwner` in one condition, is a logic
 * change and stays false.
 */
function isRenameOnly(blocks: ChangeBlock[]): boolean {
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  const uses = new Map<string, number>();
  for (const block of blocks) {
    const pairs = linePairs(block);
    if (!pairs) return false;
    for (const [oldLine, newLine] of pairs) {
      const a = oldLine.match(TOKEN) ?? [];
      const b = newLine.match(TOKEN) ?? [];
      if (a.length !== b.length) return false;
      let lineRename: [string, string] | null = null;
      let occurrences = 0;
      for (let k = 0; k < a.length; k++) {
        const x = a[k] ?? "";
        const y = b[k] ?? "";
        if (x === y) continue;
        if (!isIdentifier(x) || !isIdentifier(y)) return false;
        if (lineRename && (lineRename[0] !== x || lineRename[1] !== y)) return false;
        lineRename = [x, y];
        occurrences += 1;
      }
      if (!lineRename) continue;
      const [from, to] = lineRename;
      if ((forward.get(from) ?? to) !== to || (backward.get(to) ?? from) !== from) return false;
      forward.set(from, to);
      backward.set(to, from);
      uses.set(from, (uses.get(from) ?? 0) + occurrences);
    }
  }
  return uses.size > 0 && [...uses.values()].every((n) => n >= 2);
}

function inComment(prefix: string): boolean {
  return (
    prefix.includes("//") ||
    prefix.includes("/*") ||
    prefix.includes("<!--") ||
    /^\s*(\*|#|--\s|;)/.test(prefix) ||
    /\s#/.test(prefix)
  );
}

function inString(prefix: string): boolean {
  for (const quote of ['"', "'", "`"]) {
    let count = 0;
    for (let k = 0; k < prefix.length; k++) {
      if (prefix[k] === "\\") {
        k += 1;
        continue;
      }
      if (prefix[k] === quote) count += 1;
    }
    if (count % 2 === 1) return true;
  }
  return false;
}

export const TYPO_MAX_LINES = 3;
export const TYPO_MAX_CHARS = 3;

/** Typo-only: at most three lines changed, each by at most three characters inside a comment, a string or a docs file. */
function isTypoOnly(blocks: ChangeBlock[]): boolean {
  let changed = 0;
  for (const block of blocks) {
    const pairs = linePairs(block);
    if (!pairs) return false;
    for (const [oldRaw, newRaw] of pairs) {
      const o = oldRaw.trim();
      const n = newRaw.trim();
      if (o === n) continue;
      changed += 1;
      if (changed > TYPO_MAX_LINES) return false;
      let p = 0;
      while (p < o.length && p < n.length && o[p] === n[p]) p += 1;
      let s = 0;
      while (s < Math.min(o.length, n.length) - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s += 1;
      const oldPart = o.length - s - p;
      const newPart = n.length - s - p;
      if (Math.max(oldPart, newPart) > TYPO_MAX_CHARS) return false;
      const prefix = n.slice(0, p);
      if (!isDocsFile(block.file.filename) && !inComment(prefix) && !inString(prefix)) return false;
    }
  }
  return changed > 0;
}

// ------------------------------------------------------------------ message checks

/** Phrases that address the reviewer. Checked in the commit message. */
const MESSAGE_INJECTION = [
  /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(of\s+)?(your|the|previous|prior|earlier|above|these|those)\s+(previous\s+|prior\s+)?(rules|instructions|prompts?|guidelines)\b/,
  /\b(you|referee|verifier|lane)\b[^.\n]{0,30}\b(must|should|have to|need to)\s+(accept|approve|count|pass)\s+(this|it|my)\b/,
  /\b(accept|approve|count)\s+(this|my)\s+(commit|proof|submission)\b/,
  /\bmark\s+(this|it|the commit)\s+as\s+(accepted|valid|approved|meaningful|counted)\b/,
  /\bthis\s+(commit|proof)\s+(counts|is\s+(meaningful|valid|legit))\b/,
];
/** The narrower set checked in added lines, where honest UI copy may say "you must accept this". */
const LINE_INJECTION = [MESSAGE_INJECTION[0]!, MESSAGE_INJECTION[2]!, MESSAGE_INJECTION[3]!];

const normalizeText = (s: string): string => s.toLowerCase().replace(/\s+/g, " ");

export function hasInjectionText(message: string, addedLines: readonly string[]): boolean {
  const msg = normalizeText(message);
  if (MESSAGE_INJECTION.some((re) => re.test(msg))) return true;
  return addedLines.some((line) => {
    const l = normalizeText(line);
    return LINE_INJECTION.some((re) => re.test(l));
  });
}

/** Case-insensitive whole-token match of a one-time or bind code. */
export function containsCode(text: string, code: string): boolean {
  const c = code.trim();
  if (!c) return false;
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`, "i").test(text);
}

const ONE_TIME_CODE_KINDS = new Set<InboxItem["kind"]>(["extra_proof", "surprise_check"]);

// ------------------------------------------------------------------ backdating

/** Smallest author-to-committer gap that counts as backdating: 10 minutes, or half a demo day. */
export function backdateThresholdMs(challenge: Pick<Challenge, "clock">): number {
  return challenge.clock ? Math.min(10 * 60_000, dayLengthMs(challenge.clock) / 2) : 6 * 3_600_000;
}

/**
 * The author date (which sets the proof's day) is on an earlier challenge day than the
 * committer date. `git commit --date` moves only the author date. An amend on the same day is
 * not backdating.
 */
export function isBackdated(authored: Date | null, committed: Date | null, challenge: Pick<Challenge, "clock">): boolean {
  if (!authored || !committed) return false;
  const gap = committed.getTime() - authored.getTime();
  if (gap < backdateThresholdMs(challenge)) return false;
  if (!challenge.clock) return true;
  return dayIndexAt(challenge.clock, authored) < dayIndexAt(challenge.clock, committed);
}

// ------------------------------------------------------------------ extractor

export interface ShipWeekFeatureInput {
  recheck: RecheckResult | null;
  openRequests: readonly InboxItem[];
  challenge: Pick<Challenge, "clock">;
}

export const MESSAGE_FEATURE_CAP = 500;

export function emptyShipWeekFeatures(): Features {
  return {
    rename_only: false,
    whitespace_only: false,
    docs_only: false,
    typo_only: false,
    empty_commit: false,
    backdated: false,
    injection_text: false,
    code_lines_changed: 0,
    docs_lines_changed: 0,
    lines_added: 0,
    lines_removed: 0,
    files_changed: 0,
    message_matches: "",
    has_open_code: false,
    has_bind_code: false,
  };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Features of one commit, from the content the re-check fetched. */
export function extractShipWeekFeatures(input: ShipWeekFeatureInput): Features {
  const source = input.recheck?.source ?? null;
  if (!source) return emptyShipWeekFeatures();
  const message = source.text;
  const parsed = source.diff ? parseCappedDiff(source.diff) : null;
  const totalFiles = source.stats?.files ?? parsed?.totalFiles ?? 0;
  const additions = source.stats?.additions ?? parsed?.additions ?? 0;
  const deletions = source.stats?.deletions ?? parsed?.deletions ?? 0;
  const totalLines = additions + deletions;
  const files = parsed?.files ?? [];

  const docsLines = files.filter((f) => isDocsFile(f.filename)).reduce((n, f) => n + f.additions + f.deletions, 0);
  const manifestComplete = parsed?.manifestComplete === true && files.length === totalFiles;
  const fullyVisible =
    parsed !== null &&
    !parsed.truncated &&
    manifestComplete &&
    files.every((f) => f.additions + f.deletions === 0 || f.patch !== null);

  const blocks = fullyVisible ? files.flatMap(changeBlocks) : [];
  const lineFeatures = fullyVisible && totalLines > 0;
  const addedLines = files.flatMap((f) => (f.patch ?? []).filter((l) => l.startsWith("+")).map((l) => l.slice(1)));

  const openCodes = input.openRequests.filter((r) => r.status === "open" && r.code);
  const committed = parseDate(input.recheck?.info?.committed_at);

  return {
    rename_only: lineFeatures && isRenameOnly(blocks),
    whitespace_only:
      lineFeatures &&
      blocks.every((b) => sameMultiset(b.removed.map(squash).filter(Boolean), b.added.map(squash).filter(Boolean))),
    docs_only: totalFiles > 0 && manifestComplete && files.every((f) => isDocsFile(f.filename)),
    typo_only: lineFeatures && isTypoOnly(blocks),
    empty_commit: totalLines === 0,
    backdated: isBackdated(source.created_at, committed, input.challenge),
    injection_text: hasInjectionText(message, addedLines),
    code_lines_changed: Math.max(0, totalLines - docsLines),
    docs_lines_changed: docsLines,
    lines_added: additions,
    lines_removed: deletions,
    files_changed: totalFiles,
    message_matches: message.slice(0, MESSAGE_FEATURE_CAP),
    has_open_code: openCodes.some((r) => ONE_TIME_CODE_KINDS.has(r.kind) && containsCode(message, r.code ?? "")),
    has_bind_code: openCodes.some((r) => r.kind === "bind_code" && containsCode(message, r.code ?? "")),
  };
}

/** Lane-built feed line from features, for example "commit, 3 files, +42/-5" (KTD15). */
export function summarizeShipWeek(features: Features): string {
  const files = Number(features.files_changed ?? 0);
  const added = Number(features.lines_added ?? 0);
  const removed = Number(features.lines_removed ?? 0);
  return `commit, ${files} ${files === 1 ? "file" : "files"}, +${added}/-${removed}`;
}
