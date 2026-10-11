import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { closeMongoClient } from "@lane/core/db";
import { provideServices, resetServices, services } from "@lane/core/interfaces";
import type { PayInput, ResetStageInput, RollbackRuleInput, MarkLiveCheatInput } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema";
import { dayIndexAt, demoClockSettings } from "@lane/core/clock";
import { readSettings } from "@lane/core/config";
import * as login from "../app/api/ops/login/route";
import * as logout from "../app/api/ops/logout/route";
import * as decideRoute from "../app/api/ops/decide/route";
import * as advanceRoute from "../app/api/ops/advance-day/route";
import * as closeRoute from "../app/api/ops/close-window/route";
import * as resetRoute from "../app/api/ops/reset/route";
import * as rollbackRoute from "../app/api/ops/rollback/route";
import * as liveCheatRoute from "../app/api/ops/live-cheat/route";
import * as settingsRoute from "../app/api/ops/settings/route";
import * as surpriseRoute from "../app/api/ops/surprise-check/route";
import * as redTeamRoute from "../app/api/ops/red-team/route";
import { opsToken, OPS_COOKIE } from "../lib/auth-ops";
import {
  PASSCODE,
  approvalsDouble,
  challenge,
  membership,
  opsCookie,
  payoutApproval,
  player,
  postJson,
  proof,
  rule,
  ruleApproval,
} from "./fixtures/dashboard";

let mongo: TestMongo;
let db: Db;

beforeAll(async () => {
  mongo = await startReplSet();
  process.env.MONGODB_URI = mongo.replSet.getUri();
}, 120_000);

beforeEach(async () => {
  db = await mongo.freshDb();
  process.env.MONGODB_DB = db.databaseName;
  process.env.OPS_PASSCODE = PASSCODE;
  resetServices();
});

afterEach(() => {
  resetServices();
});

afterAll(async () => {
  await closeMongoClient();
  await mongo?.stop();
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB;
  delete process.env.OPS_PASSCODE;
});

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** A challenge on a demo clock that started a minute ago, so "now" is day 0. */
function liveChallenge() {
  return challenge({ clock: demoClockSettings(new Date(Date.now() - 60_000), { days: 7, day_length_sec: 300, grace_sec: 90 }) });
}

