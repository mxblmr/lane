import { MongoClient, type Db } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { ensureIndexes } from "../../src/schema/indexes";

/**
 * In-memory single-node replica set for tests, so transactions work (KTD2).
 * Usage:
 *   const mongo = useReplSet();            // at file top level, registers beforeAll/afterAll
 *   it("...", async () => { const db = mongo.db(); ... });
 * Each call to `freshDb()` returns an empty database with every index created.
 */
export interface TestMongo {
  client: MongoClient;
  replSet: MongoMemoryReplSet;
  freshDb(): Promise<Db>;
  stop(): Promise<void>;
}

let counter = 0;

export async function startReplSet(): Promise<TestMongo> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const client = await new MongoClient(replSet.getUri()).connect();
  return {
    client,
    replSet,
    async freshDb() {
      counter += 1;
      const db = client.db(`lane_test_${process.pid}_${counter}`);
      await ensureIndexes(db);
      return db;
    },
    async stop() {
      await client.close();
      await replSet.stop();
    },
  };
}
