import type { ClockSettings } from "./schema/challenges";
import type { QuietHours } from "./schema/contracts";
import {
  CHECKIN_INTERVAL_MIN,
  DEMO_DAY_LENGTH_SEC,
  DEMO_GRACE_SEC,
  QUIET_HOURS,
  REAL_DAY_LENGTH_SEC,
  REAL_GRACE_SEC,
} from "./config";

/**
 * The one clock module behind every time rule (KTD13).
 *
 * Day `i` of a challenge covers the real-time interval
 *   [start_at + (i - offset_days) * day_length, start_at + (i - offset_days + 1) * day_length)
 * so advancing the operator offset by one moves the challenge forward a whole day (R32).
 * A proof's day index comes from its source time, and Lane accepts it while that day's
 * grace period is still open.
 */

/** Injectable source of "now". Pass a fixed clock in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ManualClock extends Clock {
  set(at: Date): void;
  advance(ms: number): void;
}

/** A clock that only moves when told to. For tests and scripts. */
export function manualClock(start: Date): ManualClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (at: Date) => {
      t = at.getTime();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export function realClockSettings(start: Date, days: number): ClockSettings {
  return { mode: "real", start_at: start, day_length_sec: REAL_DAY_LENGTH_SEC, days, grace_sec: REAL_GRACE_SEC, offset_days: 0 };
}

export function demoClockSettings(
  start: Date,
  opts: { days?: number; day_length_sec?: number; grace_sec?: number } = {},
): ClockSettings {
  return {
    mode: "demo",
    start_at: start,
    day_length_sec: opts.day_length_sec ?? DEMO_DAY_LENGTH_SEC,
    days: opts.days ?? 7,
    grace_sec: opts.grace_sec ?? DEMO_GRACE_SEC,
    offset_days: 0,
  };
}

export function dayLengthMs(c: ClockSettings): number {
  return c.day_length_sec * 1000;
}

export function graceMs(c: ClockSettings): number {
  return c.grace_sec * 1000;
}

/**
 * Day index of a real time. Can be negative (before the window) or >= `days` (after it);
 * use `isDayInWindow` to check.
 */
export function dayIndexAt(c: ClockSettings, t: Date): number {
  return Math.floor((t.getTime() - c.start_at.getTime()) / dayLengthMs(c)) + c.offset_days;
}

export function isDayInWindow(c: ClockSettings, dayIndex: number): boolean {
  return Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex < c.days;
}

/** Current day index, or null outside the window. */
export function currentDayIndex(c: ClockSettings, now: Date): number | null {
  const i = dayIndexAt(c, now);
  return isDayInWindow(c, i) ? i : null;
}

/** Real time when day `i` starts. */
export function dayStart(c: ClockSettings, dayIndex: number): Date {
  return new Date(c.start_at.getTime() + (dayIndex - c.offset_days) * dayLengthMs(c));
}

/** Real time when day `i` ends (exclusive). */
export function dayEnd(c: ClockSettings, dayIndex: number): Date {
  return dayStart(c, dayIndex + 1);
}

/** Real time when day `i`'s grace period ends. Proofs for day `i` are accepted until then. */
export function dayGraceEnd(c: ClockSettings, dayIndex: number): Date {
  return new Date(dayEnd(c, dayIndex).getTime() + graceMs(c));
}

/** Real time the window opens (start of day 0). */
export function windowStart(c: ClockSettings): Date {
  return dayStart(c, 0);
}

/** Real time the window closes (end of the last day). */
export function windowEnd(c: ClockSettings): Date {
  return dayStart(c, c.days);
}

/** Grace end of the last day: the latest time any proof can still be accepted. */
export function finalGraceEnd(c: ClockSettings): Date {
  return dayGraceEnd(c, c.days - 1);
}

export function isWindowClosed(c: ClockSettings, now: Date): boolean {
  return now.getTime() >= windowEnd(c).getTime();
}

/**
 * KTD13: Lane accepts a proof while its day's grace period is open, so routine lag never
 * costs an honest day. False for days outside the window or not yet started.
 */
export function isProofDayOpen(c: ClockSettings, dayIndex: number, now: Date): boolean {
  if (!isDayInWindow(c, dayIndex)) return false;
  const t = now.getTime();
  return t >= dayStart(c, dayIndex).getTime() && t < dayGraceEnd(c, dayIndex).getTime();
}

/** The operator's advance-day control (R32): a new settings object with the offset bumped. */
export function advanceDay(c: ClockSettings, days = 1): ClockSettings {
  return { ...c, offset_days: c.offset_days + days };
}

/** Deadline for an item opened at `from` under this challenge's grace period. */
export function graceDeadline(c: ClockSettings, from: Date): Date {
  return new Date(from.getTime() + graceMs(c));
}

/** When the player's routine should check in next (R10). */
export function nextCheckInAt(now: Date): Date {
  return new Date(now.getTime() + CHECKIN_INTERVAL_MIN * 60_000);
}

// ---------------------------------------------------------------- quiet hours (R10)

/** Local wall-clock hour and minute of `at` in `timeZone`. */
export function localTime(timeZone: string, at: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True when `at` falls in the player's quiet hours, start inclusive and end exclusive. */
export function isQuietHours(timeZone: string, at: Date, quiet: QuietHours = QUIET_HOURS): boolean {
  const { hour, minute } = localTime(timeZone, at);
  const m = hour * 60 + minute;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  return start <= end ? m >= start && m < end : m >= start || m < end;
}

/** True when any moment in [from, to] falls in quiet hours. */
export function overlapsQuietHours(timeZone: string, from: Date, to: Date, quiet: QuietHours = QUIET_HOURS): boolean {
  const stepMs = 5 * 60_000;
  const end = to.getTime();
  for (let t = from.getTime(); t < end; t += stepMs) {
    if (isQuietHours(timeZone, new Date(t), quiet)) return true;
  }
  return isQuietHours(timeZone, to, quiet);
}

export type SurpriseCheckDecision = { ok: true } | { ok: false; reason: "quiet_hours" | "after_window" };

/**
 * KTD13: no surprise check is drawn whose release or grace would touch the player's quiet hours.
 * `releaseAt` is when the check reaches the inbox; its grace ends `graceSec` later.
 */
export function canScheduleSurpriseCheck(input: {
  releaseAt: Date;
  graceSec: number;
  timeZone: string;
  quiet?: QuietHours;
  /** Optional: refuse checks whose grace would end after this time (for example the final grace end). */
  notAfter?: Date;
}): SurpriseCheckDecision {
  const graceEnd = new Date(input.releaseAt.getTime() + input.graceSec * 1000);
  if (input.notAfter && graceEnd.getTime() > input.notAfter.getTime()) {
    return { ok: false, reason: "after_window" };
  }
  if (overlapsQuietHours(input.timeZone, input.releaseAt, graceEnd, input.quiet ?? QUIET_HOURS)) {
    return { ok: false, reason: "quiet_hours" };
  }
  return { ok: true };
}