describe("operator passcode (KTD16)", () => {
  it("refuses approve without the cookie, and a hand-set cookie with any other value for approve, close-window and reset", async () => {
    const c = liveChallenge();
    const r = rule();
    const a = ruleApproval(r);
    await collections(db).challenges.insertOne(c);
    await collections(db).rules.insertOne(r);
    await collections(db).approvals.insertOne(a);
    const approvals = approvalsDouble(db);
    let resets = 0;
    provideServices({
      approvals: { decide: approvals.decide },
      stage: {
        reset: async () => {
          resets += 1;
          return { ok: true, cancelled_challenge_id: c._id, new_challenge_id: "chl_new" };
        },
      },
    });

    const badCookies: (string | null)[] = [
      null,
      `${OPS_COOKIE}=${"0".repeat(64)}`,
      `${OPS_COOKIE}=${opsToken("some-other-passcode-123456")}`,
      `${OPS_COOKIE}=${PASSCODE}`,
      `${OPS_COOKIE}=`,
      `other=${opsToken(PASSCODE)}`,
    ];
    for (const cookie of badCookies) {
      const approve = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: a._id, decision: "approve" }, cookie));
      const close = await closeRoute.POST(
        postJson("/api/ops/close-window", { challenge_id: c._id, expected_status: "active", confirm: true }, cookie),
      );
      const reset = await resetRoute.POST(postJson("/api/ops/reset", { challenge_type: "ship_week", confirm: true }, cookie));
      expect([approve.status, close.status, reset.status]).toEqual([401, 401, 401]);
    }

    expect(approvals.calls).toHaveLength(0);
    expect(resets).toBe(0);
    expect((await collections(db).challenges.findOne({ _id: c._id }))?.status).toBe("active");
    expect((await collections(db).approvals.findOne({ _id: a._id }))?.status).toBe("pending");
  });

  it("turns every ops route off when OPS_PASSCODE is unset or short", async () => {
    for (const value of [undefined, "short"]) {
      if (value === undefined) delete process.env.OPS_PASSCODE;
      else process.env.OPS_PASSCODE = value;
      const res = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: "apr_x", decision: "approve" }, opsCookie(value ?? "")));
      expect(res.status).toBe(503);
      const signIn = await login.POST(postJson("/api/ops/login", { passcode: value ?? "" }, null));
      expect(signIn.status).toBe(503);
    }
  });

  it("signs in only with the right passcode, with an httpOnly Secure SameSite=Strict cookie that opens the ops routes", async () => {
    const wrong = await login.POST(postJson("/api/ops/login", { passcode: "not-the-passcode-at-all" }, null));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await login.POST(postJson("/api/ops/login", { passcode: PASSCODE }, null));
    expect(right.status).toBe(200);
    const setCookie = right.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${OPS_COOKIE}=${opsToken(PASSCODE)}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(PASSCODE);

    const cookie = setCookie.split(";")[0]!;
    const res = await settingsRoute.POST(postJson("/api/ops/settings", { patch: { learning_paused: true } }, cookie));
    expect(res.status).toBe(200);

    const out = await logout.POST();
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("exposes every ops control as POST only", () => {
    const routes = [decideRoute, advanceRoute, closeRoute, resetRoute, rollbackRoute, liveCheatRoute, settingsRoute, surpriseRoute, redTeamRoute, login, logout];
    for (const route of routes) {
      const methods = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
      expect(methods).toEqual(["POST"]);
    }
  });
});

