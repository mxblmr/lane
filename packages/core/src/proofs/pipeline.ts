import type { Db } from "mongodb";
import {
  services,
  type AgentInvokeResult,
  type EvaluateResult,
  type LaneServices,
  type SubmitProofInput,
  type SubmitProofResult,
} from "../interfaces";
import { fail, newId, type ChallengeType, type Features, type HandlePlatform, type LaneError, type RuleRef } from "../schema/common";
import type { Challenge } from "../schema/challenges";
import type { Contract } from "../schema/contracts";
import { collections, isDuplicateKeyError } from "../schema/collections";
import type { InboxItem } from "../schema/inbox";
import { isInboxItemExpired, isInboxItemLive } from "../schema/inbox";
import type { Membership } from "../schema/memberships";
import type { AnyPack, PackContext, RecheckResult } from "../schema/pack";
import type { Player } from "../schema/players";
import { normalizeHandle } from "../schema/players";
import {
  ProofSchema,
  type DecidedBy,
  type Proof,
  type ProofStatus,
  type RuleMatch,
  type TrustLevel,
  type Verdict,
  type VerdictOutcome,
} from "../schema/proofs";
import { quote, RefereeProofInputSchema, RefereeProofOutputSchema, type RefereeProofInput } from "../schema/agents";
import { getPack as registryGetPack, renderRuleLine } from "../packs/index";
import { systemClock, type Clock } from "../clock";
import { DIFF_CAP_CHARS, QUOTE_CAP_CHARS, REFEREE_REPLY_MS } from "../config";
import { runClaimedJob, type JobHandler, type JobOutcome } from "../jobs";
import { trackEvent } from "../observe/raindrop";
import { checkAuthenticity, confirmHandle } from "./authenticity";
import { acceptAnsweredProof, answerHasCode, loadRequest, markUnanswered, openExtraProofRequest, ownsRequest } from "./requests";
import { cap, dayLabel, historyEntry, isFinalStatus, loadLatestContract, outcomeOf, writeProofEvent } from "./state";

/**
 * Proof pipeline (U5, KTD7): schema, authenticity, active rules, then the referee agent only
 * when no rule decided. Owns the `proofs` service in `interfaces.ts`.
 *
 * - The pack's proof schema parses the flat fields; a short commit SHA is refused (step 1).
 * - The proof is stored as received, deduplicated on challenge, player and source key (KTD6).
 * - Authenticity runs, and the source is claimed only when it passes (step 2, KTD6, KTD21).
 * - The rule engine runs through the `engine` service (U4). A hold_payout match accepts with a
 *   payout hold (step 3).
 * - Otherwise the referee runs through the `agents` service (U8) with the re-checked content as
 *   capped, quoted data (KTD18). A reply after 20 seconds finishes in a `referee_verdict` job
 *   whose verdict write requires the proof to still be in AI review, and the verdict reaches the
 *   player through the inbox (KTD20).
 * - ask_more outcomes open one extra-proof request through the inbox interface (step 4).
 * - Every verdict records what decided it, and an AI rejection queues learning (step 5).
 */

export interface ProofDeps {
  /** Pack lookup. Defaults to U3's pack registry. */
  getPack?: (type: ChallengeType) => AnyPack;
  /** Injected so tests never reach the network. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Server-side GitHub token for re-checks (KTD17). Defaults to GITHUB_VERIFIER_TOKEN. */
  githubToken?: string | null;
  /** Used when the input carries no `now`, and for verdicts that arrive late. */
  clock?: Clock;
  /** How long the submit call waits for the referee before returning pending. Default 20 s. */
  refereeReplyMs?: number;
  /**
   * Runs work after the response. The web app passes Next.js `after()`. The default lets the
   * promise run on and logs a failure; the job record lets the tick recover it either way.
   */
  runAfter?: (work: Promise<unknown>) => void;
}

interface Deps {
  getPack: (type: ChallengeType) => AnyPack;
  fetch: typeof fetch;
  githubToken: string | null;
  clock: Clock;
  refereeReplyMs: number;
  runAfter: (work: Promise<unknown>) => void;
}

function resolveDeps(d: ProofDeps = {}): Deps {
  return {
    getPack: d.getPack ?? registryGetPack,
    fetch: d.fetch ?? (((input, init) => globalThis.fetch(input, init)) as typeof fetch),
    githubToken: d.githubToken !== undefined ? d.githubToken : (process.env.GITHUB_VERIFIER_TOKEN ?? null),
    clock: d.clock ?? systemClock,
    refereeReplyMs: d.refereeReplyMs ?? REFEREE_REPLY_MS,
    runAfter:
      d.runAfter ??
      ((work) => {
        void work.catch((err: unknown) => console.error("[proofs] background work failed", err));
      }),
  };
}

/** Everything a decision needs, loaded once per proof. */
interface Run {
  db: Db;
  deps: Deps;
  pack: AnyPack;
  challenge: Challenge;
  player: Player;
  membership: Membership;
  contract: Contract | null;
  /** Decision time. The day's grace is judged at the proof's receive time instead (KTD13). */
  now: Date;
  /** performance.now() when the submit call started, for verdict latency. Null when unknown. */
  t0: number | null;
}

/** Facts from authenticity and the rule run that every verdict on this proof records. */
interface VerdictFacts {
  trust: TrustLevel;
  evaluated: RuleRef[];
  matched: RuleMatch[];
  push_event_time: Date | null;
}

function packCtx(run: Pick<Run, "deps" | "now">): PackContext {
  return { now: run.now, fetch: run.deps.fetch, githubToken: run.deps.githubToken };
}

function elapsed(t0: number | null, fallback = 0): number {
  return t0 === null ? Math.max(0, Math.round(fallback)) : Math.max(0, Math.round(performance.now() - t0));
}

function failed(error: LaneError): SubmitProofResult {
  return { ok: false, error };
}

// ---------------------------------------------------------------- service entry points

export function createProofService(deps: ProofDeps = {}): LaneServices["proofs"] {
  return { submit: (db, input) => submitProof(db, input, deps) };
}

export async function submitProof(db: Db, input: SubmitProofInput, deps?: ProofDeps): Promise<SubmitProofResult> {
  const d = resolveDeps(deps);
  const now = input.now ?? d.clock.now();
  const t0 = performance.now();
  if (input.request_id) return answerRequest(db, input, d, now, t0);
  return submitNew(db, input, d, now, t0, null);
}

// ---------------------------------------------------------------- step 1: parse, key, store

