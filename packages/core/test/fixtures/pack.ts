import { z } from "zod";
import type { ChallengeType } from "../../src/schema/common";
import type { AnyPack, FeatureCatalog, Pack } from "../../src/schema/pack";
import { genericValue } from "../../src/schema/pack";
import type { LabelledExample } from "../../src/schema/examples";

/**
 * Fixture pack for tests in every unit. Deterministic, no network.
 * A proof is `{ event_id, post_text, source_time }`; features come from the text:
 *   word_count, rename_only ("rename" in the text), filler (< 3 words), message_matches (the text).
 * Import with `import { fixturePack, makeFixturePack } from "../fixtures/pack"`.
 */

export const FixtureProofSchema = z.object({
  event_id: z.string().min(1).max(200),
  post_text: z.string().max(2000).default(""),
  source_time: z.iso.datetime({ offset: true }),
});
export type FixtureProof = z.infer<typeof FixtureProofSchema>;

export const FIXTURE_FEATURES: FeatureCatalog = {
  word_count: { kind: "number", description: "Words in the text.", ops: ["lt", "lte", "gt", "gte", "eq"], bound: { min: 0, max: 20 } },
  rename_only: { kind: "boolean", description: "The text says it only renames.", ops: ["eq"] },
  filler: { kind: "boolean", description: "Fewer than three words.", ops: ["eq"] },
  message_matches: { kind: "string", description: "The text, for literal substring tests.", ops: ["matches"] },
};

export const FIXTURE_EXAMPLES: LabelledExample[] = [
  { example_key: "honest-1", label: "honest", cheat_class: null, features: { word_count: 12, rename_only: false, filler: false, message_matches: "add billing export" }, summary: "12 words" },
  { example_key: "honest-2", label: "honest", cheat_class: null, features: { word_count: 7, rename_only: false, filler: false, message_matches: "fix login redirect" }, summary: "7 words" },
  { example_key: "cheat-rename-1", label: "cheat", cheat_class: "rename_only", features: { word_count: 3, rename_only: true, filler: false, message_matches: "rename userId" }, summary: "3 words" },
  { example_key: "cheat-filler-1", label: "cheat", cheat_class: "filler", features: { word_count: 2, rename_only: false, filler: true, message_matches: "wip stuff" }, summary: "2 words" },
];

export function makeFixturePack(type: ChallengeType = "ship_week"): AnyPack {
  const pack: Pack<FixtureProof> = {
    type,
    title: `Fixture ${type}`,
    proofSchema: FixtureProofSchema,
    sourceKey: (p) => p.event_id,
    sourceTime: (p) => new Date(p.source_time),
    handlePlatform: () => null,
    features: FIXTURE_FEATURES,
    extractFeatures: ({ proof }) => {
      const words = proof.post_text.trim().split(/\s+/).filter(Boolean).length;
      return {
        word_count: words,
        rename_only: /\brename/i.test(proof.post_text),
        filler: words < 3,
        message_matches: proof.post_text.slice(0, 500),
      };
    },
    recheck: async (p, _player, _handle, ctx) => ({
      status: "rechecked",
      source: {
        kind: "commit",
        text: p.post_text,
        diff: null,
        author: null,
        stats: null,
        created_at: new Date(p.source_time),
        fetched_at: ctx.now,
      },
      reason: null,
      info: {},
    }),
    verifyHandle: async () => ({ verified: true, reason: null }),
    finalCheck: async () => ({ not_counted: [], requests: [] }),
    cheatClasses: ["rename_only", "filler"],
    scoreUnit: "days",
    contract: {
      paramsSchema: z.object({}),
      requiredDraftFields: [],
      render: ({ goal, days }) => ({
        send: ["One fixture proof per day."],
        scoring: `Reach ${goal} of ${days} days.`,
        extra_proof: ["A one-time code."],
        agent_instructions: "Submit one fixture proof per day.",
      }),
      doesNotCount: {
        rename_only: () => "the change only renames identifiers",
        filler: () => "the text is filler",
        word_count: (c) => `the text has ${c.op.startsWith("l") ? "at most" : "at least"} ${genericValue(c)} words`,
        message_matches: (c) => `the text contains ${genericValue(c)}`,
      },
    },
    seedRules: [
      {
        rule_key: "fixture-filler",
        when: { all: [{ feature: "filler", op: "eq", value: true }] },
        action: "reject",
        cheat_class: "filler",
        reason: "Seed: filler does not count.",
      },
    ],
    examples: FIXTURE_EXAMPLES,
    summarize: (f) => `fixture, ${Number(f.word_count ?? 0)} words`,
  };
  return pack as unknown as AnyPack;
}

export const fixturePack = makeFixturePack();
