import type { Db, Filter } from "mongodb";
import { fail, newId, type Id } from "./schema/common";
import { collections, isDuplicateKeyError } from "./schema/collections";
import {
  ACTION_KINDS,
  INFO_KINDS,
  InboxItemSchema,
  isActionKind,
  isInboxItemExpired,
  isInboxItemLive,
  type InboxItem,
  type NewInboxItem,
} from "./schema/inbox";
import type { Proof, ProofHistoryEntry } from "./schema/proofs";
import type {
  InboxAddResult,
  InboxExpireInput,
  InboxExpireResult,
  InboxResolveInput,
  InboxResolveResult,
  InboxWriteOptions,
} from "./interfaces";

/**
 * The inbox (U18, implements the U3 inbox interface). Lane's only channel to players (R11).
 *
 * - Action items stay until resolved or expired; info items are delivered once (KTD6).
 * - A proof has at most one open extra-proof request (unique index). Adding a second request for
 *   the same proof returns the open one and only adds the new notify ids, which is how a dispute
 *   on a proof that already has a request adds the disputer for notification only.
 * - Only the player who owns the subject proof or surprise-check slot can answer a request.
 * - Reads treat an open item past its due time as expired (KTD13), so a late tick changes nothing.
 */

const ACTION_KIND_LIST = [...ACTION_KINDS];
const INFO_KIND_LIST = [...INFO_KINDS];

function assertAddable(item: NewInboxItem): void {
  if (item.kind === "extra_proof" && !item.subject_proof_id) {
    throw new Error("inbox.add: an extra_proof item needs subject_proof_id");
  }
  if (item.kind === "surprise_check") {
    if (!item.challenge_id || item.day_index === null || item.slot === null) {
      throw new Error("inbox.add: a surprise_check item needs challenge_id, day_index and slot");
    }
  }
}

/** The open (or scheduled) item a unique index would collide with, if any. */
async function findCollision(db: Db, item: NewInboxItem, opts: InboxWriteOptions): Promise<InboxItem | null> {
  const col = collections(db).inbox;
  if (item.kind === "extra_proof" && (item.status ?? "open") === "open") {
    return col.findOne(
      { kind: "extra_proof", status: "open", subject_proof_id: item.subject_proof_id },
      { session: opts.session },
    );
  }
  if (item.kind === "surprise_check") {
    return col.findOne(
      {
        kind: "surprise_check",
        challenge_id: item.challenge_id,
        player_id: item.player_id,
        day_index: item.day_index,
        slot: item.slot,
      },
      { session: opts.session },
    );
  }
  return null;
}

/** Merge extra notify ids into an existing item and return it. */
async function mergeNotify(db: Db, existing: InboxItem, ids: readonly string[], opts: InboxWriteOptions): Promise<InboxItem> {
  const fresh = ids.filter((id) => !existing.notify_player_ids.includes(id) && id !== existing.player_id);
  if (fresh.length === 0) return existing;
  const now = opts.now ?? new Date();
  const updated = await collections(db).inbox.findOneAndUpdate(
    { _id: existing._id },
    { $addToSet: { notify_player_ids: { $each: fresh } }, $set: { updated_at: now } },
    { returnDocument: "after", session: opts.session },
  );
  return updated ?? existing;
}

/**
 * Add an inbox item. Idempotent on the unique indexes (KTD6): an open extra-proof request for the
 * same proof, or the same surprise-check slot, returns the existing item with `created: false`.
 * Items with a future `release_at` start as scheduled; the tick releases them when due.
 */
export async function addInboxItem(db: Db, item: NewInboxItem, opts: InboxWriteOptions = {}): Promise<InboxAddResult> {
  assertAddable(item);
  const now = opts.now ?? new Date();
  const col = collections(db).inbox;
  const notify = item.notify_player_ids ?? [];

  const existing = await findCollision(db, item, opts);
  if (existing) {
    if (existing.kind === "extra_proof" && isInboxItemExpired(existing, now)) {
      // The old request is past due: expire it so a new one can open.
      await col.updateOne(
        { _id: existing._id, status: "open" },
        { $set: { status: "expired", updated_at: now } },
        { session: opts.session },
      );
    } else {
      return { item: await mergeNotify(db, existing, notify, opts), created: false };
    }
  }

  const status = item.status ?? (item.release_at && item.release_at.getTime() > now.getTime() ? "scheduled" : "open");
  const doc: InboxItem = InboxItemSchema.parse({
    ...item,
    _id: newId("inbox"),
    status,
    notify_player_ids: [...new Set(notify.filter((id) => id !== item.player_id))],
    answer_proof_id: null,
    created_at: now,
    updated_at: now,
    resolved_at: null,
    delivered_at: null,
  });
  try {
    await col.insertOne(doc, { session: opts.session });
    return { item: doc, created: true };
  } catch (err) {
    if (!isDuplicateKeyError(err) || opts.session?.inTransaction()) throw err;
    const raced = await findCollision(db, item, {});
    if (!raced) throw err;
    return { item: await mergeNotify(db, raced, notify, { now }), created: false };
  }
}