describe("approvals through U9", () => {
  it("approving a pending rule calls U9's approvals once, even on a double click", async () => {
    const r = rule();
    const a = ruleApproval(r);
    await collections(db).rules.insertOne(r);
    await collections(db).approvals.insertOne(a);
    const approvals = approvalsDouble(db);
    provideServices({ approvals: { decide: approvals.decide } });

    const body = { approval_id: a._id, decision: "approve" };
    const [first, second] = await Promise.all([
      decideRoute.POST(postJson("/api/ops/decide", body)),
      decideRoute.POST(postJson("/api/ops/decide", body)),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const third = await decideRoute.POST(postJson("/api/ops/decide", body));
    expect(third.status).toBe(409);
    expect((await json(third)).code).toBe("already_decided");

    expect(approvals.calls).toHaveLength(1);
    expect(approvals.calls[0]).toMatchObject({ approval_id: a._id, decision: "approve", decided_by: "operator" });
    const stored = await collections(db).approvals.findOne({ _id: a._id });
    expect(stored?.status).toBe("approved");
    const answer = await json(first);
    expect(answer).toMatchObject({ ok: true, decided: true, rule_status: "active" });
    expect(JSON.stringify(answer)).not.toContain("suspend context is internal");
  });

  it("a rule approval whose resume failed takes Retry, and Retry re-sends the same decision once", async () => {
    const r = rule();
    const a = ruleApproval(r, {
      status: "approved",
      decided_by: "operator",
      decided_at: new Date(),
      follow_up: { status: "failed", attempts: 1, error: "promoter resume timed out" },
    });
    await collections(db).rules.insertOne(r);
    await collections(db).approvals.insertOne(a);
    const approvals = approvalsDouble(db);
    provideServices({ approvals: { decide: approvals.decide } });

    // Without the retry flag an already decided approval is not sent again.
    const plain = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: a._id, decision: "approve" }));
    expect(plain.status).toBe(409);
    // A retry must carry the decision already recorded.
    const wrongDecision = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: a._id, decision: "decline", retry: true }));
    expect(wrongDecision.status).toBe(409);
    expect(approvals.calls).toHaveLength(0);

    const body = { approval_id: a._id, decision: "approve", retry: true };
    const [first, second] = await Promise.all([
      decideRoute.POST(postJson("/api/ops/decide", body)),
      decideRoute.POST(postJson("/api/ops/decide", body)),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(approvals.calls).toHaveLength(1);
    expect(approvals.calls[0]).toMatchObject({ approval_id: a._id, decision: "approve" });
    const stored = await collections(db).approvals.findOne({ _id: a._id });
    expect(stored?.follow_up.status).toBe("ok");
    expect(stored?.kind === "rule" && stored.rule_status).toBe("active");

    // Once the follow-up succeeded there is nothing left to retry.
    const again = await decideRoute.POST(postJson("/api/ops/decide", body));
    expect(again.status).toBe(409);
    expect(approvals.calls).toHaveLength(1);
  });

  it("covers AE6: approving a payout pays once", async () => {
    const c = liveChallenge();
    const maya = player({ display_name: "Maya", key_hash: "b".repeat(64) });
    const priya = player({ display_name: "Priya", key_hash: "c".repeat(64) });
    const a = payoutApproval(c, [
      { player_id: maya._id, amount: 200 },
      { player_id: priya._id, amount: 200 },
    ]);
    await collections(db).challenges.insertOne(c);
    await collections(db).approvals.insertOne(a);
    const pays: PayInput[] = [];
    provideServices({
      settlement: {
        pay: async (_db, input) => {
          pays.push(input);
          return { ok: true, status: "paid", entries: [] };
        },
      },
    });
    const approvals = approvalsDouble(db, {
      followUp: async (decided) => {
        if (decided.kind !== "payout") return "failed";
        const paid = await services().settlement.pay(db, { challenge_id: decided.challenge_id, snapshot_id: decided.snapshot_id, decision: "approve" });
        return paid.ok ? "ok" : "failed";
      },
    });
    provideServices({ approvals: { decide: approvals.decide } });

    const body = { approval_id: a._id, decision: "approve" };
    const results = await Promise.all([1, 2, 3].map(() => decideRoute.POST(postJson("/api/ops/decide", body))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const late = await decideRoute.POST(postJson("/api/ops/decide", body));
    expect(late.status).toBe(409);

    expect(approvals.calls).toHaveLength(1);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ challenge_id: c._id, snapshot_id: a.snapshot_id, decision: "approve" });
  });

  it("answers not available yet while U9's approvals are not wired", async () => {
    const r = rule();
    const a = ruleApproval(r);
    await collections(db).approvals.insertOne(a);
    const res = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: a._id, decision: "approve" }));
    expect(res.status).toBe(501);
    expect(await json(res)).toMatchObject({ ok: false, code: "not_available", owner: "U9" });
  });

  it("answers 404 for an unknown approval and 400 for a bad body", async () => {
    const missing = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: "apr_missing", decision: "approve" }));
    expect(missing.status).toBe(404);
    const bad = await decideRoute.POST(postJson("/api/ops/decide", { approval_id: "apr_x", decision: "maybe" }));
    expect(bad.status).toBe(400);
  });
});

