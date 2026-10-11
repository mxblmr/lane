import type { ClientSession, Db, TransactionOptions } from "mongodb";
import { fail, newId, type LaneError } from "./schema/common";
import { collections, isDuplicateKeyError } from "./schema/collections";
import { ledgerDelta, LedgerKindSchema, type LedgerEntry, type LedgerKind } from "./schema/ledger";
import { PLAY_CREDIT_LABEL } from "./config";

/**
 * The single ledger function (KTD12). Every credit movement goes through `appendLedgerEntry`:
 * it appends an entry and updates the player's balance in one transaction, and refuses a debit
 * the balance cannot cover. Stakes, payouts and refunds happen at most once per player and
 * challenge (unique index), and a repeat returns the existing entry (KTD6).
 */

export const TRANSACTION_OPTIONS: TransactionOptions = {
  readPreference: "primary",
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
};

/**
 * Run `fn` in a transaction on `db`'s client. If `session` is already in a transaction,
 * `fn` joins it instead, so callers such as join (U6) and pay (U11) can compose writes.
 */
export async function inTransaction<T>(
  db: Db,
  fn: (session: ClientSession) => Promise<T>,
  session?: ClientSession,
): Promise<T> {
  if (session?.inTransaction()) return fn(session);
  return db.client.withSession((s) => s.withTransaction(() => fn(s), TRANSACTION_OPTIONS));
}

export interface LedgerAppendInput {
  player_id: string;
  /** Null for grants only; required for stakes, payouts and refunds. */
  challenge_id: string | null;
  kind: LedgerKind;
  /** Positive whole credits. The kind gives the sign. */
  amount: number;
  /** Settlement snapshot id, reset id or similar. */
  ref?: string | null;
}

export type LedgerAppendResult =
  | { ok: true; entry: LedgerEntry; duplicate: boolean; balance: number }
  | { ok: false; error: LaneError };

export interface LedgerAppendOptions {
  /** Join an outer transaction (for example U6's join or U11's pay step). */
  session?: ClientSession;
  now?: Date;
}

function validate(input: LedgerAppendInput): { ok: false; error: LaneError } | null {
  if (!LedgerKindSchema.safeParse(input.kind).success) {
    return fail("invalid_input", `Unknown ledger kind ${String(input.kind)}.`, "Use grant, stake, payout or refund.");
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    return fail("invalid_input", "Ledger amounts are positive whole credits.", "Send a whole number of play credits above zero.");
  }
  if (input.kind === "grant" && input.challenge_id !== null) {
    return fail("invalid_input", "Grants are not tied to a challenge.", "Send challenge_id null for grants.");
  }
  if (input.kind !== "grant" && !input.challenge_id) {
    return fail("invalid_input", `A ${input.kind} needs a challenge.`, "Send the challenge id.");
  }
  return null;
}

async function applyEntry(
  db: Db,
  input: LedgerAppendInput,
  session: ClientSession,
  now: Date,
): Promise<LedgerAppendResult> {
  const col = collections(db);
  if (input.challenge_id !== null) {
    const existing = await col.ledger.findOne(
      { challenge_id: input.challenge_id, kind: input.kind, player_id: input.player_id },
      { session },
    );
    if (existing) {
      const player = await col.players.findOne({ _id: input.player_id }, { session, projection: { credits: 1 } });
      return { ok: true, entry: existing, duplicate: true, balance: player?.credits ?? existing.balance_after };
    }
  }

  const delta = ledgerDelta(input.kind, input.amount);
  const filter = delta < 0 ? { _id: input.player_id, credits: { $gte: -delta } } : { _id: input.player_id };
  const updated = await col.players.findOneAndUpdate(
    filter,
    { $inc: { credits: delta }, $set: { updated_at: now } },
    { session, returnDocument: "after" },
  );
  if (!updated) {
    const exists = await col.players.findOne({ _id: input.player_id }, { session, projection: { credits: 1 } });
    if (!exists) {
      return fail("not_found", "That player does not exist.", "Register first with lane_register.");
    }
    return fail(
      "insufficient_credits",
      `The balance of ${exists.credits} ${PLAY_CREDIT_LABEL} cannot cover ${input.amount}.`,
      "Choose a smaller stake.",
    );
  }

  const entry: LedgerEntry = {
    _id: newId("ledger"),
    player_id: input.player_id,
    challenge_id: input.challenge_id,
    kind: input.kind,
    amount: input.amount,
    delta,
    balance_after: updated.credits,
    ref: input.ref ?? null,
    created_at: now,
  };
  await col.ledger.insertOne(entry, { session });
  return { ok: true, entry, duplicate: false, balance: updated.credits };
}

/**
 * Append one ledger entry and update the balance in one transaction.
 * Refused debits write nothing. A repeated stake, payout or refund returns the existing entry.
 */
export async function appendLedgerEntry(
  db: Db,
  input: LedgerAppendInput,
  opts: LedgerAppendOptions = {},
): Promise<LedgerAppendResult> {
  const invalid = validate(input);
  if (invalid) return invalid;
  const now = opts.now ?? new Date();
  try {
    return await inTransaction(db, (session) => applyEntry(db, input, session, now), opts.session);
  } catch (err) {
    // A concurrent writer committed the same stake, payout or refund first.
    if (isDuplicateKeyError(err) && input.challenge_id !== null && !opts.session?.inTransaction()) {
      const col = collections(db);
      const existing = await col.ledger.findOne({
        challenge_id: input.challenge_id,
        kind: input.kind,
        player_id: input.player_id,
      });
      if (existing) {
        const player = await col.players.findOne({ _id: input.player_id }, { projection: { credits: 1 } });
        return { ok: true, entry: existing, duplicate: true, balance: player?.credits ?? existing.balance_after };
      }
    }
    throw err;
  }
}

/** The pot is the sum of the challenge's stake entries (KTD12). */
export async function potOf(db: Db, challengeId: string, session?: ClientSession): Promise<number> {
  const rows = await collections(db)
    .ledger.aggregate<{ total: number }>(
      [{ $match: { challenge_id: challengeId, kind: "stake" } }, { $group: { _id: null, total: { $sum: "$amount" } } }],
      { session },
    )
    .toArray();
  return rows[0]?.total ?? 0;
}

/** Sum of a player's ledger deltas. Equals their balance when every movement went through the ledger. */
export async function ledgerBalanceOf(db: Db, playerId: string, session?: ClientSession): Promise<number> {
  const rows = await collections(db)
    .ledger.aggregate<{ total: number }>(
      [{ $match: { player_id: playerId } }, { $group: { _id: null, total: { $sum: "$delta" } } }],
      { session },
    )
    .toArray();
  return rows[0]?.total ?? 0;
}