function historyEntry(from: Proof["status"], to: Proof["status"], at: Date, note: string): ProofHistoryEntry {
  return { at, from, to, by: "system", note };
}

/**
 * Release a surprise-check hold on a player's day: proofs held for that day's check go back to
 * accepted, unless another check for the same day is still live.
 */
async function releaseSurpriseHold(db: Db, item: InboxItem, now: Date): Promise<number> {
  if (item.kind !== "surprise_check" || item.challenge_id === null || item.day_index === null) return 0;
  const col = collections(db);
  const others = await col.inbox
    .find({
      _id: { $ne: item._id },
      kind: "surprise_check",
      challenge_id: item.challenge_id,
      player_id: item.player_id,
      day_index: item.day_index,
      status: "open",
    })
    .toArray();
  if (others.some((o) => isInboxItemLive(o, now))) return 0;
  const res = await col.proofs.updateMany(
    {
      challenge_id: item.challenge_id,
      player_id: item.player_id,
      day_index: item.day_index,
      status: "held",
      held_reason: "surprise_check",
    },
    {
      $set: { status: "accepted", held_reason: null, updated_at: now },
      $push: { history: historyEntry("held", "accepted", now, "surprise check answered") },
    },
  );
  return res.modifiedCount;
}

/** Lane-rendered notice to players watching an item (for example a disputer). Never quotes anyone. */
async function notifyWatchers(db: Db, item: InboxItem, outcome: "answered" | "expired", now: Date): Promise<void> {
  if (item.notify_player_ids.length === 0) return;
  const instruction =
    outcome === "answered"
      ? "The extra-proof request on a proof you disputed was answered. The referees will re-check it."
      : "The extra-proof request on a proof you disputed was not answered in time, so that proof does not count.";
  for (const player_id of item.notify_player_ids) {
    await addInboxItem(
      db,
      {
        player_id,
        challenge_id: item.challenge_id,
        kind: "dispute_notice",
        actor: "player",
        instruction,
        answer_tool: null,
        answer_args: {},
        day_index: item.day_index,
        subject_proof_id: item.subject_proof_id,
        slot: null,
        code: null,
        release_at: null,
        due_at: null,
      },
      { now },
    );
  }
}

/**
 * Resolve an action item with the answering proof. Only the player the item is for, who owns the
 * subject proof or slot, can answer it. Idempotent: resolving a resolved item returns it with
 * `resolved: false`. An item past its due time is refused, even before the tick expires it.
 */
