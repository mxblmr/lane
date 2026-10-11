/**
 * Services for U13's tests. U6 (players, challenges, contracts) is real. U9 (rollback and rule
 * approvals) and U18 (inbox add and expiry) are doubles that keep real state in the test database
 * with U3's schemas, until those units merge. Test helper only.
 */
import { provideServices, services, type LaneServices } from "@lane/core/interfaces";
import { challengesService } from "@lane/core/challenges";
import { contractsService } from "@lane/core/contracts";
import { playersService } from "@lane/core/players";
import { collections, isDuplicateKeyError } from "@lane/core/schema/collections";
import { fail, newId } from "@lane/core/schema/common";
import type { InboxItem } from "@lane/core/schema/inbox";
import type { Rule } from "@lane/core/schema/rules";
import type { RuleApproval } from "@lane/core/schema/approvals";
import type { Db } from "../stage";

export interface DoubleCalls {
  rollback: number;
  decide: number;
  expire: number;
  inbox_add: number;
}

export function upstreamDoubles(calls: DoubleCalls = { rollback: 0, decide: 0, expire: 0, inbox_add: 0 }) {
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
    const { contracts } = await services().contracts.publishForType(db, { challenge_type: input.challenge_type, reason: "rule_rolled_back" });
    return { ok: true, restored, contracts };
  };

  /** Rule approvals only. Approve activates the rule and publishes a contract; decline rejects it. */
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
      await services().contracts.publishForType(db, { challenge_type: rule.challenge_type, reason: "rule_activated" });
      return { ok: true, approval, decided: true, follow_up, rule_status: "active" };
    }
    await col.rules.updateOne({ _id: rule._id }, { $set: { status: "rejected" } });
    return { ok: true, approval, decided: true, follow_up, rule_status: "rejected" };
  };

  const add: LaneServices["inbox"]["add"] = async (db, item, opts) => {
    calls.inbox_add += 1;
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
      await collections(db).inbox.insertOne(doc, { session: opts?.session });
      return { item: doc, created: true };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      return { item: doc, created: false };
    }
  };

  const expire: LaneServices["inbox"]["expire"] = async (db, input) => {
    calls.expire += 1;
    const col = collections(db);
    const filter = {
      status: "open" as const,
      ...(input.challenge_id ? { challenge_id: input.challenge_id } : {}),
      ...(input.item_ids ? { _id: { $in: input.item_ids } } : {}),
    };
    const items: InboxItem[] = await col.inbox.find(filter).toArray();
    await col.inbox.updateMany(filter, { $set: { status: "expired", updated_at: input.now } });
    return { expired: items };
  };

  provideServices({
    players: playersService,
    challenges: challengesService,
    contracts: contractsService,
    lifecycle: { rollback },
    approvals: { decide },
    inbox: { add, expire },
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

/** Environment a seed test needs: Lane keys plus GitHub logins and Threads handles. Test values only. */
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
