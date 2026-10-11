import { z } from "zod";
import { ChallengeTypeSchema, IdSchema } from "./common";

/**
 * Known event kinds for the dashboard activity feed. Units may add kinds that follow the
 * `noun.verb` pattern without editing this list.
 */
export const KNOWN_EVENT_KINDS = [
  "player.registered",
  "challenge.drafted",
  "challenge.confirmed",
  "challenge.joined",
  "challenge.day_advanced",
  "challenge.window_closed",
  "challenge.settled",
  "challenge.cancelled",
  "contract.published",
  "proof.received",
  "proof.verdict",
  "proof.held",
  "proof.not_counted",
  "inbox.surprise_check",
  "dispute.filed",
  "dispute.decided",
  "rule.proposed",
  "rule.tested",
  "rule.pending_approval",
  "rule.activated",
  "rule.rejected",
  "rule.rolled_back",
  "approval.decided",
  "ledger.payout",
  "job.failed",
  "stage.reset",
] as const;

export const EVENT_KIND_PATTERN = /^[a-z_]+(\.[a-z_]+)+$/;
export const EventKindSchema = z.string().regex(EVENT_KIND_PATTERN).max(64);

/** Event data holds ids, counts and pack features only, never player or model text (KTD15). */
export const EventDataSchema = z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]));
export type EventData = z.infer<typeof EventDataSchema>;

/** `events` collection: activity feed for the dashboard. Every unit writes through `events.ts`. */
export const LaneEventSchema = z.object({
  _id: IdSchema,
  at: z.date(),
  kind: EventKindSchema,
  challenge_id: IdSchema.nullable(),
  challenge_type: ChallengeTypeSchema.nullable(),
  player_id: IdSchema.nullable(),
  proof_id: IdSchema.nullable(),
  rule_key: z.string().max(64).nullable(),
  rule_version: z.int().min(1).nullable(),
  /** Lane-rendered one-line summary. */
  summary: z.string().max(300),
  data: EventDataSchema,
});
export type LaneEvent = z.infer<typeof LaneEventSchema>;
