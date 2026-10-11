import type { Db } from "mongodb";
import type { z } from "zod";
import type { ErrorCode, LaneError } from "../schema/common";
import { collections } from "../schema/collections";
import { actionNeedsApproval } from "../schema/rule";
import type { Example } from "../schema/examples";
import type { GateResult, Rule } from "../schema/rules";
import type { AnyPack } from "../schema/pack";
import {
  INTERNAL_API,
  type ExampleView,
  type GateResultJson,
  type InternalEndpointName,
  type InternalError,
  type InternalRole,
  type PredicateView,
  type RuleView,
} from "../schema/agents";
import { getPack, renderRuleLine } from "../packs/index";
import { activateRule, OPEN_RULE_STATUSES, proposeRule, rejectCandidate, testCandidate } from "./lifecycle";
import { addRedTeamExamples } from "./examples";
import { ruleApprovalId } from "./approvals";

/**
 * Domain handlers behind Lane's internal agent API (U9 approach step 6, KTD10). The contract
 * (paths, roles, request and response shapes) is U3's `INTERNAL_API`; the web routes check the
 * role key, parse the body with the endpoint's request schema and call these handlers.
 *
 * Rule-lab may read examples, rules and the predicate catalog, propose and test candidates,
 * and add red-team cheat examples. The promoter may read a candidate, activate it and reject it.
 */

/** Parsed request body of an internal endpoint. */
export type InternalRequest<K extends InternalEndpointName> = z.infer<(typeof INTERNAL_API)[K]["request"]>;
/** Success response of an internal endpoint. */
export type InternalResponse<K extends InternalEndpointName> = z.infer<(typeof INTERNAL_API)[K]["response"]>;
type Req<K extends InternalEndpointName> = InternalRequest<K>;
type Res<K extends InternalEndpointName> = InternalResponse<K>;

export interface InternalContext {
  db: Db;
  role: InternalRole;
  now: Date;
}

export type InternalHandler<K extends InternalEndpointName> = (ctx: InternalContext, body: Req<K>) => Promise<Res<K> | InternalError>;

export function internalError(code: ErrorCode, message: string, recovery: string): InternalError {
  return { ok: false, error: { code, message: message.slice(0, 300), recovery: recovery.slice(0, 300) } };
}

function fromLaneError(error: LaneError): InternalError {
  return { ok: false, error };
}

/** HTTP status for an internal error code. */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "invalid_input":
      return 400;
    case "unauthenticated":
      return 401;
    case "not_allowed":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
    case "duplicate":
      return 409;
    default:
      return 500;
  }
}

export function gateToJson(gate: GateResult): GateResultJson {
  return { ...gate, tested_at: gate.tested_at.toISOString() };
}

export function toRuleView(rule: Rule, pack: AnyPack): RuleView {
  return {
    rule_id: rule._id,
    rule_key: rule.rule_key,
    version: rule.version,
    parent_version: rule.parent_version,
    challenge_type: rule.challenge_type,
    when: rule.when,
    action: rule.action,
    cheat_class: rule.cheat_class,
    status: rule.status,
    source: rule.source,
    line: renderRuleLine(pack, rule),
    test_results: rule.test_results ? gateToJson(rule.test_results) : null,
  };
}

export function toExampleView(ex: Example): ExampleView {
  return {
    example_key: ex.example_key,
    label: ex.label,
    cheat_class: ex.cheat_class,
    features: ex.features,
    source: ex.source,
    summary: ex.summary,
  };
}

export function predicateCatalog(pack: AnyPack): PredicateView[] {
  return Object.entries(pack.features).map(([feature, spec]) => ({
    feature,
    kind: spec.kind,
    description: spec.description,
    ops: [...spec.ops],
    bound: spec.bound ? { ...spec.bound } : null,
  }));
}

const ping: InternalHandler<"ping"> = async (ctx) => ({ ok: true, role: ctx.role, server_time: ctx.now.toISOString() });