export async function resolveInboxItem(db: Db, input: InboxResolveInput): Promise<InboxResolveResult> {
  const now = input.now ?? new Date();
  const col = collections(db);
  const item = await col.inbox.findOne({ _id: input.item_id });
  if (!item) {
    return fail("not_found", "Lane has no request with that id.", "Call lane_check_in to get your open requests and their ids.");
  }
  const notYours = fail(
    "not_allowed",
    "Only the player this request is for can answer it.",
    "Answer only the requests listed in your own check-in.",
  );
  if (item.player_id !== input.by_player_id) return notYours;
  if (item.kind === "extra_proof" && item.subject_proof_id) {
    const subject = await col.proofs.findOne({ _id: item.subject_proof_id }, { projection: { player_id: 1 } });
    if (subject && subject.player_id !== input.by_player_id) return notYours;
  }
  if (!isActionKind(item.kind)) {
    return fail("invalid_input", "That item is a message and needs no answer.", "Call lane_check_in for requests that need an answer.");
  }
  if (item.status === "resolved") return { ok: true, item, resolved: false };
  if (item.status === "scheduled" || (item.release_at && item.release_at.getTime() > now.getTime())) {
    return fail("not_found", "That request is not open yet.", "Call lane_check_in to get your open requests.");
  }
  const closed = fail(
    "grace_closed",
    "That request closed before it was answered.",
    "Call lane_check_in to see your current requests.",
  );
  if (item.status !== "open" || isInboxItemExpired(item, now)) return closed;

  const updated = await col.inbox.findOneAndUpdate(
    { _id: item._id, status: "open", $or: [{ due_at: null }, { due_at: { $gt: now } }] },
    {
      $set: {
        status: "resolved",
        resolved_at: now,
        updated_at: now,
        answer_proof_id: input.answer_proof_id ?? null,
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    const again = await col.inbox.findOne({ _id: item._id });
    if (again?.status === "resolved") return { ok: true, item: again, resolved: false };
    return closed;
  }
  await releaseSurpriseHold(db, updated, now);
  await notifyWatchers(db, updated, "answered", now);
  return { ok: true, item: updated, resolved: true };
}

/**
 * Expire action items.
 * - With neither `item_ids` nor `challenge_id`: expire every open action item past its due time
 *   (the tick's grace expiry).
 * - With `item_ids` or `challenge_id`: expire every matching open or scheduled action item now,
 *   regardless of due time (for example when reset cancels a challenge, KTD22).
 * Each item moves by a conditional update, so concurrent callers expire it once.
 */
export async function expireInboxItems(db: Db, input: InboxExpireInput): Promise<InboxExpireResult> {
  const now = input.now;
  const col = collections(db).inbox;
  const forced = Boolean(input.item_ids || input.challenge_id);
  const filter: Filter<InboxItem> = forced
    ? { kind: { $in: ACTION_KIND_LIST }, status: { $in: ["open", "scheduled"] } }
    : { kind: { $in: ACTION_KIND_LIST }, status: "open", due_at: { $ne: null, $lte: now } };
  if (input.item_ids) filter._id = { $in: input.item_ids };
  if (input.challenge_id) filter.challenge_id = input.challenge_id;

  const candidates = await col.find(filter).toArray();
  const expired: InboxItem[] = [];
  for (const item of candidates) {
    const where: Filter<InboxItem> = forced
      ? { _id: item._id, status: { $in: ["open", "scheduled"] } }
      : { _id: item._id, status: "open", due_at: { $ne: null, $lte: now } };
    const updated = await col.findOneAndUpdate(where, { $set: { status: "expired", updated_at: now } }, { returnDocument: "after" });
    if (updated) expired.push(updated);
  }
  if (!forced) {
    for (const item of expired) await notifyWatchers(db, item, "expired", now);
  }
  return { expired };
}

/**
 * Release scheduled items whose release time has come (KTD13). A scheduled item already past its
 * due time when the tick first sees it is cancelled rather than released, so a late tick never
 * shows a player a check that is already over.
 */
export async function releaseDueInboxItems(db: Db, now: Date): Promise<{ released: InboxItem[]; cancelled: InboxItem[] }> {
  const col = collections(db).inbox;
  const due = await col.find({ status: "scheduled", release_at: { $ne: null, $lte: now } }).toArray();
  const released: InboxItem[] = [];
  const cancelled: InboxItem[] = [];
  for (const item of due) {
    const missed = item.due_at !== null && item.due_at.getTime() <= now.getTime();
    const updated = await col.findOneAndUpdate(
      { _id: item._id, status: "scheduled" },
      { $set: { status: missed ? "cancelled" : "open", updated_at: now } },
      { returnDocument: "after" },
    );
    if (updated) (missed ? cancelled : released).push(updated);
  }
  return { released, cancelled };
}

/** Open action items for a player in one challenge that are live now, earliest due first. */
export async function listOpenActions(db: Db, playerId: Id, challengeId: Id, now: Date): Promise<InboxItem[]> {
  const items = await collections(db)
    .inbox.find({ player_id: playerId, challenge_id: challengeId, kind: { $in: ACTION_KIND_LIST }, status: "open" })
    .sort({ created_at: 1 })
    .toArray();
  return items
    .filter((i) => isInboxItemLive(i, now))
    .sort((a, b) => (a.due_at?.getTime() ?? Infinity) - (b.due_at?.getTime() ?? Infinity));
}

/**
 * Deliver a player's open info items for one challenge, once (KTD6). Each item moves from open to
 * delivered by a conditional update, so two concurrent check-ins never both return it.
 */
export async function deliverInfoItems(db: Db, playerId: Id, challengeId: Id, now: Date): Promise<InboxItem[]> {
  const col = collections(db).inbox;
  const candidates = await col
    .find({
      player_id: playerId,
      challenge_id: challengeId,
      kind: { $in: INFO_KIND_LIST },
      status: "open",
      $or: [{ release_at: null }, { release_at: { $lte: now } }],
    })
    .sort({ created_at: 1 })
    .toArray();
  const delivered: InboxItem[] = [];
  for (const item of candidates) {
    const updated = await col.findOneAndUpdate(
      { _id: item._id, status: "open" },
      { $set: { status: "delivered", delivered_at: now, updated_at: now } },
      { returnDocument: "after" },
    );
    if (updated) delivered.push(updated);
  }
  return delivered;
}

/** The U18 inbox service, in the shape of `LaneServices["inbox"]`. */
export const inboxService = {
  add: addInboxItem,
  resolve: resolveInboxItem,
  expire: expireInboxItems,
};
