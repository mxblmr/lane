import { withTransaction } from "@lane/core/db";

export const HEALTH_COLLECTION_A = "health_tx_a";
export const HEALTH_COLLECTION_B = "health_tx_b";

type HealthDoc = { _id: string; checks: number; last_check: Date };

export type DbHealthResult =
  | { ok: true; transaction: "committed"; checks: number; latency_ms: number; server_time: string }
  | { ok: false; error: string; server_time: string };

/**
 * Commits one transaction that updates a fixed document in each of two
 * collections. Reports a configuration or connection failure without leaking
 * the connection string.
 */
export async function runDbHealthCheck(now: Date = new Date()): Promise<DbHealthResult> {
  const started = Date.now();
  if (!process.env.MONGODB_URI) {
    return { ok: false, error: "MONGODB_URI is not set", server_time: now.toISOString() };
  }
  try {
    const checks = await withTransaction(async (session, db) => {
      const update = { $inc: { checks: 1 }, $set: { last_check: now } };
      const a = await db
        .collection<HealthDoc>(HEALTH_COLLECTION_A)
        .findOneAndUpdate({ _id: "u1" }, update, { upsert: true, returnDocument: "after", session });
      const b = await db
        .collection<HealthDoc>(HEALTH_COLLECTION_B)
        .findOneAndUpdate({ _id: "u1" }, update, { upsert: true, returnDocument: "after", session });
      if (!a || !b) {
        throw new Error("health upsert returned no document");
      }
      return a.checks;
    });
    return {
      ok: true,
      transaction: "committed",
      checks,
      latency_ms: Date.now() - started,
      server_time: now.toISOString(),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    console.error("db health check failed", name);
    return { ok: false, error: `transaction failed (${name})`, server_time: now.toISOString() };
  }
}
