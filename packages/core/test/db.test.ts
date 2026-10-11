import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { closeMongoClient, getDb, getMongoClient, withTransaction } from "../src/db";

type PlayerDoc = { _id: string; balance: number };

// An in-memory single-node replica set, so multi-document transactions work (KTD2).
let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB = "lane_test";
});

afterAll(async () => {
  await closeMongoClient();
  await replSet?.stop();
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB;
});

describe("getMongoClient", () => {
  it("returns the same client across two calls in one process", async () => {
    const first = await getMongoClient();
    const second = await getMongoClient();
    expect(second).toBe(first);

    const [third, fourth] = await Promise.all([getMongoClient(), getMongoClient()]);
    expect(third).toBe(first);
    expect(fourth).toBe(first);
  });

  it("uses a small connection pool", async () => {
    const client = await getMongoClient();
    expect(client.options.maxPoolSize).toBe(5);
  });

  it("opens the database named by MONGODB_DB", async () => {
    const db = await getDb();
    expect(db.databaseName).toBe("lane_test");
  });

  it("refuses to connect without MONGODB_URI", async () => {
    const saved = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      expect(() => getMongoClient()).toThrow(/MONGODB_URI/);
    } finally {
      process.env.MONGODB_URI = saved;
    }
  });
});

describe("withTransaction", () => {
  it("commits a multi-document transaction across two collections", async () => {
    const db = await getDb();
    await db.createCollection("tx_players");
    await db.createCollection("tx_ledger");

    const result = await withTransaction(async (session, txDb) => {
      await txDb
        .collection<PlayerDoc>("tx_players")
        .insertOne({ _id: "player-1", balance: 1000 }, { session });
      await txDb
        .collection("tx_ledger")
        .insertOne({ player: "player-1", kind: "grant", amount: 1000 }, { session });
      await txDb
        .collection<PlayerDoc>("tx_players")
        .updateOne({ _id: "player-1" }, { $inc: { balance: -50 } }, { session });
      await txDb
        .collection("tx_ledger")
        .insertOne({ player: "player-1", kind: "stake", amount: -50 }, { session });
      return "committed";
    });

    expect(result).toBe("committed");
    const player = await db.collection<PlayerDoc>("tx_players").findOne({ _id: "player-1" });
    expect(player?.balance).toBe(950);
    expect(await db.collection("tx_ledger").countDocuments({ player: "player-1" })).toBe(2);
  });

  it("rolls back every write when the transaction throws", async () => {
    const db = await getDb();

    await expect(
      withTransaction(async (session, txDb) => {
        await txDb
          .collection<PlayerDoc>("tx_players")
          .insertOne({ _id: "player-2", balance: 1000 }, { session });
        await txDb
          .collection("tx_ledger")
          .insertOne({ player: "player-2", kind: "grant", amount: 1000 }, { session });
        throw new Error("abort on purpose");
      }),
    ).rejects.toThrow("abort on purpose");

    expect(await db.collection<PlayerDoc>("tx_players").findOne({ _id: "player-2" })).toBeNull();
    expect(await db.collection("tx_ledger").countDocuments({ player: "player-2" })).toBe(0);
  });
});
