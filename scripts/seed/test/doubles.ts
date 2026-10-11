/**
 * Test doubles for the upstream units U13 calls through U3's interfaces: U6 (confirm, join,
 * publish), U9 (rollback, approvals) and U18 (inbox expiry). They keep real state in the test
 * database with the U3 schemas, so the seed, the reset and the stage runner can be tested end to
 * end before those units merge. Test helper only.
 */
import { randomInt } from "node:crypto";
import { appendLedgerEntry } from "@lane/core/ledger";
import { provideServices, type LaneServices } from "@lane/core/interfaces";
import { collections, isDuplicateKeyError } from "@lane/core/schema/collections";
import { fail, newId, type ChallengeType } from "@lane/core/schema/common";
import type { Challenge } from "@lane/core/schema/challenges";
import type { Contract } from "@lane/core/schema/contracts";
import type { Membership } from "@lane/core/schema/memberships";
import type { InboxItem } from "@lane/core/schema/inbox";
import type { Rule } from "@lane/core/schema/rules";
import type { RuleApproval } from "@lane/core/schema/approvals";
import { demoClockSettings, realClockSettings, windowEnd } from "@lane/core/clock";
import { getPack, renderRuleLine } from "@lane/core/packs";
import { PLAY_CREDIT_LABEL, QUIET_HOURS } from "@lane/core/config";
import type { Db } from "../stage";

const TERMS_VERSION = "terms-v1";

export interface DoubleCalls {
  confirm: number;
  join: number;
  publish: number;
  rollback: number;
  decide: number;
  expire: number;
}

async function insertContract(db: Db, challenge: Challenge, version: number, reason: string): Promise<Contract> {
  const col = collections(db);
  const pack = getPack(challenge.type);
  const rules = await col.rules.find({ challenge_type: challenge.type, status: "active" }).sort({ rule_key: 1 }).toArray();
  const clock = challenge.clock!;
  const contract: Contract = {
    _id: newId("contract"),
    challenge_id: challenge._id,
    version,
    fields: {
      challenge_type: challenge.type,
      title: challenge.title,
      goal: challenge.goal!,
      score_unit: pack.scoreUnit,
      window: { start_at: clock.start_at, end_at: windowEnd(clock), days: clock.days, day_length_sec: clock.day_length_sec },
      stake: challenge.stake!,
      winner_rule: challenge.winner_rule!,
      credit_label: PLAY_CREDIT_LABEL,
      checkin: { interval_min: 27, surprise_checks_per_day: 3, quiet_hours: QUIET_HOURS, grace_sec: clock.grace_sec },
      send: ["send"],
      scoring: "scoring",
      extra_proof: [],
      params: challenge.params,
    },
    agent_instructions: "instructions",
    does_not_count: rules.map((r) => ({ rule_key: r.rule_key, rule_version: r.version, line: renderRuleLine(pack, r) })),
    built_from_rules: rules.map((r) => ({ rule_key: r.rule_key, version: r.version })),
    reason,
    changes: [reason],
    created_at: new Date(),
  };
  await col.contracts.insertOne(contract);
  return contract;
}

async function joinPlayer(db: Db, challenge: Challenge, playerId: string, now: Date) {
  const col = collections(db);
  const membership: Membership = {
    _id: newId("membership"),
    challenge_id: challenge._id,
    player_id: playerId,
    accepted_terms_version: TERMS_VERSION,
    handle_platform: getPack(challenge.type).handlePlatform(challenge),
    joined_at: now,
    joined_day_index: 0,
    last_check_in_at: null,
    last_seen_contract_version: challenge.contract_version,
  };
  try {
    await col.memberships.insertOne(membership);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // A concurrent join committed first (KTD6).
  }
  const stake = await appendLedgerEntry(db, { player_id: playerId, challenge_id: challenge._id, kind: "stake", amount: challenge.stake! }, { now });
  if (!stake.ok) throw new Error(stake.error.message);
  return { membership, stake_entry: stake.entry };
}

async function publishForType(db: Db, type: ChallengeType, reason: string): Promise<{ challenge_id: string; version: number }[]> {
  const col = collections(db);
  const out: { challenge_id: string; version: number }[] = [];
  for (const c of await col.challenges.find({ type, status: "active" }).toArray()) {
    const updated = await col.challenges.findOneAndUpdate({ _id: c._id }, { $inc: { contract_version: 1 } }, { returnDocument: "after" });
    await insertContract(db, updated!, updated!.contract_version, reason);
    out.push({ challenge_id: c._id, version: updated!.contract_version });
  }
  return out;
}