const ruleLabRead: InternalHandler<"rule_lab_read"> = async (ctx, body) => {
  const pack = getPack(body.challenge_type);
  const col = collections(ctx.db);
  const include = new Set(body.include);
  let examples: ExampleView[] = [];
  if (include.has("examples")) {
    const filter = body.cheat_class
      ? { challenge_type: body.challenge_type, $or: [{ cheat_class: body.cheat_class }, { label: "honest" as const }] }
      : { challenge_type: body.challenge_type };
    const docs = await col.examples.find(filter).sort({ example_key: 1 }).limit(body.limit ?? 200).toArray();
    examples = docs.map(toExampleView);
  }
  let rules: RuleView[] = [];
  if (include.has("rules")) {
    const docs = await col.rules
      .find({ challenge_type: body.challenge_type, status: { $in: ["active", ...OPEN_RULE_STATUSES] } })
      .sort({ rule_key: 1, version: 1 })
      .toArray();
    rules = docs.map((r) => toRuleView(r, pack));
  }
  return {
    ok: true,
    examples,
    rules,
    catalog: include.has("catalog") ? predicateCatalog(pack) : [],
    cheat_classes: [...pack.cheatClasses],
  };
};

const ruleLabPropose: InternalHandler<"rule_lab_propose"> = async (ctx, body) => {
  const res = await proposeRule(ctx.db, body, { now: ctx.now });
  if (!res.ok) return fromLaneError(res.error);
  return { ok: true, candidate_id: res.rule._id, rule_key: res.rule.rule_key, version: res.rule.version, status: res.rule.status };
};

const ruleLabTest: InternalHandler<"rule_lab_test"> = async (ctx, body) => {
  const res = await testCandidate(ctx.db, body.candidate_id, { now: ctx.now });
  if (!res.ok) return fromLaneError(res.error);
  return { ok: true, candidate_id: res.rule._id, status: res.rule.status, gate: gateToJson(res.gate) };
};

const ruleLabAddExamples: InternalHandler<"rule_lab_add_examples"> = async (ctx, body) => {
  const res = await addRedTeamExamples(ctx.db, body, { now: ctx.now });
  if (!res.ok) return fromLaneError(res.error);
  return { ok: true, added: res.added, duplicates: res.duplicates };
};

const promoterRead: InternalHandler<"promoter_read"> = async (ctx, body) => {
  const rule = await collections(ctx.db).rules.findOne({ _id: body.candidate_id });
  if (!rule) return internalError("not_found", `Candidate ${body.candidate_id} does not exist.`, "Use the candidate id from the invoke payload.");
  const approval = await collections(ctx.db).approvals.findOne({ _id: ruleApprovalId(rule._id) });
  return {
    ok: true,
    candidate: toRuleView(rule, getPack(rule.challenge_type)),
    requires_approval: actionNeedsApproval(rule.action),
    approval_status: approval ? approval.status : "none",
  };
};

const promoterActivate: InternalHandler<"promoter_activate"> = async (ctx, body) => {
  const res = await activateRule(
    ctx.db,
    { candidate_id: body.candidate_id, execution_id: body.execution_id, by: ctx.role },
    { now: ctx.now },
  );
  if (!res.ok) return fromLaneError(res.error);
  return { ok: true, candidate_id: res.rule._id, status: res.status, contract_versions: res.contracts };
};

const promoterReject: InternalHandler<"promoter_reject"> = async (ctx, body) => {
  const res = await rejectCandidate(ctx.db, { candidate_id: body.candidate_id, reason: body.reason, by: ctx.role }, { now: ctx.now });
  if (!res.ok) return fromLaneError(res.error);
  return { ok: true, candidate_id: res.rule._id, status: res.status };
};

export const INTERNAL_HANDLERS: { [K in InternalEndpointName]: InternalHandler<K> } = {
  ping,
  rule_lab_read: ruleLabRead,
  rule_lab_propose: ruleLabPropose,
  rule_lab_test: ruleLabTest,
  rule_lab_add_examples: ruleLabAddExamples,
  promoter_read: promoterRead,
  promoter_activate: promoterActivate,
  promoter_reject: promoterReject,
};

/** Run one endpoint's handler. The caller has already checked the role and parsed the body. */
export function runInternal<K extends InternalEndpointName>(name: K, ctx: InternalContext, body: Req<K>): Promise<Res<K> | InternalError> {
  return INTERNAL_HANDLERS[name](ctx, body);
}