type Parsed = { ok: true; payload: Record<string, unknown> } | { ok: false; error: LaneError };

function parseProof(pack: AnyPack, fields: SubmitProofInput["fields"]): Parsed {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const parsed = pack.proofSchema.safeParse(clean);
  if (parsed.success) {
    const payload = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    return { ok: true, payload };
  }
  const sha = typeof clean.sha === "string" ? clean.sha.trim() : null;
  if (sha && /^[0-9a-f]{4,39}$/i.test(sha)) {
    return fail(
      "short_sha",
      "This is a short commit SHA. Lane needs the full one.",
      "Send the full 40-character commit SHA (git rev-parse HEAD prints it), then submit again.",
    );
  }
  const issue = parsed.error.issues[0];
  const field = issue?.path.length ? issue.path.join(".") : "proof";
  return fail(
    "invalid_input",
    cap(`The proof field "${field}" is missing or invalid for ${pack.title}.`, 300),
    cap(`${issue?.message ?? "Check the contract for what to send."} Send the proof again with "${field}" fixed.`, 300),
  );
}

type ChallengeLookup = { ok: true; challenge: Challenge } | { ok: false; error: LaneError };

async function resolveChallenge(db: Db, playerId: string, challengeId: string | undefined): Promise<ChallengeLookup> {
  const col = collections(db);
  if (challengeId) {
    const challenge = await col.challenges.findOne({ _id: challengeId });
    return challenge
      ? { ok: true, challenge }
      : fail("not_found", "Lane has no challenge with this id.", "Check in with lane_check_in to see your challenge ids.");
  }
  const memberships = await col.memberships.find({ player_id: playerId }).toArray();
  const active = await col.challenges
    .find({ _id: { $in: memberships.map((m) => m.challenge_id) }, status: "active" })
    .toArray();
  if (active.length === 1 && active[0]) return { ok: true, challenge: active[0] };
  return fail(
    "invalid_input",
    "Lane needs to know which challenge this proof is for.",
    "Send the proof again with challenge_id from your check-in.",
  );
}

async function submitNew(
  db: Db,
  input: SubmitProofInput,
  d: Deps,
  now: Date,
  t0: number,
  answersRequestId: string | null,
): Promise<SubmitProofResult> {
  const col = collections(db);
  const player = await col.players.findOne({ _id: input.player_id });
  if (!player) return failed(fail("unauthenticated", "Lane does not know this player.", "Register with lane_register, then try again.").error);
  const lookup = await resolveChallenge(db, player._id, input.challenge_id);
  if (!lookup.ok) return failed(lookup.error);
  const challenge = lookup.challenge;
  const membership = await col.memberships.findOne({ challenge_id: challenge._id, player_id: player._id });
  if (!membership) {
    return failed(
      fail(
        "not_member",
        "You have not joined this challenge, so Lane cannot take proof for it.",
        "Join it with lane_join_challenge and its join code, then send the proof again.",
      ).error,
    );
  }
  if (challenge.status !== "active" || !challenge.clock) {
    return failed(
      fail("window_closed", "This challenge is not taking proof right now.", "Check in with lane_check_in to see your active challenges.").error,
    );
  }
  const pack = d.getPack(challenge.type);
  const parsed = parseProof(pack, input.fields);
  if (!parsed.ok) return failed(parsed.error);
  const sourceKey = pack.sourceKey(parsed.payload);
  if (!sourceKey || sourceKey.length > 200) {
    return failed(fail("invalid_input", "Lane could not identify the source of this proof.", "Send the proof fields the contract lists.").error);
  }

  const proof: Proof = ProofSchema.parse({
    _id: newId("proof"),
    challenge_id: challenge._id,
    player_id: player._id,
    challenge_type: challenge.type,
    source_key: sourceKey,
    claimed: false,
    payload: parsed.payload,
    features: null,
    source_time: null,
    day_index: null,
    status: "received",
    held_reason: null,
    not_counted_reason: null,
    verdict: null,
    answers_request_id: answersRequestId,
    history: [historyEntry(now, null, "received", "system")],
    received_at: now,
    updated_at: now,
  });
  try {
    await col.proofs.insertOne(proof);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await col.proofs.findOne({ challenge_id: challenge._id, player_id: player._id, source_key: sourceKey });
    if (!existing) throw err;
    return duplicateResult(db, existing);
  }
  await writeProofEvent(db, "proof.received", proof, { packTitle: pack.title, at: now });

  const contract = await loadLatestContract(db, challenge._id);
  return processReceived({ db, deps: d, pack, challenge, player, membership, contract, now, t0 }, proof, { resumed: false });
}

/** KTD6: the same source again returns the existing proof, or "still reviewing" when not final. */
async function duplicateResult(db: Db, existing: Proof): Promise<SubmitProofResult> {
  const request =
    existing.status === "held"
      ? await collections(db).inbox.findOne({ subject_proof_id: existing._id, kind: "extra_proof", status: "open" })
      : null;
  const reviewing = !isFinalStatus(existing.status) && existing.status !== "held";
  return {
    ok: true,
    proof: existing,
    outcome: outcomeOf(existing.status),
    duplicate: true,
    verdict: existing.verdict,
    request,
    lines: reviewing
      ? ["Lane is still reviewing this proof. The verdict will arrive in your inbox at your next check-in."]
      : ["Lane already has this proof.", ...verdictLines(existing, request)].slice(0, 3),
  };
}

// ---------------------------------------------------------------- steps 2 to 5

