/**
 * Totality helpers (src/lib/totality.ts). Run with `pnpm --filter @eclyps/app test`
 * (node --test; Node >= 22.18 runs TypeScript files directly).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countdown,
  DAY,
  eclipseAt,
  eclipseOffset,
  HOUR,
  lensArea,
  localWhen,
  MINUTE,
  nextWindow,
  parseTotality,
  planningWindow,
  totalityPlan,
  totalityStatus,
  untilText,
  utcClock,
  utcSpan,
  utcStart,
  utcWhen,
  WEEK,
  windowByNumber,
  windowNumber,
  windowOn,
} from "../src/lib/totality.ts";

const CONFIG = { weekday: 0, hourUtc: 20, minutes: 60, first: "2026-10-18T20:00:00Z" };
const t = parseTotality(CONFIG)!;
const FIRST = Date.UTC(2026, 9, 18, 20); // Sunday 18 October 2026, 20:00 UTC

describe("parseTotality", () => {
  it("accepts the default weekly window", () => {
    assert.deepEqual(t, { weekday: 0, hourUtc: 20, minutes: 60, firstMs: FIRST, lengthMs: HOUR });
    assert.equal(parseTotality({ ...CONFIG, first: "2026-10-18T22:00:00+02:00" })?.firstMs, FIRST);
  });

  it("hides Totality for anything unexpected", () => {
    for (const bad of [
      undefined,
      null,
      "weekly",
      [],
      {},
      { ...CONFIG, weekday: 7 },
      { ...CONFIG, weekday: 1 }, // first is a Sunday
      { ...CONFIG, hourUtc: 21 }, // first is at 20:00
      { ...CONFIG, hourUtc: 20.5 },
      { ...CONFIG, minutes: 0 },
      { ...CONFIG, minutes: 24 * 60 + 1 },
      { ...CONFIG, minutes: "60" },
      { ...CONFIG, first: "2026-10-18T20:00:00" }, // no zone: would be read as local time
      { ...CONFIG, first: "2026-10-18T20:30:00Z" }, // not on the hour
      { ...CONFIG, first: "soon" },
      { ...CONFIG, first: 1792353600000 },
    ]) {
      assert.equal(parseTotality(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("windows", () => {
  it("numbers windows from first; none exist before it", () => {
    assert.equal(windowNumber(t, FIRST - 1), 0);
    assert.equal(windowNumber(t, FIRST), 1);
    assert.equal(windowNumber(t, FIRST + WEEK - 1), 1);
    assert.equal(windowNumber(t, FIRST + WEEK), 2);
    assert.equal(windowNumber(t, FIRST + 10 * WEEK + 3 * DAY), 11);
    assert.deepEqual(windowByNumber(t, 3), { number: 3, start: FIRST + 2 * WEEK, end: FIRST + 2 * WEEK + HOUR });
  });

  it("knows when a window is on (start inclusive, end exclusive)", () => {
    assert.equal(windowOn(t, FIRST - 1), undefined);
    assert.deepEqual(windowOn(t, FIRST), { number: 1, start: FIRST, end: FIRST + HOUR });
    assert.equal(windowOn(t, FIRST + 59 * MINUTE)?.number, 1);
    assert.equal(windowOn(t, FIRST + HOUR), undefined);
    assert.equal(windowOn(t, FIRST + WEEK + 30 * MINUTE)?.number, 2);
    assert.equal(windowOn(t, FIRST + WEEK - MINUTE), undefined);
  });

  it("finds the next window, across the week boundary", () => {
    const now = Date.UTC(2026, 9, 13, 9); // Tuesday before Totality #1
    assert.deepEqual(nextWindow(t, now), { number: 1, start: FIRST, end: FIRST + HOUR });
    assert.equal(nextWindow(t, FIRST).number, 2); // while #1 is on, the next is #2
    assert.equal(nextWindow(t, FIRST + HOUR).number, 2);
    assert.equal(nextWindow(t, FIRST + WEEK - 1).start, FIRST + WEEK);
    assert.equal(nextWindow(t, FIRST + WEEK).start, FIRST + 2 * WEEK);
    // Saturday 23:59 UTC to Sunday: still the same week's window.
    assert.equal(nextWindow(t, Date.UTC(2026, 9, 24, 23, 59)).number, 2);
    assert.deepEqual(totalityStatus(t, FIRST + 10 * MINUTE), { on: windowByNumber(t, 1), next: windowByNumber(t, 2) });
  });

  it("is daylight-saving free: every window starts at 20:00 UTC", () => {
    for (let n = 1; n <= 60; n++) {
      const d = new Date(windowByNumber(t, n).start);
      assert.equal(d.getUTCDay(), 0);
      assert.equal(d.getUTCHours(), 20);
      assert.equal(d.getUTCMinutes(), 0);
    }
  });

  it("plans in the window that is on while enough of it remains, else the next", () => {
    assert.equal(planningWindow(t, FIRST + 30 * MINUTE).number, 1);
    assert.equal(planningWindow(t, FIRST + 55 * MINUTE).number, 2);
    assert.equal(planningWindow(t, FIRST - DAY).number, 1);
  });

  it("places a plan inside its window, a minute before it ends", () => {
    const before = totalityPlan(t, FIRST - 2 * DAY);
    assert.deepEqual(before, { window: windowByNumber(t, 1), from: FIRST, windowMs: HOUR - MINUTE });
    const during = totalityPlan(t, FIRST + 20 * MINUTE);
    assert.equal(during.window.number, 1);
    assert.equal(during.from, FIRST + 21 * MINUTE);
    assert.equal(during.windowMs, 38 * MINUTE);
    assert.equal(totalityPlan(t, FIRST + 52 * MINUTE).window.number, 2);
  });
});

describe("wording", () => {
  it("says when, in UTC", () => {
    assert.equal(utcWhen(t), "Sunday 20:00 UTC");
    assert.equal(utcSpan(t), "Sunday 20:00–21:00 UTC");
    assert.equal(utcClock(FIRST + HOUR), "21:00 UTC");
    assert.equal(utcStart(windowByNumber(t, 1), FIRST - 2 * DAY), "Sunday 20:00 UTC");
    assert.equal(utcStart(windowByNumber(t, 1), FIRST - 10 * DAY), "Sunday 18 October 20:00 UTC");
    const late = parseTotality({ weekday: 6, hourUtc: 23, minutes: 90, first: "2026-10-17T23:00:00Z" })!;
    assert.equal(utcSpan(late), "Saturday 23:00–00:30 UTC");
  });

  it("says when on the viewer's clock, following their daylight saving", () => {
    const o = (timeZone: string) => ({ timeZone, locale: "en-GB" });
    assert.equal(localWhen(FIRST, o("UTC")), undefined);
    assert.equal(localWhen(FIRST, o("Europe/Rome")), "22:00 your time"); // CEST
    assert.equal(localWhen(windowByNumber(t, 3).start, o("Europe/Rome")), "21:00 your time"); // CET from 25 October
    assert.equal(localWhen(windowByNumber(t, 3).start, o("Europe/London")), undefined); // GMT
    assert.equal(localWhen(FIRST, o("America/Los_Angeles")), "13:00 your time");
    assert.equal(localWhen(FIRST, o("Asia/Tokyo")), "Monday 05:00 your time");
  });

  it("counts down in plain units", () => {
    const now = 1_000_000;
    assert.equal(untilText(now - 1, now), "now");
    assert.equal(untilText(now + 30_000, now), "in under a minute");
    assert.equal(untilText(now + 12 * MINUTE + 59_000, now), "in 12 min");
    assert.equal(untilText(now + 3 * HOUR + 20 * MINUTE, now), "in 3 h 20 min");
    assert.equal(untilText(now + 5 * HOUR, now), "in 5 h");
    assert.equal(untilText(now + DAY + 6 * HOUR, now), "in 1 day 6 h");
    assert.equal(untilText(now + 4 * DAY + 11 * HOUR, now), "in 4 days");
    assert.equal(untilText(FIRST, Date.UTC(2026, 9, 13, 9)), "in 5 days");
  });
});

describe("eclipse", () => {
  it("fills from a full bright disk a week before Totality #1 to total at its start", () => {
    assert.deepEqual(eclipseAt(t, FIRST - 10 * DAY), { phase: "approach", coverage: 0, window: windowByNumber(t, 1) });
    assert.equal(eclipseAt(t, FIRST - WEEK).coverage, 0);
    assert.equal(eclipseAt(t, FIRST - WEEK / 2).coverage, 0.5);
    assert.equal(eclipseAt(t, FIRST - DAY).coverage, 6 / 7);
    assert.equal(eclipseAt(t, FIRST - 1).phase, "approach");
    assert.ok(eclipseAt(t, FIRST - 1).coverage > 0.999);
  });

  it("is total while a window is on, then starts again from full", () => {
    assert.deepEqual(eclipseAt(t, FIRST), { phase: "total", coverage: 1, window: windowByNumber(t, 1) });
    assert.equal(eclipseAt(t, FIRST + 59 * MINUTE).phase, "total");
    const after = eclipseAt(t, FIRST + HOUR);
    assert.deepEqual(after, { phase: "approach", coverage: 0, window: windowByNumber(t, 2) });
    const mid = FIRST + HOUR + (WEEK - HOUR) / 2;
    assert.equal(eclipseAt(t, mid).coverage, 0.5);
    assert.equal(eclipseAt(t, FIRST + WEEK).phase, "total");
    assert.equal(eclipseAt(t, FIRST + WEEK).window.number, 2);
  });

  it("measures the covered area of two disks", () => {
    assert.equal(lensArea(1, 1, 2), 0);
    assert.equal(lensArea(1, 1, 3), 0);
    assert.equal(lensArea(1, 1.1, 0.05), Math.PI);
    assert.ok(Math.abs(lensArea(1, 1, 0) - Math.PI) < 1e-12);
    // Two unit disks one radius apart share 2π/3 − √3/2.
    assert.ok(Math.abs(lensArea(1, 1, 1) - ((2 * Math.PI) / 3 - Math.sqrt(3) / 2)) < 1e-12);
  });

  it("places the dark disk so that it covers exactly the asked share", () => {
    assert.equal(eclipseOffset(0), 2);
    assert.equal(eclipseOffset(1), 0);
    assert.equal(eclipseOffset(-1), 2);
    assert.equal(eclipseOffset(2), 0);
    assert.ok(Math.abs(eclipseOffset(1, 1.03) - 0.03) < 1e-12);
    assert.ok(Math.abs(eclipseOffset(0, 1.03) - 2.03) < 1e-12);
    let last = Infinity;
    for (const k of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      for (const moon of [1, 1.03]) {
        const d = eclipseOffset(k, moon);
        assert.ok(Math.abs(lensArea(1, moon, d) / Math.PI - k) < 1e-9, `${k} ${moon}`);
      }
      const d = eclipseOffset(k);
      assert.ok(d < last, "covers more as it moves in");
      last = d;
    }
  });
});

describe("countdown", () => {
  it("counts down to the eclipse in days, hours and minutes, with seconds at the end", () => {
    assert.equal(countdown(4 * DAY + 6 * HOUR + 12 * MINUTE + 59_000), "4d 06h 12m");
    assert.equal(countdown(DAY), "1d 00h 00m");
    assert.equal(countdown(6 * HOUR + 5 * MINUTE), "6h 05m");
    assert.equal(countdown(42 * MINUTE + 30_000), "42m");
    assert.equal(countdown(10 * MINUTE + 1000), "10m");
    assert.equal(countdown(10 * MINUTE), "10m 00s");
    assert.equal(countdown(9 * MINUTE + 5_900), "9m 05s");
    assert.equal(countdown(42_000), "42s");
    assert.equal(countdown(0), "0s");
    assert.equal(countdown(-5000), "0s");
    assert.equal(countdown(FIRST - Date.UTC(2026, 9, 13, 13, 47, 30)), "5d 06h 12m");
  });
});
