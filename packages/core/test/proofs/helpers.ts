import { randomBytes } from "node:crypto";
import type { Db } from "mongodb";
import { z } from "zod";
import { makeFixturePack } from "../fixtures/pack";
import type { AnyPack } from "../../src/schema/pack";
import { fail, newId, type ChallengeType, type Features } from "../../src/schema/common";
import type { Challenge, ClockSettings } from "../../src/schema/challenges";
import type { Contract, DoesNotCountLine } from "../../src/schema/contracts";
import type { Membership } from "../../src/schema/memberships";
import type { Player } from "../../src/schema/players";
import type { InboxItem } from "../../src/schema/inbox";
import { isInboxItemExpired } from "../../src/schema/inbox";
import type { Rule } from "../../src/schema/rules";
import type { Cond, RuleAction, When } from "../../src/schema/rule";
import type { RefereeProofInput, RefereeProofOutput } from "../../src/schema/agents";
import { collections, isDuplicateKeyError } from "../../src/schema/collections";
import type {
  AgentInvokeResult,
  EvaluateResult,
  InboxResolveInput,
  LaneServices,
  LearningSourceInput,
  ServiceOverrides,
} from "../../src/interfaces";
import { renderRuleLine } from "../../src/packs/index";
import { demoClockSettings } from "../../src/clock";
import { PLAY_CREDIT_LABEL } from "../../src/config";

/**
 * Seeds, test packs and service doubles for the U5 pipeline tests. The doubles stand in for
 * U4 (engine), U8 (agents), U9 (learning) and U18 (inbox); nothing here reaches the network.
 */

export const T0 = new Date("2026-10-11T20:00:00.000Z");
export const at = (ms: number) => new Date(T0.getTime() + ms);
export const SEC = 1000;
export const SCORING = "One meaningful commit on your own project counts for that day.";

/** Demo clock: 5-minute days, 90-second grace, 7 days, starting at T0. */
export function stageClock(): ClockSettings {
  return demoClockSettings(T0, { days: 7, day_length_sec: 300, grace_sec: 90 });
}

export function sha(n: number): string {
  return n.toString(16).padStart(40, "a").slice(-40);
}

// ---------------------------------------------------------------- packs

const GitProofSchema = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Send the repository as owner/name."),
  sha: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{40}$/, "Send the full 40-character commit SHA, not a short SHA."),
});

function textFeatures(text: string): Features {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return { word_count: words, rename_only: /\brename/i.test(text), filler: words < 3, message_matches: text.slice(0, 500) };
}

/**
 * A Ship Week stand-in built on the U3 fixture pack: a commit proof (repo, sha) whose re-check
 * fetches the commit from GitHub's API through the injected fetch, and whose handle check reads
 * the profile bio. U14 owns the real pack; this only exercises U5's hand-offs.
 */
export function makeGitPack(): AnyPack {
  const base = makeFixturePack("ship_week");
  return {
    ...base,
    title: "Ship Week",
    proofSchema: GitProofSchema,
    sourceKey: (p) => String(p.sha),
    sourceTime: (_p, recheck) => recheck?.source?.created_at ?? null,
    handlePlatform: () => "github",
    extractFeatures: ({ recheck }) => textFeatures(recheck?.source?.text ?? ""),
    recheck: async (p, _player, _handle, ctx) => {
      const res = await ctx.fetch(`https://api.github.com/repos/${String(p.repo)}/commits/${String(p.sha)}`, {
        headers: ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {},
      });
      if (res.status === 404) return { status: "failed", source: null, reason: "Lane could not find this commit on GitHub.", info: {} };
      if (!res.ok) return { status: "pending", source: null, reason: "GitHub did not answer.", info: {} };
      const body = (await res.json()) as {
        commit: { message: string; author: { date: string } };
        author: { login: string } | null;
        stats: { additions: number; deletions: number };
        files: { patch?: string }[];
      };
      return {
        status: "rechecked",
        source: {
          kind: "commit",
          text: body.commit.message,
          diff: body.files.map((f) => f.patch ?? "").join("\n"),
          author: body.author?.login ?? null,
          stats: { files: body.files.length, additions: body.stats.additions, deletions: body.stats.deletions },
          created_at: new Date(body.commit.author.date),
          fetched_at: ctx.now,
        },
        reason: null,
        info: {},
      };
    },
    verifyHandle: async (handle, code, ctx) => {
      const res = await ctx.fetch(`https://api.github.com/users/${handle}`);
      const body = (await res.json()) as { bio?: string | null };
      return { verified: String(body.bio ?? "").includes(code), reason: null };
    },
  };
}