async function processReceived(run: Run, proof: Proof, opts: { resumed: boolean }): Promise<SubmitProofResult> {
  const { db, pack, challenge, player, membership } = run;
  const col = collections(db);
  const auth = await checkAuthenticity({
    pack,
    payload: proof.payload,
    challenge,
    player,
    membership,
    ctx: packCtx(run),
    receivedAt: proof.received_at,
  });

  if (auth.status === "unavailable") {
    // Nothing is decided. A new proof is removed so the same source can be sent again; a
    // resumed proof goes back to held so the next release retries it.
    if (opts.resumed) {
      await col.proofs.updateOne(
        { _id: proof._id, status: "received" },
        {
          $set: { status: "held", held_reason: "handle_unverified", updated_at: run.now },
          $push: { history: historyEntry(run.now, "received", "held", "system", "re-check unavailable") },
        },
      );
    } else {
      await col.proofs.deleteOne({ _id: proof._id, status: "received", claimed: false });
    }
    return failed(fail("internal", cap(auth.reason, 300), "Send the same proof again in a few minutes.").error);
  }

  const facts: VerdictFacts = { trust: auth.trust, evaluated: [], matched: [], push_event_time: auth.push_event_time };

  if (auth.status === "reject") {
    const verdict = makeVerdict(run, facts, {
      outcome: "reject",
      decided_by: "authenticity",
      reason: auth.reason,
      fix: auth.fix,
    });
    const done = await transition(db, proof._id, "received", "rejected", "authenticity", run.now, {
      verdict,
      source_time: auth.source_time,
      day_index: auth.day_index,
    });
    return finish(run, proof._id, done, null, { late: false });
  }

  if (auth.status === "hold_handle") {
    // KTD21: held until the bind code verifies the handle. Not claimed yet.
    const held = await transition(db, proof._id, "received", "held", "authenticity", run.now, {
      held_reason: "handle_unverified",
      source_time: auth.source_time,
      day_index: auth.day_index,
    });
    if (held) await writeProofEvent(db, "proof.held", held, { packTitle: pack.title, at: run.now });
    const current = held ?? (await col.proofs.findOne({ _id: proof._id })) ?? proof;
    return {
      ok: true,
      proof: current,
      outcome: outcomeOf(current.status),
      duplicate: false,
      verdict: current.verdict,
      request: null,
      lines: verdictLines(current, null, auth.platform),
    };
  }

  // KTD6: claim the source. Another player's claimed proof of the same source wins.
  let inRules: Proof | null;
  try {
    inRules = await transition(db, proof._id, "received", "rules", "authenticity", run.now, {
      claimed: true,
      source_time: auth.source_time,
      day_index: auth.day_index,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const verdict = makeVerdict(run, facts, {
      outcome: "reject",
      decided_by: "authenticity",
      reason: "This source already counted for another player in this challenge.",
      fix: "Send a source you made yourself.",
    });
    const done = await transition(db, proof._id, "received", "rejected", "authenticity", run.now, {
      verdict,
      source_time: auth.source_time,
      day_index: auth.day_index,
    });
    return finish(run, proof._id, done, null, { late: false });
  }
  if (!inRules) return finish(run, proof._id, null, null, { late: false });

  // Step 3: features from the content the re-check fetched, then the rule engine.
  const [openRequests, earlierProofs] = await Promise.all([
    col.inbox.find({ player_id: player._id, challenge_id: challenge._id, status: "open" }).toArray(),
    col.proofs
      .find({ challenge_id: challenge._id, player_id: player._id, _id: { $ne: proof._id } })
      .sort({ received_at: -1 })
      .limit(50)
      .toArray(),
  ]);
  const features = pack.extractFeatures({
    proof: inRules.payload,
    recheck: auth.recheck,
    openRequests: openRequests.filter((i) => isInboxItemLive(i, run.now)),
    earlierProofs,
    challenge,
    player_id: player._id,
  });

  let evaluation: EvaluateResult;
  try {
    evaluation = await services().engine.evaluate(db, { challenge_type: challenge.type, features });
  } catch (err) {
    // Never leave a proof stuck in "rules". The verdict records that no rule was evaluated.
    console.error("[proofs] rule engine failed; falling through to AI review", err);
    evaluation = { decision: "none", rule: null, matched: [], evaluated: [] };
  }
  facts.evaluated = evaluation.evaluated;
  facts.matched = evaluation.matched;

  if (evaluation.decision !== "none" && evaluation.rule) {
    return decideByRule(run, inRules, features, facts, evaluation.decision, evaluation.rule);
  }

  // No rule decided: AI review.
  const inReview = await transition(db, proof._id, "rules", "ai_review", "system", run.now, { features });
  if (!inReview) return finish(run, proof._id, null, null, { late: false });
  const refereeInput = buildRefereeInput(run, inReview, features, auth.trust, auth.recheck);
  return callReferee(run, inReview, refereeInput, facts);
}

async function ruleLine(run: Run, ref: RuleRef): Promise<{ line: string; cheat_class: string | null }> {
  const fromContract = run.contract?.does_not_count.find((l) => l.rule_key === ref.rule_key && l.rule_version === ref.version);
  const rule = await collections(run.db).rules.findOne(
    { challenge_type: run.challenge.type, rule_key: ref.rule_key, version: ref.version },
    { projection: { when: 1, action: 1, cheat_class: 1 } },
  );
  const line = fromContract?.line ?? (rule ? renderRuleLine(run.pack, rule) : `It matched rule ${ref.rule_key}.`);
  return { line, cheat_class: rule?.cheat_class ?? null };
}

async function decideByRule(
  run: Run,
  proof: Proof,
  features: Features,
  facts: VerdictFacts,
  decision: Exclude<EvaluateResult["decision"], "none">,
  rule: RuleRef,
): Promise<SubmitProofResult> {
  const { line, cheat_class } = await ruleLine(run, rule);
  const ruleName = `rule ${rule.rule_key} v${rule.version}`;
  const base = { decided_by: "rule" as const, rule, cheat_class };
  let to: ProofStatus;
  let verdict: Verdict;
  switch (decision) {
    case "reject":
      to = "rejected";
      verdict = makeVerdict(run, facts, {
        ...base,
        outcome: "reject",
        reason: `Rejected by ${ruleName}: ${line}`,
        fix: "Send a proof that does not match this rule, as the contract describes.",
      });
      break;
    case "hold_payout":
      to = "accepted";
      verdict = makeVerdict(run, facts, {
        ...base,
        outcome: "accept",
        payout_hold: true,
        reason: `Accepted with the payout held for review by ${ruleName}: ${line}`,
        fix: "",
      });
      break;
    case "ask_more":
      to = "held";
      verdict = makeVerdict(run, facts, {
        ...base,
        outcome: "ask_more",
        reason: `Extra proof needed by ${ruleName}: ${line}`,
        fix: "Answer the extra-proof request before its grace period ends.",
      });
      break;
    case "flag":
      to = "flagged_accept";
      verdict = makeVerdict(run, facts, {
        ...base,
        outcome: "flag",
        reason: `Accepted and flagged for review by ${ruleName}: ${line}`,
        fix: "",
      });
      break;
  }
  const done = await transition(run.db, proof._id, "rules", to, "rule", run.now, {
    features,
    verdict,
    ...(to === "held" ? { held_reason: "extra_proof" as const } : {}),
  });
  const request = done && to === "held" ? await openRequestFor(run, done) : null;
  return finish(run, proof._id, done, request, { late: false });
}

async function openRequestFor(run: Pick<Run, "db" | "challenge" | "contract" | "now">, proof: Proof): Promise<InboxItem | null> {
  try {
    return await openExtraProofRequest(run.db, {
      proof,
      challenge: run.challenge,
      extraProofLines: run.contract?.fields.extra_proof,
      now: run.now,
    });
  } catch (err) {
    console.error("[proofs] could not open the extra-proof request", err);
    return null;
  }
}

// ---------------------------------------------------------------- the referee (U8 through interfaces)

function renderPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

/** KTD18: every text a person wrote reaches the referee as quoted, capped data. */
function buildRefereeInput(
  run: Pick<Run, "pack" | "challenge" | "contract">,
  proof: Proof,
  features: Features,
  trust: TrustLevel,
  recheck: RecheckResult | null,
): RefereeProofInput {
  const source = recheck?.source ?? null;
  // String features (for example message_matches) carry player text verbatim. That text already
  // travels quoted in source_text, so only number and boolean features go unquoted.
  const safeFeatures = Object.fromEntries(
    Object.entries(features).filter(([, value]) => typeof value === "number" || typeof value === "boolean"),
  );
  return RefereeProofInputSchema.parse({
    mode: "proof",
    challenge_type: run.challenge.type,
    contract_version: run.contract?.version ?? run.challenge.contract_version,
    does_not_count: run.contract?.does_not_count.map((l) => l.line) ?? [],
    cheat_classes: [...run.pack.cheatClasses],
    features: safeFeatures,
    trust_level: trust,
    proof: quote(renderPayload(proof.payload), QUOTE_CAP_CHARS),
    source_text: source?.text ? quote(source.text, QUOTE_CAP_CHARS) : null,
    source_diff: source?.diff ? quote(source.diff, DIFF_CAP_CHARS) : null,
  });
}

type RefereeCallResult = AgentInvokeResult<"referee">;

function invokeReferee(run: Pick<Run, "challenge" | "player">, proof: Proof, input: RefereeProofInput): Promise<RefereeCallResult> {
  const started = performance.now();
  return services()
    .agents.invoke({
      workspace: "referee",
      mode: "proof",
      input,
      meta: { challenge_id: run.challenge._id, player_id: run.player._id, proof_id: proof._id, event_id: proof._id },
    })
    .catch(
      (err: unknown): RefereeCallResult => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        schema_valid: false,
        timed_out: false,
        execution_id: null,
        latency_ms: Math.round(performance.now() - started),
      }),
    );
}

