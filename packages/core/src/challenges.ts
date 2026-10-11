import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import type { ClientSession, Db } from "mongodb";
import {
  CHALLENGE_TYPES,
  fail,
  newId,
  type ChallengeType,
  type HandlePlatform,
  type LaneError,
  type Params,
} from "./schema/common";
import { collections, isDuplicateKeyError } from "./schema/collections";
import { WINNER_RULES, WinnerRuleSchema, type Challenge, type ClockSettings, type WinnerRule } from "./schema/challenges";
import type { Contract } from "./schema/contracts";
import type { Membership } from "./schema/memberships";
import { normalizeHandle, type Handle, type Player } from "./schema/players";
import type { InboxItem } from "./schema/inbox";
import type { LedgerEntry } from "./schema/ledger";
import type { AnyPack } from "./schema/pack";
import {
  OrchestratorDraftOutputSchema,
  quote,
  type OrchestratorDraftInput,
  type OrchestratorDraftOutput,
} from "./schema/agents";
import type {
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  DraftResult,
  JoinInput,
  JoinResult,
  JoinTerms,
} from "./interfaces";
import { services } from "./interfaces";
import { allPacks, getPack } from "./packs/index";
import { inTransaction } from "./ledger";
import { CHECKIN_INTERVAL_MIN, JOIN_CODE_LENGTH, PLAY_CREDIT_LABEL, QUIET_HOURS, SURPRISE_CHECKS_PER_DAY } from "./config";
import { dayIndexAt, demoClockSettings, finalGraceEnd, isWindowClosed, realClockSettings, windowEnd, windowStart } from "./clock";
import { writeEvent } from "./events";
import { checkInTerms, latestContract, publishContract } from "./contracts";

/**
 * Challenge creation, confirmation and joining (U6, R4 to R10, F1, AE7, KTD4, KTD12, KTD15, KTD21).
 *
 * - draft: the creator's sentence goes to the orchestrator as quoted data (KTD18). The
 *   orchestrator returns a clarifying question or typed parameters, and Lane validates the
 *   parameters against the pack's contract template and required draft fields before storing.
 *   Lane renders the title and preview itself; no orchestrator free text reaches other players.
 * - confirm: sets the winner rule and stake, generates a six-character join code, publishes
 *   contract version 1 and joins the creator, all in one transaction.
 * - join: two phases. The first call returns the terms and their version; the second call, with
 *   the accepted version and the pack's handle, inserts the membership, stakes through the
 *   ledger function and starts handle verification.
 */

// ---------------------------------------------------------------- local extensions of U3 inputs

/**
 * `DraftInput` plus an optional challenge type, for callers that already know it (for example a
 * tool argument). U3's `DraftInput` has no type field; this is an optional local extension.
 */
export interface DraftChallengeInput extends DraftInput {
  challenge_type?: ChallengeType;
}

/**
 * `ConfirmInput` plus optional local extensions: the creator's handle for packs that bind one
 * (KTD21), and the clock mode (real by default; U13's stage challenges use demo days).
 */
export interface ConfirmChallengeInput extends ConfirmInput {
  handle?: string;
  clock?: { mode: "real" | "demo"; day_length_sec?: number; grace_sec?: number };
}

export type ConfirmChallengeResult =
  | (Extract<ConfirmResult, { ok: true }> & {
      /** KTD21 bind-code action for the creator, or null. */
      bind_action: InboxItem | null;
      /** Set when the pack needs a handle the creator has not bound yet. */
      handle_needed: HandlePlatform | null;
      already_confirmed: boolean;
    })
  | { ok: false; error: LaneError };

// ---------------------------------------------------------------- small helpers

/** Readable join-code alphabet: no 0, O, 1 or I. Still matches the schema's [A-Z0-9]{6}. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const BIND_CODE_LENGTH = 6;
const SENTENCE_CAP = 500;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOIN_CODE_ATTEMPTS = 5;

export function generateJoinCode(): string {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  return code;
}

export function generateBindCode(): string {
  let code = "";
  for (let i = 0; i < BIND_CODE_LENGTH; i++) code += JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)];
  return `LANE-${code}`;
}

export function normalizeJoinCode(code: string | null | undefined): string {
  return (code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const PLATFORM_NAMES: Record<HandlePlatform, string> = {
  github: "GitHub",
  x: "X",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  threads: "Threads",
};

export function platformName(platform: HandlePlatform): string {
  return PLATFORM_NAMES[platform];
}

function credits(amount: number): string {
  return `${amount} ${PLAY_CREDIT_LABEL}`;
}

/** Thrown inside a transaction to abort it and return an expected failure. */
class OutcomeAbort extends Error {
  constructor(readonly failure: { ok: false; error: LaneError }) {
    super(failure.error.message);
    this.name = "OutcomeAbort";
  }
}