/** A mock of the GitHub API endpoints the git pack calls. Every request is recorded. */
export function fakeGitHub() {
  const commits = new Map<string, { repo: string; author: string; message: string; diff: string; date: Date }>();
  const bios = new Map<string, string>();
  const requests: { url: string; authorization: string | null }[] = [];
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({ url, authorization: headers.get("authorization") });
    const commit = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]{40})$/);
    if (commit) {
      const c = commits.get(commit[2] ?? "");
      if (!c || c.repo !== commit[1]) return new Response("{}", { status: 404 });
      const lines = c.diff.split("\n");
      return Response.json({
        sha: commit[2],
        commit: { message: c.message, author: { date: c.date.toISOString() } },
        author: { login: c.author },
        stats: { additions: lines.filter((l) => l.startsWith("+")).length, deletions: lines.filter((l) => l.startsWith("-")).length },
        files: [{ filename: "src/app.ts", patch: c.diff }],
      });
    }
    const user = url.match(/^https:\/\/api\.github\.com\/users\/([^/]+)$/);
    if (user) return Response.json({ login: user[1], bio: bios.get(user[1] ?? "") ?? "" });
    return new Response("not mocked", { status: 599 });
  }) as typeof fetch;
  return {
    fetch: fetchMock,
    requests,
    bios,
    addCommit(c: { sha: string; repo?: string; author: string; message: string; diff?: string; date: Date }) {
      commits.set(c.sha, {
        repo: c.repo ?? `${c.author}/sandbox`,
        author: c.author,
        message: c.message,
        diff: c.diff ?? "-const userId = 1;\n+const accountId = 1;",
        date: c.date,
      });
    },
  };
}

// ---------------------------------------------------------------- seeds

export async function seedChallenge(db: Db, opts: { type?: ChallengeType; clock?: ClockSettings } = {}): Promise<Challenge> {
  const clock = opts.clock ?? stageClock();
  const type = opts.type ?? "ship_week";
  const challenge: Challenge = {
    _id: newId("challenge"),
    type,
    status: "active",
    title: "Ship Week stage",
    creator_id: "plr_creator",
    join_code: randomBytes(3).toString("hex").toUpperCase(),
    stake: 10,
    winner_rule: "top_score",
    goal: 3,
    params: {},
    draft: null,
    clock,
    contract_version: 0,
    settlement: null,
    stage: true,
    created_at: T0,
    updated_at: T0,
    activated_at: T0,
    closed_at: null,
  };
  await collections(db).challenges.insertOne(challenge);
  await publishContract(db, challenge, []);
  return (await collections(db).challenges.findOne({ _id: challenge._id })) as Challenge;
}

/** Stand-in for U6's publish: a new contract version with the given "does not count" lines. */
export async function publishContract(db: Db, challenge: Challenge, lines: DoesNotCountLine[]): Promise<Contract> {
  const updated = await collections(db).challenges.findOneAndUpdate(
    { _id: challenge._id },
    { $inc: { contract_version: 1 } },
    { returnDocument: "after" },
  );
  const version = updated?.contract_version ?? 1;
  const clock = challenge.clock as ClockSettings;
  const contract: Contract = {
    _id: newId("contract"),
    challenge_id: challenge._id,
    version,
    fields: {
      challenge_type: challenge.type,
      title: challenge.title,
      goal: 3,
      score_unit: "days",
      window: { start_at: clock.start_at, end_at: new Date(clock.start_at.getTime() + clock.days * clock.day_length_sec * 1000), days: clock.days, day_length_sec: clock.day_length_sec },
      stake: 10,
      winner_rule: "top_score",
      credit_label: PLAY_CREDIT_LABEL,
      checkin: { interval_min: 27, surprise_checks_per_day: 3, quiet_hours: { start: "22:00", end: "08:00" }, grace_sec: clock.grace_sec },
      send: ["For each day, the repository and the full SHA of one commit you made that day."],
      scoring: SCORING,
      extra_proof: ["Put the code in the message of your next commit."],
      params: {},
    },
    agent_instructions: "Each day, submit one commit.",
    does_not_count: lines,
    built_from_rules: lines.map((l) => ({ rule_key: l.rule_key, version: l.rule_version })),
    reason: version === 1 ? "created" : "rule_activated",
    changes: [],
    created_at: T0,
  };
  await collections(db).contracts.insertOne(contract);
  return contract;
}

