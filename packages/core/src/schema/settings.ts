import { z } from "zod";
import { GateThresholdsSchema } from "./rules";

export const SETTINGS_ID = "settings" as const;

/**
 * `settings` collection: one document with the KTD23 switches and numbers.
 * Defaults live in code (`config.ts`); every run reads it fresh; U12's operator controls write it.
 */
export const SettingsSchema = z.object({
  _id: z.literal(SETTINGS_ID),
  gate: GateThresholdsSchema,
  starting_credits: z.int().min(0),
  /** Any share above this waits for human approval (KTD12). */
  payout_limit: z.int().min(0),
  /** Disputes per disputer per challenge per day. */
  dispute_cap_per_day: z.int().min(0),
  learning_paused: z.boolean(),
  registration_open: z.boolean(),
  surprise_checks_enabled: z.boolean(),
  updated_at: z.date(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Patch accepted by `updateSettings` (operator controls). */
export const SettingsPatchSchema = SettingsSchema.omit({ _id: true, updated_at: true })
  .extend({ gate: GateThresholdsSchema.partial() })
  .partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
