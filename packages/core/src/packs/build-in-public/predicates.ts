import type { FeatureCatalog, SeedRule } from "../../schema/pack";

/**
 * Build in Public predicate menu (KTD8). Each feature is something the rule-writer may put in a
 * rule's `when`, with the operators it allows and its hard bound (KTD9). U4 validates every
 * candidate against this catalog. The names are the catalog U3 published.
 */

export const BIP_FEATURES: FeatureCatalog = {
  word_count: {
    kind: "number",
    description: "Words in the post, not counting hashtags and mentions.",
    ops: ["lt", "lte", "gt", "gte"],
    bound: { min: 0, max: 30 },
  },
  has_concrete_detail: {
    kind: "boolean",
    description: "The post names a file, a feature, a number or a link. Day counters such as 'Day 3' and hashtags do not count.",
    ops: ["eq"],
  },
  filler: { kind: "boolean", description: "Fewer than 8 words and no concrete detail.", ops: ["eq"] },
  near_duplicate: {
    kind: "boolean",
    description: "Nearly identical to one of the player's earlier posts in this challenge (numbers and hashtags ignored).",
    ops: ["eq"],
  },
  post_missing: { kind: "boolean", description: "The platform said the post does not exist when Lane re-fetched it.", ops: ["eq"] },
  platform: { kind: "string", description: "Platform of the post: x, instagram, linkedin or threads.", ops: ["eq", "in"] },
};

/** Cheat class ids. Each matches a boolean feature name. */
export const BIP_CHEAT_CLASSES = ["filler", "near_duplicate", "post_missing"] as const;
export type BuildInPublicCheatClass = (typeof BIP_CHEAT_CLASSES)[number];

/**
 * Seed rules (stored as version 1 with source `seed`). Like Ship Week, they leave the content
 * cheats (filler and near-duplicates) to the learning loop (R24): AE3's first filler post
 * reaches the AI reviewer, which rejects it under the "does not count" clause, and a learned
 * rule can then catch the next one with no AI call. A post the platform says does not exist
 * never counts.
 */
export const BIP_SEED_RULES: readonly SeedRule[] = [
  {
    rule_key: "bip-post-missing",
    when: { all: [{ feature: "post_missing", op: "eq", value: true }] },
    action: "reject",
    cheat_class: "post_missing",
    reason: "Seed: a post the platform says does not exist cannot count.",
  },
];
