import type { ClientSession, Db } from "mongodb";
import type { ChallengeType, Features, HandlePlatform, Id, Outcome, Params, RuleRef } from "./schema/common";
import type { Challenge, PlayerScore, ScoreUnit, SettlementSnapshot, WinnerRule } from "./schema/challenges";
import type { CheckInTerms, Contract } from "./schema/contracts";
import type { Membership } from "./schema/memberships";
import type { Player } from "./schema/players";
import type { Proof, RuleMatch, Verdict } from "./schema/proofs";
import type { InboxItem, NewInboxItem } from "./schema/inbox";
import type { Dispute } from "./schema/disputes";
import type {
  Approval,
  ApprovalDecision,
  FollowUp,
  PayoutApproval,
  RuleApproval,
} from "./schema/approvals";
import type { RuleStatus } from "./schema/rule";
import type { LedgerEntry } from "./schema/ledger";
import type { FeedItem, Standing, SubmitProofArgs } from "./schema/envelope";
import type { AgentIO, AgentWorkspace, PromoterInterrupt } from "./schema/agents";
import { appendLedgerEntry, type LedgerAppendInput, type LedgerAppendOptions, type LedgerAppendResult } from "./ledger";
import { claimJob, claimNextJob, queueJob, type ClaimOptions, type JobClaim, type QueueJobInput, type QueueJobResult } from "./jobs";
import type { JobKind } from "./schema/jobs";

/**
 * Cross-unit calls (U3 approach step 4). Each call has exactly one owner unit. Units call each
 * other only through `services()`, so every Wave 2 unit can start against these types and
 * replace the stubs with test doubles.
 *
 * Wiring: each owner module exports its implementation, and the web app's composition root
 * (U7) calls `provideServices({...})` once at startup with the real implementations. Tests call
 * `provideServices` with doubles and `resetServices()` afterwards. Stubs throw
 * `NotImplementedError` naming the owner, except jobs and ledger, which U3 implements here.
 */

// ---------------------------------------------------------------- U6: players, challenges, contracts

export interface RegisterInput {
  display_name: string;
  time_zone: string;
  now?: Date;
}
export type RegisterResult = Outcome<{
  player: Player;
  /** Plaintext key, returned once by lane_register and never stored (KTD4). */
  player_key: string;
  routine_text: string;
  grant: LedgerEntry;
}>;

export interface DraftInput {
  player_id: Id;
  /** The creator's sentence, or the answer to the clarifying question when draft_id is set. */
  sentence: string;
  draft_id?: Id;
  now?: Date;
}
export type DraftResult = Outcome<
  | { kind: "question"; draft_id: Id; question: string; missing_fields: string[] }
  | {
      kind: "draft";
      draft_id: Id;
      challenge_type: ChallengeType;
      title: string;
      goal: number;
      days: number;
      params: Params;
      /** Lane-rendered lines Muse shows the creator before they confirm. */
      preview_lines: string[];
      winner_rules: WinnerRule[];
    }
>;

export interface ConfirmInput {
  player_id: Id;
  draft_id: Id;
  winner_rule: WinnerRule;
  stake: number;
  now?: Date;
}
export type ConfirmResult = Outcome<{
  challenge: Challenge;
  join_code: string;
  /** The creator joins automatically. */
  membership: Membership;
  contract: Contract;
  stake_entry: LedgerEntry;
}>;

export interface JoinTerms {
  terms_version: string;
  /** Lane-rendered lines: play-credit label, stake, winner rule, window, check-ins, quiet hours, what to send. */
  lines: string[];
  stake: number;
  winner_rule: WinnerRule;
  window: { start_at: Date; end_at: Date; days: number };
  checkin: CheckInTerms;
  handle_platform: HandlePlatform | null;
  credit_label: string;
}

export interface JoinInput {
  player_id: Id;
  join_code: string;
  /** Second call only. */
  accepted_terms_version?: string;
  /** Second call only: the handle the pack needs. */
  handle?: string;
  now?: Date;
}
export type JoinResult = Outcome<
  | { phase: "terms"; challenge_id: Id; terms: JoinTerms }
  | {
      phase: "joined";
      challenge: Challenge;
      membership: Membership;
      contract: Contract;
      stake_entry: LedgerEntry;
      /** KTD21 bind-code action, or null when the pack needs no handle or it is already verified. */
      bind_action: InboxItem | null;
      already_member: boolean;
    }
