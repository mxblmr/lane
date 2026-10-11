import type { ChallengeType } from "../schema/common";
import { CHALLENGE_TYPES } from "../schema/common";
import { genericValue, type AnyPack } from "../schema/pack";
import type { Cond, RuleAction, When } from "../schema/rule";
import { shipWeekPack } from "./ship-week/index";
import { customersPack } from "./customers/index";
import { buildInPublicPack } from "./build-in-public/index";

/**
 * Pack registry (KTD8). Each pack unit (U14 Ship Week, U15 Talk to Customers, U16 Build in
 * Public) replaces only its own folder and keeps exporting the same name; this file does not change.
 */
export const PACKS: Record<ChallengeType, AnyPack> = {
  ship_week: shipWeekPack as unknown as AnyPack,
  customers: customersPack as unknown as AnyPack,
  build_in_public: buildInPublicPack as unknown as AnyPack,
};

export function getPack(type: ChallengeType): AnyPack {
  const pack = PACKS[type];
  if (!pack) throw new Error(`No pack registered for challenge type ${type}`);
  return pack;
}

export function allPacks(): AnyPack[] {
  return CHALLENGE_TYPES.map((t) => PACKS[t]);
}

const ACTION_PHRASE: Record<RuleAction, string> = {
  reject: "does not count",
  hold_payout: "counts, but holds the payout for review",
  ask_more: "needs extra proof before it counts",
  flag: "is flagged for review",
};

/** Render one condition with the pack's per-feature template, or a generic fallback. */
export function renderCond(pack: AnyPack, cond: Cond): string {
  const template = pack.contract.doesNotCount[cond.feature];
  if (template) return template(cond);
  return `${cond.feature.replace(/_/g, " ")} ${cond.op} ${genericValue(cond)}`;
}

/**
 * The "does not count" line for a rule, rendered only from its predicate and the pack's
 * templates, never from the rule-writer's reason (KTD15).
 */
export function renderRuleLine(pack: AnyPack, rule: { when: When; action: RuleAction }): string {
  const conds = "all" in rule.when ? rule.when.all : rule.when.any;
  const joiner = "all" in rule.when ? " and " : ", or ";
  const parts = conds.map((c) => renderCond(pack, c));
  return `A proof where ${parts.join(joiner)} ${ACTION_PHRASE[rule.action]}.`.slice(0, 300);
}
