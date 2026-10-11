import {
  MongoClient,
  type ClientSession,
  type Db,
  type MongoClientOptions,
  type TransactionOptions,
} from "mongodb";

/** Database used when MONGODB_DB is unset. */
export const DEFAULT_DB_NAME = "lane";

/**
 * A small pool: each Vercel function instance holds at most a few connections,
 * so many concurrent instances stay inside the Flex cluster's connection limit.
 */
export const MONGO_CLIENT_OPTIONS: MongoClientOptions = {
  appName: "lane",
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 10_000,
  serverSelectionTimeoutMS: 5_000,
};

const TRANSACTION_OPTIONS: TransactionOptions = {
  readPreference: "primary",
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
};

type MongoCache = { uri: string; promise: Promise<MongoClient> };

// Cached on globalThis so warm Vercel invocations and Next.js dev reloads
// reuse one client per process instead of opening a new pool per request.
const globalForMongo = globalThis as typeof globalThis & {
  __laneMongo?: MongoCache;
};

function readMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set. See .env.example.");
  }
  return uri;
}

/** Name of the Lane database, from MONGODB_DB or the default. */
export function getDbName(): string {
  return process.env.MONGODB_DB || DEFAULT_DB_NAME;
}

/**
 * Returns the process-wide MongoDB client, connecting on first use.
 * Every call in one process returns the same client for the same MONGODB_URI.
 * A failed connect is not cached, so the next call retries.
 */
export function getMongoClient(): Promise<MongoClient> {
  const uri = readMongoUri();
  const cached = globalForMongo.__laneMongo;
  if (cached && cached.uri === uri) {
    return cached.promise;
  }
  if (cached) {
    // The URI changed (tests only): drop the old client.
    void cached.promise.then((client) => client.close()).catch(() => undefined);
  }

  const client = new MongoClient(uri, MONGO_CLIENT_OPTIONS);
  const promise: Promise<MongoClient> = client.connect().catch((error: unknown) => {
    if (globalForMongo.__laneMongo?.promise === promise) {
      globalForMongo.__laneMongo = undefined;
    }
    throw error;
  });
  globalForMongo.__laneMongo = { uri, promise };
  return promise;
}

/** Returns the Lane database on the cached client. */
export async function getDb(name: string = getDbName()): Promise<Db> {
  const client = await getMongoClient();
  return client.db(name);
}

/**
 * Runs `fn` inside one multi-document transaction and returns its result.
 * The driver retries transient transaction errors and unknown commit results.
 * Pass the session to every read and write inside `fn`.
 */
export async function withTransaction<T>(
  fn: (session: ClientSession, db: Db) => Promise<T>,
  options: TransactionOptions = TRANSACTION_OPTIONS,
): Promise<T> {
  const client = await getMongoClient();
  const db = client.db(getDbName());
  return client.withSession((session) =>
    session.withTransaction(() => fn(session, db), options),
  );
}

/** Closes the cached client. For tests and scripts; routes never call it. */
export async function closeMongoClient(): Promise<void> {
  const cached = globalForMongo.__laneMongo;
  globalForMongo.__laneMongo = undefined;
  if (!cached) return;
  try {
    const client = await cached.promise;
    await client.close();
  } catch {
    // A client that never connected has nothing to close.
  }
}