>;

export interface PublishContractInput {
  challenge_id: Id;
  /** For example "created", "rule_activated", "rule_rolled_back". */
  reason: string;
  /** Lane-rendered change lines for players. */
  changes?: string[];
  now?: Date;
}
export interface PublishContractResult {
  contract: Contract;
}

export interface PublishForTypeInput {
  challenge_type: ChallengeType;
  reason: string;
  changes?: string[];
  now?: Date;
}
export interface PublishForTypeResult {
  contracts: { challenge_id: Id; version: number }[];
}

// ---------------------------------------------------------------- U5: proofs

export interface SubmitProofInput {
  player_id: Id;
  challenge_id?: Id;
  /** Answer to an extra-proof request, surprise check or bind code. */
  request_id?: Id;
  fields: Omit<SubmitProofArgs, "player_key" | "challenge_id" | "request_id">;
  now?: Date;
}
export type SubmitProofOutcome = "accepted" | "flagged_accept" | "rejected" | "held" | "pending" | "not_counted";
export type SubmitProofResult = Outcome<{
  proof: Proof;
  outcome: SubmitProofOutcome;
  /** True when the same source was already submitted (KTD6). */
  duplicate: boolean;
  verdict: Verdict | null;
  /** Extra-proof request opened by this submission, if any. */
  request: InboxItem | null;
  /** Lane-rendered lines for Muse to relay. */
  lines: string[];
}>;

// ---------------------------------------------------------------- U18: check-in, disputes, ask, inbox, feed, tick

export interface CheckInInput {
  player_id: Id;
  now?: Date;
}
export interface CheckInChallenge {
  challenge: Challenge;
  membership: Membership;
  day_index: number | null;
  /** Set when the contract changed since the player last saw it (R9). */
  contract: Contract | null;
  contract_changed: boolean;
  actions: InboxItem[];
  /** Info items delivered by this check-in, once. */
  info: InboxItem[];
  standings: Standing[];
  feed: FeedItem[];
}
export type CheckInResult = Outcome<{ player: Player; challenges: CheckInChallenge[]; next_check_in_at: Date }>;

export interface DisputeInput {
  player_id: Id;
  proof_id: Id;
  reason: string;
  now?: Date;
}
export type DisputeResult = Outcome<{ dispute: Dispute; created: boolean }>;

export interface AskInput {
  player_id: Id;
  question: string;
  challenge_id?: Id;
  now?: Date;
}
export type AskResult = Outcome<{ answer: string }>;

export interface InboxWriteOptions {
  session?: ClientSession;
  now?: Date;
}
export interface InboxAddResult {
  item: InboxItem;
  /** False when a unique index found the same item open already (KTD6). */
  created: boolean;
}
export interface InboxResolveInput {
  item_id: Id;
  /** Only the player who owns the subject proof or slot can answer (U18). */
  by_player_id: Id;
  answer_proof_id?: Id | null;
  now?: Date;
}
export type InboxResolveResult = Outcome<{ item: InboxItem; resolved: boolean }>;
export interface InboxExpireInput {
  now: Date;
  item_ids?: Id[];
  challenge_id?: Id;
}
export interface InboxExpireResult {
  expired: InboxItem[];
}

export interface BuildFeedInput {
  challenge_id: Id;
  viewer_player_id?: Id | null;
  limit?: number;
}

export interface TickInput {
  now?: Date;
  /** Lease holder label for logs. */
  holder?: string;
}
export interface TickResult {
  /** False when another tick held the lease. */
  ran: boolean;
  transitions: number;
  jobs_reclaimed: number;
}

// ---------------------------------------------------------------- U9: approvals, learning, lifecycle

export type NewRuleApproval = Omit<
  RuleApproval,
  "_id" | "kind" | "status" | "decided_by" | "decided_at" | "created_at" | "updated_at" | "follow_up" | "rule_status"
>;
export type NewPayoutApproval = Omit<
  PayoutApproval,
  "_id" | "kind" | "status" | "decided_by" | "decided_at" | "created_at" | "updated_at" | "follow_up"
