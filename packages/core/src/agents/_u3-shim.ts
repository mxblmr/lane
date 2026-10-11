/**
 * TEMPORARY shim until this branch is rebased onto U3 (PR #22).
 *
 * Every export below copies a U3 definition by name and shape, so the rebase is an
 * import swap: delete this file and import the same names from the U3 module noted
 * on each export. `IdSchema` from `schema/common.ts` is inlined as
 * `z.string().min(1).max(64)`, its U3 definition.
 *
 * Only `packages/core/src/agents/` may import this file.
 */
import { z } from "zod";

const IdSchema = z.string().min(1).max(64);

/** U3: `schema/agents.ts` AGENT_WORKSPACES, AgentWorkspaceSchema, AgentWorkspace. */
export const AGENT_WORKSPACES = ["orchestrator", "referee", "rule_lab", "promoter"] as const;
export const AgentWorkspaceSchema = z.enum(AGENT_WORKSPACES);
export type AgentWorkspace = z.infer<typeof AgentWorkspaceSchema>;

/** U3: `schema/approvals.ts` APPROVAL_DECISIONS, ApprovalDecisionSchema, ApprovalDecision. */
export const APPROVAL_DECISIONS = ["approve", "decline"] as const;
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** U3: `schema/rule.ts` RULE_ACTIONS, RuleActionSchema, RuleAction. */
export const RULE_ACTIONS = ["reject", "hold_payout", "ask_more", "flag"] as const;
export const RuleActionSchema = z.enum(RULE_ACTIONS);
export type RuleAction = z.infer<typeof RuleActionSchema>;

/** U3: `schema/agents.ts` PromoterInterruptSchema, PromoterInterrupt. */
export const PromoterInterruptSchema = z.object({
  candidate_id: IdSchema,
  action: RuleActionSchema,
  line: z.string().max(300),
  allowed_decisions: z.array(z.enum(["approve", "decline"])),
});
export type PromoterInterrupt = z.infer<typeof PromoterInterruptSchema>;

/** U3: `schema/agents.ts` AgentPayloadSchema, AgentPayload. */
export const AgentPayloadSchema = z.object({
  workspace: AgentWorkspaceSchema,
  prompt: z.string(),
  output_schema: z.record(z.string(), z.unknown()),
  input: z.unknown(),
  internal_api: z.record(z.string(), z.unknown()).nullable(),
});
export type AgentPayload = z.infer<typeof AgentPayloadSchema>;

/** U3: `schema/agents.ts` ROLE_KEY_HEADER. The deployed rule-lab and promoter tools send this header. */
export const ROLE_KEY_HEADER = "x-lane-role-key" as const;

/** U3: `schema/agents.ts` INTERNAL_API_BASE. The deployed tools only call paths under it. */
export const INTERNAL_API_BASE = "/api/internal" as const;