function raceReply<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([work.then((value) => ({ done: true as const, value })), timeout]).finally(() => clearTimeout(timer));
}

/** Job payload for a referee call that outlived the request. */
interface RefereeJobPayload {
  proof_id: string;
  trust: TrustLevel;
  evaluated: RuleRef[];
  matched: RuleMatch[];
  push_event_time: string | null;
}

function jobPayload(proof: Proof, facts: VerdictFacts): RefereeJobPayload {
  return {
    proof_id: proof._id,
    trust: facts.trust,
    evaluated: facts.evaluated,
    matched: facts.matched,
    push_event_time: facts.push_event_time ? facts.push_event_time.toISOString() : null,
  };
}

const PENDING_LINE = "Lane's AI reviewer is still deciding. The verdict will arrive in your inbox at your next check-in.";

function pendingResult(proof: Proof): SubmitProofResult {
  return { ok: true, proof, outcome: "pending", duplicate: false, verdict: null, request: null, lines: [PENDING_LINE] };
}

async function callReferee(run: Run, proof: Proof, input: RefereeProofInput, facts: VerdictFacts): Promise<SubmitProofResult> {
  const { db, deps } = run;
  const invocation = invokeReferee(run, proof, input);
  const raced = await raceReply(invocation, deps.refereeReplyMs);

  if (raced.done) {
    const applied = await applyRefereeResult(run, proof._id, raced.value, facts, { late: false, t0: run.t0 });
    if (applied.kind !== "error") return finish(run, proof._id, applied.proof, applied.request, { late: false, alreadyRecorded: true });
    // The referee failed or answered off-schema: never an acceptance. Retry from a job (KTD20).
    await services().jobs.queue(
      db,
      {
        kind: "referee_verdict",
        dedup_key: proof._id,
        payload: { ...jobPayload(proof, facts) },
        due_at: new Date(run.now.getTime() + 30_000),
      },
      { now: run.now },
    );
    return pendingResult(proof);
  }

  // The reply window passed: keep awaiting the same call inside a claimed job, so the tick can
  // recover it with refereeVerdictJobHandler if this instance dies (KTD20).
  const { job } = await services().jobs.queue(
    db,
    { kind: "referee_verdict", dedup_key: proof._id, payload: { ...jobPayload(proof, facts) }, due_at: run.now },
    { now: run.now },
  );
  const claim = await services().jobs.claim(db, { job_id: job._id, now: run.now });
  const finishLate = async (): Promise<JobOutcome> => {
    const result = await invocation;
    const late = { ...run, now: deps.clock.now() };
    const applied = await applyRefereeResult(late, proof._id, result, facts, { late: true, t0: run.t0 });
    if (applied.kind === "error") throw new Error(`referee failed: ${applied.error}`);
    return { kind: "done", result: { delivered: applied.kind } };
  };
  deps.runAfter(claim ? runClaimedJob(db, claim, finishLate, { clock: deps.clock }) : finishLate());
  return pendingResult(proof);
}

type Applied =
  | { kind: "written"; proof: Proof; request: InboxItem | null }
  /** The proof had already left AI review: a second late write is ignored (KTD20). */
  | { kind: "stale"; proof: Proof | null; request: null }
  | { kind: "error"; error: string };

function cheatPhrase(pack: AnyPack, cheat: string): string {
  const template = pack.contract.doesNotCount[cheat];
  return template ? template({ feature: cheat, op: "eq", value: true }) : cheat.replace(/_/g, " ");
}

/**
 * Turn a referee result into a verdict with one conditional write that requires the proof to
 * still be in AI review. Used by the in-request path, the late path and the recovery job.
 */
