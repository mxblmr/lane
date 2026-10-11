import type { Db } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pay, settle, settlementService } from "../../src/settlement/payout";
import { demoClockSettings, finalGraceEnd, manualClock, windowEnd } from "../../src/clock";
import { appendLedgerEntry, ledgerBalanceOf } from "../../src/ledger";
import { addInboxItem } from "../../src/inbox";
import { updateSettings } from "../../src/config";
import { runTick, runTickJobs, settlementJobHandler } from "../../src/tick";
import {
  provideServices,
  resetServices,
  services,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type LaneServices,
  type PayResult,
} from "../../src/interfaces";
import { collections } from "../../src/schema/collections";
import { fail, newId } from "../../src/schema/common";
import type { Challenge, WinnerRule } from "../../src/schema/challenges";
import { PayoutApprovalSchema, type PayoutApproval } from "../../src/schema/approvals";
import type { Player } from "../../src/schema/players";
import { VerdictSchema } from "../../src/schema/proofs";
import type { AgentWorkspace, OrchestratorSettleInput, OrchestratorSettleOutput } from "../../src/schema/agents";
import { startReplSet, type TestMongo } from "../../src/testing/mongo";
import { fixturePack } from "../fixtures/pack";
import { extraProofItem, seedChallenge, seedMembership, seedPlayer, seedProof } from "../helpers/u18-seed";

let mongo: TestMongo;
beforeAll(async () => {
  mongo = await startReplSet();
});
afterAll(async () => {
  await mongo?.stop();
});

const START = new Date("2026-10-11T20:00:00.000Z");
const at = (sec: number) => new Date(START.getTime() + sec * 1000);
// Demo clock: 300-second days, 90-second grace, three days.
const DEMO = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });
const SETTLE_AT = new Date(finalGraceEnd(DEMO).getTime() + 1000);

// ---------------------------------------------------------------- the world and the invariant

let current: { db: Db; challenge_id: string } | null = null;

beforeEach(() => {
  provideServices({ settlement: settlementService });
  useApprovalsDouble();
});

/** After every settlement test: payouts plus refunds equal the stakes, and every balance equals its ledger. */
async function expectBalanced(db: Db, challengeId: string): Promise<void> {
  const col = collections(db);
  const entries = await col.ledger.find({ challenge_id: challengeId }).toArray();
  const sum = (kinds: string[]) => entries.filter((e) => kinds.includes(e.kind)).reduce((s, e) => s + e.amount, 0);
  const challenge = await col.challenges.findOne({ _id: challengeId });
  expect(sum(["payout", "refund"]), "payouts plus refunds").toBe(challenge?.status === "settled" ? sum(["stake"]) : 0);
  for (const player of await col.players.find().toArray()) {
    expect(player.credits, `credits of ${player.display_name}`).toBe(await ledgerBalanceOf(db, player._id));
  }
}

afterEach(async () => {
  const done = current;
  current = null;
  resetServices();
  if (done) await expectBalanced(done.db, done.challenge_id);
});

interface WorldOpts {
  names?: string[];
  rule?: WinnerRule;
  stake?: number;
  goal?: number;
  status?: Challenge["status"];
  payoutLimit?: number;
}

