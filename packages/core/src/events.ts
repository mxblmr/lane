import type { ClientSession, Db, Filter } from "mongodb";
import { newId, type ChallengeType } from "./schema/common";
import { collections } from "./schema/collections";
import { LaneEventSchema, type EventData, type LaneEvent } from "./schema/events";

/**
 * The `events` writer: the dashboard's activity feed. Every unit writes events through here.
 * Summaries are Lane-rendered, and `data` holds ids, counts and pack features only, never
 * player or model text (KTD15).
 */

export interface NewEvent {
  kind: string;
  summary: string;
  challenge_id?: string | null;
  challenge_type?: ChallengeType | null;
  player_id?: string | null;
  proof_id?: string | null;
  rule_key?: string | null;
  rule_version?: number | null;
  data?: EventData;
  at?: Date;
}

export async function writeEvent(db: Db, input: NewEvent, opts: { session?: ClientSession } = {}): Promise<LaneEvent> {
  const event = LaneEventSchema.parse({
    _id: newId("event"),
    at: input.at ?? new Date(),
    kind: input.kind,
    challenge_id: input.challenge_id ?? null,
    challenge_type: input.challenge_type ?? null,
    player_id: input.player_id ?? null,
    proof_id: input.proof_id ?? null,
    rule_key: input.rule_key ?? null,
    rule_version: input.rule_version ?? null,
    summary: input.summary.slice(0, 300),
    data: input.data ?? {},
  });
  await collections(db).events.insertOne(event, { session: opts.session });
  return event;
}

export interface ListEventsInput {
  challenge_id?: string;
  challenge_type?: ChallengeType;
  /** Only events after this time, for polling. */
  since?: Date;
  limit?: number;
}

/** Newest first. */
export async function listEvents(db: Db, input: ListEventsInput = {}): Promise<LaneEvent[]> {
  const filter: Filter<LaneEvent> = {};
  if (input.challenge_id) filter.challenge_id = input.challenge_id;
  if (input.challenge_type) filter.challenge_type = input.challenge_type;
  if (input.since) filter.at = { $gt: input.since };
  return collections(db)
    .events.find(filter)
    .sort({ at: -1 })
    .limit(Math.min(input.limit ?? 50, 500))
    .toArray();
}
