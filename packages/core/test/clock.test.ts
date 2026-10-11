import { describe, expect, it } from "vitest";
import {
  advanceDay,
  canScheduleSurpriseCheck,
  currentDayIndex,
  dayEnd,
  dayGraceEnd,
  dayIndexAt,
  dayStart,
  demoClockSettings,
  isProofDayOpen,
  isQuietHours,
  isWindowClosed,
  manualClock,
  nextCheckInAt,
  realClockSettings,
  windowEnd,
} from "../src/clock";
import { DEMO_GRACE_SEC, REAL_GRACE_SEC } from "../src/config";

const START = new Date("2026-10-11T20:00:00.000Z");
const sec = (n: number) => new Date(START.getTime() + n * 1000);

describe("challenge clock (KTD13)", () => {
  it("with a 300-second demo day and an operator offset of one day, 10 seconds after the start is day 1", () => {
    const clock = { ...demoClockSettings(START, { day_length_sec: 300 }), offset_days: 1 };
    expect(dayIndexAt(clock, sec(10))).toBe(1);
  });

  it("maps times to day indexes without an offset", () => {
    const clock = demoClockSettings(START, { day_length_sec: 300, days: 3 });
    expect(dayIndexAt(clock, sec(0))).toBe(0);
    expect(dayIndexAt(clock, sec(299))).toBe(0);
    expect(dayIndexAt(clock, sec(300))).toBe(1);
    expect(dayIndexAt(clock, sec(-1))).toBe(-1);
    expect(currentDayIndex(clock, sec(-1))).toBeNull();
    expect(currentDayIndex(clock, sec(900))).toBeNull();
    expect(currentDayIndex(clock, sec(650))).toBe(2);
  });

  it("advancing the operator clock moves the current day forward by one", () => {
    const clock = demoClockSettings(START, { day_length_sec: 300, days: 5 });
    const now = sec(30);
    expect(currentDayIndex(clock, now)).toBe(0);
    const advanced = advanceDay(clock);
    expect(advanced.offset_days).toBe(1);
    expect(currentDayIndex(advanced, now)).toBe(1);
    // Day 0 of the advanced clock started a day earlier in real time.
    expect(dayStart(advanced, 0).getTime()).toBe(START.getTime() - 300_000);
  });

  it("accepts a proof for a day until that day's grace ends", () => {
    const clock = demoClockSettings(START, { day_length_sec: 300, days: 3, grace_sec: 90 });
    // A commit made just before the day 0 boundary, submitted during day 1 but inside day 0's grace.
    const sourceDay = dayIndexAt(clock, sec(299));
    expect(sourceDay).toBe(0);
    expect(dayEnd(clock, 0).getTime()).toBe(sec(300).getTime());
    expect(dayGraceEnd(clock, 0).getTime()).toBe(sec(390).getTime());
    expect(isProofDayOpen(clock, sourceDay, sec(350))).toBe(true);
    expect(isProofDayOpen(clock, sourceDay, sec(390))).toBe(false);
    expect(isProofDayOpen(clock, 5, sec(10))).toBe(false);
    expect(isProofDayOpen(clock, -1, sec(10))).toBe(false);
  });

  it("closes the window at the end of the last day", () => {
    const clock = demoClockSettings(START, { day_length_sec: 300, days: 2 });
    expect(windowEnd(clock).getTime()).toBe(sec(600).getTime());
    expect(isWindowClosed(clock, sec(599))).toBe(false);
    expect(isWindowClosed(clock, sec(600))).toBe(true);
    expect(isWindowClosed(advanceDay(clock), sec(300))).toBe(true);
  });

  it("uses one-day days and a 90-minute grace in real mode, and a 90-second grace in demo mode", () => {
    const real = realClockSettings(START, 7);
    expect(real.day_length_sec).toBe(86_400);
    expect(real.grace_sec).toBe(REAL_GRACE_SEC);
    expect(REAL_GRACE_SEC).toBe(90 * 60);
    expect(demoClockSettings(START).grace_sec).toBe(DEMO_GRACE_SEC);
    expect(DEMO_GRACE_SEC).toBe(90);
  });

  it("schedules the next check-in 27 minutes out", () => {
    expect(nextCheckInAt(START).getTime() - START.getTime()).toBe(27 * 60_000);
  });

  it("provides a manual clock for tests", () => {
    const clock = manualClock(START);
    clock.advance(5_000);
    expect(clock.now().getTime()).toBe(START.getTime() + 5_000);
  });
});

describe("quiet hours (R10)", () => {
  const LA = "America/Los_Angeles";

  it("counts 10:30 PM in America/Los_Angeles as quiet hours and 8:01 AM as not", () => {
    // 2026-10-11 is PDT (UTC-7).
    expect(isQuietHours(LA, new Date("2026-10-12T05:30:00Z"))).toBe(true); // 10:30 PM PDT
    expect(isQuietHours(LA, new Date("2026-10-12T15:01:00Z"))).toBe(false); // 8:01 AM PDT
    expect(isQuietHours(LA, new Date("2026-10-12T14:59:00Z"))).toBe(true); // 7:59 AM PDT
    expect(isQuietHours(LA, new Date("2026-10-12T04:59:00Z"))).toBe(false); // 9:59 PM PDT
  });

  it("refuses a surprise check due at 9:00 PM with a 90-minute grace, because its grace would end in quiet hours", () => {
    const decision = canScheduleSurpriseCheck({
      releaseAt: new Date("2026-10-12T04:00:00Z"), // 9:00 PM PDT
      graceSec: 90 * 60,
      timeZone: LA,
    });
    expect(decision).toEqual({ ok: false, reason: "quiet_hours" });
  });

  it("allows a surprise check at 6:00 PM with a 90-minute grace", () => {
    const decision = canScheduleSurpriseCheck({
      releaseAt: new Date("2026-10-12T01:00:00Z"), // 6:00 PM PDT
      graceSec: 90 * 60,
      timeZone: LA,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("refuses a surprise check released during quiet hours", () => {
    const decision = canScheduleSurpriseCheck({
      releaseAt: new Date("2026-10-12T14:00:00Z"), // 7:00 AM PDT
      graceSec: 90,
      timeZone: LA,
    });
    expect(decision.ok).toBe(false);
  });

  it("refuses a surprise check whose grace would end after the window", () => {
    const decision = canScheduleSurpriseCheck({
      releaseAt: new Date("2026-10-12T01:00:00Z"),
      graceSec: 90,
      timeZone: LA,
      notAfter: new Date("2026-10-12T01:00:30Z"),
    });
    expect(decision).toEqual({ ok: false, reason: "after_window" });
  });
});
