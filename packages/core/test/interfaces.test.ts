import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  NotImplementedError,
  SERVICE_OWNERS,
  createStubServices,
  laneDb,
  provideServices,
  resetServices,
  services,
  withServices,
  type LaneServices,
} from "../src/interfaces";
import { DEFAULT_SETTINGS, mergeSettings, readSettings, updateSettings } from "../src/config";
import { listEvents, writeEvent } from "../src/events";
import { collections } from "../src/schema/collections";
import { closeMongoClient } from "../src/db";
import { startReplSet, type TestMongo } from "../src/testing/mongo";

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

describe("cross-unit interfaces", () => {
  it("names exactly one owner for every service", () => {
    const stub = createStubServices();
    expect(Object.keys(SERVICE_OWNERS).sort()).toEqual(Object.keys(stub).sort());
    expect(SERVICE_OWNERS.proofs).toBe("U5");
    expect(SERVICE_OWNERS.inbox).toBe("U18");
    expect(SERVICE_OWNERS.agents).toBe("U8");
    expect(SERVICE_OWNERS.approvals).toBe("U9");
    expect(SERVICE_OWNERS.settlement).toBe("U11");
    expect(SERVICE_OWNERS.ledger).toBe("U3");
    expect(SERVICE_OWNERS.jobs).toBe("U3");
  });

  it("stubs throw a NotImplementedError naming the owner", async () => {
    const db = await mongo.freshDb();
    await expect(services().inbox.add(db, {} as never)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(services().proofs.submit(db, {} as never)).rejects.toThrow(/owned by U5/);
    await expect(
      services().agents.invoke({ workspace: "referee", mode: "proof", input: {} as never }),
    ).rejects.toThrow(/owned by U8/);
  });

  it("lets a test replace one method and restores the stubs afterwards", async () => {
    const db = await mongo.freshDb();
    const calls: string[] = [];
    const add: LaneServices["inbox"]["add"] = async (_db, item) => {
      calls.push(item.kind);
      return { item: { ...item, _id: "inb_1" } as never, created: true };
    };
    provideServices({ inbox: { add } });
    const res = await services().inbox.add(db, { kind: "extra_proof" } as never);
    expect(res.created).toBe(true);
    expect(calls).toEqual(["extra_proof"]);
    // The other inbox methods are still stubs.
    await expect(services().inbox.resolve(db, {} as never)).rejects.toThrow(/owned by U18/);

    resetServices();
    await expect(services().inbox.add(db, {} as never)).rejects.toThrow(/owned by U18/);

    const answer = await withServices({ ask: { ask: async () => ({ ok: true, answer: "You lead." }) } }, () =>
      services().ask.ask(db, { player_id: "plr_1", question: "How am I doing?" }),
    );
    expect(answer).toEqual({ ok: true, answer: "You lead." });
    await expect(services().ask.ask(db, {} as never)).rejects.toThrow(/owned by U18/);
  });

  it("wires the real jobs and ledger implementations", async () => {
    const db = await mongo.freshDb();
    const queued = await services().jobs.queue(db, { kind: "learning", dedup_key: "prf_1" });
    expect(queued.created).toBe(true);
    const claim = await services().jobs.claim(db, { job_id: queued.job._id });
    expect(claim?.attempt).toBe(1);

    await collections(db).players.insertOne({
      _id: "plr_1",
      display_name: "Maya",
      time_zone: "America/Los_Angeles",
      key_hash: "0".repeat(64),
      routine_text: "",
      handles: {},
      credits: 0,
      scripted: false,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const grant = await services().ledger.append(db, { player_id: "plr_1", challenge_id: null, kind: "grant", amount: 1000 });
    expect(grant.ok && grant.balance).toBe(1000);
  });
});

describe("laneDb", () => {
  it("returns the Lane database with the unique indexes created at startup", async () => {
    process.env.MONGODB_URI = mongo.replSet.getUri();
    process.env.MONGODB_DB = "lane_laneDb_test";
    try {
      const db = await laneDb();
      expect(db.databaseName).toBe("lane_laneDb_test");
      const names = (await db.collection("proofs").indexes()).map((i) => i.name);
      expect(names).toContain("uniq_claimed_source");
      expect(await laneDb()).not.toBeNull();
    } finally {
      await closeMongoClient();
      delete process.env.MONGODB_URI;
      delete process.env.MONGODB_DB;
    }
  });
});

describe("settings (KTD23)", () => {
  it("falls back to code defaults and reads operator changes fresh", async () => {
    const db = await mongo.freshDb();
    expect(await readSettings(db)).toMatchObject({
      starting_credits: 1000,
      payout_limit: 150,
      dispute_cap_per_day: 3,
      learning_paused: false,
      registration_open: true,
      surprise_checks_enabled: true,
      gate: { min_catch_gain: 0.1, max_false_alarm_rule: 0.01, max_false_alarm_set: 0.02, max_other_class_drop: 0.02 },
    });
    await updateSettings(db, { registration_open: false, gate: { max_false_alarm_rule: 0.02 } });
    const next = await readSettings(db);
    expect(next.registration_open).toBe(false);
    expect(next.gate.max_false_alarm_rule).toBe(0.02);
    expect(next.gate.max_false_alarm_set).toBe(0.02);
    expect(next.payout_limit).toBe(150);
  });

  it("ignores an invalid stored document", () => {
    expect(mergeSettings({ payout_limit: -5 } as never)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("events writer", () => {
  it("writes and lists events newest first, and refuses malformed kinds", async () => {
    const db = await mongo.freshDb();
    await writeEvent(db, { kind: "proof.verdict", summary: "Sam's commit rejected by rule", challenge_id: "chl_1", at: new Date(1000) });
    await writeEvent(db, { kind: "rule.activated", summary: "rename-only v2 active", challenge_id: "chl_1", at: new Date(2000), data: { ai_calls: 0 } });
    const events = await listEvents(db, { challenge_id: "chl_1" });
    expect(events.map((e) => e.kind)).toEqual(["rule.activated", "proof.verdict"]);
    expect((await listEvents(db, { since: new Date(1500) })).length).toBe(1);
    await expect(writeEvent(db, { kind: "Not A Kind", summary: "x" })).rejects.toThrow();
  });
});
