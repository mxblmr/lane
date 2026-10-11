import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Db } from "mongodb";
import { startReplSet, type TestMongo } from "@lane/core/testing/mongo";
import { resetServices } from "@lane/core/interfaces";
import { collections } from "@lane/core/schema";
import { demoClockSettings } from "@lane/core/clock";
import { PLAY_CREDIT_LABEL } from "@lane/core/config";
import { loadChallenge, loadRules } from "../lib/dashboard-data";
import { StageScreen, type StageData } from "../app/(dashboard)/_components/StageScreen";
import { RulesView, type RulesWire } from "../app/(dashboard)/_components/Rules";
import { IDLE, opsButtonReducer } from "../app/(dashboard)/_components/OpsButton";
import { approvalPhase, phaseLabel, recordedDecision } from "../app/(dashboard)/_components/wire";
import { challenge, membership, payoutApproval, player, proof, rule, ruleApproval, stakeEntry, verdict } from "./fixtures/dashboard";

let mongo: TestMongo;
let db: Db;

beforeAll(async () => {
  mongo = await startReplSet();
}, 120_000);

beforeEach(async () => {
  db = await mongo.freshDb();
  resetServices();
});

afterAll(async () => {
  await mongo?.stop();
});

/** Seeds a stage run and returns its data exactly as the browser receives it (after JSON). */
async function stageData(opts: { failedResume?: boolean } = {}): Promise<StageData> {
  const col = collections(db);
  const start = new Date(Date.now() - 120_000);
  const sam = player({ display_name: "Sam" });
  const maya = player({ display_name: "Maya", key_hash: "b".repeat(64) });
  const c = challenge({ clock: demoClockSettings(new Date(Date.now() - 60_000), { days: 7 }), created_at: start, activated_at: start });
  await col.players.insertMany([sam, maya]);
  await col.challenges.insertOne(c);
  await col.memberships.insertMany([membership(c, sam), membership(c, maya)]);
  await stakeEntry(db, c, sam, 200);
  await stakeEntry(db, c, maya, 200);
  const junk = proof(c, sam, { verdict: verdict({ reason: "<b>renames only</b>" }) });
  await col.proofs.insertOne(junk);
  const learned = rule({
    version: 2,
    parent_version: 1,
    created_at: new Date(Date.now() - 5_000),
    evidence: { proof_ids: [junk._id], example_keys: [], dispute_ids: [] },
  });
  await col.rules.insertOne(learned);
  await col.approvals.insertOne(
    ruleApproval(
      learned,
      opts.failedResume
        ? { status: "approved", decided_by: "operator", decided_at: new Date(), follow_up: { status: "failed", attempts: 1, error: "promoter resume timed out" } }
        : {},
    ),
  );
  await col.approvals.insertOne(
    payoutApproval(c, [
      { player_id: sam._id, amount: 200 },
      { player_id: maya._id, amount: 200 },
    ]),
  );
  const data = await loadChallenge(db, c._id);
  return JSON.parse(JSON.stringify(data)) as StageData;
}

function render(data: StageData, operator: boolean): string {
  return renderToStaticMarkup(createElement(StageScreen, { data, operator }));
}