>;
export type CreateApprovalInput = ({ kind: "rule" } & NewRuleApproval) | ({ kind: "payout" } & NewPayoutApproval);
export interface CreateApprovalResult {
  approval: Approval;
  created: boolean;
}
export interface DecideApprovalInput {
  approval_id: Id;
  decision: ApprovalDecision;
  decided_by: string;
  now?: Date;
}
export type DecideApprovalResult = Outcome<{
  approval: Approval;
  /** False when another caller decided first (one conditional update from pending). */
  decided: boolean;
  follow_up: FollowUp;
  rule_status: RuleStatus | null;
}>;

export interface LearningSourceInput {
  challenge_type: ChallengeType;
  source: "ai_judgment" | "dispute" | "live_cheat" | "red_team";
  cheat_class: string | null;
  proof_id?: Id;
  example_key?: string;
  dispute_id?: Id;
  now?: Date;
}
export interface LearningSourceResult {
  job_id: Id | null;
  queued: boolean;
  /** Why nothing was queued, for example an open candidate for the same cheat class. */
  skipped_reason: string | null;
}

export interface MarkLiveCheatInput {
  proof_id: Id;
  by: string;
  now?: Date;
}
export interface RollbackRuleInput {
  challenge_type: ChallengeType;
  rule_key: string;
  by: string;
  now?: Date;
}
export type RollbackRuleResult = Outcome<{ restored: RuleRef | null; contracts: { challenge_id: Id; version: number }[] }>;

// ---------------------------------------------------------------- U4: rule engine

export interface EvaluateInput {
  challenge_type: ChallengeType;
  features: Features;
  session?: ClientSession;
}
export interface EvaluateResult {
  /** "none" when no rule decided. Order: reject, hold_payout, ask_more, flag (U4). */
  decision: "none" | "reject" | "hold_payout" | "ask_more" | "flag";
  rule: RuleRef | null;
  matched: RuleMatch[];
  evaluated: RuleRef[];
}

// ---------------------------------------------------------------- U8: agent client

export interface AgentCallMeta {
  challenge_id?: Id | null;
  player_id?: Id | null;
  proof_id?: Id | null;
  /** Lane id used as the observability event id (U20). */
  event_id?: string | null;
}

export interface AgentInvokeInput<W extends AgentWorkspace> {
  workspace: W;
  /** Mode key in `AGENT_SCHEMAS[workspace]`, for example "proof" or "draft". */
  mode: string;
  input: AgentIO[W]["input"];
  /** KTD10: one session per workspace for judges; one per candidate for the promoter. */
  session_id?: string;
  timeout_ms?: number;
  meta?: AgentCallMeta;
}

export type AgentInvokeResult<W extends AgentWorkspace> =
  | {
      ok: true;
      status: "completed";
      output: AgentIO[W]["output"];
      execution_id: string;
      latency_ms: number;
    }
  | {
      ok: true;
      status: "suspended";
      execution_id: string;
      workspace_id: string;
      interrupt: PromoterInterrupt;
      latency_ms: number;
    }
  | {
      ok: false;
      error: string;
      /** False when the agent answered but failed its schema: never treat as an acceptance. */
      schema_valid: boolean;
      timed_out: boolean;
      execution_id: string | null;
      latency_ms: number;
    };

export interface AgentResumeInput {
  workspace: "promoter";
  execution_id: string;
  decision: ApprovalDecision;
  meta?: AgentCallMeta;
}

// ---------------------------------------------------------------- U11: scoring and settlement

export interface ComputeScoresInput {
  challenge_id: Id;
  now?: Date;
  session?: ClientSession;
}
export interface ScoresResult {
  challenge_id: Id;
  unit: ScoreUnit;
  goal: number;
  winner_rule: WinnerRule;
  pot: number;
  scores: PlayerScore[];
  standings: Standing[];
}

export interface SettleInput {
  challenge_id: Id;
  now?: Date;
}
export type SettleResult = Outcome<{
  status: "paid" | "refunded" | "awaiting_approval" | "already_settled" | "requeued";
  snapshot: SettlementSnapshot | null;
  approval_id: Id | null;
}>;

export interface PayInput {
  challenge_id: Id;
  snapshot_id: Id;
  decision: ApprovalDecision;
  now?: Date;
}
export type PayResult = Outcome<{ status: "paid" | "refunded" | "already_settled"; entries: LedgerEntry[] }>;