/** Players registered through the ledger (a 1,000-credit grant) who each staked through the ledger. */
async function world(opts: WorldOpts = {}) {
  const db = await mongo.freshDb();
  await updateSettings(
    db,
    { surprise_checks_enabled: false, ...(opts.payoutLimit === undefined ? {} : { payout_limit: opts.payoutLimit }) },
    at(0),
  );
  const names = opts.names ?? ["Maya", "Priya", "Sam", "Gary"];
  const players: Player[] = [];
  for (const name of names) {
    const player = await seedPlayer(db, name);
    await collections(db).players.updateOne({ _id: player._id }, { $set: { credits: 0 } });
    const grant = await appendLedgerEntry(db, { player_id: player._id, challenge_id: null, kind: "grant", amount: 1000, ref: "registration" }, { now: at(0) });
    expect(grant.ok).toBe(true);
    players.push(player);
  }
  const seeded = await seedChallenge(db, { creator: players[0]!, clock: DEMO, status: opts.status ?? "settling", goal: opts.goal ?? 2 });
  const stake = opts.stake ?? 100;
  await collections(db).challenges.updateOne({ _id: seeded._id }, { $set: { winner_rule: opts.rule ?? "top_score", stake } });
  const challenge = (await collections(db).challenges.findOne({ _id: seeded._id }))!;
  for (const player of players) {
    await seedMembership(db, challenge, player);
    const staked = await appendLedgerEntry(db, { player_id: player._id, challenge_id: challenge._id, kind: "stake", amount: stake }, { now: at(1) });
    expect(staked.ok).toBe(true);
  }
  current = { db, challenge_id: challenge._id };
  const p = Object.fromEntries(players.map((pl) => [pl.display_name, pl])) as Record<string, Player>;
  return { db, challenge, p };
}

/** Accepted proofs for some days, received `offset` seconds into each day. */
async function counted(db: Db, challenge: Challenge, player: Player, days: number[], offset = 20) {
  const proofs = [];
  for (const day of days) proofs.push(await seedProof(db, { challenge, player, day_index: day, received_at: at(day * 300 + offset) }));
  return proofs;
}

async function credits(db: Db, player: Player): Promise<number> {
  return (await collections(db).players.findOne({ _id: player._id }))!.credits;
}

async function entriesOf(db: Db, challengeId: string, kind: "payout" | "refund") {
  const rows = await collections(db).ledger.find({ challenge_id: challengeId, kind }).toArray();
  return rows;
}

async function amountsByName(db: Db, challengeId: string, kind: "payout" | "refund"): Promise<Record<string, number>> {
  const rows = await entriesOf(db, challengeId, kind);
  const names = new Map((await collections(db).players.find().toArray()).map((pl) => [pl._id, pl.display_name]));
  return Object.fromEntries(rows.map((r) => [names.get(r.player_id), r.amount]));
}

// ---------------------------------------------------------------- doubles for U9 and U8

/** U9 double: payout approvals stored in `approvals`, decided by one conditional update, then pay as the follow-up. */
function useApprovalsDouble() {
  const calls = { created: 0, pays: [] as PayResult[] };
  provideServices({
    approvals: {
      create: async (db, input) => {
        if (input.kind !== "payout") throw new Error("only payout approvals are used here");
        const col = collections(db).approvals;
        const existing = await col.findOne({ kind: "payout", snapshot_id: input.snapshot_id });
        if (existing) return { approval: existing, created: false };
        const now = new Date();
        const approval: PayoutApproval = PayoutApprovalSchema.parse({
          _id: newId("approval"),
          kind: "payout",
          status: "pending",
          decided_by: null,
          decided_at: null,
          created_at: now,
          updated_at: now,
          challenge_id: input.challenge_id,
          snapshot_id: input.snapshot_id,
          snapshot: input.snapshot,
          follow_up: { status: "not_started", attempts: 0, error: null },
        });
        await col.insertOne(approval);
        calls.created += 1;
        return { approval, created: true };
      },
      decide: async (db, input) => {
        const col = collections(db).approvals;
        const now = input.now ?? new Date();
        const status = input.decision === "approve" ? "approved" : "declined";
        const decided = await col.findOneAndUpdate(
          { _id: input.approval_id, status: "pending" },
          { $set: { status, decided_by: input.decided_by, decided_at: now, updated_at: now } },
          { returnDocument: "after" },
        );
        const approval = decided ?? (await col.findOne({ _id: input.approval_id }));
        if (!approval || approval.kind !== "payout") return fail("not_found", "No such payout approval.", "Reload.");
        const paid = await services().settlement.pay(db, {
          challenge_id: approval.challenge_id,
          snapshot_id: approval.snapshot_id,
          decision: input.decision,
          now,
        });
        calls.pays.push(paid);
        return {
          ok: true,
          approval,
          decided: decided !== null,
          follow_up: { status: paid.ok ? "ok" : "failed", attempts: 1, error: paid.ok ? null : paid.error.message },
          rule_status: null,
        };
      },
    },
  });
  return calls;
}

