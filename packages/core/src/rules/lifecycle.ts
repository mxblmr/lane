import type { Db } from "mongodb";
import { ChallengeTypeSchema, fail, newId, type ChallengeType, type Id, type Outcome, type RuleRef } from "../schema/common";
import { collections, isDuplicateKeyError } from "../schema/collections";
import { actionNeedsApproval, type RuleStatus } from "../schema/rule";
import type { GateResult, Rule } from "../schema/rules";
import type { AnyPack } from "../schema/pack";
import { getPack, renderRuleLine } from "../packs/index";
import { readSettings } from "../config";
import { writeEvent } from "../events";
import { inTransaction } from "../ledger";
import { services, type LaneServices, type RollbackRuleInput, type RollbackRuleResult } from "../interfaces";
import { runGate } from "./gate";
import { validateRule } from "./grammar";
import { listExamples } from "./examples";

/**
 * The rule lifecycle (U9 approach step 3, KTD10, R21 to R23).
 *
 *   candidate -> rejected          fails the test gate or a hard bound
 *   candidate -> active            passes, action is flag or ask_more (the promoter activates)
 *   candidate -> pending_approval  passes, action is reject or hold_payout (the promoter suspends)
 *   candidate -> superseded        the parent is no longer the active version
 *   pending_approval -> active     approval recorded, promoter resumed
 *   pending_approval -> rejected   a human declines
 *   active -> retired              replaced by a child version
 *   active -> rolled_back          operator rollback or demo reset
 *
 * Every version keeps its parent, reason, evidence and test results (R23). Activation refuses a
 * reject or hold_payout candidate unless its approval is approved, is idempotent, requires the
 * parent to still be active, retires the parent, and publishes a new contract version for
 * every challenge of the type through U6's `contracts.publishForType`.
 */

export const OPEN_RULE_STATUSES: readonly RuleStatus[] = ["candidate", "pending_approval"];

export interface LifecycleOptions {
  now?: Date;
  /** Defaults to the registered pack for the rule's challenge type. */
  pack?: AnyPack;
}

export interface ContractVersion {
  challenge_id: Id;
  version: number;
}

export async function getRule(db: Db, ruleId: Id): Promise<Rule | null> {
  return collections(db).rules.findOne({ _id: ruleId });
}

/** The type's active rules, read fresh (KTD7). */
export async function activeRules(db: Db, challengeType: ChallengeType): Promise<Rule[]> {
  return collections(db).rules.find({ challenge_type: challengeType, status: "active" }).sort({ rule_key: 1 }).toArray();
}

/** An open candidate (candidate or pending approval) for the same type and cheat class (KTD20). */
export async function openCandidateFor(
  db: Db,
  challengeType: ChallengeType,
  cheatClass: string,
  excludeIds: readonly Id[] = [],
): Promise<Rule | null> {
  return collections(db).rules.findOne({
    challenge_type: challengeType,
    cheat_class: cheatClass,
    status: { $in: [...OPEN_RULE_STATUSES] },
    ...(excludeIds.length > 0 ? { _id: { $nin: [...excludeIds] } } : {}),
  });
}

function defaultRuleKey(cheatClass: string): string {
  return `learned-${cheatClass}`.replace(/_/g, "-").slice(0, 64);
}

/**
 * Store a rule-writer proposal as a candidate (rule-lab's propose call). Lane assigns the key,
 * the version (one above the highest for the key) and the parent version. A proposal with no
 * parent whose key is already active is treated as a change to that active version.
 */
