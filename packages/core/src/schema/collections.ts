import type { Collection, Db } from "mongodb";
import type { Player } from "./players";
import type { Challenge } from "./challenges";
import type { Contract } from "./contracts";
import type { Membership } from "./memberships";
import type { Proof } from "./proofs";
import type { InboxItem } from "./inbox";
import type { Rule } from "./rules";
import type { Example } from "./examples";
import type { Dispute } from "./disputes";
import type { Approval } from "./approvals";
import type { LedgerEntry } from "./ledger";
import type { Job } from "./jobs";
import type { Settings } from "./settings";
import type { OpsLease } from "./ops";
import type { LaneEvent } from "./events";

/** Collection names from the data model. */
export const COLLECTIONS = {
  players: "players",
  challenges: "challenges",
  contracts: "contracts",
  memberships: "memberships",
  proofs: "proofs",
  inbox: "inbox",
  rules: "rules",
  examples: "examples",
  disputes: "disputes",
  approvals: "approvals",
  ledger: "ledger",
  jobs: "jobs",
  settings: "settings",
  ops: "ops",
  events: "events",
} as const;
export type CollectionName = keyof typeof COLLECTIONS;

export interface LaneCollections {
  players: Collection<Player>;
  challenges: Collection<Challenge>;
  contracts: Collection<Contract>;
  memberships: Collection<Membership>;
  proofs: Collection<Proof>;
  inbox: Collection<InboxItem>;
  rules: Collection<Rule>;
  examples: Collection<Example>;
  disputes: Collection<Dispute>;
  approvals: Collection<Approval>;
  ledger: Collection<LedgerEntry>;
  jobs: Collection<Job>;
  settings: Collection<Settings>;
  ops: Collection<OpsLease>;
  events: Collection<LaneEvent>;
}

/** Typed handles for every collection. Use this rather than `db.collection("...")`. */
export function collections(db: Db): LaneCollections {
  return {
    players: db.collection<Player>(COLLECTIONS.players),
    challenges: db.collection<Challenge>(COLLECTIONS.challenges),
    contracts: db.collection<Contract>(COLLECTIONS.contracts),
    memberships: db.collection<Membership>(COLLECTIONS.memberships),
    proofs: db.collection<Proof>(COLLECTIONS.proofs),
    inbox: db.collection<InboxItem>(COLLECTIONS.inbox),
    rules: db.collection<Rule>(COLLECTIONS.rules),
    examples: db.collection<Example>(COLLECTIONS.examples),
    disputes: db.collection<Dispute>(COLLECTIONS.disputes),
    approvals: db.collection<Approval>(COLLECTIONS.approvals),
    ledger: db.collection<LedgerEntry>(COLLECTIONS.ledger),
    jobs: db.collection<Job>(COLLECTIONS.jobs),
    settings: db.collection<Settings>(COLLECTIONS.settings),
    ops: db.collection<OpsLease>(COLLECTIONS.ops),
    events: db.collection<LaneEvent>(COLLECTIONS.events),
  };
}

/** True when a MongoDB error is a duplicate-key error (KTD6: the write already happened). */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === 11000;
}