async function applyRefereeResult(
  run: Run,
  proofId: string,
  result: RefereeCallResult,
  facts: VerdictFacts,
  opts: { late: boolean; t0: number | null },
): Promise<Applied> {
  if (!result.ok) return { kind: "error", error: result.timed_out ? "timed out" : result.error };
  if (result.status !== "completed") return { kind: "error", error: "unexpected suspended referee call" };
  const parsed = RefereeProofOutputSchema.safeParse(result.output);
  if (!parsed.success) return { kind: "error", error: "referee output failed its schema" };
  const output = parsed.data;
  const { pack } = run;
  const redact = pack.type === "customers"; // KTD15: no AI reason text for Talk to Customers
  const cheat = output.cheat_class && pack.cheatClasses.includes(output.cheat_class) ? output.cheat_class : null;
  const ai = {
    decided_by: "ai" as const,
    ai_calls: 1,
    ai_judgment: true,
    cheat_class: cheat,
    confidence: output.confidence,
    latency_ms: elapsed(opts.t0, result.latency_ms),
  };

  let to: ProofStatus;
  let verdict: Verdict;
  if (output.verdict === "accept") {
    to = "accepted";
    verdict = makeVerdict(run, facts, {
      ...ai,
      outcome: "accept",
      reason: redact ? "Accepted by AI review." : cap(`Accepted by AI review. ${output.reason}`, 500),
      fix: "",
    });
  } else if (output.verdict === "reject") {
    // KTD7: an AI rejection cites the contract clause and is labelled as an AI judgment.
    const clause = run.contract?.fields.scoring ?? `the ${pack.title} contract`;
    const why = redact ? (cheat ? `It looks like ${cheatPhrase(pack, cheat)}.` : "") : output.reason;
    to = "rejected";
    verdict = makeVerdict(run, facts, {
      ...ai,
      outcome: "reject",
      reason: cap(`AI judgment: this proof does not count under the contract clause "${clause}". ${why}`.trim(), 500),
      fix: cap(redact || !output.fix ? "Send a proof that meets the contract." : output.fix, 500),
    });
  } else {
    to = "held";
    verdict = makeVerdict(run, facts, {
      ...ai,
      outcome: "ask_more",
      reason: cap(
        `AI review needs extra proof before this counts.${!redact && output.extra_proof ? ` ${output.extra_proof}` : ""}`,
        500,
      ),
      fix: "Answer the extra-proof request before its grace period ends.",
    });
  }

  const written = await transition(run.db, proofId, "ai_review", to, "ai", run.now, {
    verdict,
    ...(to === "held" ? { held_reason: "extra_proof" as const } : {}),
  });
  if (!written) {
    return { kind: "stale", proof: await collections(run.db).proofs.findOne({ _id: proofId }), request: null };
  }
  const request = to === "held" ? await openRequestFor(run, written) : null;
  await afterVerdict(run, written, request, { late: opts.late });
  return { kind: "written", proof: written, request };
}

/**
 * Recovery for a referee call whose request instance died (KTD20). U18's tick passes this to
 * `runDueJobs` for the `referee_verdict` kind. It calls the referee again only while the proof
 * is still in AI review, and its verdict write is conditional on that status.
 */
export function refereeVerdictJobHandler(deps?: ProofDeps): JobHandler {
  const d = resolveDeps(deps);
  return async (ctx) => {
    const payload = ctx.job.payload as Partial<RefereeJobPayload>;
    const proofId = typeof payload.proof_id === "string" ? payload.proof_id : "";
    const db = ctx.db;
    const col = collections(db);
    const proof = await col.proofs.findOne({ _id: proofId });
    if (!proof || proof.status !== "ai_review") return { kind: "skip", reason: "proof is no longer in AI review" };
    const [challenge, player, membership, contract] = await Promise.all([
      col.challenges.findOne({ _id: proof.challenge_id }),
      col.players.findOne({ _id: proof.player_id }),
      col.memberships.findOne({ challenge_id: proof.challenge_id, player_id: proof.player_id }),
      loadLatestContract(db, proof.challenge_id),
    ]);
    if (!challenge || !player || !membership) return { kind: "skip", reason: "challenge, player or membership is gone" };
    const pack = d.getPack(challenge.type);
    const run: Run = { db, deps: d, pack, challenge, player, membership, contract, now: ctx.now(), t0: performance.now() };
    const platform = pack.handlePlatform(challenge);
    let recheck: RecheckResult | null = null;
    try {
      recheck = await pack.recheck(proof.payload, player, platform ? (player.handles[platform] ?? null) : null, packCtx(run));
    } catch {
      recheck = null;
    }
    const facts: VerdictFacts = {
      trust: payload.trust ?? "agent_attested",
      evaluated: payload.evaluated ?? [],
      matched: payload.matched ?? [],
      push_event_time: payload.push_event_time ? new Date(payload.push_event_time) : null,
    };
    const input = buildRefereeInput(run, proof, proof.features ?? {}, facts.trust, recheck);
    const result = await invokeReferee(run, proof, input);
    if (ctx.isLost()) return { kind: "done", result: { delivered: "lost" } };
    const applied = await applyRefereeResult({ ...run, now: ctx.now() }, proof._id, result, facts, { late: true, t0: null });
    if (applied.kind === "error") throw new Error(`referee failed: ${applied.error}`);
    return { kind: "done", result: { delivered: applied.kind } };
  };
}

/**
 * A verdict written by the recovery job or the late path: same conditional write, exposed so
 * callers (and tests) can deliver a referee result for a proof by id.
 */
export async function deliverLateRefereeResult(
  db: Db,
  input: { proof_id: string; result: RefereeCallResult; now?: Date },
  deps?: ProofDeps,
): Promise<{ written: boolean; proof: Proof | null }> {
  const d = resolveDeps(deps);
  const col = collections(db);
  const proof = await col.proofs.findOne({ _id: input.proof_id });
  if (!proof) return { written: false, proof: null };
  const [challenge, player, membership, contract, job] = await Promise.all([
    col.challenges.findOne({ _id: proof.challenge_id }),
    col.players.findOne({ _id: proof.player_id }),
    col.memberships.findOne({ challenge_id: proof.challenge_id, player_id: proof.player_id }),
    loadLatestContract(db, proof.challenge_id),
    col.jobs.findOne({ kind: "referee_verdict", dedup_key: proof._id }),
  ]);
  if (!challenge || !player || !membership) return { written: false, proof };
  const payload = (job?.payload ?? {}) as Partial<RefereeJobPayload>;
  const run: Run = {
    db,
    deps: d,
    pack: d.getPack(challenge.type),
    challenge,
    player,
    membership,
    contract,
    now: input.now ?? d.clock.now(),
    t0: null,
  };
  const facts: VerdictFacts = {
    trust: payload.trust ?? "agent_attested",
    evaluated: payload.evaluated ?? [],
    matched: payload.matched ?? [],
    push_event_time: payload.push_event_time ? new Date(payload.push_event_time) : null,
  };
  const applied = await applyRefereeResult(run, proof._id, input.result, facts, { late: true, t0: null });
  if (applied.kind === "written") return { written: true, proof: applied.proof };
  return { written: false, proof: applied.kind === "stale" ? applied.proof : proof };
}

