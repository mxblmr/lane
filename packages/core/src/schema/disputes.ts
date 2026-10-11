import { z } from "zod";
import { IdSchema, ShortTextSchema } from "./common";

export const DISPUTE_OUTCOMES = ["pending", "unfounded", "ask_more", "reject"] as const;
export const DisputeOutcomeSchema = z.enum(DISPUTE_OUTCOMES);
export type DisputeOutcome = z.infer<typeof DisputeOutcomeSchema>;

/**
 * `disputes` collection. Written by U18. Unique on (proof_id, disputer_id).
 * The reason is quoted data for the referee only and is never forwarded to the disputed player (KTD15).
 */
export const DisputeSchema = z.object({
  _id: IdSchema,
  challenge_id: IdSchema,
  proof_id: IdSchema,
  disputer_id: IdSchema,
  disputed_player_id: IdSchema,
  reason: ShortTextSchema,
  /** Challenge day index at filing, for the per-day dispute cap (KTD23). */
  day_index: z.int().min(0),
  outcome: DisputeOutcomeSchema,
  referee: z
    .object({
      reason: ShortTextSchema,
      cheat_class: z.string().max(48).nullable(),
      confidence: z.number().min(0).max(1).nullable(),
    })
    .nullable(),
  created_at: z.date(),
  decided_at: z.date().nullable(),
});
export type Dispute = z.infer<typeof DisputeSchema>;
