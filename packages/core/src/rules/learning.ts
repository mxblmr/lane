import type { Db } from "mongodb";
import { z } from "zod";
import { ChallengeTypeSchema, type ChallengeType, type Features, type Id, type RuleRef } from "../schema/common";
import { collections } from "../schema/collections";
import { actionNeedsApproval, type RuleSource } from "../schema/rule";
import type { Rule } from "../schema/rules";
import type { AnyPack } from "../schema/pack";
import { quote, type AgentWorkspace, type PromoterInput, type PromoterOutput, type Quoted, type RuleLabInput, type RuleLabOutput } from "../schema/agents";
import { getPack, renderRuleLine } from "../packs/index";
import { claimJob, queueJob, runClaimedJob, runDueJobs, type JobContext, type JobHandlers, type JobOutcome, type RunJobResult } from "../jobs";
import type { Clock } from "../clock";
import { writeEvent } from "../events";
import {
  services,
  type AgentInvokeResult,
  type LaneServices,
  type LearningSourceInput,
  type LearningSourceResult,
  type MarkLiveCheatInput,
} from "../interfaces";
import { activeRules, getRule, markPendingApproval, openCandidateFor, proposeRule, testCandidate } from "./lifecycle";
import { addRedTeamExamples, ensurePackSeeds, insertCheatExample, proofExampleKey } from "./examples";
import { applyPromoterDecision, createApproval } from "./approvals";

/**
 * The learning chain (U9 approach step 4, R20 to R24, KTD10, KTD20).
 *
 * Entry points for the four R20 sources queue a `learning` job keyed by the evidence proof id
 * or example key: an AI rejection (U5), a dispute (U18), a live cheat the presenter marks on
 * the dashboard (U12), and each red-team example no active reject rule catches.
 *
 * A learning job is skipped while an open candidate exists for the same type and cheat class,
 * and is not claimed while learning is paused (U3's claim). When it runs it invokes rule-lab
 * with the source and evidence as quoted data, makes sure every candidate it proposed was
 * tested, invokes the promoter once for each candidate that passed, and creates one rule
 * approval with the execution id when the promoter suspends. Agents never invoke each other.
 *
 * No-egress mode (Risks & Dependencies): rule-lab returns its proposal and the red team its
 * examples as their result, the core runs propose and the gate between two rule-lab
 * invocations, and the promoter's returned decision lands through the activate step.
 *
 * The route that queued a job runs it after responding (`runLearningJob` inside `after()`),
 * and U18's tick recovers it through `learningJobHandlers()`.
 */

/** Rule-writer revisions after a failed gate (U10: revise once). */
export const RULE_WRITER_MAX_REVISIONS = 1;
/** Red team: new examples per run. Policy Engine's per-run tool-call cap also applies (U10). */
export const RED_TEAM_MAX_EXAMPLES = 10;

/** True when agents cannot reach Lane's internal API (LANE_AGENT_NO_EGRESS=1 or true). */
export function noEgressFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env.LANE_AGENT_NO_EGRESS ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export interface LearningRunOptions {
  /** Defaults to `noEgressFromEnv()`. */
  noEgress?: boolean;
  clock?: Clock;
  /** Claim renewal interval; defaults to U3's 15 seconds. */
  renewEveryMs?: number;
}

// ---------------------------------------------------------------- entry points

const LearningPayloadSchema = z.object({
  challenge_type: ChallengeTypeSchema,
  source: z.enum(["ai_judgment", "dispute", "live_cheat", "red_team"]),
  cheat_class: z.string().nullable(),
  proof_id: z.string().nullable().default(null),
  example_key: z.string().nullable().default(null),
  dispute_id: z.string().nullable().default(null),
  /** Candidates this job's rule-lab run produced, recorded under the claim's fence. */
  candidate_ids: z.array(z.string()).default([]),
  /** Candidates already handed to the promoter, so a retry never invokes it twice. */
  promoted: z.array(z.string()).default([]),
});
type LearningPayload = z.infer<typeof LearningPayloadSchema>;