// ---------------------------------------------------------------- U13: stage reset

export interface ResetStageInput {
  challenge_type: ChallengeType;
  by: string;
  now?: Date;
}
export type ResetStageResult = Outcome<{ cancelled_challenge_id: Id | null; new_challenge_id: Id }>;

// ---------------------------------------------------------------- the services table

export interface LaneServices {
  /** U6 */
  players: {
    register(db: Db, input: RegisterInput): Promise<RegisterResult>;
  };
  /** U6 */
  challenges: {
    draft(db: Db, input: DraftInput): Promise<DraftResult>;
    confirm(db: Db, input: ConfirmInput): Promise<ConfirmResult>;
    join(db: Db, input: JoinInput): Promise<JoinResult>;
  };
  /** U6. U9 calls publishForType on activation and rollback. */
  contracts: {
    publish(db: Db, input: PublishContractInput): Promise<PublishContractResult>;
    publishForType(db: Db, input: PublishForTypeInput): Promise<PublishForTypeResult>;
  };
  /** U5 */
  proofs: {
    submit(db: Db, input: SubmitProofInput): Promise<SubmitProofResult>;
  };
  /** U18 */
  checkin: {
    checkIn(db: Db, input: CheckInInput): Promise<CheckInResult>;
  };
  /** U18 */
  disputes: {
    dispute(db: Db, input: DisputeInput): Promise<DisputeResult>;
  };
  /** U18 */
  ask: {
    ask(db: Db, input: AskInput): Promise<AskResult>;
  };
  /** U18 */
  inbox: {
    add(db: Db, item: NewInboxItem, opts?: InboxWriteOptions): Promise<InboxAddResult>;
    resolve(db: Db, input: InboxResolveInput): Promise<InboxResolveResult>;
    expire(db: Db, input: InboxExpireInput): Promise<InboxExpireResult>;
  };
  /** U18 */
  feed: {
    build(db: Db, input: BuildFeedInput): Promise<FeedItem[]>;
  };
  /** U18. The dashboard data routes call it on each poll (KTD13). */
  tick: {
    run(db: Db, input: TickInput): Promise<TickResult>;
  };
  /** U9 (rule approvals) and U11 (payout approvals create through here too). */
  approvals: {
    create(db: Db, input: CreateApprovalInput): Promise<CreateApprovalResult>;
    decide(db: Db, input: DecideApprovalInput): Promise<DecideApprovalResult>;
  };
  /** U9: the four R20 learning entry points, plus the dashboard's live-cheat mark (U12). */
  learning: {
    fromSource(db: Db, input: LearningSourceInput): Promise<LearningSourceResult>;
    markLiveCheat(db: Db, input: MarkLiveCheatInput): Promise<LearningSourceResult>;
  };
  /** U9 */
  lifecycle: {
    rollback(db: Db, input: RollbackRuleInput): Promise<RollbackRuleResult>;
  };
  /** U4 */
  engine: {
    evaluate(db: Db, input: EvaluateInput): Promise<EvaluateResult>;
  };
  /** U3 (implemented here) */
  jobs: {
    queue(db: Db, input: QueueJobInput, opts?: { now?: Date; session?: ClientSession }): Promise<QueueJobResult>;
    claim(db: Db, input: { job_id?: Id; kinds?: JobKind[] } & ClaimOptions): Promise<JobClaim | null>;
  };
  /** U8 */
  agents: {
    invoke<W extends AgentWorkspace>(input: AgentInvokeInput<W>): Promise<AgentInvokeResult<W>>;
    resume(input: AgentResumeInput): Promise<AgentInvokeResult<"promoter">>;
  };
  /** U11. Check-in and the dashboard import computeScores for standings. */
  settlement: {
    computeScores(db: Db, input: ComputeScoresInput): Promise<ScoresResult>;
    settle(db: Db, input: SettleInput): Promise<SettleResult>;
    pay(db: Db, input: PayInput): Promise<PayResult>;
  };
  /** U3 (implemented here) */
  ledger: {
    append(db: Db, input: LedgerAppendInput, opts?: LedgerAppendOptions): Promise<LedgerAppendResult>;
  };
  /** U13 (KTD22) */
  stage: {
    reset(db: Db, input: ResetStageInput): Promise<ResetStageResult>;
  };
}