async function decide(db: Db, approvalId: string, decision: "approve" | "decline") {
  return services().approvals.decide(db, { approval_id: approvalId, decision, decided_by: "operator", now: new Date(SETTLE_AT.getTime() + 60_000) });
}

/** U8 double: the orchestrator answers the settle call with `propose(input)`, or fails. */
function useOrchestrator(propose: (input: OrchestratorSettleInput) => OrchestratorSettleOutput | "fail" | "throw") {
  const inputs: OrchestratorSettleInput[] = [];
  const invoke = async <W extends AgentWorkspace>(call: AgentInvokeInput<W>): Promise<AgentInvokeResult<W>> => {
    const input = call.input as unknown as OrchestratorSettleInput;
    inputs.push(input);
    const answer = propose(input);
    if (answer === "throw") throw new Error("agent engine unreachable");
    if (answer === "fail") {
      return { ok: false, error: "timed out", schema_valid: true, timed_out: true, execution_id: null, latency_ms: 30_000 };
    }
    return { ok: true, status: "completed", output: answer, execution_id: "exec_1", latency_ms: 5 } as unknown as AgentInvokeResult<W>;
  };
  provideServices({ agents: { invoke: invoke as LaneServices["agents"]["invoke"] } });
  return inputs;
}

function holdVerdict() {
  return VerdictSchema.parse({
    outcome: "accept",
    decided_by: "rule",
    rule: { rule_key: "ship-week-hold", version: 1 },
    matched_rules: [{ rule_key: "ship-week-hold", version: 1, action: "hold_payout" }],
    evaluated_rules: [{ rule_key: "ship-week-hold", version: 1 }],
    contract_version: 1,
    ai_calls: 0,
    ai_judgment: false,
    latency_ms: 3,
    trust_level: "rechecked",
    payout_hold: true,
    reason: "Counts, but holds the payout for review.",
    fix: "",
    cheat_class: "rename_only",
    confidence: null,
    decided_at: at(330),
  });
}

/** AE6's world: Maya and Priya tie on two days each, Sam has one, Gary none; 4 x 100 = 400 credits. */
async function ae6World() {
  const w = await world();
  const { db, challenge, p } = w;
  await counted(db, challenge, p.Maya!, [0, 1], 20);
  await counted(db, challenge, p.Priya!, [0, 1], 40);
  await counted(db, challenge, p.Sam!, [0]);
  return w;
}

// ---------------------------------------------------------------- the U11 test scenarios

