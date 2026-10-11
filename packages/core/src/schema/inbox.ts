import { z } from "zod";
import { IdSchema, PrimitiveMapSchema, ToolNameSchema } from "./common";

/**
 * Inbox kinds. Action items stay until resolved or expired; info items are delivered once (KTD6).
 * - extra_proof: R17 request tied to one proof (at most one open per proof).
 * - surprise_check: R10/R18, one per (challenge, player, day, slot 0..2).
 * - bind_code: KTD21 handle verification, a player task.
 * - refetch: ask Muse for a fresh fetch (KTD14, Build in Public final check).
 */
export const ACTION_KINDS = ["extra_proof", "surprise_check", "bind_code", "refetch"] as const;
export const INFO_KINDS = ["contract_update", "verdict", "standing", "message", "dispute_notice"] as const;
export const INBOX_KINDS = [...ACTION_KINDS, ...INFO_KINDS] as const;
export const InboxKindSchema = z.enum(INBOX_KINDS);
export type InboxKind = z.infer<typeof InboxKindSchema>;

export function isActionKind(kind: InboxKind): boolean {
  return (ACTION_KINDS as readonly string[]).includes(kind);
}

/** Who does an item: the agent itself, or the agent relays it to the player (KTD5). */
export const ActorSchema = z.enum(["agent", "player"]);
export type Actor = z.infer<typeof ActorSchema>;

/**
 * - scheduled: drawn but not released yet (surprise checks, `release_at` in the future).
 * - open: visible at check-in. Info items move to delivered after one check-in.
 * - resolved / expired / cancelled: final for action items.
 */
export const INBOX_STATUSES = ["scheduled", "open", "resolved", "expired", "delivered", "cancelled"] as const;
export const InboxStatusSchema = z.enum(INBOX_STATUSES);
export type InboxStatus = z.infer<typeof InboxStatusSchema>;

/** `inbox` collection. Written by U18 through the U3 inbox interface. Never projected (KTD15). */
export const InboxItemSchema = z.object({
  _id: IdSchema,
  player_id: IdSchema,
  challenge_id: IdSchema.nullable(),
  kind: InboxKindSchema,
  actor: ActorSchema,
  /** Lane-rendered instruction. Never contains another player's text (KTD15). */
  instruction: z.string().max(600),
  /** Tool and fixed arguments that answer this item. */
  answer_tool: ToolNameSchema.nullable(),
  answer_args: PrimitiveMapSchema,
  day_index: z.int().min(0).nullable(),
  subject_proof_id: IdSchema.nullable(),
  /** Surprise-check slot, 0 to 2 (KTD13). */
  slot: z.int().min(0).max(2).nullable(),
  /** One-time code or bind code the answer must contain. */
  code: z.string().max(32).nullable(),
  /** For scheduled items: when the tick releases it. */
  release_at: z.date().nullable(),
  /** Deadline. An open item past `due_at` reads as expired even before the tick runs (KTD13). */
  due_at: z.date().nullable(),
  status: InboxStatusSchema,
  /** Players notified about this item's outcome, for example a disputer (U18). */
  notify_player_ids: z.array(IdSchema),
  /** The proof that answered this item. */
  answer_proof_id: IdSchema.nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  resolved_at: z.date().nullable(),
  delivered_at: z.date().nullable(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** Input for the inbox `add` interface (U18). Lane fills ids, timestamps and defaults. */
export type NewInboxItem = Omit<
  InboxItem,
  "_id" | "created_at" | "updated_at" | "resolved_at" | "delivered_at" | "answer_proof_id" | "status" | "notify_player_ids"
> & {
  status?: Extract<InboxStatus, "scheduled" | "open">;
  notify_player_ids?: string[];
};

/** Reads treat an open item past its due time as expired, so a late tick changes no outcome (KTD13). */
export function isInboxItemExpired(item: Pick<InboxItem, "status" | "due_at">, now: Date): boolean {
  if (item.status === "expired") return true;
  return item.status === "open" && item.due_at !== null && item.due_at.getTime() <= now.getTime();
}

/** Open, released and not past due. */
export function isInboxItemLive(item: Pick<InboxItem, "status" | "due_at" | "release_at">, now: Date): boolean {
  if (item.status !== "open") return false;
  if (item.release_at && item.release_at.getTime() > now.getTime()) return false;
  return !isInboxItemExpired(item, now);
}