export async function seedPlayer(
  db: Db,
  name: string,
  github?: { handle: string; status?: "verified" | "unverified"; bind_code?: string },
): Promise<Player> {
  const player: Player = {
    _id: newId("player"),
    display_name: name,
    time_zone: "America/Los_Angeles",
    key_hash: randomBytes(32).toString("hex"),
    routine_text: "Check in every 27 minutes.",
    handles: github
      ? {
          github: {
            platform: "github",
            handle: github.handle,
            status: github.status ?? "verified",
            bind_code: github.bind_code ?? null,
            verified_at: (github.status ?? "verified") === "verified" ? T0 : null,
          },
        }
      : {},
    credits: 990,
    scripted: true,
    created_at: T0,
    updated_at: T0,
  };
  await collections(db).players.insertOne(player);
  return player;
}

export async function joinChallenge(db: Db, challenge: Challenge, player: Player): Promise<Membership> {
  const membership: Membership = {
    _id: newId("membership"),
    challenge_id: challenge._id,
    player_id: player._id,
    accepted_terms_version: "t1",
    handle_platform: player.handles.github ? "github" : null,
    joined_at: T0,
    joined_day_index: 0,
    last_check_in_at: null,
    last_seen_contract_version: 1,
  };
  await collections(db).memberships.insertOne(membership);
  return membership;
}

/**
 * Stand-in for U9's activation: an active rule in MongoDB, plus a new contract version with its
 * "does not count" line rendered from the predicate by the pack template (KTD15).
 */
export async function activateRule(
  db: Db,
  pack: AnyPack,
  challenge: Challenge,
  rule: { rule_key: string; when: When; action: RuleAction; cheat_class: string | null },
): Promise<Rule> {
  const doc: Rule = {
    _id: newId("rule"),
    rule_key: rule.rule_key,
    version: 1,
    parent_version: null,
    challenge_type: challenge.type,
    when: rule.when,
    action: rule.action,
    cheat_class: rule.cheat_class,
    reason: "Rule-writer reason, never shown to players.",
    source: "ai_judgment",
    evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
    status: "active",
    test_results: null,
    approval_id: null,
    created_at: T0,
    updated_at: T0,
    activated_at: T0,
    retired_at: null,
  };
  await collections(db).rules.insertOne(doc);
  await publishContract(db, challenge, [{ rule_key: doc.rule_key, rule_version: doc.version, line: renderRuleLine(pack, doc) }]);
  return doc;
}

// ---------------------------------------------------------------- doubles

const ACTION_ORDER: RuleAction[] = ["reject", "hold_payout", "ask_more", "flag"];

function condMatches(c: Cond, features: Features): boolean {
  const actual = features[c.feature];
  switch (c.op) {
    case "eq":
      return actual === c.value;
    case "in":
      return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
    case "matches":
      return typeof actual === "string" && typeof c.value === "string" && actual.toLowerCase().includes(c.value.toLowerCase());
    case "lt":
      return typeof actual === "number" && typeof c.value === "number" && actual < c.value;
    case "lte":
      return typeof actual === "number" && typeof c.value === "number" && actual <= c.value;
    case "gt":
      return typeof actual === "number" && typeof c.value === "number" && actual > c.value;
    case "gte":
      return typeof actual === "number" && typeof c.value === "number" && actual >= c.value;
  }
}

export type RefereeScript = (input: RefereeProofInput) => RefereeProofOutput | Promise<RefereeProofOutput> | "error";

export const refereeReject = (cheat = "rename_only"): RefereeProofOutput => ({
  verdict: "reject",
  reason: "The commit only renames a variable, which is not meaningful work.",
  fix: "Ship a commit that changes behavior.",
  cheat_class: cheat,
  confidence: 0.92,
  extra_proof: null,
});
export const refereeAccept = (): RefereeProofOutput => ({
  verdict: "accept",
  reason: "A real feature change.",
  fix: "",
  cheat_class: null,
  confidence: 0.88,
  extra_proof: null,
});

/** Default referee: rejects text that mentions a rename, accepts everything else. */
export const defaultReferee: RefereeScript = (input) =>
  /rename/i.test(`${input.source_text?.quoted_data ?? ""} ${input.proof.quoted_data}`) ? refereeReject() : refereeAccept();

export interface Doubles {
  overrides: ServiceOverrides;
  refereeCalls: RefereeProofInput[];
  engineCalls: { count: number };
  learning: LearningSourceInput[];
  inbox: { added: InboxItem[]; resolveCalls: InboxResolveInput[]; expireCalls: number };
  setReferee(script: RefereeScript): void;
}