// ---------------------------------------------------------------- verdicts and side effects

function makeVerdict(
  run: Pick<Run, "challenge" | "contract" | "now" | "t0">,
  facts: VerdictFacts,
  v: {
    outcome: VerdictOutcome;
    decided_by: DecidedBy;
    reason: string;
    fix: string;
    rule?: RuleRef | null;
    ai_calls?: number;
    ai_judgment?: boolean;
    payout_hold?: boolean;
    cheat_class?: string | null;
    confidence?: number | null;
    latency_ms?: number;
  },
): Verdict {
  return {
    outcome: v.outcome,
    decided_by: v.decided_by,
    rule: v.rule ?? null,
    matched_rules: facts.matched,
    evaluated_rules: facts.evaluated,
    contract_version: run.contract?.version ?? run.challenge.contract_version,
    ai_calls: v.ai_calls ?? 0,
    ai_judgment: v.ai_judgment ?? false,
    latency_ms: v.latency_ms ?? elapsed(run.t0 ?? null),
    trust_level: facts.trust,
    payout_hold: v.payout_hold ?? false,
    reason: cap(v.reason, 500),
    fix: cap(v.fix, 500),
    cheat_class: v.cheat_class ?? null,
    confidence: v.confidence ?? null,
    push_event_time: facts.push_event_time,
    decided_at: run.now,
  };
}

/** One conditional status transition with a history entry. Null when the proof was not in `from`. */
async function transition(
  db: Db,
  proofId: string,
  from: ProofStatus,
  to: ProofStatus,
  by: DecidedBy | "system",
  now: Date,
  set: Partial<Proof>,
): Promise<Proof | null> {
  return collections(db).proofs.findOneAndUpdate(
    { _id: proofId, status: from },
    { $set: { ...set, status: to, updated_at: now }, $push: { history: historyEntry(now, from, to, by) } },
    { returnDocument: "after" },
  );
}

async function queueLearning(db: Db, proof: Proof, now: Date): Promise<void> {
  const cheat = proof.verdict?.cheat_class ?? null;
  try {
    await services().learning.fromSource(db, {
      challenge_type: proof.challenge_type,
      source: "ai_judgment",
      cheat_class: cheat,
      proof_id: proof._id,
      now,
    });
    return;
  } catch (err) {
    console.error("[proofs] learning.fromSource failed; queueing the learning job directly", err);
  }
  try {
    // KTD20: a learning job keyed by the evidence proof id. U9's runner skips it while an open
    // candidate exists for the same type and cheat class.
    await services().jobs.queue(
      db,
      {
        kind: "learning",
        dedup_key: proof._id,
        payload: { source: "ai_judgment", challenge_type: proof.challenge_type, cheat_class: cheat, proof_id: proof._id },
      },
      { now },
    );
  } catch (err) {
    console.error("[proofs] could not queue the learning job", err);
  }
}

/** Event, learning and late delivery for a verdict that was just written. */
async function afterVerdict(
  run: Pick<Run, "db" | "pack" | "now">,
  proof: Proof,
  request: InboxItem | null,
  opts: { late: boolean },
): Promise<void> {
  const { db, pack, now } = run;
  let feedSummary: string | null = null;
  try {
    feedSummary = proof.features ? pack.summarize(proof.features) : null;
  } catch {
    feedSummary = null;
  }
  await writeProofEvent(db, proof.status === "held" ? "proof.held" : "proof.verdict", proof, {
    packTitle: pack.title,
    feedSummary,
    at: now,
  });

  // U20 (KTD24): a rule-decided verdict with no AI call is recorded in Raindrop. Fired after the
  // verdict write and never awaited, so Raindrop can neither slow nor fail the verdict. Ids,
  // rule keys and outcomes only (KTD15).
  const v = proof.verdict;
  if (v && v.decided_by === "rule" && v.ai_calls === 0) {
    void trackEvent({
      eventId: proof._id,
      userId: proof.player_id,
      event: "rule.verdict",
      properties: {
        challenge_type: proof.challenge_type,
        challenge_id: proof.challenge_id,
        proof_id: proof._id,
        decided_by: v.decided_by,
        outcome: v.outcome,
        rule_key: v.rule?.rule_key ?? null,
        rule_version: v.rule?.version ?? null,
        cheat_class: v.cheat_class,
        payout_hold: v.payout_hold,
        contract_version: v.contract_version,
        ai_call_count: 0,
        latency_ms: v.latency_ms,
      },
    });
  }

  if (proof.status === "rejected" && proof.verdict?.decided_by === "ai") await queueLearning(db, proof, now);

  if (opts.late) {
    // KTD20: a verdict that missed the 20-second reply reaches the player through the inbox.
    try {
      await services().inbox.add(
        db,
        {
          player_id: proof.player_id,
          challenge_id: proof.challenge_id,
          kind: "verdict",
          actor: "agent",
          instruction: cap(verdictLines(proof, request).join(" "), 600),
          answer_tool: null,
          answer_args: {},
          day_index: proof.day_index,
          subject_proof_id: proof._id,
          slot: null,
          code: null,
          release_at: null,
          due_at: null,
          status: "open",
        },
        { now },
      );
    } catch (err) {
      console.error("[proofs] could not deliver the late verdict to the inbox", err);
    }
  }
}

/**
 * Build the submit result from a transition. `done` is null when another writer moved the
 * proof first, so the current state is returned instead.
 */
async function finish(
  run: Run,
  proofId: string,
  done: Proof | null,
  request: InboxItem | null,
  opts: { late: boolean; alreadyRecorded?: boolean },
): Promise<SubmitProofResult> {
  if (done && !opts.alreadyRecorded && done.verdict) await afterVerdict(run, done, request, { late: opts.late });
  const current = done ?? (await collections(run.db).proofs.findOne({ _id: proofId }));
  if (!current) return failed(fail("internal", "Lane lost track of this proof.", "Send the proof again.").error);
  if (current.status === "received" || current.status === "rules" || current.status === "ai_review") return pendingResult(current);
  return {
    ok: true,
    proof: current,
    outcome: outcomeOf(current.status),
    duplicate: false,
    verdict: current.verdict,
    request,
    lines: verdictLines(current, request),
  };
}

