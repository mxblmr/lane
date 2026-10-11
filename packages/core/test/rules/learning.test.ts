import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import { collections } from "../../src/schema/collections";
import { provideServices, resetServices } from "../../src/interfaces";
import { manualClock } from "../../src/clock";
import { claimJob, reclaimStaleJobs } from "../../src/jobs";
import { updateSettings } from "../../src/config";
import { proposeRule, testCandidate } from "../../src/rules/lifecycle";
import { addRedTeamExamples } from "../../src/rules/examples";
import { ruleApprovalId } from "../../src/rules/approvals";
import {
  markLiveCheat,
  noEgressFromEnv,
  queueLearning,
  queueRedTeamRun,
  runDueLearningJobs,
  runLearningJob,
} from "../../src/rules/learning";
import type { RuleLabInput } from "../../src/schema/agents";
import type { When } from "../../src/schema/rule";
import {
  ae1Examples,
  ae2Examples,
  agentsDouble,
  callFeatures,
  completed,
  contractsDouble,
  engineDouble,
  insertActiveRule,
  insertExamples,
  insertProof,
  PERSONAL_NO_NOTES_WHEN,
  plus,
  promoterOutput,
  proposal,
  RENAME_WHEN,
  ruleLabOutput,
  shipFeatures,
  suspended,
  T0,
  type AgentScript,
} from "./u9-fixtures";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});
afterEach(() => {
  resetServices();
});

/** Rule-lab with egress: proposes and tests through the same functions the internal API calls. */
function egressRuleLab(db: Db, when: When = RENAME_WHEN): AgentScript["ruleLab"] {
  return async (input: RuleLabInput) => {
    const p = await proposeRule(
      db,
      proposal({
        challenge_type: input.challenge_type,
        when,
        action: "reject",
        cheat_class: input.cheat_class ?? "rename_only",
        source: input.source,
        evidence: { proof_ids: input.evidence_proof_ids, example_keys: input.evidence_example_keys, dispute_ids: [] },
      }),
      { now: T0 },
    );
    if (!p.ok) throw new Error(p.error.message);
    await testCandidate(db, p.rule._id, { now: T0 });
    return ruleLabOutput({ candidate_ids: [p.rule._id] });
  };
}

function setup(script: (db: Db) => AgentScript) {
  return async () => {
    const db = await mongo.freshDb();
    const agents = agentsDouble(script(db));
    const contracts = contractsDouble();
    provideServices({ agents: agents.service, contracts: contracts.service, engine: engineDouble });
    return { db, agents, contracts };
  };
}

const suspendingPromoter: AgentScript["promoter"] = async (input) => suspended(input, `exec_${input.candidate_id}`);

async function aiRejection(db: Db, now: Date = T0) {
  const proofId = await insertProof(db, { challenge_type: "ship_week", features: shipFeatures({ rename_only: true, code_lines_changed: 12 }), cheat_class: "rename_only" });
  const queued = await queueLearning(db, { challenge_type: "ship_week", source: "ai_judgment", cheat_class: "rename_only", proof_id: proofId, now });
  return { proofId, queued };
}