/** Queue one learning chain for an R20 source. */
export async function queueLearning(db: Db, input: LearningSourceInput): Promise<LearningSourceResult> {
  const dedupKey = input.proof_id ?? input.example_key ?? input.dispute_id ?? null;
  if (!dedupKey) return { job_id: null, queued: false, skipped_reason: "no_evidence" };
  if (input.cheat_class) {
    const open = await openCandidateFor(db, input.challenge_type, input.cheat_class);
    if (open) return { job_id: null, queued: false, skipped_reason: "open_candidate" };
  }
  const payload: LearningPayload = {
    challenge_type: input.challenge_type,
    source: input.source,
    cheat_class: input.cheat_class,
    proof_id: input.proof_id ?? null,
    example_key: input.example_key ?? null,
    dispute_id: input.dispute_id ?? null,
    candidate_ids: [],
    promoted: [],
  };
  const { job, created } = await queueJob(db, { kind: "learning", dedup_key: dedupKey, payload }, { now: input.now });
  return { job_id: job._id, queued: created, skipped_reason: created ? null : "duplicate" };
}

/** Pick the cheat class for a proof marked as a live cheat: the referee's class, else the first true class feature. */
function inferCheatClass(features: Features, verdictClass: string | null | undefined, pack: AnyPack): string | null {
  if (verdictClass && pack.cheatClasses.includes(verdictClass)) return verdictClass;
  return pack.cheatClasses.find((c) => features[c] === true) ?? null;
}

/** The presenter marks a proof as a live cheat (U12): store it as an example and queue learning. */
export async function markLiveCheat(db: Db, input: MarkLiveCheatInput): Promise<LearningSourceResult> {
  const now = input.now ?? new Date();
  const proof = await collections(db).proofs.findOne({ _id: input.proof_id });
  if (!proof) return { job_id: null, queued: false, skipped_reason: "proof_not_found" };
  if (!proof.features) return { job_id: null, queued: false, skipped_reason: "no_features" };
  const pack = getPack(proof.challenge_type);
  const cheatClass = inferCheatClass(proof.features, proof.verdict?.cheat_class, pack);
  if (!cheatClass) return { job_id: null, queued: false, skipped_reason: "no_cheat_class" };

  const exampleKey = proofExampleKey("live", proof._id);
  const created = await insertCheatExample(db, {
    challenge_type: proof.challenge_type,
    example_key: exampleKey,
    cheat_class: cheatClass,
    features: proof.features,
    source: "live",
    summary: pack.summarize(proof.features),
    proof_id: proof._id,
    now,
  });
  if (created) {
    await writeEvent(db, {
      kind: "proof.live_cheat",
      summary: `A proof was marked as a live cheat (${cheatClass}) and stored as an example.`,
      challenge_id: proof.challenge_id,
      challenge_type: proof.challenge_type,
      player_id: proof.player_id,
      proof_id: proof._id,
      data: { cheat_class: cheatClass, example_key: exampleKey, by: input.by.slice(0, 64) },
      at: now,
    });
  }
  return queueLearning(db, {
    challenge_type: proof.challenge_type,
    source: "live_cheat",
    cheat_class: cheatClass,
    proof_id: proof._id,
    example_key: exampleKey,
    now,
  });
}

/**
 * After a red-team run: queue one learning job for each new cheat example that no active reject
 * rule catches. Uses the `engine` service, so the check is the same as live evaluation.
 */