export async function proposeRule(db: Db, proposal: unknown, opts: LifecycleOptions = {}): Promise<Outcome<{ rule: Rule }>> {
  // U4's grammar: shape, the pack's feature catalog, allowed operators, value types and hard bounds.
  const type = ChallengeTypeSchema.safeParse((proposal as { challenge_type?: unknown } | null)?.challenge_type);
  if (!type.success) {
    return fail("invalid_input", "Invalid rule proposal: challenge_type is missing or unknown.", "Send the challenge type the rule is for.");
  }
  const validated = validateRule(proposal, opts.pack ?? getPack(type.data));
  if (!validated.ok) {
    const issues = validated.issues.slice(0, 3).map((i) => `${i.path || "root"}: ${i.message}`).join("; ");
    return fail(
      "invalid_input",
      `Invalid rule proposal: ${issues}`.slice(0, 300),
      "Send a proposal that matches the rule grammar and the pack's predicate catalog and hard bounds.",
    );
  }
  const p = validated.value;
  const now = opts.now ?? new Date();
  const col = collections(db).rules;

  let ruleKey: string;
  let parentVersion: number | null;
  if (p.parent) {
    const parent = await col.findOne({ challenge_type: p.challenge_type, rule_key: p.parent.rule_key, version: p.parent.version });
    if (!parent) {
      return fail(
        "not_found",
        `Parent rule ${p.parent.rule_key} v${p.parent.version} does not exist for ${p.challenge_type}.`,
        "Read the rule set and link an existing version, or send parent null for a new rule.",
      );
    }
    ruleKey = parent.rule_key;
    parentVersion = parent.version;
  } else {
    ruleKey = p.rule_key ?? defaultRuleKey(p.cheat_class);
    const current = await col.findOne({ challenge_type: p.challenge_type, rule_key: ruleKey, status: "active" });
    parentVersion = current?.version ?? null;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = await col.find({ challenge_type: p.challenge_type, rule_key: ruleKey }).sort({ version: -1 }).limit(1).next();
    const rule: Rule = {
      _id: newId("rule"),
      rule_key: ruleKey,
      version: (latest?.version ?? 0) + 1,
      parent_version: parentVersion,
      challenge_type: p.challenge_type,
      when: p.when,
      action: p.action,
      cheat_class: p.cheat_class,
      reason: p.reason,
      source: p.source,
      evidence: p.evidence,
      status: "candidate",
      test_results: null,
      approval_id: null,
      created_at: now,
      updated_at: now,
      activated_at: null,
      retired_at: null,
    };
    try {
      await col.insertOne(rule);
    } catch (err) {
      if (isDuplicateKeyError(err)) continue;
      throw err;
    }
    await writeEvent(db, {
      kind: "rule.proposed",
      summary: `Candidate ${rule.rule_key} v${rule.version} proposed for ${rule.challenge_type} (${rule.action}).`,
      challenge_type: rule.challenge_type,
      rule_key: rule.rule_key,
      rule_version: rule.version,
      data: { rule_id: rule._id, cheat_class: rule.cheat_class, source: rule.source },
      at: now,
    });
    return { ok: true, rule };
  }
  return fail("conflict", "Could not allocate a rule version after several tries.", "Retry the proposal.");
}

/**
 * Run the test gate on a candidate and store the result on it (R21, R23). A failing candidate
 * becomes rejected; a passing one stays a candidate until the promoter acts. Testing an
 * already-tested rule returns the stored result without re-running.
 */
export async function testCandidate(
  db: Db,
  candidateId: Id,
  opts: LifecycleOptions = {},
): Promise<Outcome<{ rule: Rule; gate: GateResult }>> {
  const now = opts.now ?? new Date();
  const col = collections(db).rules;
  const rule = await col.findOne({ _id: candidateId });
  if (!rule) return fail("not_found", `Candidate ${candidateId} does not exist.`, "Propose the rule first, then test the id it returns.");
  if (rule.test_results) return { ok: true, rule, gate: rule.test_results };
  if (rule.status !== "candidate") {
    return fail("not_allowed", `Rule ${rule.rule_key} v${rule.version} is ${rule.status} and cannot be tested.`, "Propose a new candidate.");
  }

  const pack = opts.pack ?? getPack(rule.challenge_type);
  const [settings, active, examples] = await Promise.all([
    readSettings(db),
    activeRules(db, rule.challenge_type),
    listExamples(db, rule.challenge_type),
  ]);
  const gate = runGate({
    candidate: { rule_key: rule.rule_key, version: rule.version, when: rule.when, action: rule.action, cheat_class: rule.cheat_class },
    active,
    examples,
    pack,
    thresholds: settings.gate,
    now,
  });
  const status: RuleStatus = gate.passed ? "candidate" : "rejected";
  const updated = await col.findOneAndUpdate(
    { _id: rule._id, status: "candidate", test_results: null },
    { $set: { test_results: gate, status, updated_at: now } },
    { returnDocument: "after" },
  );
  if (!updated) {
    // Another test call stored its result first; return what is stored.
    const stored = await col.findOne({ _id: rule._id });
    if (stored?.test_results) return { ok: true, rule: stored, gate: stored.test_results };
    return fail("conflict", "The candidate changed while it was being tested.", "Read the candidate and retry.");
  }
  await writeEvent(db, {
    kind: gate.passed ? "rule.tested" : "rule.rejected",
    summary: gate.passed
      ? `Candidate ${rule.rule_key} v${rule.version} passed the test gate: ${(gate.catch_rate_before * 100).toFixed(0)}% to ${(gate.catch_rate_after * 100).toFixed(0)}% caught, ${(gate.false_alarm_rule * 100).toFixed(1)}% false alarms.`
      : `Candidate ${rule.rule_key} v${rule.version} failed the test gate.`,
    challenge_type: rule.challenge_type,
    rule_key: rule.rule_key,
    rule_version: rule.version,
    data: {
      rule_id: rule._id,
      passed: gate.passed,
      catch_rate_before: gate.catch_rate_before,
      catch_rate_after: gate.catch_rate_after,
      false_alarm_rule: gate.false_alarm_rule,
      false_alarm_set: gate.false_alarm_set,
    },
    at: now,
  });
  return { ok: true, rule: updated, gate };
}