export function makeDoubles(): Doubles {
  let script: RefereeScript = defaultReferee;
  const refereeCalls: RefereeProofInput[] = [];
  const engineCalls = { count: 0 };
  const learning: LearningSourceInput[] = [];
  const inbox = { added: [] as InboxItem[], resolveCalls: [] as InboxResolveInput[], expireCalls: 0 };

  const invoke = (async (input: { workspace: string; input: unknown }) => {
    const refInput = input.input as RefereeProofInput;
    refereeCalls.push(refInput);
    const out = await script(refInput);
    if (out === "error") {
      return { ok: false, error: "agent unavailable", schema_valid: true, timed_out: false, execution_id: null, latency_ms: 5 };
    }
    return { ok: true, status: "completed", output: out, execution_id: `exe_${refereeCalls.length}`, latency_ms: 5 } satisfies AgentInvokeResult<"referee">;
  }) as unknown as LaneServices["agents"]["invoke"];

  // U4 stand-in: reads active rules fresh from MongoDB on every call, never cached (KTD7).
  const evaluate = async (db: Db, input: { challenge_type: ChallengeType; features: Features }): Promise<EvaluateResult> => {
    engineCalls.count += 1;
    const rules = await collections(db).rules.find({ challenge_type: input.challenge_type, status: "active" }).toArray();
    rules.sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.rule_key.localeCompare(b.rule_key));
    const evaluated = rules.map((r) => ({ rule_key: r.rule_key, version: r.version }));
    const matched = rules
      .filter((r) => {
        const conds = "all" in r.when ? r.when.all : r.when.any;
        return "all" in r.when ? conds.every((c) => condMatches(c, input.features)) : conds.some((c) => condMatches(c, input.features));
      })
      .map((r) => ({ rule_key: r.rule_key, version: r.version, action: r.action }));
    const first = matched[0];
    return {
      decision: first ? first.action : "none",
      rule: first ? { rule_key: first.rule_key, version: first.version } : null,
      matched,
      evaluated,
    };
  };

  // U18 stand-in, backed by the real inbox collection and its unique indexes.
  const inboxDouble: LaneServices["inbox"] = {
    add: async (db, item, opts) => {
      const now = opts?.now ?? new Date();
      const doc: InboxItem = {
        ...item,
        _id: newId("inbox"),
        status: item.status ?? "open",
        notify_player_ids: item.notify_player_ids ?? [],
        answer_proof_id: null,
        created_at: now,
        updated_at: now,
        resolved_at: null,
        delivered_at: null,
      };
      try {
        await collections(db).inbox.insertOne(doc);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await collections(db).inbox.findOne({ subject_proof_id: item.subject_proof_id, kind: item.kind, status: "open" });
        if (!existing) throw err;
        return { item: existing, created: false };
      }
      inbox.added.push(doc);
      return { item: doc, created: true };
    },
    resolve: async (db, input) => {
      inbox.resolveCalls.push(input);
      const now = input.now ?? new Date();
      const item = await collections(db).inbox.findOne({ _id: input.item_id });
      if (!item) return fail("not_found", "No such item.", "Check in.");
      if (item.player_id !== input.by_player_id) return fail("not_allowed", "Not your item.", "Answer your own items.");
      if (isInboxItemExpired(item, now)) return fail("grace_closed", "Expired.", "Answer in time.");
      const updated = await collections(db).inbox.findOneAndUpdate(
        { _id: item._id, status: "open" },
        { $set: { status: "resolved", resolved_at: now, updated_at: now, answer_proof_id: input.answer_proof_id ?? null } },
        { returnDocument: "after" },
      );
      return { ok: true, item: updated ?? item, resolved: updated !== null };
    },
    expire: async (db, input) => {
      inbox.expireCalls += 1;
      const ids = input.item_ids ?? [];
      await collections(db).inbox.updateMany({ _id: { $in: ids }, status: "open" }, { $set: { status: "expired", updated_at: input.now } });
      return { expired: await collections(db).inbox.find({ _id: { $in: ids }, status: "expired" }).toArray() };
    },
  };

  return {
    overrides: {
      agents: { invoke },
      engine: { evaluate },
      inbox: inboxDouble,
      learning: {
        fromSource: async (_db, input) => {
          learning.push(input);
          return { job_id: null, queued: true, skipped_reason: null };
        },
      },
    },
    refereeCalls,
    engineCalls,
    learning,
    inbox,
    setReferee(next) {
      script = next;
    },
  };
}

/** A promise with its resolve function exposed, for referee replies that arrive late. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