describe("learning chain (R20 to R24, KTD10, KTD20)", () => {
  it("AE1: an AI rejection leads to one rule-lab run, one promoter invocation, and one pending rule approval", async () => {
    const { db, agents } = await setup((db) => ({ ruleLab: egressRuleLab(db), promoter: suspendingPromoter }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const { proofId, queued } = await aiRejection(db);
    expect(queued.queued).toBe(true);
    expect(queued.job_id).not.toBeNull();

    const run = await runLearningJob(db, queued.job_id as string, { noEgress: false });
    expect(run?.status).toBe("done");

    const ruleLabCalls = agents.ruleLabInvokes();
    expect(ruleLabCalls).toHaveLength(1);
    const labInput = ruleLabCalls[0]?.input as RuleLabInput;
    expect(labInput.mode).toBe("write_rule");
    expect(labInput.cheat_class).toBe("rename_only");
    expect(labInput.evidence_proof_ids).toEqual([proofId]);
    expect(labInput.evidence.map((e) => e.quoted_data).join(" ")).toContain("renames identifiers");
    expect(labInput.no_egress).toBe(false);

    const promoterCalls = agents.promoterInvokes();
    expect(promoterCalls).toHaveLength(1);
    const candidateId = (promoterCalls[0]?.input as { candidate_id: string }).candidate_id;
    expect(promoterCalls[0]?.session_id).toBe(`promoter-${candidateId}`);
    expect(promoterCalls[0]?.input).toMatchObject({ requires_approval: true, action: "reject", gate: { passed: true, catch_rate_before: 0 } });

    const rule = await collections(db).rules.findOne({ _id: candidateId });
    expect(rule?.status).toBe("pending_approval");
    // The pack's own seed examples (if any) load before the run, so compare with what is stored.
    const renameExamples = await collections(db).examples.find({ challenge_type: "ship_week", cheat_class: "rename_only" }).toArray();
    const expectedAfter = renameExamples.filter((e) => e.features.rename_only === true).length / renameExamples.length;
    expect(expectedAfter).toBeGreaterThanOrEqual(0.95);
    expect(rule?.test_results?.catch_rate_after).toBeCloseTo(expectedAfter, 10);
    const approvals = await collections(db).approvals.find().toArray();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ _id: ruleApprovalId(candidateId), kind: "rule", status: "pending", execution_id: `exec_${candidateId}` });
    expect(rule?.approval_id).toBe(ruleApprovalId(candidateId));

    // Re-running the queue and re-queueing the same proof change nothing.
    const again = await runDueLearningJobs(db, { noEgress: false });
    expect(again.runs).toHaveLength(0);
    const dup = await queueLearning(db, { challenge_type: "ship_week", source: "ai_judgment", cheat_class: "rename_only", proof_id: proofId, now: T0 });
    expect(dup.queued).toBe(false);
    expect(agents.promoterInvokes()).toHaveLength(1);
  });

  it("a second AI rejection of the same cheat class while a candidate is open queues no new chain", async () => {
    const { db, agents } = await setup((db) => ({ ruleLab: egressRuleLab(db), promoter: suspendingPromoter }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const first = await aiRejection(db);
    // Queued before the first run made a candidate: skipped when it runs.
    const early = await aiRejection(db);
    expect(early.queued.queued).toBe(true);

    await runLearningJob(db, first.queued.job_id as string, { noEgress: false });
    const skipped = await runLearningJob(db, early.queued.job_id as string, { noEgress: false });
    expect(skipped?.status).toBe("skipped");

    const late = await aiRejection(db);
    expect(late.queued).toEqual({ job_id: null, queued: false, skipped_reason: "open_candidate" });
    expect(await collections(db).jobs.countDocuments({ kind: "learning" })).toBe(2);
    expect(agents.ruleLabInvokes()).toHaveLength(1);
    expect(agents.promoterInvokes()).toHaveLength(1);
    expect(await collections(db).approvals.countDocuments()).toBe(1);
  });

  it("a retried job does not run rule-lab again and creates one approval", async () => {
    let promoterAttempts = 0;
    const { db, agents } = await setup((db) => ({
      ruleLab: egressRuleLab(db),
      promoter: async (input) => {
        promoterAttempts += 1;
        if (promoterAttempts === 1) return { ok: false, error: "timeout", schema_valid: true, timed_out: true, execution_id: null, latency_ms: 1 };
        return suspended(input, "exec_retry");
      },
    }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const clock = manualClock(T0);
    const { queued } = await aiRejection(db);
    const first = await runLearningJob(db, queued.job_id as string, { noEgress: false, clock });
    expect(first?.status).toBe("failed");
    const job = await collections(db).jobs.findOne({ _id: queued.job_id as string });
    expect(job?.status).toBe("queued");
    expect((job?.payload as { candidate_ids: string[] }).candidate_ids).toHaveLength(1);

    clock.advance(31_000);
    const second = await runDueLearningJobs(db, { noEgress: false, clock });
    expect(second.runs.map((r) => r.status)).toEqual(["done"]);
    expect(agents.ruleLabInvokes()).toHaveLength(1);
    expect(agents.promoterInvokes()).toHaveLength(2);
    expect(await collections(db).approvals.countDocuments()).toBe(1);
  });

  it("a learning job whose post-response run died is completed by the next tick's recovery", async () => {
    const { db, agents } = await setup((db) => ({ ruleLab: egressRuleLab(db), promoter: suspendingPromoter }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const clock = manualClock(T0);
    const { queued } = await aiRejection(db);
    // The after() run claimed the job and then the function died: no renewals, no result.
    const claim = await claimJob(db, queued.job_id as string, { now: T0 });
    expect(claim).not.toBeNull();

    clock.set(plus(30_000));
    const tooEarly = await runDueLearningJobs(db, { noEgress: false, clock });
    expect(tooEarly).toEqual({ reclaimed: 0, runs: [] });

    clock.set(plus(46_000));
    const tick = await runDueLearningJobs(db, { noEgress: false, clock });
    expect(tick.reclaimed).toBe(1);
    expect(tick.runs.map((r) => r.status)).toEqual(["done"]);
    const job = await collections(db).jobs.findOne({ _id: queued.job_id as string });
    expect(job?.status).toBe("done");
    expect(job?.attempt).toBe(2);
    expect(agents.promoterInvokes()).toHaveLength(1);
    expect(await collections(db).approvals.countDocuments()).toBe(1);
  });

  it("a learning job still renewing its claim after 90 seconds is not reclaimed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { db } = await setup((db) => {
      const lab = egressRuleLab(db);
      return {
        ruleLab: async (input) => {
          await gate;
          return lab!(input, undefined as never);
        },
        promoter: suspendingPromoter,
      };
    })();
    await insertExamples(db, "ship_week", ae1Examples());
    const clock = manualClock(T0);
    const { queued } = await aiRejection(db);
    const running = runLearningJob(db, queued.job_id as string, { noEgress: false, clock, renewEveryMs: 10 });

    const renewedAt = async () => (await collections(db).jobs.findOne({ _id: queued.job_id as string }))?.renewed_at?.getTime() ?? 0;
    const waitForRenewal = async (atLeast: Date) => {
      for (let i = 0; i < 200 && (await renewedAt()) < atLeast.getTime(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    for (const step of [30_000, 60_000, 90_000]) {
      clock.set(plus(step));
      await waitForRenewal(plus(step));
    }
    expect(await renewedAt()).toBe(plus(90_000).getTime());
    expect(await reclaimStaleJobs(db, plus(90_000))).toBe(0);
    const tick = await runDueLearningJobs(db, { noEgress: false, clock });
    expect(tick).toEqual({ reclaimed: 0, runs: [] });
    const job = await collections(db).jobs.findOne({ _id: queued.job_id as string });
    expect(job?.status).toBe("running");
    expect(job?.attempt).toBe(1);

    release();
    const result = await running;
    expect(result?.status).toBe("done");
  });

  it("does not claim a learning job while learning is paused", async () => {
    const { db, agents } = await setup((db) => ({ ruleLab: egressRuleLab(db), promoter: suspendingPromoter }))();
    await updateSettings(db, { learning_paused: true }, T0);
    const { queued } = await aiRejection(db);
    expect(await runLearningJob(db, queued.job_id as string, { noEgress: false })).toBeNull();
    expect(agents.invokes).toHaveLength(0);
  });

  it("a red-team run queues one learning job for each new cheat example no active reject rule catches", async () => {
    const { db } = await setup((db) => ({
      ruleLab: async (input) => {
        expect(input.mode).toBe("red_team");
        const res = await addRedTeamExamples(
          db,
          {
            challenge_type: "ship_week",
            examples: [
              { example_key: "rt-rename-1", cheat_class: "rename_only", features: shipFeatures({ rename_only: true }), summary: null },
              { example_key: "rt-rename-2", cheat_class: "rename_only", features: shipFeatures({ rename_only: true }), summary: null },
              { example_key: "rt-ws-1", cheat_class: "whitespace_only", features: shipFeatures({ whitespace_only: true }), summary: null },
              { example_key: "rt-ws-2", cheat_class: "whitespace_only", features: shipFeatures({ whitespace_only: true, code_lines_changed: 3 }), summary: null },
              { example_key: "rt-docs-1", cheat_class: "docs_only", features: shipFeatures({ docs_only: true }), summary: null },
            ],
          },
          { now: T0 },
        );
        if (!res.ok) throw new Error(res.error.message);
        return ruleLabOutput({ outcome: "examples_added", example_keys: res.added });
      },
    }))();
    await insertActiveRule(db, { challenge_type: "ship_week", rule_key: "rename-only", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" });
    // A flag rule does not count as caught: only an active reject rule does.
    await insertActiveRule(db, { challenge_type: "ship_week", rule_key: "docs-flag", when: { all: [{ feature: "docs_only", op: "eq", value: true }] }, action: "flag", cheat_class: "docs_only" });

    const { job_id } = await queueRedTeamRun(db, { challenge_type: "ship_week", run_id: "run1", now: T0 });
    const run = await runLearningJob(db, job_id, { noEgress: false });
    expect(run?.status).toBe("done");
    const jobs = await collections(db).jobs.find({ kind: "learning" }).toArray();
    expect(jobs.map((j) => j.dedup_key).sort()).toEqual(["rt-docs-1", "rt-ws-1", "rt-ws-2"]);
    expect(jobs.every((j) => (j.payload as { source: string }).source === "red_team")).toBe(true);
    expect(await collections(db).examples.countDocuments({ source: "red_team", label: "cheat" })).toBe(5);
  });

  it("marking a proof as a live cheat stores it as an example and queues one learning job with source live_cheat", async () => {
    const { db } = await setup(() => ({}))();
    const proofId = await insertProof(db, { challenge_type: "customers", features: callFeatures({ all_personal_email: true, has_notes: false }), cheat_class: null, ai_judgment: false });
    const first = await markLiveCheat(db, { proof_id: proofId, by: "presenter", now: T0 });
    const second = await markLiveCheat(db, { proof_id: proofId, by: "presenter", now: T0 });
    expect(first.queued).toBe(true);
    expect(second).toMatchObject({ queued: false, skipped_reason: "duplicate" });
    const examples = await collections(db).examples.find({ challenge_type: "customers" }).toArray();
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({ example_key: `live-${proofId}`, label: "cheat", cheat_class: "all_personal_email", source: "live", proof_id: proofId });
    const jobs = await collections(db).jobs.find({ kind: "learning" }).toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ source: "live_cheat", cheat_class: "all_personal_email", proof_id: proofId });
    expect(await markLiveCheat(db, { proof_id: "prf_missing", by: "presenter" })).toMatchObject({ queued: false, skipped_reason: "proof_not_found" });
  });

  it("no-egress: the core proposes and gates rule-lab's proposal, revising once after a failed gate", async () => {
    const broad: When = { all: [{ feature: "files_changed", op: "gte", value: 2 }] };
    let calls = 0;
    const { db, agents } = await setup(() => ({
      ruleLab: async (input) => {
        calls += 1;
        const when = calls === 1 ? broad : RENAME_WHEN;
        return ruleLabOutput({
          proposal: proposal({ challenge_type: input.challenge_type, when, action: "reject", cheat_class: "rename_only", rule_key: "rename-only" }),
        });
      },
      promoter: suspendingPromoter,
    }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const { queued } = await aiRejection(db);
    const run = await runLearningJob(db, queued.job_id as string, { noEgress: true });
    expect(run?.status).toBe("done");

    const labCalls = agents.ruleLabInvokes();
    expect(labCalls).toHaveLength(2);
    expect((labCalls[0]?.input as RuleLabInput).no_egress).toBe(true);
    const retryEvidence = (labCalls[1]?.input as RuleLabInput).evidence.map((e) => e.quoted_data).join(" ");
    expect(retryEvidence).toContain("failed the test gate");
    const rules = await collections(db).rules.find({ rule_key: "rename-only" }).sort({ version: 1 }).toArray();
    expect(rules.map((r) => r.status)).toEqual(["rejected", "pending_approval"]);
    expect(rules[1]?.evidence.proof_ids).toHaveLength(1);
    expect(agents.promoterInvokes()).toHaveLength(1);
    expect(await collections(db).approvals.countDocuments()).toBe(1);
  });

  it("no-egress: a proposal U4's grammar refuses is fed back to rule-lab for its one revision", async () => {
    const outOfBound: When = { all: [{ feature: "code_lines_changed", op: "lte", value: 25 }] };
    let calls = 0;
    const { db, agents } = await setup(() => ({
      ruleLab: async (input) => {
        calls += 1;
        const when = calls === 1 ? outOfBound : RENAME_WHEN;
        return ruleLabOutput({
          proposal: proposal({ challenge_type: input.challenge_type, when, action: "reject", cheat_class: "rename_only", rule_key: "rename-only" }),
        });
      },
      promoter: suspendingPromoter,
    }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const { queued } = await aiRejection(db);
    const run = await runLearningJob(db, queued.job_id as string, { noEgress: true });
    expect(run?.status).toBe("done");

    const labCalls = agents.ruleLabInvokes();
    expect(labCalls).toHaveLength(2);
    const retryEvidence = (labCalls[1]?.input as RuleLabInput).evidence.map((e) => e.quoted_data).join(" ");
    expect(retryEvidence).toContain("was invalid");
    expect(retryEvidence).toContain("hard bound 0 to 20, got 25");
    // The refused proposal was never stored; only the revision exists.
    const rules = await collections(db).rules.find({ rule_key: "rename-only" }).toArray();
    expect(rules.map((r) => r.status)).toEqual(["pending_approval"]);
    expect(agents.promoterInvokes()).toHaveLength(1);
  });

  it("no-egress: a promoter returning activated for a reject rule without approval does not activate it", async () => {
    const { db, contracts } = await setup(() => ({
      ruleLab: async (input) =>
        ruleLabOutput({ proposal: proposal({ challenge_type: input.challenge_type, when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" }) }),
      promoter: async (input) => completed(promoterOutput(input.candidate_id, "activated")),
    }))();
    await insertExamples(db, "ship_week", ae1Examples());
    const { queued } = await aiRejection(db);
    await runLearningJob(db, queued.job_id as string, { noEgress: true });
    const rule = await collections(db).rules.findOne({ rule_key: "learned-rename-only" });
    expect(rule?.status).toBe("candidate");
    expect(contracts.calls).toHaveLength(0);
    expect(await collections(db).events.countDocuments({ kind: "rule.promotion_refused" })).toBe(1);
  });

  it("no-egress: AE2 ask_more rule returned activated by the promoter goes active without approval", async () => {
    const { db, contracts } = await setup(() => ({
      ruleLab: async (input) =>
        ruleLabOutput({
          proposal: proposal({ challenge_type: input.challenge_type, when: PERSONAL_NO_NOTES_WHEN, action: "ask_more", cheat_class: "all_personal_email", source: "dispute" }),
        }),
      promoter: async (input) => {
        expect(input.requires_approval).toBe(false);
        return completed(promoterOutput(input.candidate_id, "activated"));
      },
    }))();
    await insertExamples(db, "customers", ae2Examples());
    const proofId = await insertProof(db, { challenge_type: "customers", features: callFeatures({ all_personal_email: true, has_notes: false }), cheat_class: "all_personal_email" });
    const queued = await queueLearning(db, { challenge_type: "customers", source: "dispute", cheat_class: "all_personal_email", proof_id: proofId, now: T0 });
    await runLearningJob(db, queued.job_id as string, { noEgress: true });
    const rule = await collections(db).rules.findOne({ challenge_type: "customers" });
    expect(rule?.status).toBe("active");
    expect(contracts.calls).toHaveLength(1);
    expect(await collections(db).approvals.countDocuments()).toBe(0);
  });

  it("no-egress: red-team examples returned by rule-lab are loaded and uncaught ones queue learning", async () => {
    const { db } = await setup(() => ({
      ruleLab: async () =>
        ruleLabOutput({
          outcome: "examples_added",
          examples: [
            { example_key: "rt-a", cheat_class: "whitespace_only", features: shipFeatures({ whitespace_only: true }), summary: null },
            { example_key: "rt-b", cheat_class: "rename_only", features: shipFeatures({ rename_only: true }), summary: null },
          ],
        }),
    }))();
    await insertActiveRule(db, { challenge_type: "ship_week", rule_key: "rename-only", when: RENAME_WHEN, action: "reject", cheat_class: "rename_only" });
    const { job_id } = await queueRedTeamRun(db, { challenge_type: "ship_week", run_id: "run2", now: T0 });
    await runLearningJob(db, job_id, { noEgress: true });
    expect(await collections(db).examples.countDocuments({ source: "red_team" })).toBe(2);
    const jobs = await collections(db).jobs.find({ kind: "learning" }).toArray();
    expect(jobs.map((j) => j.dedup_key)).toEqual(["rt-a"]);
  });

  it("reads the no-egress flag from LANE_AGENT_NO_EGRESS", () => {
    expect(noEgressFromEnv({ LANE_AGENT_NO_EGRESS: "1" })).toBe(true);
    expect(noEgressFromEnv({ LANE_AGENT_NO_EGRESS: "true" })).toBe(true);
    expect(noEgressFromEnv({ LANE_AGENT_NO_EGRESS: "" })).toBe(false);
    expect(noEgressFromEnv({})).toBe(false);
  });
});
