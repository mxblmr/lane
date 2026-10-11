import { z } from "zod";
import { ChallengeTypeSchema, IdSchema } from "./common";
import { SettlementSnapshotSchema } from "./challenges";
import { RuleActionSchema, RuleKeySchema, RuleStatusSchema } from "./rule";

export const APPROVAL_STATUSES = ["pending", "approved", "declined"] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const APPROVAL_DECISIONS = ["approve", "decline"] as const;
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

const approvalBase = {
  _id: IdSchema,
  status: ApprovalStatusSchema,
  decided_by: z.string().max(64).nullable(),
  decided_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
};

/**
 * What happened after the decision. For rule approvals this is the promoter resume (U9);
 * for payout approvals it is U11's pay step. A failed follow-up keeps the decision so the
 * dashboard can retry the same decision (U12).
 */
export const FollowUpSchema = z.object({
  status: z.enum(["not_started", "running", "ok", "failed"]),
  attempts: z.int().min(0),
  error: z.string().max(500).nullable(),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const RuleApprovalSchema = z.object({
  ...approvalBase,
  kind: z.literal("rule"),
  rule_id: IdSchema,
  rule_key: RuleKeySchema,
  rule_version: z.int().min(1),
  challenge_type: ChallengeTypeSchema,
  action: RuleActionSchema,
  /** Agent Engine execution suspended at the promoter's interrupt. */
  execution_id: z.string().min(1).max(200),
  workspace_id: z.string().min(1).max(200),
  suspend_context: z.record(z.string(), z.unknown()),
  allowed_decisions: z.array(ApprovalDecisionSchema),
  follow_up: FollowUpSchema,
  /** The rule's status after the promoter resumed. */
  rule_status: RuleStatusSchema.nullable(),
});
export type RuleApproval = z.infer<typeof RuleApprovalSchema>;

export const PayoutApprovalSchema = z.object({
  ...approvalBase,
  kind: z.literal("payout"),
  challenge_id: IdSchema,
  /** The approval binds this exact snapshot (KTD12). */
  snapshot_id: IdSchema,
  snapshot: SettlementSnapshotSchema,
  follow_up: FollowUpSchema,
});
export type PayoutApproval = z.infer<typeof PayoutApprovalSchema>;

/** `approvals` collection. Written by U9 (rule) and U11 (payout). Decided by one conditional update from pending. */
export const ApprovalSchema = z.discriminatedUnion("kind", [RuleApprovalSchema, PayoutApprovalSchema]);
export type Approval = z.infer<typeof ApprovalSchema>;