/** The promoter suspended on this candidate: it now waits for the human approval. */
export async function markPendingApproval(db: Db, candidateId: Id, approvalId: Id, now: Date = new Date()): Promise<Rule | null> {
  const updated = await collections(db).rules.findOneAndUpdate(
    { _id: candidateId, status: "candidate" },
    { $set: { status: "pending_approval", approval_id: approvalId, updated_at: now } },
    { returnDocument: "after" },
  );
  if (updated) {
    await writeEvent(db, {
      kind: "rule.pending_approval",
      summary: `Candidate ${updated.rule_key} v${updated.version} waits for approval because it would ${updated.action === "reject" ? "reject proof" : "hold a payout"}.`,
      challenge_type: updated.challenge_type,
      rule_key: updated.rule_key,
      rule_version: updated.version,
      data: { rule_id: updated._id, approval_id: approvalId },
      at: now,
    });
    return updated;
  }
  return getRule(db, candidateId);
}

export interface ActivateInput {
  candidate_id: Id;
  execution_id?: string;
  by: string;
}

export type ActivateResult = Outcome<{
  rule: Rule;
  status: RuleStatus;
  /** Contract versions this call published; empty when the rule was already active or superseded. */
  contracts: ContractVersion[];
  already_active: boolean;
}>;

/**
 * Activate a candidate (KTD10). Refuses a reject or hold_payout candidate without an approved
 * approval record and any candidate that has not passed the gate. Idempotent: activating an
 * active rule succeeds without publishing a new contract version. If the parent is no longer
 * the active version, the candidate is marked superseded.
 */
