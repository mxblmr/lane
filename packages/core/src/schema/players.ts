import { z } from "zod";
import { DisplayNameSchema, HandlePlatformSchema, IdSchema, TimeZoneSchema } from "./common";

/**
 * One bound handle (KTD21). Handles are keyed by platform on the player, so the
 * partial unique index per platform covers verified handles only.
 * `handle` is stored normalized (lowercase, no leading `@`).
 */
export const HandleSchema = z.object({
  platform: HandlePlatformSchema,
  handle: z.string().min(1).max(64),
  status: z.enum(["unverified", "verified"]),
  bind_code: z.string().max(32).nullable(),
  verified_at: z.date().nullable(),
});
export type Handle = z.infer<typeof HandleSchema>;

export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/** `players` collection. Written by U6 and by the ledger function (credits). */
export const PlayerSchema = z.object({
  _id: IdSchema,
  display_name: DisplayNameSchema,
  time_zone: TimeZoneSchema,
  /** SHA-256 hex of the player key. The key itself is never stored (KTD4). */
  key_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Routine text returned at registration and stored once (KTD5). Never projected. */
  routine_text: z.string().max(4000),
  handles: z.partialRecord(HandlePlatformSchema, HandleSchema),
  /** Balance in play credits. Only the ledger function changes it (KTD12). */
  credits: z.int().min(0),
  /** Scripted demo players (KTD17). */
  scripted: z.boolean().default(false),
  created_at: z.date(),
  updated_at: z.date(),
});
export type Player = z.infer<typeof PlayerSchema>;