export async function queueForUncaughtExamples(
  db: Db,
  challengeType: ChallengeType,
  exampleKeys: readonly string[],
  now: Date = new Date(),
): Promise<LearningSourceResult[]> {
  if (exampleKeys.length === 0) return [];
  const examples = await collections(db)
    .examples.find({ challenge_type: challengeType, example_key: { $in: [...exampleKeys] }, label: "cheat" })
    .toArray();
  const results: LearningSourceResult[] = [];
  for (const ex of examples) {
    const evaluation = await services().engine.evaluate(db, { challenge_type: challengeType, features: ex.features });
    if (evaluation.matched.some((m) => m.action === "reject")) continue;
    results.push(
      await queueLearning(db, {
        challenge_type: challengeType,
        source: "red_team",
        cheat_class: ex.cheat_class,
        example_key: ex.example_key,
        now,
      }),
    );
  }
  return results;
}

/** Queue one red-team run for a challenge type (U12's control, U10's red team). */
export async function queueRedTeamRun(
  db: Db,
  input: { challenge_type: ChallengeType; run_id?: string; max_examples?: number; now?: Date },
): Promise<{ job_id: Id; queued: boolean }> {
  const now = input.now ?? new Date();
  const { job, created } = await queueJob(
    db,
    {
      kind: "red_team",
      dedup_key: `${input.challenge_type}:${input.run_id ?? now.toISOString()}`,
      payload: { challenge_type: input.challenge_type, max_examples: input.max_examples ?? RED_TEAM_MAX_EXAMPLES },
    },
    { now },
  );
  return { job_id: job._id, queued: created };
}

// ---------------------------------------------------------------- running jobs

/** Handlers for U18's tick (`runDueJobs`) and for running a job after the response. */
export function learningJobHandlers(opts: LearningRunOptions = {}): JobHandlers {
  return {
    learning: (ctx) => runLearningChain(ctx, opts),
    red_team: (ctx) => runRedTeam(ctx, opts),
  };
}

/** Claim one learning or red-team job by id and run it (the route's `after()` path). */
export async function runLearningJob(db: Db, jobId: Id, opts: LearningRunOptions = {}): Promise<RunJobResult | null> {
  const now = opts.clock?.now() ?? new Date();
  const claim = await claimJob(db, jobId, { now });
  if (!claim) return null;
  const handler = learningJobHandlers(opts)[claim.job.kind];
  if (!handler) throw new Error(`job ${jobId} is a ${claim.job.kind} job, not a learning job`);
  return runClaimedJob(db, claim, handler, { clock: opts.clock, renewEveryMs: opts.renewEveryMs });
}

/** Reclaim stale jobs and run due learning and red-team jobs (the tick's recovery, for these kinds). */
export async function runDueLearningJobs(
  db: Db,
  opts: LearningRunOptions & { limit?: number } = {},
): Promise<{ reclaimed: number; runs: RunJobResult[] }> {
  return runDueJobs(db, learningJobHandlers(opts), { clock: opts.clock, limit: opts.limit });
}

async function setPayload(ctx: JobContext, update: Record<string, unknown>): Promise<boolean> {
  const res = await collections(ctx.db).jobs.updateOne(ctx.fence, update);
  return res.matchedCount === 1;
}