describe("settlement and payouts (U11, KTD12)", () => {
  it("covers AE6: Maya and Priya tie on top score in a 400-credit pot, each share of 200 is above the 150 limit, the payout waits for approval, and approving pays 200 each in one transaction", async () => {
    const { db, challenge, p } = await ae6World();
    const settled = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.status).toBe("awaiting_approval");
    expect(settled.snapshot).toMatchObject({ pot: 400, needs_approval: true, approval_reasons: ["over_limit"], refund_all: false });
    expect(settled.snapshot?.shares).toEqual(
      expect.arrayContaining([
        { player_id: p.Maya!._id, amount: 200 },
        { player_id: p.Priya!._id, amount: 200 },
      ]),
    );
    expect(settled.approval_id).toBeTruthy();
    expect(await entriesOf(db, challenge._id, "payout")).toEqual([]);
    const waiting = await collections(db).challenges.findOne({ _id: challenge._id });
    expect(waiting).toMatchObject({ status: "settling", settlement: { approval_id: settled.approval_id } });
    const approval = await collections(db).approvals.findOne({ _id: settled.approval_id! });
    expect(approval).toMatchObject({ kind: "payout", status: "pending", snapshot_id: settled.snapshot!.snapshot_id });

    const decided = await decide(db, settled.approval_id!, "approve");
    expect(decided).toMatchObject({ ok: true, decided: true, follow_up: { status: "ok" } });
    const paid = await collections(db).challenges.findOne({ _id: challenge._id });
    expect(paid?.status).toBe("settled");
    const payouts = await entriesOf(db, challenge._id, "payout");
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 200, Priya: 200 });
    expect(payouts.every((e) => e.ref === settled.snapshot!.snapshot_id)).toBe(true);
    expect(await credits(db, p.Maya!)).toBe(1100);
    expect(await credits(db, p.Sam!)).toBe(900);
    const events = await collections(db).events.find({ challenge_id: challenge._id, kind: "challenge.settled" }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatch(/400 play credits \(no real money\) paid to 2 player/);
  });

  it("pays in one transaction: a failed ledger write leaves no payouts and the challenge settling, and a retry pays once", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"] });
    await counted(db, challenge, p.Maya!, [0, 1]);
    await counted(db, challenge, p.Priya!, [0, 1]);
    let payouts = 0;
    provideServices({
      ledger: {
        append: async (d, input, opts) => {
          if (input.kind === "payout" && ++payouts === 2) return fail("internal", "Ledger write failed.", "Try again.");
          return appendLedgerEntry(d, input, opts);
        },
      },
    });
    const failed = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(await entriesOf(db, challenge._id, "payout")).toEqual([]);
    expect(await credits(db, p.Maya!)).toBe(900);
    expect((await collections(db).challenges.findOne({ _id: challenge._id }))?.status).toBe("settling");
    expect(await collections(db).events.countDocuments({ kind: "challenge.settled" })).toBe(0);

    provideServices({ ledger: { append: (d, input, opts) => appendLedgerEntry(d, input, opts) } });
    const retried = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(retried).toMatchObject({ ok: true, status: "paid" });
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 150, Priya: 150 });
  });

  it("a three-way top-score tie on a 400-credit pot pays 134, 133 and 133, with 134 to the earliest goal-reacher", async () => {
    const { db, challenge, p } = await world();
    await counted(db, challenge, p.Maya!, [0, 1], 20);
    await counted(db, challenge, p.Priya!, [0, 1], 10);
    await counted(db, challenge, p.Sam!, [0, 1], 30);
    await counted(db, challenge, p.Gary!, [0]);
    const inputs = useOrchestrator(() => ({
      shares: [
        { player_id: p.Priya!._id, amount: 134 },
        { player_id: p.Maya!._id, amount: 133 },
        { player_id: p.Sam!._id, amount: 133 },
      ],
      refund_all: false,
      note: "Three-way tie.",
    }));
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "paid", approval_id: null, snapshot: { orchestrator: "agreed", needs_approval: false } });
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Priya: 134, Maya: 133, Sam: 133 });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ mode: "settle", challenge_id: challenge._id, winner_rule: "top_score", unit: "days", pot: 400, payout_limit: 150 });
  });

  it("under the finishers-split rule with three finishers of four on a 400-credit pot, the finishers get 134, 133 and 133", async () => {
    const { db, challenge, p } = await world({ rule: "finishers_split", goal: 2 });
    await counted(db, challenge, p.Maya!, [0, 1, 2], 20);
    await counted(db, challenge, p.Priya!, [0, 1], 10);
    await counted(db, challenge, p.Sam!, [0, 1], 30);
    await counted(db, challenge, p.Gary!, [0]);
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    // U8 is not wired in this test, so the stub's NotImplementedError counts as an orchestrator error.
    expect(result).toMatchObject({ ok: true, status: "paid", snapshot: { orchestrator: "error" } });
    // Priya reached her final counted score first (day 1 at 310 s); Maya's came on day 2.
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Priya: 134, Maya: 133, Sam: 133 });
  });

  it("under the top-score rule, leaders who finish below the goal still split the pot", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"], goal: 3 });
    await counted(db, challenge, p.Maya!, [0, 1]);
    await counted(db, challenge, p.Priya!, [1, 2]);
    await counted(db, challenge, p.Sam!, [2]);
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "paid" });
    if (!result.ok) return;
    expect(result.snapshot?.scores.every((s) => !s.reached_goal)).toBe(true);
    // 150 each is not above the 150 limit, so no approval is needed.
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 150, Priya: 150 });
  });

  it("under the top-score rule, when every score is zero, every stake is refunded", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"] });
    await seedProof(db, { challenge, player: p.Maya!, day_index: 0, status: "rejected", received_at: at(20) });
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "refunded", snapshot: { refund_all: true, needs_approval: false } });
    expect(await amountsByName(db, challenge._id, "refund")).toEqual({ Maya: 100, Priya: 100, Sam: 100 });
    expect(await entriesOf(db, challenge._id, "payout")).toEqual([]);
    for (const player of Object.values(p)) expect(await credits(db, player)).toBe(1000);
  });

  it("under the finishers-split rule, when nobody reaches the goal, every stake is refunded", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"], rule: "finishers_split", goal: 3 });
    await counted(db, challenge, p.Maya!, [0, 1]);
    await counted(db, challenge, p.Priya!, [0]);
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "refunded" });
    expect(await amountsByName(db, challenge._id, "refund")).toEqual({ Maya: 100, Priya: 100, Sam: 100 });
  });

  it("a winning player with a proof under a payout hold makes the payout wait for approval even when every share is under the limit", async () => {
    const { db, challenge, p } = await world({ stake: 25 });
    const [, held] = await counted(db, challenge, p.Maya!, [0, 1]);
    await collections(db).proofs.updateOne({ _id: held!._id }, { $set: { verdict: holdVerdict() } });
    await counted(db, challenge, p.Priya!, [0]);
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "awaiting_approval", snapshot: { approval_reasons: ["payout_hold"] } });
    if (!result.ok) return;
    expect(result.snapshot?.shares).toEqual([{ player_id: p.Maya!._id, amount: 100 }]);
    expect(await entriesOf(db, challenge._id, "payout")).toEqual([]);
    await decide(db, result.approval_id!, "approve");
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 100 });
  });

  it("a payout hold on a player who does not win does not hold the payout", async () => {
    const { db, challenge, p } = await world({ stake: 25 });
    await counted(db, challenge, p.Maya!, [0, 1]);
    const [held] = await counted(db, challenge, p.Sam!, [0]);
    await collections(db).proofs.updateOne({ _id: held!._id }, { $set: { verdict: holdVerdict() } });
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "paid" });
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 100 });
  });

  it("two concurrent settlement runs write one set of ledger entries", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"] });
    await counted(db, challenge, p.Maya!, [0, 1]);
    await counted(db, challenge, p.Priya!, [0, 1]);
    const runs = await Promise.all([1, 2, 3].map(() => settle(db, { challenge_id: challenge._id, now: SETTLE_AT })));
    expect(runs.every((r) => r.ok)).toBe(true);
    const statuses = runs.map((r) => (r.ok ? r.status : "error")).sort();
    expect(statuses.filter((s) => s === "paid")).toHaveLength(1);
    expect(statuses.filter((s) => s !== "paid").every((s) => s === "already_settled")).toBe(true);
    const ids = new Set(runs.map((r) => (r.ok ? r.snapshot?.snapshot_id : null)));
    expect(ids.size).toBe(1);
    expect(await entriesOf(db, challenge._id, "payout")).toHaveLength(2);
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 150, Priya: 150 });
    expect(await collections(db).events.countDocuments({ kind: "challenge.settled" })).toBe(1);
  });

  it("two concurrent pay calls for an approved snapshot write one set of ledger entries", async () => {
    const { db, challenge } = await ae6World();
    const waiting = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    if (!waiting.ok) throw new Error("settle failed");
    await collections(db).approvals.updateOne({ _id: waiting.approval_id! }, { $set: { status: "approved" } });
    const input = { challenge_id: challenge._id, snapshot_id: waiting.snapshot!.snapshot_id, decision: "approve" as const, now: SETTLE_AT };
    const runs = await Promise.all([pay(db, input), pay(db, input)]);
    expect(runs.map((r) => (r.ok ? r.status : "error")).sort()).toEqual(["already_settled", "paid"]);
    const again = runs.find((r) => r.ok && r.status === "already_settled");
    expect(again && again.ok ? again.entries : []).toHaveLength(2);
    expect(await entriesOf(db, challenge._id, "payout")).toHaveLength(2);
  });

  it("a proof that changes after the payout approval is created does not change the payout", async () => {
    const { db, challenge, p } = await ae6World();
    const first = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    if (!first.ok) throw new Error("settle failed");
    expect(first.status).toBe("awaiting_approval");
    // After the approval exists, Priya's day-1 proof stops counting and Sam gains a day.
    await collections(db).proofs.updateOne(
      { challenge_id: challenge._id, player_id: p.Priya!._id, day_index: 1 },
      { $set: { status: "not_counted", not_counted_reason: "removed" } },
    );
    await counted(db, challenge, p.Sam!, [1, 2]);
    const again = await settle(db, { challenge_id: challenge._id, now: new Date(SETTLE_AT.getTime() + 30_000) });
    expect(again).toMatchObject({ ok: true, status: "awaiting_approval", approval_id: first.approval_id });
    if (!again.ok) return;
    expect(again.snapshot?.snapshot_id).toBe(first.snapshot?.snapshot_id);
    expect(await collections(db).approvals.countDocuments({ kind: "payout" })).toBe(1);
    await decide(db, first.approval_id!, "approve");
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 200, Priya: 200 });
  });

  it("an orchestrator proposal that disagrees with the computed scores is ignored, and the computed results are paid", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"], payoutLimit: 1000 });
    await counted(db, challenge, p.Maya!, [0, 1]);
    await counted(db, challenge, p.Priya!, [0]);
    const inputs = useOrchestrator(() => ({ shares: [{ player_id: p.Sam!._id, amount: 300 }], refund_all: false, note: "Sam wins." }));
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "paid", snapshot: { orchestrator: "disagreed" } });
    expect(inputs[0]?.scores).toEqual(
      expect.arrayContaining([{ player_id: p.Maya!._id, score: 2, reached_goal: true }]),
    );
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 300 });
    const computed = await collections(db).events.findOne({ kind: "settlement.computed" });
    expect(computed?.data).toMatchObject({ orchestrator: "disagreed" });
  });

  it("when the orchestrator call fails, settlement still stores scores and a pending payout that a human can approve", async () => {
    const { db, challenge, p } = await ae6World();
    useOrchestrator(() => "fail");
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "awaiting_approval", snapshot: { orchestrator: "error" } });
    if (!result.ok) return;
    expect(result.snapshot?.scores.find((s) => s.player_id === p.Maya!._id)).toMatchObject({ score: 2 });
    expect(await collections(db).approvals.findOne({ _id: result.approval_id! })).toMatchObject({ status: "pending" });
    await decide(db, result.approval_id!, "approve");
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 200, Priya: 200 });
  });

  it("an orchestrator that throws also falls back to the computed results", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya"], payoutLimit: 1000 });
    await counted(db, challenge, p.Maya!, [0]);
    useOrchestrator(() => "throw");
    const result = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(result).toMatchObject({ ok: true, status: "paid", snapshot: { orchestrator: "error" } });
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 200 });
  });

  it("declining the payout approval refunds every stake", async () => {
    const { db, challenge } = await ae6World();
    const waiting = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    if (!waiting.ok) throw new Error("settle failed");
    const declined = await decide(db, waiting.approval_id!, "decline");
    expect(declined).toMatchObject({ ok: true, follow_up: { status: "ok" } });
    expect(await amountsByName(db, challenge._id, "refund")).toEqual({ Maya: 100, Priya: 100, Sam: 100, Gary: 100 });
    expect(await entriesOf(db, challenge._id, "payout")).toEqual([]);
    expect((await collections(db).challenges.findOne({ _id: challenge._id }))?.status).toBe("settled");
  });

  it("waits while a request the final check opened is still in grace, then counts anything unresolved as not counted", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya", "Sam"] });
    await counted(db, challenge, p.Maya!, [0]);
    const held = await seedProof(db, { challenge, player: p.Priya!, day_index: 1, status: "held", held_reason: "extra_proof", received_at: at(320) });
    await counted(db, challenge, p.Priya!, [0]);
    const review = await seedProof(db, { challenge, player: p.Sam!, day_index: 0, status: "ai_review", received_at: at(30) });
    const due = new Date(SETTLE_AT.getTime() + 90_000);
    await addInboxItem(db, extraProofItem({ player_id: p.Priya!._id, challenge_id: challenge._id, proof_id: held._id, due_at: due }), { now: SETTLE_AT });

    const early = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    expect(early).toEqual({ ok: true, status: "requeued", snapshot: null, approval_id: null });
    expect((await collections(db).challenges.findOne({ _id: challenge._id }))?.settlement).toBeNull();

    const later = await settle(db, { challenge_id: challenge._id, now: new Date(due.getTime() + 1000) });
    expect(later).toMatchObject({ ok: true, status: "paid" });
    for (const id of [held._id, review._id]) {
      expect(await collections(db).proofs.findOne({ _id: id })).toMatchObject({
        status: "not_counted",
        not_counted_reason: "unresolved_at_settlement",
        held_reason: null,
      });
    }
    // Maya and Priya each have one counted day; Priya's held day 1 did not count.
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 150, Priya: 150 });
  });

  it("refuses to settle or pay out of turn, and repeats return already settled", async () => {
    const active = await world({ names: ["Ana", "Ben"], status: "active" });
    expect(await settle(active.db, { challenge_id: active.challenge._id, now: SETTLE_AT })).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await pay(active.db, { challenge_id: active.challenge._id, snapshot_id: "snp_x", decision: "approve" })).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    expect(await settle(active.db, { challenge_id: "chl_missing" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    await expectBalanced(active.db, active.challenge._id);

    const { db, challenge } = await ae6World();
    const waiting = await settle(db, { challenge_id: challenge._id, now: SETTLE_AT });
    if (!waiting.ok) throw new Error("settle failed");
    const snapshot_id = waiting.snapshot!.snapshot_id;
    expect(await pay(db, { challenge_id: challenge._id, snapshot_id: "snp_other", decision: "approve" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    // Still pending: pay refuses both decisions until a human decides.
    expect(await pay(db, { challenge_id: challenge._id, snapshot_id, decision: "approve" })).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await pay(db, { challenge_id: challenge._id, snapshot_id, decision: "decline" })).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await entriesOf(db, challenge._id, "payout")).toEqual([]);

    await decide(db, waiting.approval_id!, "approve");
    expect(await settle(db, { challenge_id: challenge._id, now: SETTLE_AT })).toMatchObject({ ok: true, status: "already_settled", approval_id: waiting.approval_id });
    const repeat = await pay(db, { challenge_id: challenge._id, snapshot_id, decision: "approve" });
    expect(repeat).toMatchObject({ ok: true, status: "already_settled" });
    expect(repeat.ok ? repeat.entries : []).toHaveLength(2);
    expect(await entriesOf(db, challenge._id, "payout")).toHaveLength(2);
  });

  it("a snapshot that needs no approval cannot be declined", async () => {
    const { db, challenge, p } = await world({ names: ["Maya", "Priya"] });
    await counted(db, challenge, p.Maya!, [0]);
    await collections(db).challenges.updateOne(
      { _id: challenge._id },
      {
        $set: {
          settlement: {
            snapshot_id: "snp_manual",
            computed_at: SETTLE_AT,
            winner_rule: "top_score",
            unit: "days",
            goal: 2,
            pot: 200,
            scores: [],
            shares: [{ player_id: p.Maya!._id, amount: 200 }],
            refunds: [],
            refund_all: false,
            needs_approval: false,
            approval_reasons: [],
            approval_id: null,
            orchestrator: "skipped",
          },
        },
      },
    );
    expect(await pay(db, { challenge_id: challenge._id, snapshot_id: "snp_manual", decision: "decline" })).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    });
    expect(await pay(db, { challenge_id: challenge._id, snapshot_id: "snp_manual", decision: "approve" })).toMatchObject({ ok: true, status: "paid" });
  });
});