function isJoinCodeCollision(err: unknown): boolean {
  if (!isDuplicateKeyError(err)) return false;
  const e = err as { keyPattern?: Record<string, unknown>; message?: string };
  return Boolean(e.keyPattern?.join_code) || /join_code/.test(e.message ?? "");
}

function agentFailed(): { ok: false; error: LaneError } {
  return fail(
    "agent_failed",
    "Lane could not read the challenge description right now.",
    "Call lane_create_challenge again in a minute with the same sentence.",
  );
}

// ---------------------------------------------------------------- winner rule and terms text

export function winnerRuleLine(rule: WinnerRule, goal: number, unit: string): string {
  return rule === "top_score"
    ? "Winner rule: the highest verified score takes the pot, and ties split it."
    : `Winner rule: everyone who reaches the goal of ${goal} ${unit} splits the pot.`;
}

function winnerRuleChoiceLines(goal: number, unit: string): string[] {
  return WINNER_RULES.map((r) => `${r}: ${winnerRuleLine(r, goal, unit).replace(/^Winner rule: /, "")}`);
}

/**
 * The join terms (U6 approach step 4): play-credit label, stake, winner rule, window, the
 * check-in routine, the surprise-check limit, quiet hours and what the pack asks Muse to send.
 * Values come from config and the challenge. The version is a hash of the rendered lines, so it
 * is stable between the two join calls and changes whenever the terms do.
 */
export function buildJoinTerms(challenge: Challenge, pack: AnyPack = getPack(challenge.type)): JoinTerms {
  const { stake, winner_rule, goal, clock } = requireConfirmed(challenge);
  const checkin = checkInTerms(challenge);
  const handlePlatform = pack.handlePlatform(challenge);
  const send = pack.contract.render({
    params: challenge.params,
    title: challenge.title,
    goal,
    stake,
    winner_rule,
    days: clock.days,
    day_length_sec: clock.day_length_sec,
  }).send;
  const start = windowStart(clock);
  const end = windowEnd(clock);

  const lines = [
    `${challenge.title} (${pack.title}).`,
    `Stakes and payouts are ${PLAY_CREDIT_LABEL}. Nothing here is real money.`,
    `Stake: ${credits(stake)}, paid into the pot when you join.`,
    winnerRuleLine(winner_rule, goal, pack.scoreUnit),
    `Goal: ${goal} ${pack.scoreUnit}.`,
    `Window: ${clock.days} days, from ${start.toISOString()} to ${end.toISOString()}. Days before you join count as missed.`,
    `Check-ins: your agent checks in with Lane every ${CHECKIN_INTERVAL_MIN} minutes and relays what Lane sends.`,
    `Surprise checks: up to ${SURPRISE_CHECKS_PER_DAY} surprise proof checks a day, never between ${QUIET_HOURS.start} and ${QUIET_HOURS.end} in your time zone.`,
    ...send.map((line) => `What your agent sends: ${line}`),
  ];
  if (handlePlatform) {
    lines.push(
      `Handle: you bind your ${platformName(handlePlatform)} handle by putting a code Lane gives you in your profile bio. Your proofs count once it is verified.`,
    );
  }
  const capped = lines.map((l) => (l.length > 300 ? `${l.slice(0, 297)}...` : l));
  const terms_version = `terms-${createHash("sha256").update(JSON.stringify(capped)).digest("hex").slice(0, 16)}`;
  return {
    terms_version,
    lines: capped,
    stake,
    winner_rule,
    window: { start_at: start, end_at: end, days: clock.days },
    checkin,
    handle_platform: handlePlatform,
    credit_label: PLAY_CREDIT_LABEL,
  };
}

function requireConfirmed(challenge: Challenge): {
  stake: number;
  winner_rule: WinnerRule;
  goal: number;
  clock: ClockSettings;
} {
  const { stake, winner_rule, goal, clock } = challenge;
  if (stake === null || winner_rule === null || goal === null || clock === null) {
    throw new Error(`Challenge ${challenge._id} is not confirmed.`);
  }
  return { stake, winner_rule, goal, clock };
}

// ---------------------------------------------------------------- draft (R4, AE7)

function packDraftSpec(pack: AnyPack): OrchestratorDraftInput["packs"][number] {
  return {
    type: pack.type,
    title: pack.title,
    required_fields: [...pack.contract.requiredDraftFields],
    params_json_schema: z.toJSONSchema(pack.contract.paramsSchema, { unrepresentable: "any" }) as Record<string, unknown>,
  };
}

/** Keep only the pack's typed parameters. Partial mode keeps each valid known key on its own. */
function sanitizeParams(pack: AnyPack, params: Params, partial: boolean): { ok: true; params: Params } | { ok: false; fields: string[] } {
  const schema = pack.contract.paramsSchema;
  if (schema instanceof z.ZodObject) {
    if (partial) {
      const kept: Params = {};
      for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
        if (!(key in params)) continue;
        const parsed = field.safeParse(params[key]);
        if (parsed.success && parsed.data !== undefined) kept[key] = parsed.data as Params[string];
      }
      return { ok: true, params: kept };
    }
  }
  const parsed = schema.safeParse(params);
  if (parsed.success) return { ok: true, params: parsed.data as Params };
  const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "params")))];
  return { ok: false, fields };
}