async function runLearningChain(ctx: JobContext, opts: LearningRunOptions): Promise<JobOutcome | void> {
  const db = ctx.db;
  const noEgress = opts.noEgress ?? noEgressFromEnv();
  const p = LearningPayloadSchema.parse(ctx.job.payload);
  const pack = getPack(p.challenge_type);
  await ensurePackSeeds(db);

  let candidateIds = p.candidate_ids;
  if (candidateIds.length === 0) {
    // KTD20: skip while an open candidate exists for the same type and cheat class.
    if (p.cheat_class) {
      const open = await openCandidateFor(db, p.challenge_type, p.cheat_class);
      if (open) return { kind: "skip", reason: `open candidate ${open.rule_key} v${open.version}` };
    }
    candidateIds = await writeRule(db, p, pack, noEgress, ctx.now());
    if (ctx.isLost()) return;
    if (!(await setPayload(ctx, { $set: { "payload.candidate_ids": candidateIds, updated_at: ctx.now() } }))) return;
  }

  const outcomes: Record<string, string> = {};
  for (const id of candidateIds) {
    if (ctx.isLost()) return;
    let rule = await getRule(db, id);
    if (!rule || rule.challenge_type !== p.challenge_type) continue;
    if (rule.status === "candidate" && !rule.test_results) {
      // Rule-lab proposed but did not test: the core runs the gate itself.
      const tested = await testCandidate(db, id, { now: ctx.now(), pack });
      if (tested.ok) rule = tested.rule;
    }
    if (rule.status !== "candidate" || !rule.test_results?.passed) {
      outcomes[id] = rule.status;
      continue;
    }
    if (p.promoted.includes(id)) {
      outcomes[id] = rule.status;
      continue;
    }
    // Mark before invoking, under the fence, so a passed candidate gets one promoter invocation.
    const marked = await collections(db).jobs.updateOne(
      { ...ctx.fence, "payload.promoted": { $ne: id } },
      { $addToSet: { "payload.promoted": id }, $set: { updated_at: ctx.now() } },
    );
    if (marked.matchedCount !== 1) {
      if (ctx.isLost()) return;
      continue;
    }
    try {
      outcomes[id] = await promote(db, rule, pack, noEgress, ctx.now());
    } catch (err) {
      // Let a retry invoke the promoter again for this candidate.
      await setPayload(ctx, { $pull: { "payload.promoted": id } });
      throw err;
    }
  }
  return { kind: "done", result: { candidate_ids: candidateIds, outcomes } };
}

interface Evidence {
  quoted: Quoted[];
  features: Features | null;
  proof_ids: Id[];
  example_keys: string[];
  dispute_ids: Id[];
}

async function buildEvidence(db: Db, p: LearningPayload, pack: AnyPack): Promise<Evidence> {
  const col = collections(db);
  const ev: Evidence = { quoted: [], features: null, proof_ids: [], example_keys: [], dispute_ids: [] };
  let proofId = p.proof_id;
  if (p.dispute_id) {
    const dispute = await col.disputes.findOne({ _id: p.dispute_id });
    if (dispute) {
      ev.dispute_ids.push(dispute._id);
      ev.quoted.push(quote(`Dispute reason: ${dispute.reason}`));
      if (dispute.referee?.reason) ev.quoted.push(quote(`Referee on the dispute: ${dispute.referee.reason}`));
      proofId = proofId ?? dispute.proof_id;
    }
  }
  if (proofId) {
    const proof = await col.proofs.findOne({ _id: proofId });
    if (proof) {
      ev.proof_ids.push(proof._id);
      if (proof.features) {
        ev.features = proof.features;
        ev.quoted.push(quote(`Proof summary: ${pack.summarize(proof.features)}`));
      }
      if (proof.verdict?.reason) {
        ev.quoted.push(quote(`${proof.verdict.ai_judgment ? "AI reviewer" : "Verdict"} reason: ${proof.verdict.reason}`));
      }
    }
  }
  if (p.example_key) {
    const ex = await col.examples.findOne({ challenge_type: p.challenge_type, example_key: p.example_key });
    if (ex) {
      ev.example_keys.push(ex.example_key);
      ev.features = ev.features ?? ex.features;
      if (ex.summary) ev.quoted.push(quote(`Example summary: ${ex.summary}`));
    }
  }
  return ev;
}

async function parentFor(db: Db, type: ChallengeType, cheatClass: string | null): Promise<RuleRef | null> {
  if (!cheatClass) return null;
  const active = (await activeRules(db, type)).find((r) => r.cheat_class === cheatClass);
  return active ? { rule_key: active.rule_key, version: active.version } : null;
}

function agentFailure(agent: string, res: AgentInvokeResult<AgentWorkspace>): Error {
  return new Error(res.ok ? `${agent} returned ${res.status} instead of completing` : `${agent} failed: ${res.error}`);
}