// ---------------------------------------------------------------- end to end through U18's tick and job

describe("window close to payout through the tick (U18 hand-off)", () => {
  const closedAt = new Date(windowEnd(DEMO).getTime() + 1000);
  const graceEnd = finalGraceEnd(DEMO);

  it("closing a demo challenge settles it end to end: tick, settlement job, approval, payout", async () => {
    const { db, challenge, p } = await world({ status: "active" });
    await counted(db, challenge, p.Maya!, [0, 1], 20);
    await counted(db, challenge, p.Priya!, [0, 1], 40);
    await counted(db, challenge, p.Sam!, [0]);

    const tick = await runTick(db, { now: closedAt }, { packFor: () => fixturePack });
    expect(tick.details.closed).toEqual([challenge._id]);
    const job = await collections(db).jobs.findOne({ kind: "settlement", dedup_key: challenge._id });
    expect(job).toMatchObject({ status: "queued", due_at: graceEnd });

    const { runs } = await runTickJobs(db, { clock: manualClock(graceEnd), handlers: { settlement: settlementJobHandler } });
    expect(runs.map((r) => r.status)).toEqual(["done"]);
    const finished = await collections(db).jobs.findOne({ _id: job!._id });
    expect(finished?.result).toMatchObject({ status: "awaiting_approval" });
    const approvalId = finished?.result?.approval_id as string;

    await decide(db, approvalId, "approve");
    expect((await collections(db).challenges.findOne({ _id: challenge._id }))?.status).toBe("settled");
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 200, Priya: 200 });
  });

  it("while U9 is not wired the settlement job waits, keeps the stored snapshot, and creates the approval once U9 is there", async () => {
    const { db, challenge, p } = await world({ status: "active" });
    await counted(db, challenge, p.Maya!, [0, 1]);
    await counted(db, challenge, p.Priya!, [0, 1]);
    await runTick(db, { now: closedAt }, { packFor: () => fixturePack });

    resetServices();
    provideServices({ settlement: settlementService });
    const clock = manualClock(graceEnd);
    const first = await runTickJobs(db, { clock, handlers: { settlement: settlementJobHandler } });
    expect(first.runs.map((r) => r.status)).toEqual(["requeued"]);
    const stored = (await collections(db).challenges.findOne({ _id: challenge._id }))?.settlement;
    expect(stored).toMatchObject({ needs_approval: true, approval_id: null });

    useApprovalsDouble();
    clock.advance(120_000);
    const second = await runTickJobs(db, { clock, handlers: { settlement: settlementJobHandler } });
    expect(second.runs.map((r) => r.status)).toEqual(["done"]);
    const after = (await collections(db).challenges.findOne({ _id: challenge._id }))?.settlement;
    expect(after?.snapshot_id).toBe(stored?.snapshot_id);
    expect(after?.approval_id).toBeTruthy();
    await decide(db, after!.approval_id!, "approve");
    expect(await amountsByName(db, challenge._id, "payout")).toEqual({ Maya: 200, Priya: 200 });
  });
});
