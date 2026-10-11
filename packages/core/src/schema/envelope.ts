import { z } from "zod";
import {
  ChallengeTypeSchema,
  ErrorCodeSchema,
  IdSchema,
  IsoDateTimeSchema,
  PrimitiveMapSchema,
  ToolNameSchema,
} from "./common";
import { ChallengeStatusSchema, ScoreUnitSchema, WinnerRuleSchema } from "./challenges";
import { ActorSchema, InboxKindSchema } from "./inbox";
import { DecidedBySchema, TrustLevelSchema } from "./proofs";

/**
 * Connector result envelope (High-Level Technical Design, "Connector tool surface").
 * Every tool returns this shape. Errors come back as results with a recovery instruction.
 */

/** An action waiting for the player's agent. Built from an inbox action item. */
export const EnvelopeActionSchema = z.object({
  id: IdSchema,
  challenge_id: IdSchema.nullable(),
  kind: InboxKindSchema,
  /** "agent" does it, "player" means the agent relays it to the player. */
  actor: ActorSchema,
  instruction: z.string().max(600),
  due_at: IsoDateTimeSchema.nullable(),
  tool: ToolNameSchema,
  args: PrimitiveMapSchema,
});
export type EnvelopeAction = z.infer<typeof EnvelopeActionSchema>;

export const StandingSchema = z.object({
  player_id: IdSchema,
  display_name: z.string().max(24),
  score: z.int().min(0),
  unit: ScoreUnitSchema,
  rank: z.int().min(1),
  reached_goal: z.boolean(),
  is_you: z.boolean(),
});
export type Standing = z.infer<typeof StandingSchema>;

/** One redacted feed line, built from pack features by Lane (KTD15). */
export const FeedItemSchema = z.object({
  proof_id: IdSchema,
  player_id: IdSchema,
  display_name: z.string().max(24),
  day_index: z.int().min(0),
  /** For example "commit, 3 files, +42/-5". */
  summary: z.string().max(200),
  status: z.string().max(32),
  decided_by: DecidedBySchema.nullable(),
  trust_level: TrustLevelSchema.nullable(),
  at: IsoDateTimeSchema,
});
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const EnvelopeContractSchema = z.object({
  version: z.int().min(1),
  agent_instructions: z.string().max(4000),
  send: z.array(z.string()),
  does_not_count: z.array(z.string()),
  changes: z.array(z.string()),
});
export type EnvelopeContract = z.infer<typeof EnvelopeContractSchema>;

export const EnvelopeChallengeSchema = z.object({
  challenge_id: IdSchema,
  type: ChallengeTypeSchema,
  title: z.string().max(80),
  status: ChallengeStatusSchema,
  /** Current day index on the challenge clock, or null outside the window. */
  day_index: z.int().min(0).nullable(),
  contract_version: z.int().min(0),
  /** True when the contract changed since the player last saw it; `contract` is then set (R9). */
  contract_changed: z.boolean(),
  contract: EnvelopeContractSchema.nullable(),
  actions: z.array(EnvelopeActionSchema),
  /** Info items delivered once (verdicts, standings, messages). Lane-rendered. */
  messages: z.array(z.string().max(600)),
  standings: z.array(StandingSchema),
  feed: z.array(FeedItemSchema),
});
export type EnvelopeChallenge = z.infer<typeof EnvelopeChallengeSchema>;

export const EnvelopeStatusSchema = z.enum(["ok", "pending", "error"]);
export type EnvelopeStatus = z.infer<typeof EnvelopeStatusSchema>;

export const EnvelopeSchema = z.object({
  status: EnvelopeStatusSchema,
  /** One or two plain lines for Muse to relay to the player. */
  lines: z.array(z.string().max(400)).max(3),
  server_time: IsoDateTimeSchema,
  next_check_in_at: IsoDateTimeSchema.nullable(),
  error: z.object({ code: ErrorCodeSchema, recovery: z.string().max(400) }).nullable(),
  /** Tool-specific payload, for example the player key (register only), draft, terms or verdict. */
  data: z.record(z.string(), z.unknown()).nullable(),
  challenges: z.array(EnvelopeChallengeSchema),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * Flat tool arguments (KTD3). `player_key` is accepted as an argument or as a bearer header (KTD4).
 * U7 owns the descriptions; these are the shapes every face (MCP, JSON mirror) parses.
 */
const playerKey = { player_key: z.string().min(16).max(200).optional() };

export const RegisterArgsSchema = z.object({
  display_name: z.string().max(100),
  time_zone: z.string().max(64),
});

export const CreateChallengeArgsSchema = z.object({
  ...playerKey,
  /** The creator's sentence, or the answer to a clarifying question when `draft_id` is set. */
  sentence: z.string().min(1).max(500),
  draft_id: IdSchema.optional(),
});

export const ConfirmChallengeArgsSchema = z.object({
  ...playerKey,
  draft_id: IdSchema,
  winner_rule: WinnerRuleSchema,
  stake: z.int().min(1),
});

export const JoinChallengeArgsSchema = z.object({
  ...playerKey,
  join_code: z.string().min(1).max(12),
  /** Second call only: the terms version the player accepted. */
  accepted_terms_version: z.string().max(64).optional(),
  /** Second call only: the handle the pack needs (GitHub, platform handle, or none). */
  handle: z.string().max(64).optional(),
});

export const CheckInArgsSchema = z.object({ ...playerKey });

/**
 * Proof fields are the flat union of every pack's fields; the pack's proof schema picks its own.
 * Ship Week: repo, sha. Talk to Customers: event_id, starts_at, ends_at, attendees, notes.
 * Build in Public: post_url, platform, post_text.
 */
export const SubmitProofArgsSchema = z.object({
  ...playerKey,
  challenge_id: IdSchema.optional(),
  /** Answer an extra-proof request, surprise check or bind code by its action id. */
  request_id: IdSchema.optional(),
  /** ISO time the source was created, when the agent knows it. Lane re-checks it where it can. */
  source_time: z.string().max(40).optional(),
  repo: z.string().max(200).optional(),
  sha: z.string().max(64).optional(),
  event_id: z.string().max(200).optional(),
  starts_at: z.string().max(40).optional(),
  ends_at: z.string().max(40).optional(),
  attendees: z.array(z.string().max(200)).max(50).optional(),
  notes: z.string().max(4000).optional(),
  post_url: z.string().max(500).optional(),
  platform: z.string().max(20).optional(),
  post_text: z.string().max(4000).optional(),
});
export type SubmitProofArgs = z.infer<typeof SubmitProofArgsSchema>;

export const AskArgsSchema = z.object({
  ...playerKey,
  question: z.string().min(1).max(500),
  challenge_id: IdSchema.optional(),
});

export const DisputeArgsSchema = z.object({
  ...playerKey,
  proof_id: IdSchema,
  reason: z.string().min(1).max(500),
});

export const TOOL_ARGS = {
  lane_register: RegisterArgsSchema,
  lane_create_challenge: CreateChallengeArgsSchema,
  lane_confirm_challenge: ConfirmChallengeArgsSchema,
  lane_join_challenge: JoinChallengeArgsSchema,
  lane_check_in: CheckInArgsSchema,
  lane_submit_proof: SubmitProofArgsSchema,
  lane_ask: AskArgsSchema,
  lane_dispute: DisputeArgsSchema,
} as const;
export type ToolArgs = { [K in keyof typeof TOOL_ARGS]: z.infer<(typeof TOOL_ARGS)[K]> };