export type ServiceName = keyof LaneServices;

/** The one owner of each cross-unit call. */
export const SERVICE_OWNERS: Record<ServiceName, string> = {
  players: "U6",
  challenges: "U6",
  contracts: "U6",
  proofs: "U5",
  checkin: "U18",
  disputes: "U18",
  ask: "U18",
  inbox: "U18",
  feed: "U18",
  tick: "U18",
  approvals: "U9",
  learning: "U9",
  lifecycle: "U9",
  engine: "U4",
  jobs: "U3",
  agents: "U8",
  settlement: "U11",
  ledger: "U3",
  stage: "U13",
};

export class NotImplementedError extends Error {
  readonly service: string;
  readonly owner: string;
  constructor(service: ServiceName, method: string) {
    const owner = SERVICE_OWNERS[service];
    super(
      `${service}.${method} is owned by ${owner} and is not wired yet. ` +
        `Call provideServices({ ${service}: { ${method}: ... } }) with the real implementation or a test double.`,
    );
    this.name = "NotImplementedError";
    this.service = `${service}.${method}`;
    this.owner = owner;
  }
}

function stub(service: ServiceName, method: string) {
  return async (): Promise<never> => {
    throw new NotImplementedError(service, method);
  };
}

/** Fresh services: stubs that throw for every unit-owned call, real jobs and ledger. */
export function createStubServices(): LaneServices {
  return {
    players: { register: stub("players", "register") },
    challenges: { draft: stub("challenges", "draft"), confirm: stub("challenges", "confirm"), join: stub("challenges", "join") },
    contracts: { publish: stub("contracts", "publish"), publishForType: stub("contracts", "publishForType") },
    proofs: { submit: stub("proofs", "submit") },
    checkin: { checkIn: stub("checkin", "checkIn") },
    disputes: { dispute: stub("disputes", "dispute") },
    ask: { ask: stub("ask", "ask") },
    inbox: { add: stub("inbox", "add"), resolve: stub("inbox", "resolve"), expire: stub("inbox", "expire") },
    feed: { build: stub("feed", "build") },
    tick: { run: stub("tick", "run") },
    approvals: { create: stub("approvals", "create"), decide: stub("approvals", "decide") },
    learning: { fromSource: stub("learning", "fromSource"), markLiveCheat: stub("learning", "markLiveCheat") },
    lifecycle: { rollback: stub("lifecycle", "rollback") },
    engine: { evaluate: stub("engine", "evaluate") },
    jobs: {
      queue: (db, input, opts) => queueJob(db, input, opts),
      claim: (db, input) =>
        input.job_id ? claimJob(db, input.job_id, input) : claimNextJob(db, { ...input, kinds: input.kinds }),
    },
    agents: {
      invoke: stub("agents", "invoke") as LaneServices["agents"]["invoke"],
      resume: stub("agents", "resume"),
    },
    settlement: {
      computeScores: stub("settlement", "computeScores"),
      settle: stub("settlement", "settle"),
      pay: stub("settlement", "pay"),
    },
    ledger: { append: (db, input, opts) => appendLedgerEntry(db, input, opts) },
    stage: { reset: stub("stage", "reset") },
  };
}

/** Partial overrides, per service and per method. */
export type ServiceOverrides = { [K in ServiceName]?: Partial<LaneServices[K]> };

let current: LaneServices = createStubServices();

/** The current services table. Call it at use time (not at import time) so overrides apply. */
export function services(): LaneServices {
  return current;
}

/** Replace some methods. Owners call this from the composition root; tests call it with doubles. */
export function provideServices(overrides: ServiceOverrides): void {
  const next = { ...current } as Record<ServiceName, object>;
  for (const [name, methods] of Object.entries(overrides) as [ServiceName, object | undefined][]) {
    if (!methods) continue;
    next[name] = { ...next[name], ...methods };
  }
  current = next as LaneServices;
}

/** Back to stubs (plus real jobs and ledger). Call in test teardown. */
export function resetServices(): void {
  current = createStubServices();
}

/** Run `fn` with overrides applied, then restore the previous table. */
export async function withServices<T>(overrides: ServiceOverrides, fn: () => Promise<T>): Promise<T> {
  const saved = current;
  provideServices(overrides);
  try {
    return await fn();
  } finally {
    current = saved;
  }
}