/** Lane-rendered lines for Muse to relay (KTD15). */
export function verdictLines(proof: Proof, request: InboxItem | null = null, platform: HandlePlatform | null = null): string[] {
  const v = proof.verdict;
  switch (proof.status) {
    case "accepted":
      return [`Proof accepted for ${dayLabel(proof.day_index)}.${v?.payout_hold ? " The payout is held for review." : ""}`];
    case "flagged_accept":
      return [`Proof accepted for ${dayLabel(proof.day_index)} and flagged for review.`];
    case "rejected":
      return [cap(`Proof rejected. ${v?.reason ?? ""}`.trim(), 400), cap(`How to fix: ${v?.fix || "send a proof that meets the contract."}`, 400)];
    case "held":
      if (proof.held_reason === "handle_unverified") {
        return [
          `Proof held until your ${platform ?? "platform"} handle is verified.`,
          "Put the bind code from your inbox in your public profile bio, then answer the bind-code action.",
        ];
      }
      return [cap(request?.instruction ?? "Lane needs extra proof before this counts. Check in to see the request.", 400)];
    case "not_counted":
      return proof.not_counted_reason === "unanswered"
        ? ["Not counted (unanswered): the extra-proof request expired before an answer arrived."]
        : ["This proof no longer counts."];
    default:
      return [PENDING_LINE];
  }
}

// ---------------------------------------------------------------- answers by request id (step 4)

async function answerRequest(db: Db, input: SubmitProofInput, d: Deps, now: Date, t0: number): Promise<SubmitProofResult> {
  const col = collections(db);
  const item = await loadRequest(db, input.request_id ?? "");
  if (!item || item.status === "scheduled") {
    return failed(
      fail("not_found", "Lane has no open request with this id.", "Check in with lane_check_in and use the request id it returns.").error,
    );
  }
  const subject = item.subject_proof_id ? await col.proofs.findOne({ _id: item.subject_proof_id }) : null;
  if (!ownsRequest(item, subject, input.player_id)) {
    return failed(
      fail("not_allowed", "Only the player this request was sent to can answer it.", "Answer only the requests in your own check-in.").error,
    );
  }
  if (input.challenge_id && item.challenge_id && input.challenge_id !== item.challenge_id) {
    return failed(fail("invalid_input", "This request belongs to another challenge.", "Send the answer with the request's own challenge_id.").error);
  }
  switch (item.kind) {
    case "extra_proof":
      return answerExtraProof(db, d, item, subject, input, now);
    case "surprise_check":
      return answerSurpriseCheck(db, d, item, input, now, t0);
    case "bind_code":
      return answerBindCode(db, d, item, input, now, t0);
    default:
      return failed(fail("invalid_input", "This inbox item does not take an answer.", "Answer only action items from your check-in.").error);
  }
}

async function answerExtraProof(
  db: Db,
  d: Deps,
  item: InboxItem,
  subject: Proof | null,
  input: SubmitProofInput,
  now: Date,
): Promise<SubmitProofResult> {
  const col = collections(db);
  if (!subject) return failed(fail("not_found", "The proof this request is about is gone.", "Check in with lane_check_in.").error);
  const [challenge, player] = await Promise.all([
    col.challenges.findOne({ _id: subject.challenge_id }),
    col.players.findOne({ _id: input.player_id }),
  ]);
  if (!challenge || !player) return failed(fail("not_found", "Lane could not find this challenge.", "Check in with lane_check_in.").error);
  const pack = d.getPack(challenge.type);

  if (isInboxItemExpired(item, now)) {
    // KTD7: past grace, the request is unanswered and the proof is not counted.
    try {
      await services().inbox.expire(db, { now, item_ids: [item._id] });
    } catch (err) {
      console.error("[proofs] could not expire the extra-proof request", err);
    }
    const updated = await markUnanswered(db, subject._id, { now, packTitle: pack.title });
    const current = updated ?? (await col.proofs.findOne({ _id: subject._id })) ?? subject;
    return {
      ok: true,
      proof: current,
      outcome: outcomeOf(current.status),
      duplicate: false,
      verdict: current.verdict,
      request: null,
      lines: ["Not counted (unanswered): the extra-proof request expired before this answer arrived."],
    };
  }
  if (item.status !== "open") {
    return { ok: true, proof: subject, outcome: outcomeOf(subject.status), duplicate: true, verdict: subject.verdict, request: null, lines: ["This request was already answered."] };
  }

  const parsed = parseProof(pack, input.fields);
  if (!parsed.ok) return failed(parsed.error);
  const platform = pack.handlePlatform(challenge);
  const handle = platform ? (player.handles[platform] ?? null) : null;
  let recheck: RecheckResult;
  try {
    recheck = await pack.recheck(parsed.payload, player, handle, { now, fetch: d.fetch, githubToken: d.githubToken });
  } catch {
    return failed(fail("internal", "Lane could not re-check the answer just now.", "Answer again in a few minutes.").error);
  }
  if (recheck.status === "pending") {
    return failed(fail("internal", cap(recheck.reason ?? "Lane could not re-check the answer just now.", 300), "Answer again in a few minutes.").error);
  }
  if (recheck.status === "failed") {
    return failed(fail("invalid_input", "Lane could not confirm the source of this answer.", "Answer with a public source you made yourself.").error);
  }
  if (platform && handle && recheck.status === "rechecked") {
    const author = recheck.source?.author ?? null;
    if (!author || normalizeHandle(author) !== handle.handle) {
      return failed(fail("not_allowed", `The answer must come from your own ${platform} handle.`, `Answer with a source made as @${handle.handle}.`).error);
    }
  }
  // A re-checked answer must carry the code in the source itself; an agent-attested one may carry it in its fields.
  const texts =
    recheck.status === "rechecked"
      ? [recheck.source?.text]
      : [recheck.source?.text, ...Object.values(parsed.payload).filter((v): v is string => typeof v === "string")];
  if (!answerHasCode(item.code, texts)) {
    return failed(
      fail("invalid_input", "The answer does not contain the one-time code.", cap(`Include the code ${item.code ?? ""} as the request says, then answer again.`, 300)).error,
    );
  }
  const resolved = await services().inbox.resolve(db, { item_id: item._id, by_player_id: input.player_id, answer_proof_id: null, now });
  if (!resolved.ok) return failed(resolved.error);
  const accepted = resolved.resolved ? await acceptAnsweredProof(db, subject, { now, packTitle: pack.title }) : null;
  const current = accepted ?? (await col.proofs.findOne({ _id: subject._id })) ?? subject;
  return {
    ok: true,
    proof: current,
    outcome: outcomeOf(current.status),
    duplicate: !resolved.resolved,
    verdict: current.verdict,
    request: null,
    lines: resolved.resolved ? verdictLines(current) : ["This request was already answered."],
  };
}

