import type { z } from "zod";
import type { ChallengeType, Features, HandlePlatform, Id, Params } from "./common";
import type { Challenge, ScoreUnit, WinnerRule } from "./challenges";
import type { Handle, Player } from "./players";
import type { InboxItem, NewInboxItem } from "./inbox";
import type { NotCountedReason, Proof } from "./proofs";
import type { Cond, Op, RuleAction, When } from "./rule";
import type { LabelledExample } from "./examples";

/**
 * The challenge-pack interface (U3 approach step 3). Each pack unit (U14, U15, U16)
 * replaces only its own folder under `packs/`, and the registry in `packs/index.ts`
 * maps each challenge type to its pack.
 */

export type FeatureKind = "boolean" | "number" | "string" | "string_list";

export interface FeatureSpec {
  kind: FeatureKind;
  description: string;
  /** Operators a rule may use on this feature. */
  ops: readonly Op[];
  /** Hard bound on numeric rule parameters (KTD9), for example code_lines_changed max 20. */
  bound?: { min?: number; max?: number };
}

/** Feature name to spec. Cheat class ids match feature names. */
export type FeatureCatalog = Record<string, FeatureSpec>;

/** KTD14 re-check outcome. */
export type RecheckStatus = "rechecked" | "agent_attested" | "pending" | "failed";

/** Source content a re-check fetched, passed to the feature extractor and (capped, quoted) to the referee. */
export interface RecheckSource {
  kind: "commit" | "post" | "calendar_event";
  /** Commit message (Ship Week) or post text (Build in Public). */
  text: string;
  /** Capped diff for Ship Week; null otherwise. */
  diff: string | null;
  /** Author handle the source belongs to, when the source says. */
  author: string | null;
  /** Files touched and line counts, when the source says (Ship Week). */
  stats: { files: number; additions: number; deletions: number } | null;
  fetched_at: Date;
}

export interface RecheckResult {
  status: RecheckStatus;
  source: RecheckSource | null;
  /** Lane-rendered reason when status is failed or pending. */
  reason: string | null;
  /** Information-only facts, for example a GitHub push-event time (KTD14). */
  info: Record<string, string | number | boolean | null>;
}

/** Network and identity context for re-checks, handle verification and the final check. */
export interface PackContext {
  now: Date;
  /** Injected so tests never reach the network. */
  fetch: typeof fetch;
  /** Server-side GitHub token for the verifier (KTD17). */
  githubToken?: string | null;
}

export interface FeatureInput<P> {
  proof: P;
  recheck: RecheckResult | null;
  /** Open inbox requests for this player and challenge (for example one-time codes). */
  openRequests: InboxItem[];
  /** The player's earlier proofs in this challenge (for near-duplicate checks). */
  earlierProofs: Proof[];
  challenge: Challenge;
  player_id: Id;
}

export interface FinalCheckResult {
  /** Accepted proofs that stop counting, for example a deleted post (AE3). */
  not_counted: { proof_id: Id; reason: NotCountedReason }[];
  /** Inbox requests to open, for example a Muse re-fetch where the platform cannot be re-fetched. */
  requests: NewInboxItem[];
}

/** Lane-rendered text for a contract version, built from typed parameters only (KTD15). */
export interface RenderedContract {
  send: string[];
  scoring: string;
  extra_proof: string[];
  agent_instructions: string;
}

export interface ContractRenderInput<Prm> {
  params: Prm;
  title: string;
  goal: number;
  stake: number;
  winner_rule: WinnerRule;
  days: number;
  day_length_sec: number;
}

export interface ContractTemplate<Prm extends Params = Params> {
  /** Typed parameters the orchestrator fills (platform, goal, window, stake...). */
  paramsSchema: z.ZodType<Prm>;
  /** Fields a draft needs before it can be confirmed; missing ones trigger a clarifying question (R4). */
  requiredDraftFields: readonly string[];
  render(input: ContractRenderInput<Prm>): RenderedContract;
  /**
   * Per-feature "does not count" templates (KTD15). Each renders one condition. String and list
   * values must be rendered as a generic phrase, never verbatim.
   */
  doesNotCount: Record<string, (cond: Cond) => string>;
}

/** A seed rule as a pack ships it. Lane stores it as version 1 with source `seed`. */
export interface SeedRule {
  rule_key: string;
  when: When;
  action: RuleAction;
  cheat_class: string;
  reason: string;
}

export interface Pack<P extends Record<string, unknown> = Record<string, unknown>> {
  type: ChallengeType;
  title: string;
  /**
   * Parses the flat submit-proof fields (and extra-proof answers). The parse applies KTD15's
   * reductions: attendees to domains, notes capped. A failed parse gives the recovery message.
   */
  proofSchema: z.ZodType<P>;
  /** Canonical source key: full 40-char lowercase SHA, `platform:post_id`, or calendar event id. */
  sourceKey(proof: P): string;
  /** Source time, which sets the proof's day index (KTD13). */
  sourceTime(proof: P): Date;
  /** Handle the pack binds at join, or null (Talk to Customers). */
  handlePlatform: HandlePlatform | null;
  features: FeatureCatalog;
  extractFeatures(input: FeatureInput<P>): Features;
  /** Re-check public sources where they exist (R16, KTD14). */
  recheck(proof: P, player: Player, handle: Handle | null, ctx: PackContext): Promise<RecheckResult>;
  /** KTD21 handle verification: look for the bind code in the public profile bio. */
  verifyHandle(handle: string, bindCode: string, ctx: PackContext): Promise<{ verified: boolean; reason: string | null }>;
  /** R27 final check at window close. */
  finalCheck(challenge: Challenge, proofs: Proof[], ctx: PackContext): Promise<FinalCheckResult>;
  /** Cheat class ids; each matches a feature name. */
  cheatClasses: readonly string[];
  scoreUnit: ScoreUnit;
  contract: ContractTemplate;
  seedRules: readonly SeedRule[];
  examples: readonly LabelledExample[];
  /** Lane-built feed summary from features, for example "commit, 3 files, +42/-5" (KTD15). */
  summarize(features: Features): string;
}

/** Any registered pack. Pack methods are bivariant, so concrete packs are assignable. */
export type AnyPack = Pack<Record<string, unknown>>;