describe("stage screen render", () => {
  it("the spectator render contains no operator controls", async () => {
    const data = await stageData();
    const html = render(data, false);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Operator controls");
    for (const control of ["Approve", "Decline", "Retry", "Advance one day", "Close window", "Reset stage", "Mark as live cheat"]) {
      expect(html).not.toContain(control);
    }
    // The spectator still sees the queue, the feed and the strip.
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("Proof feed");
    expect(html).toContain("Awaiting approval");
  });

  it("the operator render shows approve and decline on pending approvals and the demo controls", async () => {
    const data = await stageData();
    const html = render(data, true);
    expect(html).toContain("Operator controls");
    expect(html.match(/>Approve</g)).toHaveLength(2);
    expect(html.match(/>Decline</g)).toHaveLength(2);
    expect(html).toContain("Advance one day");
    expect(html).toContain("Close window");
    expect(html).toContain("Reset stage");
  });

  it("a rule approval whose resume failed shows Retry to the operator only", async () => {
    const data = await stageData({ failedResume: true });
    const operatorHtml = render(data, true);
    expect(operatorHtml).toContain("Approved, resume failed");
    expect(operatorHtml).toContain(">Retry<");
    expect(operatorHtml).toContain("promoter resume timed out");
    const spectatorHtml = render(data, false);
    expect(spectatorHtml).toContain("Approved, resume failed");
    expect(spectatorHtml).not.toContain("Retry");
  });

  it("renders the pot, stake and payout shares with the play-credit label", async () => {
    const data = await stageData();
    const html = render(data, false);
    expect(html).toContain(`400 ${PLAY_CREDIT_LABEL}`);
    expect(html).toContain(`Stake 100 ${PLAY_CREDIT_LABEL}`);
    expect(html).toContain(`Maya: 200 ${PLAY_CREDIT_LABEL}`);
    expect(html).toContain(`Payout of 400 ${PLAY_CREDIT_LABEL}`);
  });

  it("renders player and AI text as plain text, never as HTML", async () => {
    const data = await stageData();
    const html = render(data, false);
    expect(html).not.toContain("<b>renames only</b>");
    expect(html).toContain("&lt;b&gt;renames only&lt;/b&gt;");
  });

  it("shows the rule approval's rule line, action, evidence, gate result and parent version", async () => {
    const data = await stageData();
    const html = render(data, false);
    expect(html).toContain("A proof where the commit only renames identifiers does not count.");
    expect(html).toContain("no-rename-only v2, changes v1");
    expect(html).toContain("commit, 1 file, +1/-1");
    expect(html).toContain("passed: catch rate 0% to 95%, false alarms 0.0%");
  });

  it("shows roll back on the rules page only to the operator", async () => {
    await collections(db).rules.insertMany([
      rule({ version: 1, source: "seed", status: "superseded", test_results: null }),
      rule({ version: 2, parent_version: 1, status: "active" }),
    ]);
    const data = JSON.parse(JSON.stringify(await loadRules(db))) as RulesWire;
    const operatorHtml = renderToStaticMarkup(createElement(RulesView, { data, operator: true }));
    expect(operatorHtml).toContain("Roll back to v1");
    const spectatorHtml = renderToStaticMarkup(createElement(RulesView, { data, operator: false }));
    expect(spectatorHtml).not.toContain("<button");
    expect(spectatorHtml).toContain("parent v1");
  });
});

describe("operator control behavior", () => {
  it("reset, close-window and roll back need a confirming second click before anything is sent", () => {
    const first = opsButtonReducer(IDLE, { type: "click", needsConfirm: true });
    expect(first.phase).toBe("confirming");
    const second = opsButtonReducer(first, { type: "click", needsConfirm: true });
    expect(second.phase).toBe("sending");
    // Without the second click the confirmation lapses.
    expect(opsButtonReducer(first, { type: "timeout" }).phase).toBe("idle");
  });

  it("ignores a click while a request is in flight", () => {
    const sending = opsButtonReducer(IDLE, { type: "click", needsConfirm: false });
    expect(sending.phase).toBe("sending");
    expect(opsButtonReducer(sending, { type: "click", needsConfirm: false })).toBe(sending);
    const done = opsButtonReducer(sending, { type: "done", ok: false, message: "Failed." });
    expect(done).toEqual({ phase: "idle", message: "Failed.", error: true });
  });

  it("moves an approval through pending, activating, active, and failed with the recorded decision", () => {
    const base = { kind: "rule" as const, rule_status: null };
    expect(approvalPhase({ ...base, status: "pending", follow_up: { status: "not_started", attempts: 0, error: null } })).toBe("pending");
    expect(approvalPhase({ ...base, status: "approved", follow_up: { status: "running", attempts: 1, error: null } })).toBe("activating");
    expect(approvalPhase({ ...base, status: "approved", rule_status: "active", follow_up: { status: "ok", attempts: 1, error: null } })).toBe(
      "active",
    );
    const failed = { ...base, status: "declined" as const, follow_up: { status: "failed" as const, attempts: 1, error: "x" } };
    expect(approvalPhase(failed)).toBe("failed");
    expect(phaseLabel(failed)).toBe("Declined, resume failed");
    expect(recordedDecision(failed)).toBe("decline");
    expect(approvalPhase({ kind: "payout", status: "approved", follow_up: { status: "ok", attempts: 1, error: null } })).toBe("paid");
  });
});