async function answerSurpriseCheck(
  db: Db,
  d: Deps,
  item: InboxItem,
  input: SubmitProofInput,
  now: Date,
  t0: number,
): Promise<SubmitProofResult> {
  if (isInboxItemExpired(item, now)) {
    return failed(fail("grace_closed", "This surprise check has expired.", "Answer surprise checks before their due time.").error);
  }
  if (!isInboxItemLive(item, now)) {
    return failed(fail("not_found", "This surprise check is not open.", "Check in with lane_check_in to see open checks.").error);
  }
  const result = await submitNew(
    db,
    { ...input, request_id: undefined, challenge_id: item.challenge_id ?? input.challenge_id },
    d,
    now,
    t0,
    item._id,
  );
  if (!result.ok) return result;
  const answers = result.proof.claimed && (item.day_index === null || result.proof.day_index === item.day_index);
  if (!answers) {
    return { ...result, lines: [...result.lines, `This proof does not answer the surprise check for ${dayLabel(item.day_index)}.`].slice(0, 3) };
  }
  const resolved = await services().inbox.resolve(db, { item_id: item._id, by_player_id: input.player_id, answer_proof_id: result.proof._id, now });
  if (!resolved.ok) return failed(resolved.error);
  return { ...result, lines: [...result.lines, "Surprise check answered."].slice(0, 3) };
}

async function answerBindCode(
  db: Db,
  d: Deps,
  item: InboxItem,
  input: SubmitProofInput,
  now: Date,
  t0: number,
): Promise<SubmitProofResult> {
  const col = collections(db);
  const [challenge, player] = await Promise.all([
    item.challenge_id ? col.challenges.findOne({ _id: item.challenge_id }) : Promise.resolve(null),
    col.players.findOne({ _id: input.player_id }),
  ]);
  if (!challenge || !player) return failed(fail("not_found", "Lane could not find this challenge.", "Check in with lane_check_in.").error);
  const pack = d.getPack(challenge.type);
  const platform = pack.handlePlatform(challenge);
  if (!platform) return failed(fail("invalid_input", "This challenge needs no handle.", "Send your proof with lane_submit_proof.").error);
  const code = item.code ?? player.handles[platform]?.bind_code ?? null;
  if (!code) return failed(fail("not_found", "Lane has no bind code for this handle.", "Join the challenge again to get a bind code.").error);
  const confirmed = await confirmHandle(db, { pack, player, platform, code, ctx: { now, fetch: d.fetch, githubToken: d.githubToken } });
  if (confirmed.status === "taken") {
    return failed(fail("handle_taken", `Another player already verified this ${platform} handle.`, "Join with your own handle.").error);
  }
  if (confirmed.status === "not_found") {
    return failed(
      fail(
        "handle_unverified",
        `Lane did not find the bind code in your ${platform} profile bio.`,
        `Put ${code} in your public ${platform} bio, then answer the bind-code action again.`,
      ).error,
    );
  }
  const resolved = await services().inbox.resolve(db, { item_id: item._id, by_player_id: input.player_id, answer_proof_id: null, now });
  if (!resolved.ok && resolved.error.code !== "not_found") return failed(resolved.error);
  const released = await releaseHeld(db, d, { player_id: player._id, platform, now, t0 });
  const first = released[0];
  if (first?.ok) return { ...first, lines: [`Your ${platform} handle is verified.`, ...first.lines].slice(0, 3) };
  // SubmitProofResult needs a proof, and none was waiting. See the U5 report: U7 may prefer to
  // call verifyBindCode directly for bind-code actions.
  return failed(fail("not_found", `Your ${platform} handle is verified. No proof was waiting for it.`, "Send today's proof with lane_submit_proof.").error);
}

/**
 * KTD21: once a handle verifies, run the player's proofs that were held for it through the rest
 * of the pipeline. The day's grace is judged at each proof's original receive time. Safe to
 * call twice: each proof is taken with one conditional update.
 */
export async function releaseHandleHeldProofs(
  db: Db,
  input: { player_id: string; platform: HandlePlatform; now?: Date },
  deps?: ProofDeps,
): Promise<SubmitProofResult[]> {
  const d = resolveDeps(deps);
  return releaseHeld(db, d, { player_id: input.player_id, platform: input.platform, now: input.now ?? d.clock.now(), t0: performance.now() });
}

async function releaseHeld(
  db: Db,
  d: Deps,
  input: { player_id: string; platform: HandlePlatform; now: Date; t0: number },
): Promise<SubmitProofResult[]> {
  const col = collections(db);
  const held = await col.proofs.find({ player_id: input.player_id, status: "held", held_reason: "handle_unverified" }).toArray();
  const results: SubmitProofResult[] = [];
  for (const proof of held) {
    const challenge = await col.challenges.findOne({ _id: proof.challenge_id });
    if (!challenge) continue;
    const pack = d.getPack(challenge.type);
    if (pack.handlePlatform(challenge) !== input.platform) continue;
    const resumed = await col.proofs.findOneAndUpdate(
      { _id: proof._id, status: "held", held_reason: "handle_unverified" },
      {
        $set: { status: "received", held_reason: null, updated_at: input.now },
        $push: { history: historyEntry(input.now, "held", "received", "system", "handle verified") },
      },
      { returnDocument: "after" },
    );
    if (!resumed) continue;
    const [player, membership, contract] = await Promise.all([
      col.players.findOne({ _id: input.player_id }),
      col.memberships.findOne({ challenge_id: challenge._id, player_id: input.player_id }),
      loadLatestContract(db, challenge._id),
    ]);
    if (!player || !membership) continue;
    const run: Run = { db, deps: d, pack, challenge, player, membership, contract, now: input.now, t0: input.t0 };
    results.push(await processReceived(run, resumed, { resumed: true }));
  }
  return results;
}

/** The default service for the web app's composition root (U7): `provideServices({ proofs: proofService })`. */
export const proofService: LaneServices["proofs"] = createProofService();
