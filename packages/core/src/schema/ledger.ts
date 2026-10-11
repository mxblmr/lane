import { z } from "zod";
import { IdSchema } from "./common";

/** grant and payout and refund credit the player; stake debits the player. */
export const LEDGER_KINDS = ["grant", "stake", "payout", "refund"] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

export const DEBIT_KINDS: readonly LedgerKind[] = ["stake"];
export function ledgerDelta(kind: LedgerKind, amount: number): number {
  return DEBIT_KINDS.includes(kind) ? -amount : amount;
}

/**
 * `ledger` collection. Append-only, written only by the ledger function (KTD12).
 * Unique on (challenge_id, kind, player_id) for entries that have a challenge
 * (stakes, payouts and refunds), so each happens at most once per player and challenge.
 */
export const LedgerEntrySchema = z.object({
  _id: IdSchema,
  player_id: IdSchema,
  /** Null only for grants. */
  challenge_id: IdSchema.nullable(),
  kind: LedgerKindSchema,
  /** Always positive. The sign comes from the kind. */
  amount: z.int().min(1),
  /** Signed change to the player's balance. */
  delta: z.int(),
  balance_after: z.int().min(0),
  /** Settlement snapshot id, reset id or similar. */
  ref: z.string().max(100).nullable(),
  created_at: z.date(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