export function upstreamDoubles(calls: DoubleCalls = { confirm: 0, join: 0, publish: 0, rollback: 0, decide: 0, expire: 0 }) {
  const confirm: LaneServices["challenges"]["confirm"] = async (db, input) => {
    calls.confirm += 1;
    const now = input.now ?? new Date();
    const col = collections(db);
    const draft = await col.challenges.findOne({ _id: input.draft_id });
    if (!draft) return fail("not_found", "no draft", "create one");
    const ext = input as typeof input & { clock?: { mode: "real" | "demo" } };
    if (draft.status === "draft") {
      const joinCode = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomInt(32)]).join("");
      const clock = ext.clock?.mode === "demo" ? demoClockSettings(now, { days: draft.clock!.days }) : realClockSettings(now, draft.clock!.days);
      const res = await col.challenges.updateOne(
        { _id: draft._id, status: "draft" },
        { $set: { status: "active", join_code: joinCode, stake: input.stake, winner_rule: input.winner_rule, clock, contract_version: 1, activated_at: now } },
      );
      if (res.modifiedCount === 1) {
        const active = (await col.challenges.findOne({ _id: draft._id }))!;
        await insertContract(db, active, 1, "created");
        await joinPlayer(db, active, input.player_id, now);
      }
    }
    const challenge = (await col.challenges.findOne({ _id: draft._id }))!;
    if (challenge.status !== "active") return fail("conflict", "not active", "start again");
    // A concurrent confirm may still be writing the contract and the creator's stake.
    for (let i = 0; i < 50 && !(await col.ledger.findOne({ challenge_id: challenge._id, player_id: input.player_id, kind: "stake" })); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const membership = (await col.memberships.findOne({ challenge_id: challenge._id, player_id: input.player_id }))!;
    const contract = (await col.contracts.find({ challenge_id: challenge._id }).sort({ version: -1 }).next())!;
    const stake = (await col.ledger.findOne({ challenge_id: challenge._id, player_id: input.player_id, kind: "stake" }))!;
    return { ok: true, challenge, join_code: challenge.join_code!, membership, contract, stake_entry: stake };
  };

  const join: LaneServices["challenges"]["join"] = async (db, input) => {
    calls.join += 1;
    const now = input.now ?? new Date();
    const col = collections(db);
    const challenge = await col.challenges.findOne({ join_code: input.join_code });
    if (!challenge) return fail("not_found", "no challenge", "check the code");
    const existing = await col.memberships.findOne({ challenge_id: challenge._id, player_id: input.player_id });
    const contract = (await col.contracts.find({ challenge_id: challenge._id }).sort({ version: -1 }).next())!;
    if (existing) {
      const stake = (await col.ledger.findOne({ challenge_id: challenge._id, player_id: input.player_id, kind: "stake" }))!;
      return { ok: true, phase: "joined", challenge, membership: existing, contract, stake_entry: stake, bind_action: null, already_member: true };
    }
    if (challenge.status !== "active") return fail("window_closed", "not active", "start a new one");
    if (!input.accepted_terms_version) {
      return {
        ok: true,
        phase: "terms",
        challenge_id: challenge._id,
        terms: {
          terms_version: TERMS_VERSION,
          lines: [],
          stake: challenge.stake!,
          winner_rule: challenge.winner_rule!,
          window: { start_at: challenge.clock!.start_at, end_at: windowEnd(challenge.clock!), days: challenge.clock!.days },
          checkin: contract.fields.checkin,
          handle_platform: getPack(challenge.type).handlePlatform(challenge),
          credit_label: PLAY_CREDIT_LABEL,
        },
      };
    }
    const { membership, stake_entry } = await joinPlayer(db, challenge, input.player_id, now);
    return { ok: true, phase: "joined", challenge, membership, contract, stake_entry, bind_action: null, already_member: false };
  };

  const publishForTypeSvc: LaneServices["contracts"]["publishForType"] = async (db, input) => {
    calls.publish += 1;
    return { contracts: await publishForType(db, input.challenge_type, input.reason) };
  };

  const rollback: LaneServices["lifecycle"]["rollback"] = async (db, input) => {
    calls.rollback += 1;
    const col = collections(db);
    const active = await col.rules.findOne({ challenge_type: input.challenge_type, rule_key: input.rule_key, status: "active" });
    if (!active) return fail("not_found", "no active rule", "nothing to roll back");
    await col.rules.updateOne({ _id: active._id, status: "active" }, { $set: { status: "rolled_back", retired_at: new Date() } });
    let restored = null;
    if (active.parent_version !== null) {
      await col.rules.updateOne(
        { challenge_type: input.challenge_type, rule_key: input.rule_key, version: active.parent_version },
        { $set: { status: "active" } },
      );
      restored = { rule_key: input.rule_key, version: active.parent_version };
    }
    const contracts = await publishForType(db, input.challenge_type, "rule_rolled_back");
    return { ok: true, restored, contracts };
  };

  /** Rule approvals only. Approve activates the rule and publishes; decline rejects it. */
  const decide: LaneServices["approvals"]["decide"] = async (db, input) => {
    calls.decide += 1;
    const col = collections(db);
    const status = input.decision === "approve" ? "approved" : "declined";
    const updated = await col.approvals.findOneAndUpdate(
      { _id: input.approval_id, status: "pending" },
      { $set: { status, decided_by: input.decided_by, decided_at: input.now ?? new Date() } },
      { returnDocument: "after" },
    );
    const approval = (updated ?? (await col.approvals.findOne({ _id: input.approval_id }))) as RuleApproval | null;
    if (!approval) return fail("not_found", "no approval", "check the id");
    const follow_up = { status: "ok" as const, attempts: 1, error: null };
    if (!updated) return { ok: true, approval, decided: false, follow_up, rule_status: null };
    const rule = (await col.rules.findOne({ _id: approval.rule_id }))!;
    if (input.decision === "approve") {
      if (rule.parent_version !== null) {
        await col.rules.updateOne(
          { challenge_type: rule.challenge_type, rule_key: rule.rule_key, version: rule.parent_version, status: "active" },
          { $set: { status: "retired" } },
        );
      }
      await col.rules.updateOne({ _id: rule._id }, { $set: { status: "active", activated_at: new Date() } });
      await publishForType(db, rule.challenge_type, "rule_activated");
      return { ok: true, approval, decided: true, follow_up, rule_status: "active" };
    }
    await col.rules.updateOne({ _id: rule._id }, { $set: { status: "rejected" } });
    return { ok: true, approval, decided: true, follow_up, rule_status: "rejected" };
  };

  const expire: LaneServices["inbox"]["expire"] = async (db, input) => {
    calls.expire += 1;
    const col = collections(db);
    const filter = { status: "open" as const, ...(input.challenge_id ? { challenge_id: input.challenge_id } : {}) };
    const items: InboxItem[] = await col.inbox.find(filter).toArray();
    await col.inbox.updateMany(filter, { $set: { status: "expired", updated_at: input.now } });
    return { expired: items };
  };

  provideServices({
    challenges: { confirm, join },
    contracts: { publishForType: publishForTypeSvc },
    lifecycle: { rollback },
    approvals: { decide },
    inbox: { expire },
  });
  return calls;
}

