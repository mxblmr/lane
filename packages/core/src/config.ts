import type { ClientSession, Db } from "mongodb";
import { collections } from "./schema/collections";
import {
  SETTINGS_ID,
  SettingsPatchSchema,
  SettingsSchema,
  type Settings,
  type SettingsPatch,
} from "./schema/settings";
import type { QuietHours } from "./schema/contracts";

/**
 * Fixed product numbers. Tunable numbers and operator switches live in `settings` (KTD23),
 * with defaults below; read them fresh on every run with `readSettings`.
 */

/** R7: every credit amount a player sees carries this label. */
export const PLAY_CREDIT_LABEL = "play credits (no real money)";

/** R10: Muse routine interval. Odd on purpose so it feels unscheduled. */
export const CHECKIN_INTERVAL_MIN = 27;
/** R10: at most three surprise proof checks a day, slots 0 to 2 (KTD13). */
export const SURPRISE_CHECKS_PER_DAY = 3;
/** R10: never between 10 PM and 8 AM in the player's time zone. */
export const QUIET_HOURS: QuietHours = { start: "22:00", end: "08:00" };

/** KTD13 clock defaults. Real mode: one-day days, 90-minute grace (two check-ins plus 30 minutes). */
export const REAL_DAY_LENGTH_SEC = 86_400;
export const REAL_GRACE_SEC = 90 * 60;
/** Demo mode: days of a few minutes and a 90-second grace. */
export const DEMO_DAY_LENGTH_SEC = 300;
export const DEMO_GRACE_SEC = 90;

/** KTD13: the tick takes a 15-second lease. */
export const TICK_LEASE_MS = 15_000;
/** KTD20: job runners renew every 15 seconds; the tick reclaims after 45 seconds without renewal. */
export const JOB_RENEW_MS = 15_000;
export const JOB_RECLAIM_MS = 45_000;
export const JOB_MAX_ATTEMPTS = 5;
/** U5: reply within 20 seconds, otherwise return pending and finish in a job. */
export const REFEREE_REPLY_MS = 20_000;

/** U6: six-character join codes. */
export const JOIN_CODE_LENGTH = 6;
/** KTD15: caps for quoted data and stored notes. */
export const QUOTE_CAP_CHARS = 2_000;
export const DIFF_CAP_CHARS = 6_000;
export const NOTE_CAP_CHARS = 280;

export const DEFAULT_SETTINGS: Settings = {
  _id: SETTINGS_ID,
  gate: {
    min_catch_gain: 0.1,
    max_false_alarm_rule: 0.01,
    max_false_alarm_set: 0.02,
    max_other_class_drop: 0.02,
  },
  starting_credits: 1_000,
  payout_limit: 150,
  dispute_cap_per_day: 3,
  learning_paused: false,
  registration_open: true,
  surprise_checks_enabled: true,
  updated_at: new Date(0),
};

/** Merge a stored settings document over the defaults. Unknown or invalid fields fall back to defaults. */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    _id: SETTINGS_ID,
    gate: { ...DEFAULT_SETTINGS.gate, ...(stored?.gate ?? {}) },
  };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

/** Read the settings document fresh (KTD23). Never cache across requests. */
export async function readSettings(db: Db, session?: ClientSession): Promise<Settings> {
  const stored = await collections(db).settings.findOne({ _id: SETTINGS_ID }, { session });
  return mergeSettings(stored);
}

/** Apply an operator patch (U12) and return the merged settings. */
export async function updateSettings(db: Db, patch: SettingsPatch, now: Date = new Date()): Promise<Settings> {
  const valid = SettingsPatchSchema.parse(patch);
  const set: Record<string, unknown> = { updated_at: now };
  for (const [key, value] of Object.entries(valid)) {
    if (key === "gate" && value && typeof value === "object") {
      for (const [g, v] of Object.entries(value)) {
        if (v !== undefined) set[`gate.${g}`] = v;
      }
    } else if (value !== undefined) {
      set[key] = value;
    }
  }
  await collections(db).settings.updateOne({ _id: SETTINGS_ID }, { $set: set }, { upsert: true });
  return readSettings(db);
}