/** Invoke rule-lab's rule-writer and return the candidate ids it produced. */
async function writeRule(db: Db, p: LearningPayload, pack: AnyPack, noEgress: boolean, now: Date): Promise<Id[]> {
  const ev = await buildEvidence(db, p, pack);
  const source: RuleSource = p.source;
  const input: RuleLabInput = {
    mode: "write_rule",
    challenge_type: p.challenge_type,
    source,
    cheat_class: p.cheat_class,
    evidence: ev.quoted,
    evidence_features: ev.features,
    evidence_proof_ids: ev.proof_ids,
    evidence_example_keys: ev.example_keys,
    parent: await parentFor(db, p.challenge_type, p.cheat_class),
    max_revisions: RULE_WRITER_MAX_REVISIONS,
    max_examples: 0,
    no_egress: noEgress,
  };
  const meta = { proof_id: p.proof_id, event_id: p.proof_id ?? p.example_key ?? p.dispute_id };
  const res = await services().agents.invoke({ workspace: "rule_lab", mode: "write_rule", input, meta });
  if (!res.ok || res.status !== "completed") throw agentFailure("rule-lab", res);
  const out = res.output as RuleLabOutput;

  if (!noEgress) {
    const found = await collections(db)
      .rules.find({ _id: { $in: out.candidate_ids }, challenge_type: p.challenge_type }, { projection: { _id: 1 } })
      .toArray();
    return found.map((r) => r._id);
  }

  // No-egress: the core proposes and runs the gate between two rule-lab invocations.
  const ids: Id[] = [];
  let proposal = out.proposal;
  for (let round = 0; proposal && round <= RULE_WRITER_MAX_REVISIONS; round++) {
    const proposed = await proposeRule(
      db,
      {
        ...proposal,
        challenge_type: p.challenge_type,
        source,
        evidence: {
          proof_ids: [...new Set([...proposal.evidence.proof_ids, ...ev.proof_ids])],
          example_keys: [...new Set([...proposal.evidence.example_keys, ...ev.example_keys])],
          dispute_ids: [...new Set([...proposal.evidence.dispute_ids, ...ev.dispute_ids])],
        },
      },
      { now, pack },
    );
    if (!proposed.ok) break;
    ids.push(proposed.rule._id);
    const tested = await testCandidate(db, proposed.rule._id, { now, pack });
    if (!tested.ok || tested.gate.passed || round === RULE_WRITER_MAX_REVISIONS) break;
    const retry = await services().agents.invoke({
      workspace: "rule_lab",
      mode: "write_rule",
      input: {
        ...input,
        evidence: [...ev.quoted, quote(`Your previous proposal failed the test gate: ${tested.gate.reasons.join("; ")}`)],
        max_revisions: 0,
      },
      meta,
    });
    if (!retry.ok || retry.status !== "completed") throw agentFailure("rule-lab", retry);
    proposal = (retry.output as RuleLabOutput).proposal;
  }
  return ids;
}

