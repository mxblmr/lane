import { z } from "zod";
import { ChallengeTypeSchema, FeaturesSchema, IdSchema } from "./common";
import { FeatureNameSchema } from "./rule";

export const EXAMPLE_SOURCES = ["seed", "red_team", "dispute", "live"] as const;
export const ExampleSourceSchema = z.enum(EXAMPLE_SOURCES);
export type ExampleSource = z.infer<typeof ExampleSourceSchema>;

export const ExampleLabelSchema = z.enum(["cheat", "honest"]);
export type ExampleLabel = z.infer<typeof ExampleLabelSchema>;

/** A labelled example as a pack ships it (before Lane stores it). */
export const LabelledExampleSchema = z
  .object({
    example_key: z.string().min(1).max(80),
    label: ExampleLabelSchema,
    /** Cheat class id (matches a feature name). Required for cheats, null for honest. */
    cheat_class: FeatureNameSchema.nullable(),
    features: FeaturesSchema,
    /** Lane-rendered one-line summary for the dashboard, for example "commit, 3 files, +42/-5". */
    summary: z.string().max(200).nullable().default(null),
  })
  .superRefine((e, ctx) => {
    if (e.label === "cheat" && !e.cheat_class) {
      ctx.addIssue({ code: "custom", path: ["cheat_class"], message: "cheat examples need a cheat class" });
    }
    if (e.label === "honest" && e.cheat_class !== null) {
      ctx.addIssue({ code: "custom", path: ["cheat_class"], message: "honest examples have no cheat class" });
    }
  });
export type LabelledExample = z.infer<typeof LabelledExampleSchema>;

/**
 * `examples` collection. Written by U9's loader and by rule-lab through the internal API.
 * Honest examples come only from seed data; the red team can add only cheats (KTD9).
 * Unique on (challenge_type, example_key).
 */
export const ExampleSchema = z
  .object({
    _id: IdSchema,
    challenge_type: ChallengeTypeSchema,
    example_key: z.string().min(1).max(80),
    label: ExampleLabelSchema,
    cheat_class: FeatureNameSchema.nullable(),
    features: FeaturesSchema,
    source: ExampleSourceSchema,
    summary: z.string().max(200).nullable(),
    proof_id: IdSchema.nullable(),
    created_at: z.date(),
  })
  .superRefine((e, ctx) => {
    if (e.label === "honest" && e.source !== "seed") {
      ctx.addIssue({ code: "custom", path: ["source"], message: "honest examples come only from seed data" });
    }
    if (e.label === "cheat" && !e.cheat_class) {
      ctx.addIssue({ code: "custom", path: ["cheat_class"], message: "cheat examples need a cheat class" });
    }
  });
export type Example = z.infer<typeof ExampleSchema>;
