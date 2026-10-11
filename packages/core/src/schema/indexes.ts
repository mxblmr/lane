import type { CreateIndexesOptions, Db, IndexSpecification } from "mongodb";
import { HANDLE_PLATFORMS } from "./common";
import { COLLECTIONS, type CollectionName } from "./collections";

export interface IndexDef {
  collection: CollectionName;
  name: string;
  keys: IndexSpecification;
  options: CreateIndexesOptions;
}

/**
 * Unique indexes from the data model (KTD6), plus the lookup indexes the hot paths need.
 * Created at startup by `ensureIndexes`. Names are stable so creation is idempotent.
 */
export const UNIQUE_INDEXES: IndexDef[] = [
  { collection: "players", name: "uniq_key_hash", keys: { key_hash: 1 }, options: { unique: true } },
  // One partial unique index per handle platform over verified handles (KTD21).
  ...HANDLE_PLATFORMS.map(
    (platform): IndexDef => ({
      collection: "players",
      name: `uniq_verified_handle_${platform}`,
      keys: { [`handles.${platform}.handle`]: 1 },
      options: { unique: true, partialFilterExpression: { [`handles.${platform}.status`]: "verified" } },
    }),
  ),
  {
    collection: "challenges",
    name: "uniq_join_code",
    keys: { join_code: 1 },
    options: { unique: true, partialFilterExpression: { join_code: { $type: "string" } } },
  },
  {
    collection: "memberships",
    name: "uniq_challenge_player",
    keys: { challenge_id: 1, player_id: 1 },
    options: { unique: true },
  },
  {
    collection: "proofs",
    name: "uniq_challenge_player_source",
    keys: { challenge_id: 1, player_id: 1, source_key: 1 },
    options: { unique: true },
  },
  {
    collection: "proofs",
    name: "uniq_claimed_source",
    keys: { challenge_id: 1, source_key: 1 },
    options: { unique: true, partialFilterExpression: { claimed: true } },
  },
  {
    collection: "inbox",
    name: "uniq_open_extra_proof",
    keys: { subject_proof_id: 1 },
    options: { unique: true, partialFilterExpression: { kind: "extra_proof", status: "open" } },
  },
  {
    collection: "inbox",
    name: "uniq_surprise_slot",
    keys: { challenge_id: 1, player_id: 1, day_index: 1, slot: 1 },
    options: { unique: true, partialFilterExpression: { kind: "surprise_check" } },
  },
  {
    collection: "disputes",
    name: "uniq_proof_disputer",
    keys: { proof_id: 1, disputer_id: 1 },
    options: { unique: true },
  },
  {
    collection: "rules",
    name: "uniq_active_rule_key",
    keys: { challenge_type: 1, rule_key: 1 },
    options: { unique: true, partialFilterExpression: { status: "active" } },
  },
  {
    collection: "rules",
    name: "uniq_rule_version",
    keys: { challenge_type: 1, rule_key: 1, version: 1 },
    options: { unique: true },
  },
  {
    // Stakes, payouts and refunds: entries with a challenge. Grants have challenge_id null.
    collection: "ledger",
    name: "uniq_challenge_kind_player",
    keys: { challenge_id: 1, kind: 1, player_id: 1 },
    options: { unique: true, partialFilterExpression: { challenge_id: { $type: "string" } } },
  },
  {
    collection: "examples",
    name: "uniq_type_example_key",
    keys: { challenge_type: 1, example_key: 1 },
    options: { unique: true },
  },
  { collection: "jobs", name: "uniq_kind_dedup", keys: { kind: 1, dedup_key: 1 }, options: { unique: true } },
  {
    collection: "contracts",
    name: "uniq_challenge_version",
    keys: { challenge_id: 1, version: 1 },
    options: { unique: true },
  },
];

export const LOOKUP_INDEXES: IndexDef[] = [
  // KTD7: active rules read with one indexed query on every evaluation.
  { collection: "rules", name: "by_type_status", keys: { challenge_type: 1, status: 1 }, options: {} },
  { collection: "proofs", name: "by_challenge_day", keys: { challenge_id: 1, player_id: 1, day_index: 1 }, options: {} },
  { collection: "proofs", name: "by_challenge_received", keys: { challenge_id: 1, received_at: -1 }, options: {} },
  { collection: "inbox", name: "by_player_status", keys: { player_id: 1, status: 1, challenge_id: 1 }, options: {} },
  { collection: "inbox", name: "by_status_release", keys: { status: 1, release_at: 1 }, options: {} },
  { collection: "inbox", name: "by_status_due", keys: { status: 1, due_at: 1 }, options: {} },
  { collection: "memberships", name: "by_player", keys: { player_id: 1 }, options: {} },
  { collection: "challenges", name: "by_status_type", keys: { status: 1, type: 1 }, options: {} },
  { collection: "contracts", name: "by_challenge_latest", keys: { challenge_id: 1, version: -1 }, options: {} },
  { collection: "jobs", name: "by_status_due", keys: { status: 1, due_at: 1 }, options: {} },
  { collection: "jobs", name: "by_status_renewed", keys: { status: 1, renewed_at: 1 }, options: {} },
  { collection: "ledger", name: "by_player", keys: { player_id: 1, created_at: 1 }, options: {} },
  { collection: "events", name: "by_challenge_at", keys: { challenge_id: 1, at: -1 }, options: {} },
  { collection: "events", name: "by_at", keys: { at: -1 }, options: {} },
  { collection: "approvals", name: "by_status_kind", keys: { status: 1, kind: 1 }, options: {} },
  { collection: "disputes", name: "by_disputer_day", keys: { challenge_id: 1, disputer_id: 1, day_index: 1 }, options: {} },
];

export const ALL_INDEXES: IndexDef[] = [...UNIQUE_INDEXES, ...LOOKUP_INDEXES];

const ensured = new WeakMap<Db, Promise<void>>();

/** Create every index once per process and database. Safe to call on every cold start. */
export function ensureIndexes(db: Db): Promise<void> {
  let pending = ensured.get(db);
  if (!pending) {
    pending = createAll(db).catch((err: unknown) => {
      ensured.delete(db);
      throw err;
    });
    ensured.set(db, pending);
  }
  return pending;
}

async function createAll(db: Db): Promise<void> {
  const byCollection = new Map<CollectionName, IndexDef[]>();
  for (const def of ALL_INDEXES) {
    const list = byCollection.get(def.collection) ?? [];
    list.push(def);
    byCollection.set(def.collection, list);
  }
  await Promise.all(
    [...byCollection.entries()].map(async ([name, defs]) => {
      await db.collection(COLLECTIONS[name]).createIndexes(
        defs.map((d) => ({ key: d.keys as Record<string, 1 | -1>, name: d.name, ...d.options })),
      );
    }),
  );
}
