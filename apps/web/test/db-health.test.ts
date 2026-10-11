import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { closeMongoClient, getDb } from "@lane/core/db";
import * as healthRoute from "../app/api/health/db/route";
import { HEALTH_COLLECTION_A, HEALTH_COLLECTION_B } from "../lib/db-health";

// The deploy check route, run against an in-memory single-node replica set.
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
}, 120_000);

afterAll(async () => {
  await closeMongoClient();
  await replSet?.stop();
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB;
});

describe("POST /api/health/db", () => {
  it("answers 503 without MONGODB_URI and does not leak configuration", async () => {
    delete process.env.MONGODB_URI;
    const response = await healthRoute.POST();
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("MONGODB_URI is not set");
  });

  it("commits one transaction across two collections on each call", async () => {
    process.env.MONGODB_URI = replSet.getUri();
    process.env.MONGODB_DB = "lane_health_test";

    const first = await healthRoute.POST();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, transaction: "committed", checks: 1 });

    const second = await healthRoute.POST();
    expect(await second.json()).toMatchObject({ ok: true, transaction: "committed", checks: 2 });

    const db = await getDb();
    const a = await db.collection<{ _id: string; checks: number }>(HEALTH_COLLECTION_A).findOne({ _id: "u1" });
    const b = await db.collection<{ _id: string; checks: number }>(HEALTH_COLLECTION_B).findOne({ _id: "u1" });
    expect(a?.checks).toBe(2);
    expect(b?.checks).toBe(2);
  });
});
