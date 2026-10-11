import { z } from "zod";
import { HandlePlatformSchema, IdSchema } from "./common";

/** `memberships` collection. Written by U6 (join) and U18 (check-in last-seen fields only, KTD6). */
export const MembershipSchema = z.object({
  _id: IdSchema,
  challenge_id: IdSchema,
  player_id: IdSchema,
  /** The terms version the player accepted in the second join call. */
  accepted_terms_version: z.string().min(1).max(64),
  /** Handle platform the pack needs, or null for Talk to Customers. */
  handle_platform: HandlePlatformSchema.nullable(),
  joined_at: z.date(),
  /** Day index at join. Days before it count as missed. */
  joined_day_index: z.int().min(0),
  last_check_in_at: z.date().nullable(),
  /** Last contract version delivered to this player's agent (R9). */
  last_seen_contract_version: z.int().min(0),
});
export type Membership = z.infer<typeof MembershipSchema>;