/** Insert a rule document with schema defaults filled. */
export async function insertRule(db: Db, rule: Partial<Rule> & Pick<Rule, "rule_key" | "version" | "challenge_type" | "status" | "source">): Promise<Rule> {
  const now = new Date();
  const doc: Rule = {
    _id: newId("rule"),
    parent_version: null,
    when: { all: [{ feature: "rename_only", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "rename_only",
    reason: "test rule",
    evidence: { proof_ids: [], example_keys: [], dispute_ids: [] },
    test_results: null,
    approval_id: null,
    created_at: now,
    updated_at: now,
    activated_at: rule.status === "active" ? now : null,
    retired_at: null,
    ...rule,
  };
  await collections(db).rules.insertOne(doc);
  return doc;
}

/** A pending rule approval for a candidate rule, as U9 creates when the promoter suspends. */
export async function insertPendingApproval(db: Db, rule: Rule): Promise<RuleApproval> {
  const now = new Date();
  const approval: RuleApproval = {
    _id: newId("approval"),
    kind: "rule",
    status: "pending",
    decided_by: null,
    decided_at: null,
    created_at: now,
    updated_at: now,
    rule_id: rule._id,
    rule_key: rule.rule_key,
    rule_version: rule.version,
    challenge_type: rule.challenge_type,
    action: rule.action,
    execution_id: `exec_${rule._id}`,
    workspace_id: "ws_promoter",
    suspend_context: {},
    allowed_decisions: ["approve", "decline"],
    follow_up: { status: "not_started", attempts: 0, error: null },
    rule_status: null,
  };
  await collections(db).approvals.insertOne(approval);
  return approval;
}

/** Environment a seed test needs: Lane keys plus GitHub logins and Threads handles. */
export function seedEnv(): Record<string, string> {
  return {
    GARY_LANE_KEY: "lane_pk_test_gary_0123456789abcdef",
    PRIYA_LANE_KEY: "lane_pk_test_priya_0123456789abcdef",
    SAM_LANE_KEY: "lane_pk_test_sam_0123456789abcdef",
    GARY_GITHUB_LOGIN: "gary-lane-demo",
    PRIYA_GITHUB_LOGIN: "priya-lane-demo",
    SAM_GITHUB_LOGIN: "Sam-Lane-Demo",
    GARY_GITHUB_TOKEN: "test-token-gary",
    PRIYA_GITHUB_TOKEN: "test-token-priya",
    SAM_GITHUB_TOKEN: "test-token-sam",
    GARY_GITHUB_REPO: "gary-lane-demo/sandbox",
    PRIYA_GITHUB_REPO: "priya-lane-demo/sandbox",
    SAM_GITHUB_REPO: "Sam-Lane-Demo/sandbox",
    GARY_THREADS_HANDLE: "gary.builds",
    PRIYA_THREADS_HANDLE: "priya.builds",
    SAM_THREADS_HANDLE: "sam.builds",
  };
}