export async function activateRule(db: Db, input: ActivateInput, opts: LifecycleOptions = {}): Promise<ActivateResult> {
  const now = opts.now ?? new Date();
  const col = collections(db);
  const rule = await col.rules.findOne({ _id: input.candidate_id });
  if (!rule) return fail("not_found", `Candidate ${input.candidate_id} does not exist.`, "Read the candidate id from the invoke payload.");
  if (rule.status === "active") return { ok: true, rule, status: "active", contracts: [], already_active: true };
  if (!OPEN_RULE_STATUSES.includes(rule.status)) {
    return fail("not_allowed", `Rule ${rule.rule_key} v${rule.version} is ${rule.status} and cannot be activated.`, "Only a candidate or a rule pending approval can be activated.");
  }
  if (!rule.test_results?.passed) {
    return fail("not_allowed", `Rule ${rule.rule_key} v${rule.version} has not passed the test gate.`, "Test the candidate first; only a passing candidate can be activated.");
  }
  let approvalId: Id | null = rule.approval_id;
  if (actionNeedsApproval(rule.action)) {
    const approval = await col.approvals.findOne({ kind: "rule", rule_id: rule._id, status: "approved" });
    if (!approval) {
      return fail(
        "not_allowed",
        `Rule ${rule.rule_key} v${rule.version} would ${rule.action === "reject" ? "reject proof" : "hold a payout"} and has no approved approval record.`,
        "Suspend for human approval; activation is allowed only after a person approves on the dashboard.",
      );
    }
    approvalId = approval._id;
  }

  const outcome = await inTransaction(db, async (session) => {
    const fresh = await col.rules.findOne({ _id: rule._id }, { session });
    if (!fresh) return { status: "missing" as const };
    if (fresh.status === "active") return { status: "already_active" as const, rule: fresh };
    if (!OPEN_RULE_STATUSES.includes(fresh.status)) return { status: "closed" as const, rule: fresh };
    const current = await col.rules.findOne(
      { challenge_type: fresh.challenge_type, rule_key: fresh.rule_key, status: "active" },
      { session },
    );
    const parentOk = fresh.parent_version === null ? current === null : current?.version === fresh.parent_version;
    if (!parentOk) {
      await col.rules.updateOne(
        { _id: fresh._id, status: { $in: [...OPEN_RULE_STATUSES] } },
        { $set: { status: "superseded", updated_at: now } },
        { session },
      );
      return { status: "superseded" as const, rule: { ...fresh, status: "superseded" as const, updated_at: now } };
    }
    if (current) {
      await col.rules.updateOne(
        { _id: current._id, status: "active" },
        { $set: { status: "retired", retired_at: now, updated_at: now } },
        { session },
      );
    }
    const activated = await col.rules.findOneAndUpdate(
      { _id: fresh._id, status: { $in: [...OPEN_RULE_STATUSES] } },
      { $set: { status: "active", activated_at: now, updated_at: now, approval_id: approvalId } },
      { session, returnDocument: "after" },
    );
    if (!activated) throw new Error("candidate changed during activation");
    return { status: "activated" as const, rule: activated, retired: current };
  });

  if (outcome.status === "missing") return fail("not_found", `Candidate ${input.candidate_id} does not exist.`, "Read the candidate id from the invoke payload.");
  if (outcome.status === "already_active") return { ok: true, rule: outcome.rule, status: "active", contracts: [], already_active: true };
  if (outcome.status === "closed") {
    return fail("not_allowed", `Rule ${outcome.rule.rule_key} v${outcome.rule.version} is ${outcome.rule.status} and cannot be activated.`, "Only a candidate or a rule pending approval can be activated.");
  }
  if (outcome.status === "superseded") {
    await writeEvent(db, {
      kind: "rule.superseded",
      summary: `Candidate ${rule.rule_key} v${rule.version} was superseded because its parent is no longer active.`,
      challenge_type: rule.challenge_type,
      rule_key: rule.rule_key,
      rule_version: rule.version,
      data: { rule_id: rule._id },
      at: now,
    });
    return { ok: true, rule: outcome.rule, status: "superseded", contracts: [], already_active: false };
  }

  const pack = opts.pack ?? getPack(rule.challenge_type);
  const line = renderRuleLine(pack, outcome.rule);
  await writeEvent(db, {
    kind: "rule.activated",
    summary: `Rule ${rule.rule_key} v${rule.version} is active: ${line}`,
    challenge_type: rule.challenge_type,
    rule_key: rule.rule_key,
    rule_version: rule.version,
    data: {
      rule_id: rule._id,
      action: rule.action,
      retired_version: outcome.retired?.version ?? null,
      approval_id: approvalId,
      by: input.by.slice(0, 64),
    },
    at: now,
  });
  const contracts = await publishSafely(db, {
    challenge_type: rule.challenge_type,
    reason: "rule_activated",
    changes: [line],
    now,
    rule_key: rule.rule_key,
    rule_version: rule.version,
  });
  return { ok: true, rule: outcome.rule, status: "active", contracts, already_active: false };
}

/**
 * Publish a new contract version for every challenge of the type (U6). The rule already
 * applies on the server (KTD7), so a publish failure is recorded as an event and never undoes
 * the rule change.
 */
async function publishSafely(
  db: Db,
  input: { challenge_type: ChallengeType; reason: string; changes: string[]; now: Date; rule_key: string; rule_version: number },
): Promise<ContractVersion[]> {
  try {
    const res = await services().contracts.publishForType(db, {
      challenge_type: input.challenge_type,
      reason: input.reason,
      changes: input.changes,
      now: input.now,
    });
    return res.contracts.map((c) => ({ challenge_id: c.challenge_id, version: c.version }));
  } catch (err) {
    await writeEvent(db, {
      kind: "rule.publish_failed",
      summary: `Contract versions for ${input.challenge_type} were not published after ${input.reason}.`,
      challenge_type: input.challenge_type,
      rule_key: input.rule_key,
      rule_version: input.rule_version,
      data: { error: (err instanceof Error ? err.name : "Error").slice(0, 200) },
      at: input.now,
    });
    return [];
  }
}