function isMissing(value: Params[string] | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** A Lane-rendered clarifying question for fields the template still needs (R4). */
function missingFieldsQuestion(pack: AnyPack | null, fields: string[]): string {
  if (!pack || fields.includes("challenge_type")) {
    const titles = allPacks().map((p) => p.title);
    return `Which challenge should this be: ${titles.slice(0, -1).join(", ")} or ${titles[titles.length - 1]}?`;
  }
  const phrases = fields.map((f) => f.replace(/_/g, " "));
  return `Which ${phrases.join(" and ")} should count for ${pack.title}?`;
}

/** Keyword guess for the type when the orchestrator could not tell. Lane-side only. */
function guessType(text: string): ChallengeType | null {
  const t = text.toLowerCase();
  for (const pack of allPacks()) {
    if (t.includes(pack.title.toLowerCase())) return pack.type;
  }
  if (/\bcommit|\bship|\bcode\b|\bgithub/.test(t)) return "ship_week";
  if (/\bcustomer|\bprospect|\bcall|\binterview/.test(t)) return "customers";
  if (/\bpost|\bbuild in public|\btweet|\blinkedin|\binstagram|\bthreads\b/.test(t)) return "build_in_public";
  return null;
}

function draftTitle(player: Player, pack: AnyPack | null): string {
  return pack ? `${player.display_name}'s ${pack.title}`.slice(0, 80) : `${player.display_name}'s new challenge`.slice(0, 80);
}

function previewLines(pack: AnyPack, title: string, params: Params, goal: number, days: number): string[] {
  const rendered = pack.contract.render({
    params,
    title,
    goal,
    stake: 1,
    winner_rule: "top_score",
    days,
    day_length_sec: 86_400,
  });
  return [
    `${title}: ${pack.title}, ${days} days starting when you confirm.`,
    rendered.scoring,
    ...rendered.send.map((line) => `Each player's agent sends: ${line}`),
    `Choose the winner rule: ${winnerRuleChoiceLines(goal, pack.scoreUnit).join(" | ")}`,
    `Choose the stake each player pays into the pot, in ${PLAY_CREDIT_LABEL}.`,
    `Players check in every ${CHECKIN_INTERVAL_MIN} minutes and accept up to ${SURPRISE_CHECKS_PER_DAY} surprise checks a day, never between ${QUIET_HOURS.start} and ${QUIET_HOURS.end}.`,
  ].map((l) => (l.length > 300 ? `${l.slice(0, 297)}...` : l));
}

/**
 * Turn the creator's sentence into a draft, or a clarifying question with a draft id (R4).
 * With `draft_id`, `sentence` is the creator's answer to the previous question.
 * Implements the U6 `challenges.draft` interface.
 */
export async function draftChallenge(db: Db, input: DraftChallengeInput): Promise<DraftResult> {
  const now = input.now ?? new Date();
  const col = collections(db);
  const player = await col.players.findOne({ _id: input.player_id });
  if (!player) return fail("not_found", "That player does not exist.", "Register first with lane_register.");

  const text = (input.sentence ?? "").trim().slice(0, SENTENCE_CAP);
  if (!text) {
    return fail(
      "invalid_input",
      "Lane needs the challenge described in one sentence.",
      "Call lane_create_challenge with the creator's own sentence.",
    );
  }
  if (input.challenge_type !== undefined && !(CHALLENGE_TYPES as readonly string[]).includes(input.challenge_type)) {
    return fail("invalid_input", "Unknown challenge type.", "Use ship_week, customers or build_in_public, or leave it out.");
  }

  let existing: Challenge | null = null;
  if (input.draft_id) {
    existing = await col.challenges.findOne({ _id: input.draft_id });
    if (!existing || existing.creator_id !== player._id) {
      return fail("not_found", "That draft does not exist for this player.", "Call lane_create_challenge without draft_id to start a new draft.");
    }
    if (existing.status !== "draft") {
      return fail(
        "conflict",
        "That challenge is already confirmed.",
        `Share join code ${existing.join_code ?? ""} with the other players instead.`.trim(),
      );
    }
  }

  const typeSettled = existing ? !(existing.draft?.missing_fields ?? []).includes("challenge_type") : input.challenge_type !== undefined;
  const knownType: ChallengeType | null = existing ? (typeSettled ? existing.type : null) : (input.challenge_type ?? null);
  const knownParams: Params = existing?.params ?? {};

  const orchestratorInput: OrchestratorDraftInput = {
    mode: "draft",
    sentence: quote(existing?.draft?.sentence ?? text, SENTENCE_CAP),
    answer: existing ? quote(text, SENTENCE_CAP) : null,
    previous_question: existing?.draft?.question ?? null,
    known_params: knownParams,
    challenge_type: knownType,
    packs: allPacks().map(packDraftSpec),
  };
  const invoked = await services().agents.invoke({
    workspace: "orchestrator",
    mode: "draft",
    input: orchestratorInput,
    meta: { player_id: player._id, challenge_id: existing?._id ?? null },
  });
  if (!invoked.ok || invoked.status !== "completed") return agentFailed();
  const parsed = OrchestratorDraftOutputSchema.safeParse(invoked.output);
  if (!parsed.success) return agentFailed();
  const out: OrchestratorDraftOutput = parsed.data;

  // The type: settled earlier, or from the orchestrator, or a Lane keyword guess.
  const outType = out.challenge_type ?? null;
  const type: ChallengeType | null = knownType ?? outType ?? guessType(`${existing?.draft?.sentence ?? ""} ${text}`);
  const pack = type ? getPack(type) : null;

  let question: string | null = null;
  let missing: string[] = [];
  let params: Params = knownParams;
  let goal: number | null = existing?.goal ?? null;
  let days: number | null = existing?.clock?.days ?? null;

  if (out.kind === "question") {
    if (pack) {
      const kept = sanitizeParams(pack, { ...knownParams, ...out.params }, true);
      params = kept.ok ? kept.params : knownParams;
    }
    missing = [...new Set(out.missing_fields.map((f) => f.slice(0, 48)))].slice(0, 8);
    if (!type) missing = ["challenge_type", ...missing.filter((f) => f !== "challenge_type")];
    // A question always leaves the draft unconfirmable until it is answered.
    if (missing.length === 0) missing = ["details"];
    question = out.question ?? missingFieldsQuestion(pack, missing);
  } else if (!pack) {
    missing = ["challenge_type"];
    question = missingFieldsQuestion(null, missing);
  } else {
    const merged: Params = { ...knownParams, ...out.params };
    const full = sanitizeParams(pack, merged, false);
    const needed = pack.contract.requiredDraftFields.filter((f) => isMissing(merged[f]));
    const shape = [...(out.goal === null ? ["goal"] : []), ...(out.days === null ? ["days"] : [])];
    missing = [...new Set([...needed, ...(full.ok ? [] : full.fields), ...shape])];
    if (missing.length > 0) {
      const kept = sanitizeParams(pack, merged, true);
      params = kept.ok ? kept.params : knownParams;
      question = missingFieldsQuestion(pack, missing);
    } else if (full.ok) {
      params = full.params;
    }
    if (out.days !== null) days = out.days;
    if (out.goal !== null) goal = pack.scoreUnit === "days" && days !== null ? Math.min(out.goal, days) : out.goal;
  }

  const provisionalType: ChallengeType = type ?? existing?.type ?? "ship_week";
  const draftDays = days ?? 7;
  const isDraftReady = missing.length === 0 && pack !== null && goal !== null;
  const title = draftTitle(player, pack);
  const draftDoc: Pick<Challenge, "type" | "title" | "params" | "goal" | "clock" | "draft" | "updated_at"> = {
    type: provisionalType,
    title,
    params,
    goal: isDraftReady ? goal : (goal ?? null),
    // Provisional clock so the draft carries its length in days; confirm restarts it.
    clock: realClockSettings(now, draftDays),
    draft: { sentence: existing?.draft?.sentence ?? text, question: isDraftReady ? null : question, missing_fields: isDraftReady ? [] : missing },
    updated_at: now,
  };

  let draftId: string;
  if (existing) {
    const updated = await col.challenges.updateOne({ _id: existing._id, status: "draft" }, { $set: draftDoc });
    if (updated.matchedCount === 0) {
      return fail("conflict", "That challenge is already confirmed.", "Use its join code instead of editing the draft.");
    }
    draftId = existing._id;
  } else {
    const challenge: Challenge = {
      _id: newId("challenge"),
      status: "draft",
      creator_id: player._id,
      stake: null,
      winner_rule: null,
      contract_version: 0,
      settlement: null,
      stage: false,
      created_at: now,
      activated_at: null,
      closed_at: null,
      ...draftDoc,
    };
    await col.challenges.insertOne(challenge);
    draftId = challenge._id;
  }

  await writeEvent(db, {
    kind: "challenge.drafted",
    summary: isDraftReady ? `${player.display_name} drafted ${pack?.title ?? "a challenge"}` : `${player.display_name} is drafting a challenge`,
    challenge_id: draftId,
    challenge_type: type,
    player_id: player._id,
    data: { ready: isDraftReady, missing: missing.length },
    at: now,
  });

  if (!isDraftReady || !pack || goal === null) {
    return {
      ok: true,
      kind: "question",
      draft_id: draftId,
      question: question ?? missingFieldsQuestion(pack, missing.length > 0 ? missing : ["challenge_type"]),
      missing_fields: missing.length > 0 ? missing : ["challenge_type"],
    };
  }
  return {
    ok: true,
    kind: "draft",
    draft_id: draftId,
    challenge_type: pack.type,
    title,
    goal,
    days: draftDays,
    params,
    preview_lines: previewLines(pack, title, params, goal, draftDays),
    winner_rules: [...WINNER_RULES],
  };
}

// ---------------------------------------------------------------- join core (shared by confirm and join)

interface HandlePlan {
  platform: HandlePlatform;
  handle: string;
  /** Already verified on the player: nothing to bind. */
  verified: boolean;
}

/**
 * Decide the handle a join binds (KTD21). Returns null when the pack needs none, a plan when it
 * does, or a failure. `required` is false for the creator's automatic join at confirm.
 */
async function planHandle(
  db: Db,
  player: Player,
  platform: HandlePlatform | null,
  given: string | undefined,
  required: boolean,
): Promise<{ ok: true; plan: HandlePlan | null } | { ok: false; error: LaneError }> {
  if (!platform) return { ok: true, plan: null };
  const name = platformName(platform);
  const current: Handle | undefined = player.handles[platform];
  const normalized = given !== undefined && given.trim() !== "" ? normalizeHandle(given) : null;

  if (current?.status === "verified") {
    if (normalized && normalized !== current.handle) {
      return fail(
        "conflict",
        `This player already has the ${name} handle ${current.handle} verified.`,
        `Call again without handle, or with ${current.handle}.`,
      );
    }
    return { ok: true, plan: { platform, handle: current.handle, verified: true } };
  }
  if (!normalized) {
    if (!required) return { ok: true, plan: null };
    return fail(
      "invalid_input",
      `This challenge needs the player's ${name} handle.`,
      `Ask the player for their ${name} username, then call lane_join_challenge again with handle set to it.`,
    );
  }
  if (!HANDLE_PATTERN.test(normalized)) {
    return fail("invalid_input", `That is not a valid ${name} username.`, `Send the player's ${name} username without spaces or a URL.`);
  }
  const taken = await collections(db).players.findOne(
    { _id: { $ne: player._id }, [`handles.${platform}.handle`]: normalized, [`handles.${platform}.status`]: "verified" },
    { projection: { _id: 1 } },
  );
  if (taken) {
    return fail(
      "handle_taken",
      `That ${name} handle is already verified by another player.`,
      `Send the player's own ${name} username.`,
    );
  }
  return { ok: true, plan: { platform, handle: normalized, verified: false } };
}

/** Bind an unverified handle on the player and queue the bind-code action (KTD21). */
async function startHandleVerification(
  db: Db,
  session: ClientSession,
  player: Player,
  challenge: Challenge,
  plan: HandlePlan,
  now: Date,
): Promise<InboxItem | null> {
  if (plan.verified) return null;
  const col = collections(db);
  const current = player.handles[plan.platform];
  const bindCode = current && current.status === "unverified" && current.handle === plan.handle && current.bind_code
    ? current.bind_code
    : generateBindCode();
  const handle: Handle = { platform: plan.platform, handle: plan.handle, status: "unverified", bind_code: bindCode, verified_at: null };
  await col.players.updateOne(
    { _id: player._id, [`handles.${plan.platform}.status`]: { $ne: "verified" } },
    { $set: { [`handles.${plan.platform}`]: handle, updated_at: now } },
    { session },
  );
  const name = platformName(plan.platform);
  const added = await services().inbox.add(
    db,
    {
      player_id: player._id,
      challenge_id: challenge._id,
      kind: "bind_code",
      actor: "player",
      instruction:
        `Put the code ${bindCode} in your ${name} profile bio so Lane can confirm that ${plan.handle} is yours. ` +
        `Your proofs are held until Lane sees it. Then tell your agent to answer this request with lane_submit_proof.`,
      answer_tool: "lane_submit_proof",
      answer_args: { challenge_id: challenge._id },
      day_index: null,
      subject_proof_id: null,
      slot: null,
      code: bindCode,
      release_at: null,
      due_at: challenge.clock ? finalGraceEnd(challenge.clock) : null,
    },
    { session, now },
  );
  return added.item;
}

interface JoinCoreResult {
  membership: Membership;
  stake_entry: LedgerEntry;
  bind_action: InboxItem | null;
}

/** Insert the membership, stake through the ledger function and start handle verification. */
async function joinInSession(
  db: Db,
  session: ClientSession,
  args: {
    challenge: Challenge;
    player: Player;
    terms_version: string;
    handle: HandlePlan | null;
    handle_platform: HandlePlatform | null;
    contract_version: number;
    now: Date;
    creator: boolean;
  },
): Promise<JoinCoreResult> {
  const { challenge, player, now } = args;
  const { stake, clock } = requireConfirmed(challenge);
  const dayAtJoin = Math.min(Math.max(dayIndexAt(clock, now), 0), clock.days - 1);
  const membership: Membership = {
    _id: newId("membership"),
    challenge_id: challenge._id,
    player_id: player._id,
    accepted_terms_version: args.terms_version,
    handle_platform: args.handle_platform,
    joined_at: now,
    joined_day_index: dayAtJoin,
    last_check_in_at: null,
    last_seen_contract_version: args.contract_version,
  };
  await collections(db).memberships.insertOne(membership, { session });

  const staked = await services().ledger.append(
    db,
    { player_id: player._id, challenge_id: challenge._id, kind: "stake", amount: stake },
    { session, now },
  );
  if (!staked.ok) {
    if (staked.error.code === "insufficient_credits") {
      const balance = (await collections(db).players.findOne({ _id: player._id }, { session, projection: { credits: 1 } }))?.credits ?? 0;
      throw new OutcomeAbort(
        fail(
          "insufficient_credits",
          `The stake is ${credits(stake)}, and the balance is ${credits(balance)}.`,
          args.creator
            ? "Confirm again with a stake no larger than the balance."
            : "Nothing was staked. Ask the creator for a challenge with a smaller stake, or join once a payout raises the balance.",
        ),
      );
    }
    throw new OutcomeAbort({ ok: false, error: staked.error });
  }

  const bind_action = args.handle ? await startHandleVerification(db, session, player, challenge, args.handle, now) : null;

  await writeEvent(
    db,
    {
      kind: "challenge.joined",
      summary: `${player.display_name} joined ${challenge.title}`,
      challenge_id: challenge._id,
      challenge_type: challenge.type,
      player_id: player._id,
      data: { stake, day_index: dayAtJoin, creator: args.creator },
      at: now,
    },
    { session },
  );
  return { membership, stake_entry: staked.entry, bind_action };
}

async function openBindAction(db: Db, playerId: string, challengeId: string): Promise<InboxItem | null> {
  return collections(db).inbox.findOne({ player_id: playerId, challenge_id: challengeId, kind: "bind_code", status: "open" });
}

/** State for a player who is already a member (idempotent repeat of confirm or join). */
async function memberState(
  db: Db,
  challenge: Challenge,
  player: Player,
  givenHandle: string | undefined,
  now: Date,
): Promise<
  | { ok: true; membership: Membership; contract: Contract; stake_entry: LedgerEntry; bind_action: InboxItem | null }
  | { ok: false; error: LaneError }
> {
  const col = collections(db);
  const membership = await col.memberships.findOne({ challenge_id: challenge._id, player_id: player._id });
  const stake_entry = await col.ledger.findOne({ challenge_id: challenge._id, kind: "stake", player_id: player._id });
  const contract = await latestContract(db, challenge._id);
  if (!membership || !stake_entry || !contract) {
    return fail("internal", "Lane could not load this membership.", "Call lane_join_challenge again in a moment.");
  }
  // A member may bind or re-send a handle later by joining again with it (KTD21).
  const platform = getPack(challenge.type).handlePlatform(challenge);
  let bind_action = await openBindAction(db, player._id, challenge._id);
  if (platform && givenHandle && givenHandle.trim() !== "" && player.handles[platform]?.status !== "verified") {
    const planned = await planHandle(db, player, platform, givenHandle, false);
    if (!planned.ok) return planned;
    const plan = planned.plan;
    const unchanged = plan && player.handles[platform]?.handle === plan.handle && bind_action !== null;
    if (plan && !unchanged) {
      if (bind_action) {
        await col.inbox.updateOne({ _id: bind_action._id, status: "open" }, { $set: { status: "cancelled", updated_at: now } });
      }
      bind_action = await inTransaction(db, (session) => startHandleVerification(db, session, player, challenge, plan, now));
    }
  }
  return { ok: true, membership, contract, stake_entry, bind_action };
}

// ---------------------------------------------------------------- confirm (R6, R7)

/**
 * Confirm a draft with the winner rule and stake: activate it with a fresh join code, publish
 * contract version 1 and join the creator, in one transaction. Implements `challenges.confirm`.
 */
export async function confirmChallenge(db: Db, input: ConfirmChallengeInput): Promise<ConfirmChallengeResult> {
  const now = input.now ?? new Date();
  const col = collections(db);
  const winner = WinnerRuleSchema.safeParse(input.winner_rule);
  if (!winner.success) {
    return fail(
      "invalid_input",
      "The winner rule must be top_score or finishers_split.",
      "Ask the creator which winner rule they want, then confirm again with it.",
    );
  }
  if (!Number.isInteger(input.stake) || input.stake < 1) {
    return fail(
      "invalid_input",
      `The stake must be a whole number of ${PLAY_CREDIT_LABEL} above zero.`,
      "Ask the creator for the stake, then confirm again with it.",
    );
  }

  const player = await col.players.findOne({ _id: input.player_id });
  if (!player) return fail("not_found", "That player does not exist.", "Register first with lane_register.");
  const draft = await col.challenges.findOne({ _id: input.draft_id });
  if (!draft || draft.creator_id !== player._id) {
    return fail("not_found", "That draft does not exist for this player.", "Call lane_create_challenge to start a draft.");
  }
  if (draft.status !== "draft") return confirmedState(db, draft, player, input, now);
  if ((draft.draft?.missing_fields ?? []).length > 0 || draft.goal === null || draft.clock === null) {
    return fail(
      "invalid_input",
      `The draft still needs: ${(draft.draft?.missing_fields ?? ["details"]).join(", ")}.`,
      "Answer the clarifying question with lane_create_challenge and the draft_id first.",
    );
  }
  if (player.credits < input.stake) {
    return fail(
      "insufficient_credits",
      `The stake is ${credits(input.stake)}, and the balance is ${credits(player.credits)}.`,
      "Ask the creator for a stake no larger than their balance, then confirm again.",
    );
  }

  const pack = getPack(draft.type);
  const platform = pack.handlePlatform(draft);
  const planned = await planHandle(db, player, platform, input.handle, false);
  if (!planned.ok) return planned;

  const days = draft.clock.days;
  const clock: ClockSettings =
    input.clock?.mode === "demo"
      ? demoClockSettings(now, { days, day_length_sec: input.clock.day_length_sec, grace_sec: input.clock.grace_sec })
      : realClockSettings(now, days);

  for (let attempt = 0; attempt < JOIN_CODE_ATTEMPTS; attempt++) {
    const joinCode = generateJoinCode();
    try {
      const result = await inTransaction(db, async (session) => {
        const activated = await col.challenges.findOneAndUpdate(
          { _id: draft._id, status: "draft", creator_id: player._id },
          {
            $set: {
              status: "active",
              join_code: joinCode,
              stake: input.stake,
              winner_rule: winner.data,
              clock,
              draft: draft.draft ? { ...draft.draft, question: null, missing_fields: [] } : null,
              activated_at: now,
              updated_at: now,
            },
          },
          { session, returnDocument: "after" },
        );
        if (!activated) return null;
        const { contract } = await publishContract(
          db,
          { challenge_id: activated._id, reason: "created", changes: ["First version of the contract."], now },
          { session },
        );
        const confirmed: Challenge = { ...activated, contract_version: contract.version };
        const terms = buildJoinTerms(confirmed, pack);
        const joined = await joinInSession(db, session, {
          challenge: confirmed,
          player,
          terms_version: terms.terms_version,
          handle: planned.plan,
          handle_platform: platform,
          contract_version: contract.version,
          now,
          creator: true,
        });
        await writeEvent(
          db,
          {
            kind: "challenge.confirmed",
            summary: `${player.display_name} confirmed ${confirmed.title}`,
            challenge_id: confirmed._id,
            challenge_type: confirmed.type,
            player_id: player._id,
            data: { stake: input.stake, winner_rule: winner.data, days },
            at: now,
          },
          { session },
        );
        return { challenge: confirmed, contract, ...joined };
      });

      if (!result) {
        // Another call confirmed it first: return that state (KTD6).
        const current = await col.challenges.findOne({ _id: draft._id });
        if (!current) return fail("not_found", "That draft no longer exists.", "Call lane_create_challenge to start again.");
        return confirmedState(db, current, player, input, now);
      }
      return {
        ok: true,
        challenge: result.challenge,
        join_code: joinCode,
        membership: result.membership,
        contract: result.contract,
        stake_entry: result.stake_entry,
        bind_action: result.bind_action,
        handle_needed: platform && !planned.plan ? platform : null,
        already_confirmed: false,
      };
    } catch (err) {
      if (err instanceof OutcomeAbort) return err.failure;
      if (isJoinCodeCollision(err)) continue;
      if (isDuplicateKeyError(err)) {
        const current = await col.challenges.findOne({ _id: draft._id });
        if (current && current.status !== "draft") return confirmedState(db, current, player, input, now);
      }
      throw err;
    }
  }
  return fail("conflict", "Lane could not allocate a join code.", "Call lane_confirm_challenge again.");
}

async function confirmedState(
  db: Db,
  challenge: Challenge,
  player: Player,
  input: ConfirmChallengeInput,
  now: Date,
): Promise<ConfirmChallengeResult> {
  if (challenge.status === "draft" || !challenge.join_code) {
    return fail("conflict", "That draft is not confirmed yet.", "Call lane_confirm_challenge again.");
  }
  if (challenge.stake !== input.stake || challenge.winner_rule !== input.winner_rule) {
    return fail(
      "conflict",
      "That challenge was already confirmed with a different stake or winner rule.",
      `Share join code ${challenge.join_code} as it is, or start a new draft.`,
    );
  }
  const state = await memberState(db, challenge, player, input.handle, now);
  if (!state.ok) return state;
  const platform = getPack(challenge.type).handlePlatform(challenge);
  return {
    ok: true,
    challenge,
    join_code: challenge.join_code,
    membership: state.membership,
    contract: state.contract,
    stake_entry: state.stake_entry,
    bind_action: state.bind_action,
    handle_needed: platform && player.handles[platform] === undefined ? platform : null,
    already_confirmed: true,
  };
}

// ---------------------------------------------------------------- join (R5, R10, KTD21)

/**
 * Join by code in two phases. Without `accepted_terms_version` the call returns the terms and
 * their version and stakes nothing. With the accepted version (and the pack's handle) it inserts
 * the membership, stakes through the ledger function and starts handle verification.
 * Implements the U6 `challenges.join` interface.
 */
export async function joinChallenge(db: Db, input: JoinInput): Promise<JoinResult> {
  const now = input.now ?? new Date();
  const col = collections(db);
  const player = await col.players.findOne({ _id: input.player_id });
  if (!player) return fail("not_found", "That player does not exist.", "Register first with lane_register.");

  const code = normalizeJoinCode(input.join_code);
  if (code.length !== JOIN_CODE_LENGTH) {
    return fail("invalid_input", "Join codes are six letters and digits.", "Ask the creator for the six-character join code.");
  }
  const challenge = await col.challenges.findOne({ join_code: code });
  if (!challenge) {
    return fail("not_found", "No challenge has that join code.", "Check the six-character code with the person who invited you.");
  }

  const existing = await col.memberships.findOne({ challenge_id: challenge._id, player_id: player._id });
  if (existing) return alreadyMember(db, challenge, player, input.handle, now);

  if (challenge.status !== "active" || !challenge.clock || isWindowClosed(challenge.clock, now)) {
    return fail("window_closed", "That challenge is no longer taking players.", "Ask the creator to start a new challenge.");
  }

  const pack = getPack(challenge.type);
  const terms = buildJoinTerms(challenge, pack);
  const accepted = input.accepted_terms_version?.trim();
  if (!accepted) {
    return { ok: true, phase: "terms", challenge_id: challenge._id, terms };
  }
  if (accepted !== terms.terms_version) {
    return fail(
      "conflict",
      "The terms changed since the player read them.",
      "Call lane_join_challenge without accepted_terms_version to get the current terms, show them to the player and wait for their answer.",
    );
  }

  const platform = pack.handlePlatform(challenge);
  const planned = await planHandle(db, player, platform, input.handle, true);
  if (!planned.ok) return planned;
  if (player.credits < (challenge.stake ?? 0)) {
    return fail(
      "insufficient_credits",
      `The stake is ${credits(challenge.stake ?? 0)}, and the balance is ${credits(player.credits)}.`,
      "Nothing was staked. Ask the creator for a challenge with a smaller stake, or join once a payout raises the balance.",
    );
  }

  try {
    const result = await inTransaction(db, async (session) => {
      const contract = await latestContract(db, challenge._id, session);
      if (!contract) throw new Error(`Challenge ${challenge._id} has no contract.`);
      const joined = await joinInSession(db, session, {
        challenge,
        player,
        terms_version: terms.terms_version,
        handle: planned.plan,
        handle_platform: platform,
        contract_version: contract.version,
        now,
        creator: false,
      });
      return { contract, ...joined };
    });
    return {
      ok: true,
      phase: "joined",
      challenge,
      membership: result.membership,
      contract: result.contract,
      stake_entry: result.stake_entry,
      bind_action: result.bind_action,
      already_member: false,
    };
  } catch (err) {
    if (err instanceof OutcomeAbort) return err.failure;
    // A concurrent join with the same key committed first (KTD6).
    if (isDuplicateKeyError(err)) return alreadyMember(db, challenge, player, input.handle, now);
    throw err;
  }
}

async function alreadyMember(db: Db, challenge: Challenge, player: Player, handle: string | undefined, now: Date): Promise<JoinResult> {
  const fresh = (await collections(db).players.findOne({ _id: player._id })) ?? player;
  const state = await memberState(db, challenge, fresh, handle, now);
  if (!state.ok) return state;
  return {
    ok: true,
    phase: "joined",
    challenge,
    membership: state.membership,
    contract: state.contract,
    stake_entry: state.stake_entry,
    bind_action: state.bind_action,
    already_member: true,
  };
}

/** The U6 `challenges` service, for the composition root (U7). */
export const challengesService = {
  draft: draftChallenge,
  confirm: confirmChallenge,
  join: joinChallenge,
};