/** Invoke the promoter for one passed candidate. Returns the candidate's resulting status. */
async function promote(db: Db, rule: Rule, pack: AnyPack, noEgress: boolean, now: Date): Promise<string> {
  const gate = rule.test_results;
  if (!gate) throw new Error(`candidate ${rule._id} has no test results`);
  const input: PromoterInput = {
    candidate_id: rule._id,
    rule_key: rule.rule_key,
    version: rule.version,
    challenge_type: rule.challenge_type,
    action: rule.action,
    requires_approval: actionNeedsApproval(rule.action),
    line: renderRuleLine(pack, rule),
    gate: {
      passed: gate.passed,
      target_class: gate.target_class,
      catch_rate_before: gate.catch_rate_before,
      catch_rate_after: gate.catch_rate_after,
      false_alarm_rule: gate.false_alarm_rule,
      false_alarm_set: gate.false_alarm_set,
    },
    no_egress: noEgress,
  };
  // KTD10: each promoter run uses its own session id per candidate.
  const res = await services().agents.invoke({
    workspace: "promoter",
    mode: "promote",
    input,
    session_id: `promoter-${rule._id}`,
    meta: { event_id: rule._id },
  });
  if (!res.ok) throw new Error(`promoter failed: ${res.error}`);

  if (res.status === "suspended") {
    const { approval } = await createApproval(
      db,
      {
        kind: "rule",
        rule_id: rule._id,
        rule_key: rule.rule_key,
        rule_version: rule.version,
        challenge_type: rule.challenge_type,
        action: rule.action,
        execution_id: res.execution_id,
        workspace_id: res.workspace_id,
        suspend_context: { ...res.interrupt },
        allowed_decisions: res.interrupt.allowed_decisions,
      },
      { now },
    );
    const pending = await markPendingApproval(db, rule._id, approval._id, now);
    return pending?.status ?? "pending_approval";
  }

  const error = await applyPromoterDecision(db, res.output as PromoterOutput, rule._id, "promoter", now);
  const after = await getRule(db, rule._id);
  if (error) {
    await writeEvent(db, {
      kind: "rule.promotion_refused",
      summary: `The promoter's decision on ${rule.rule_key} v${rule.version} was not applied.`,
      challenge_type: rule.challenge_type,
      rule_key: rule.rule_key,
      rule_version: rule.version,
      data: { rule_id: rule._id, status: after?.status ?? null },
      at: now,
    });
  }
  return after?.status ?? rule.status;
}

const RedTeamPayloadSchema = z.object({
  challenge_type: ChallengeTypeSchema,
  max_examples: z.int().min(0).max(50).default(RED_TEAM_MAX_EXAMPLES),
});

async function runRedTeam(ctx: JobContext, opts: LearningRunOptions): Promise<JobOutcome | void> {
  const db = ctx.db;
  const noEgress = opts.noEgress ?? noEgressFromEnv();
  const p = RedTeamPayloadSchema.parse(ctx.job.payload);
  await ensurePackSeeds(db);
  const input: RuleLabInput = {
    mode: "red_team",
    challenge_type: p.challenge_type,
    source: "red_team",
    cheat_class: null,
    evidence: [],
    evidence_features: null,
    evidence_proof_ids: [],
    evidence_example_keys: [],
    parent: null,
    max_revisions: 0,
    max_examples: p.max_examples,
    no_egress: noEgress,
  };
  const res = await services().agents.invoke({ workspace: "rule_lab", mode: "red_team", input, meta: { event_id: ctx.job._id } });
  if (!res.ok || res.status !== "completed") throw agentFailure("rule-lab", res);
  const out = res.output as RuleLabOutput;

  let keys: string[];
  if (noEgress) {
    const added = out.examples.length > 0
      ? await addRedTeamExamples(db, { challenge_type: p.challenge_type, examples: out.examples.slice(0, p.max_examples) }, { now: ctx.now() })
      : { ok: true as const, added: [], duplicates: [] };
    keys = added.ok ? added.added : [];
  } else {
    const found = await collections(db)
      .examples.find({ challenge_type: p.challenge_type, example_key: { $in: out.example_keys }, source: "red_team" })
      .toArray();
    keys = found.map((e) => e.example_key);
  }
  if (ctx.isLost()) return;
  const queued = await queueForUncaughtExamples(db, p.challenge_type, keys, ctx.now());
  return {
    kind: "done",
    result: { example_keys: keys, learning_jobs: queued.filter((q) => q.queued).map((q) => q.job_id) },
  };
}

/** U9's `learning` service, for the composition root's `provideServices`. */
export const learningService: LaneServices["learning"] = {
  fromSource: (db, input) => queueLearning(db, input),
  markLiveCheat: (db, input) => markLiveCheat(db, input),
};