export interface RejectInput {
  candidate_id: Id;
  reason?: string;
  by: string;
}

/** Reject a candidate or a rule pending approval. Idempotent for an already-rejected rule. */
export async function rejectCandidate(
  db: Db,
  input: RejectInput,
  opts: LifecycleOptions = {},
): Promise<Outcome<{ rule: Rule; status: RuleStatus }>> {
  const now = opts.now ?? new Date();
  const col = collections(db).rules;
  const updated = await col.findOneAndUpdate(
    { _id: input.candidate_id, status: { $in: [...OPEN_RULE_STATUSES] } },
    { $set: { status: "rejected", updated_at: now } },
    { returnDocument: "after" },
  );
  if (updated) {
    await writeEvent(db, {
      kind: "rule.rejected",
      summary: `Candidate ${updated.rule_key} v${updated.version} was rejected.`,
      challenge_type: updated.challenge_type,
      rule_key: updated.rule_key,
      rule_version: updated.version,
      data: { rule_id: updated._id, by: input.by.slice(0, 64) },
      at: now,
    });
    return { ok: true, rule: updated, status: "rejected" };
  }
  const rule = await col.findOne({ _id: input.candidate_id });
  if (!rule) return fail("not_found", `Candidate ${input.candidate_id} does not exist.`, "Read the candidate id from the invoke payload.");
  if (rule.status === "rejected") return { ok: true, rule, status: "rejected" };
  return fail("not_allowed", `Rule ${rule.rule_key} v${rule.version} is ${rule.status} and cannot be rejected.`, "Only a candidate or a rule pending approval can be rejected.");
}

/**
 * Roll back the active version of a rule key: it becomes rolled_back and its parent becomes
 * active again, or the key leaves the active set when there is no parent. Publishes a new
 * contract version for every challenge of the type.
 */
export async function rollbackRule(db: Db, input: RollbackRuleInput): Promise<RollbackRuleResult> {
  const now = input.now ?? new Date();
  const col = collections(db).rules;
  const outcome = await inTransaction(db, async (session) => {
    const current = await col.findOne(
      { challenge_type: input.challenge_type, rule_key: input.rule_key, status: "active" },
      { session },
    );
    if (!current) return null;
    await col.updateOne(
      { _id: current._id, status: "active" },
      { $set: { status: "rolled_back", retired_at: now, updated_at: now } },
      { session },
    );
    let restored: RuleRef | null = null;
    if (current.parent_version !== null) {
      const parent = await col.findOneAndUpdate(
        {
          challenge_type: current.challenge_type,
          rule_key: current.rule_key,
          version: current.parent_version,
          status: { $in: ["retired", "rolled_back"] },
        },
        { $set: { status: "active", activated_at: now, retired_at: null, updated_at: now } },
        { session, returnDocument: "after" },
      );
      if (parent) restored = { rule_key: parent.rule_key, version: parent.version };
    }
    return { current, restored };
  });
  if (!outcome) {
    return fail("not_found", `No active version of ${input.rule_key} for ${input.challenge_type}.`, "Pick a rule key that is active.");
  }
  await writeEvent(db, {
    kind: "rule.rolled_back",
    summary: outcome.restored
      ? `Rule ${input.rule_key} rolled back from v${outcome.current.version} to v${outcome.restored.version}.`
      : `Rule ${input.rule_key} v${outcome.current.version} rolled back; no earlier version is active.`,
    challenge_type: input.challenge_type,
    rule_key: input.rule_key,
    rule_version: outcome.current.version,
    data: { restored_version: outcome.restored?.version ?? null, by: input.by.slice(0, 64) },
    at: now,
  });
  const contracts = await publishSafely(db, {
    challenge_type: input.challenge_type,
    reason: "rule_rolled_back",
    changes: [],
    now,
    rule_key: input.rule_key,
    rule_version: outcome.current.version,
  });
  return { ok: true, restored: outcome.restored, contracts };
}

/** U9's `lifecycle` service, for the composition root's `provideServices`. */
export const lifecycleService: LaneServices["lifecycle"] = {
  rollback: (db, input) => rollbackRule(db, input),
};