describe("clock controls (R32)", () => {
  it("a double click on advance-day advances one day", async () => {
    const c = liveChallenge();
    await collections(db).challenges.insertOne(c);
    const expected = dayIndexAt(c.clock!, new Date());

    const body = { challenge_id: c._id, expected_day_index: expected };
    const results = await Promise.all([
      advanceRoute.POST(postJson("/api/ops/advance-day", body)),
      advanceRoute.POST(postJson("/api/ops/advance-day", body)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const late = await advanceRoute.POST(postJson("/api/ops/advance-day", body));
    expect(late.status).toBe(409);

    const stored = await collections(db).challenges.findOne({ _id: c._id });
    expect(stored?.clock?.offset_days).toBe(1);
    expect(dayIndexAt(stored!.clock!, new Date())).toBe(expected + 1);
    expect(await collections(db).events.countDocuments({ challenge_id: c._id, kind: "challenge.day_advanced" })).toBe(1);
  });

  it("advance-day refuses a challenge that is not active", async () => {
    const c = challenge({ status: "settling" });
    await collections(db).challenges.insertOne(c);
    const res = await advanceRoute.POST(postJson("/api/ops/advance-day", { challenge_id: c._id, expected_day_index: 0 }));
    expect(res.status).toBe(409);
    expect((await collections(db).challenges.findOne({ _id: c._id }))?.clock?.offset_days).toBe(0);
  });

  it("close-window moves the challenge to settling once and queues one settlement job", async () => {
    const c = liveChallenge();
    await collections(db).challenges.insertOne(c);

    const body = { challenge_id: c._id, expected_status: "active", confirm: true };
    const results = await Promise.all([
      closeRoute.POST(postJson("/api/ops/close-window", body)),
      closeRoute.POST(postJson("/api/ops/close-window", body)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const stored = await collections(db).challenges.findOne({ _id: c._id });
    expect(stored?.status).toBe("settling");
    expect(stored?.closed_at).toBeInstanceOf(Date);
    expect(await collections(db).jobs.countDocuments({ kind: "settlement", dedup_key: c._id })).toBe(1);
    expect(await collections(db).events.countDocuments({ challenge_id: c._id, kind: "challenge.window_closed" })).toBe(1);
  });

  it("close-window and reset need the confirming step", async () => {
    const c = liveChallenge();
    await collections(db).challenges.insertOne(c);
    let resets = 0;
    provideServices({
      stage: {
        reset: async () => {
          resets += 1;
          return { ok: true, cancelled_challenge_id: null, new_challenge_id: "chl_new" };
        },
      },
    });

    const close = await closeRoute.POST(postJson("/api/ops/close-window", { challenge_id: c._id, expected_status: "active" }));
    expect(close.status).toBe(400);
    const closeFalse = await closeRoute.POST(postJson("/api/ops/close-window", { challenge_id: c._id, expected_status: "active", confirm: false }));
    expect(closeFalse.status).toBe(400);
    expect((await collections(db).challenges.findOne({ _id: c._id }))?.status).toBe("active");

    const reset = await resetRoute.POST(postJson("/api/ops/reset", { challenge_type: "ship_week" }));
    expect(reset.status).toBe(400);
    expect(resets).toBe(0);
  });
});

describe("stage, rules and proofs", () => {
  it("reset calls U13 once with the confirmation and answers not available yet when unwired", async () => {
    const unwired = await resetRoute.POST(postJson("/api/ops/reset", { challenge_type: "ship_week", confirm: true }));
    expect(unwired.status).toBe(501);
    expect((await json(unwired)).owner).toBe("U13");

    const calls: ResetStageInput[] = [];
    provideServices({
      stage: {
        reset: async (_db, input) => {
          calls.push(input);
          await new Promise((r) => setTimeout(r, 20));
          return { ok: true, cancelled_challenge_id: "chl_old", new_challenge_id: "chl_new" };
        },
      },
    });
    const body = { challenge_type: "ship_week", confirm: true };
    const [a, b] = await Promise.all([resetRoute.POST(postJson("/api/ops/reset", body)), resetRoute.POST(postJson("/api/ops/reset", body))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ challenge_type: "ship_week", by: "operator" });
    expect(await json(a)).toMatchObject({ new_challenge_id: "chl_new", cancelled_challenge_id: "chl_old" });
  });

  it("roll back restores the parent version and publishes a contract version", async () => {
    const seed = rule({ version: 1, source: "seed", status: "superseded", rule_key: "no-rename-only", test_results: null });
    const learned = rule({ version: 2, parent_version: 1, status: "active", rule_key: "no-rename-only", activated_at: new Date() });
    await collections(db).rules.insertMany([seed, learned]);
    const calls: RollbackRuleInput[] = [];
    provideServices({
      lifecycle: {
        rollback: async (_db, input) => {
          calls.push(input);
          return { ok: true, restored: { rule_key: input.rule_key, version: 1 }, contracts: [{ challenge_id: "chl_stage", version: 4 }] };
        },
      },
    });

    const unconfirmed = await rollbackRoute.POST(postJson("/api/ops/rollback", { challenge_type: "ship_week", rule_key: "no-rename-only" }));
    expect(unconfirmed.status).toBe(400);
    expect(calls).toHaveLength(0);

    const res = await rollbackRoute.POST(postJson("/api/ops/rollback", { challenge_type: "ship_week", rule_key: "no-rename-only", confirm: true }));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      ok: true,
      restored: { rule_key: "no-rename-only", version: 1 },
      contracts: [{ challenge_id: "chl_stage", version: 4 }],
    });
    expect(calls).toEqual([expect.objectContaining({ challenge_type: "ship_week", rule_key: "no-rename-only", by: "operator" })]);
  });

  it("roll back refuses an active seed rule without calling U9", async () => {
    await collections(db).rules.insertOne(rule({ version: 1, source: "seed", status: "active", rule_key: "no-empty-commit" }));
    let called = false;
    provideServices({
      lifecycle: {
        rollback: async () => {
          called = true;
          return { ok: true, restored: null, contracts: [] };
        },
      },
    });
    const res = await rollbackRoute.POST(postJson("/api/ops/rollback", { challenge_type: "ship_week", rule_key: "no-empty-commit", confirm: true }));
    expect(res.status).toBe(409);
    expect(called).toBe(false);
  });

  it("mark as live cheat sends the proof to U9's live-cheat entry point", async () => {
    const c = liveChallenge();
    const p = player();
    const pr = proof(c, p, { status: "accepted" });
    await collections(db).challenges.insertOne(c);
    await collections(db).players.insertOne(p);
    await collections(db).memberships.insertOne(membership(c, p));
    await collections(db).proofs.insertOne(pr);
    const calls: MarkLiveCheatInput[] = [];
    provideServices({
      learning: {
        markLiveCheat: async (_db, input) => {
          calls.push(input);
          return { job_id: "job_1", queued: true, skipped_reason: null };
        },
      },
    });
    const res = await liveCheatRoute.POST(postJson("/api/ops/live-cheat", { proof_id: pr._id }));
    expect(res.status).toBe(200);
    expect(calls).toEqual([expect.objectContaining({ proof_id: pr._id, by: "operator" })]);
    const missing = await liveCheatRoute.POST(postJson("/api/ops/live-cheat", { proof_id: "prf_missing" }));
    expect(missing.status).toBe(404);
  });

  it("settings switches write the settings document and reject a bad patch", async () => {
    const res = await settingsRoute.POST(
      postJson("/api/ops/settings", { patch: { learning_paused: true, payout_limit: 250, gate: { max_false_alarm_set: 0.03 } } }),
    );
    expect(res.status).toBe(200);
    const stored = await readSettings(db);
    expect(stored.learning_paused).toBe(true);
    expect(stored.payout_limit).toBe(250);
    expect(stored.gate.max_false_alarm_set).toBe(0.03);
    expect(stored.gate.min_catch_gain).toBe(0.1);

    const bad = await settingsRoute.POST(postJson("/api/ops/settings", { patch: { payout_limit: -5 } }));
    expect(bad.status).toBe(400);
    expect((await readSettings(db)).payout_limit).toBe(250);
  });

  it("surprise-check and red-team answer not available yet until their owners add an entry point", async () => {
    const surprise = await surpriseRoute.POST(postJson("/api/ops/surprise-check", { challenge_id: "chl_x" }));
    expect(surprise.status).toBe(501);
    expect((await json(surprise)).owner).toBe("U18");
    const red = await redTeamRoute.POST(postJson("/api/ops/red-team", { challenge_type: "ship_week" }));
    expect(red.status).toBe(501);
  });
});
