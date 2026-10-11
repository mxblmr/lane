import type { FeatureCatalog, SeedRule } from "../../schema/pack";

/**
 * Talk to Customers predicate menu (KTD8). Each feature is something the rule-writer may put in
 * a rule's `when`, with the operators it allows and its hard bound (KTD9). U4 validates every
 * candidate against this catalog. The names are the catalog U3 published.
 */

const NUMBER_OPS = ["lt", "lte", "gt", "gte", "eq"] as const;

export const CUSTOMERS_FEATURES: FeatureCatalog = {
  duration_min: {
    kind: "number",
    description: "Whole minutes between the event's start and end.",
    ops: NUMBER_OPS,
    bound: { min: 0, max: 30 },
  },
  attendee_count: {
    kind: "number",
    description: "Distinct outside attendee domains: every attendee domain except the player's own company domain.",
    ops: NUMBER_OPS,
    bound: { min: 0, max: 10 },
  },
  attendee_domains: {
    kind: "string_list",
    description: "Email domains of the attendees besides the player. Never a full address (KTD15).",
    ops: ["in"],
  },
  all_personal_email: {
    kind: "boolean",
    description: "There is an outside attendee, and every outside attendee uses a personal email domain such as gmail.com.",
    ops: ["eq"],
  },
  internal_only: {
    kind: "boolean",
    description: "The player marked their own company domain, and every attendee shares it.",
    ops: ["eq"],
  },
  has_notes: { kind: "boolean", description: "A meeting-notes summary was sent.", ops: ["eq"] },
  short_call: { kind: "boolean", description: "The call lasted under five minutes.", ops: ["eq"] },
};

/** Cheat class ids. Each matches a boolean feature name. */
export const CUSTOMERS_CHEAT_CLASSES = ["all_personal_email", "internal_only", "short_call"] as const;
export type CustomersCheatClass = (typeof CUSTOMERS_CHEAT_CLASSES)[number];

/**
 * Seed rules (stored as version 1 with source `seed`). They deliberately leave
 * all_personal_email to the learning loop: in AE2 the first personal-email call reaches the
 * referees, who ask for meeting notes, and the rule-writer learns that such calls need notes
 * before they count. A plain personal-email rule would be wrong anyway, because real prospects
 * use gmail.com too; the honest examples include such calls, with notes.
 */
export const CUSTOMERS_SEED_RULES: readonly SeedRule[] = [
  {
    rule_key: "cust-internal-only",
    when: { all: [{ feature: "internal_only", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "internal_only",
    reason: "Seed: a meeting where every attendee is from the player's own company is not a customer conversation.",
  },
  {
    rule_key: "cust-short-call",
    when: { all: [{ feature: "short_call", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "short_call",
    reason: "Seed: a call under five minutes is not a real conversation.",
  },
];
