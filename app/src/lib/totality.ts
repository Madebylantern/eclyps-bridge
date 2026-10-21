/**
 * Totality: a recurring crossing window when people move in together, so batches fill sooner and
 * a deposit's timing says less about who made it. It is configuration (`deployment.totality`) plus
 * the pure functions here: no server, no reward, nothing promised about who will come.
 *
 * Every time is a UTC instant in ms. Window n starts exactly n - 1 weeks of UTC after `first`, so
 * there is no daylight-saving arithmetic; only the "your time" wording uses the viewer's time zone,
 * through Intl. Windows before `first` do not exist: numbering starts at Totality #1.
 *
 * No runtime imports, so `node --test test/totality.test.ts` runs this file as it is.
 */
import type { TotalityConfig } from "./deployment";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** A validated Totality configuration. */
export interface Totality {
  weekday: number;
  hourUtc: number;
  minutes: number;
  /** Start of Totality #1. */
  firstMs: number;
  lengthMs: number;
}

export interface TotalityWindow {
  /** Totality #n, counted from `first` (1-based). */
  number: number;
  start: number;
  /** Exclusive. */
  end: number;
}

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validates `deployment.totality`. Anything unexpected (missing fields, out-of-range numbers, a
 * `first` without an explicit zone, or a `first` that is not on the stated weekday and hour)
 * returns undefined, and the app hides Totality.
 */
export function parseTotality(raw: unknown): Totality | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Partial<Record<keyof TotalityConfig, unknown>>;
  if (!isInt(c.weekday, 0, 6) || !isInt(c.hourUtc, 0, 23) || !isInt(c.minutes, 1, 24 * 60)) return undefined;
  if (typeof c.first !== "string" || !/(?:Z|[+-]\d\d:?\d\d)$/i.test(c.first.trim())) return undefined;
  const firstMs = Date.parse(c.first);
  if (!Number.isFinite(firstMs)) return undefined;
  const f = new Date(firstMs);
  if (f.getUTCDay() !== c.weekday || f.getUTCHours() !== c.hourUtc || f.getUTCMinutes() || f.getUTCSeconds() || f.getUTCMilliseconds()) return undefined;
  return { weekday: c.weekday, hourUtc: c.hourUtc, minutes: c.minutes, firstMs, lengthMs: c.minutes * MINUTE };
}

/** Totality #n (n >= 1). */
export function windowByNumber(t: Totality, n: number): TotalityWindow {
  const start = t.firstMs + (Math.max(1, Math.floor(n)) - 1) * WEEK;
  return { number: Math.max(1, Math.floor(n)), start, end: start + t.lengthMs };
}

/** The number of the latest window that has started at or before `at`; 0 before Totality #1. */
export function windowNumber(t: Totality, at: number): number {
  return at < t.firstMs ? 0 : Math.floor((at - t.firstMs) / WEEK) + 1;
}

/** The window that is on at `now`, if any. */
export function windowOn(t: Totality, now: number): TotalityWindow | undefined {
  const n = windowNumber(t, now);
  if (n === 0) return undefined;
  const w = windowByNumber(t, n);
  return now < w.end ? w : undefined;
}

/** The first window that starts after `now` (while one is on, the one after it). */
export function nextWindow(t: Totality, now: number): TotalityWindow {
  return windowByNumber(t, windowNumber(t, now) + 1);
}

/** The window to plan in: the one that is on while at least `minLeftMs` of it remains, else the next. */
export function planningWindow(t: Totality, now: number, minLeftMs = 10 * MINUTE): TotalityWindow {
  const on = windowOn(t, now);
  return on && on.end - now >= minLeftMs ? on : nextWindow(t, now);
}

/**
 * Where a Totality plan made at `now` puts its deposits: from `from`, over `windowMs`. Deposits
 * start no sooner than `leadMs` from now (the form's minute to sign) and end `tailMs` before the
 * window does, so the last one can still be signed inside it.
 */
export function totalityPlan(t: Totality, now: number, o: { leadMs?: number; tailMs?: number; minLeftMs?: number } = {}) {
  const lead = o.leadMs ?? MINUTE;
  const tail = o.tailMs ?? MINUTE;
  const window = planningWindow(t, now + lead, o.minLeftMs);
  const from = Math.max(now + lead, window.start);
  return { window, from, windowMs: Math.max(0, window.end - tail - from) };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "21:00 UTC". */
export function utcClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "Sunday 20:00 UTC": when every window starts. */
export function utcWhen(t: Totality): string {
  return `${WEEKDAYS[t.weekday]} ${pad(t.hourUtc)}:00 UTC`;
}

/** "Sunday 20:00–21:00 UTC". */
export function utcSpan(t: Totality): string {
  const w = windowByNumber(t, 1);
  return `${WEEKDAYS[t.weekday]} ${utcClock(w.start).slice(0, 5)}–${utcClock(w.end)}`;
}

/**
 * When a window starts, in UTC: "Sunday 20:00 UTC", or with the date when it is more than a week
 * away ("Sunday 18 October 20:00 UTC").
 */
export function utcStart(w: TotalityWindow, now: number): string {
  const d = new Date(w.start);
  const date = w.start - now > WEEK ? ` ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : "";
  return `${WEEKDAYS[d.getUTCDay()]}${date} ${utcClock(w.start)}`;
}

/**
 * The same moment on the viewer's clock: "22:00 your time", "Monday 05:00 your time", or undefined
 * when the viewer's clock reads UTC anyway. `timeZone` and `locale` default to the viewer's.
 */
export function localWhen(ms: number, o: { timeZone?: string; locale?: string } = {}): string | undefined {
  const fmt = (timeZone: string | undefined, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(o.locale, { ...opts, timeZone }).format(ms);
  const time = { hour: "2-digit", minute: "2-digit" } as const;
  const day = { weekday: "long" } as const;
  const local = { t: fmt(o.timeZone, time), d: fmt(o.timeZone, day) };
  const utc = { t: fmt("UTC", time), d: fmt("UTC", day) };
  if (local.t === utc.t && local.d === utc.d) return undefined;
  return `${local.d === utc.d ? "" : `${local.d} `}${local.t} your time`;
}

/** "in 4 days", "in 1 day 6 h", "in 3 h 20 min", "in 12 min", "in under a minute", "now". */
export function untilText(ms: number, now: number): string {
  const d = ms - now;
  if (d <= 0) return "now";
  if (d < MINUTE) return "in under a minute";
  const m = Math.floor(d / MINUTE);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  const days = Math.floor(h / 24);
  if (days < 2) return `in 1 day${h % 24 ? ` ${h % 24} h` : ""}`;
  return `in ${days} days`;
}

/** Where Totality stands at `now`: the window that is on (if any) and the next one. */
export function totalityStatus(t: Totality, now: number): { on?: TotalityWindow; next: TotalityWindow } {
  return { on: windowOn(t, now), next: nextWindow(t, now) };
}

/**
 * The eclipse the app draws for Totality. Between windows a dark disk slides over a bright one:
 * `coverage` (the share of the bright disk's area that is covered) runs from 0 at the end of the
 * previous window (a week before Totality #1 for the first) to 1 when the next window starts.
 * While a window is on the eclipse is total. Linear in time, so a glance says how close it is.
 */
export interface EclipseState {
  phase: "approach" | "total";
  coverage: number;
  /** The window the eclipse leads to, or the one that is on. */
  window: TotalityWindow;
}

export function eclipseAt(t: Totality, now: number): EclipseState {
  const on = windowOn(t, now);
  if (on) return { phase: "total", coverage: 1, window: on };
  const next = nextWindow(t, now);
  const from = next.number > 1 ? windowByNumber(t, next.number - 1).end : t.firstMs - WEEK;
  const span = next.start - from;
  const coverage = span > 0 ? Math.min(1, Math.max(0, (now - from) / span)) : 1;
  return { phase: "approach", coverage, window: next };
}

/** Area shared by two circles of radii `r1` and `r2` whose centres are `d` apart. */
export function lensArea(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a + b - c;
}

/**
 * How far the dark disk's centre sits from the bright disk's (in bright-disk radii) when it covers
 * `coverage` of its area. `moon` is the dark disk's radius in the same unit (at least 1, so that
 * it can cover everything): `1 + moon` when nothing is covered, `moon - 1` when all of it is.
 */
export function eclipseOffset(coverage: number, moon = 1): number {
  const k = Math.min(1, Math.max(0, coverage));
  let lo = Math.max(0, moon - 1);
  let hi = 1 + moon;
  if (k <= 0) return hi;
  if (k >= 1) return lo;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (lensArea(1, moon, mid) / Math.PI > k) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The eclipse countdown: "4d 06h 12m", "6h 05m", "42m"; in the last ten minutes with seconds,
 * "9m 05s", "42s". Units are floored, so it never says more time is left than there is.
 */
export function countdown(leftMs: number): string {
  const s = Math.max(0, Math.floor(leftMs / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (leftMs <= 10 * MINUTE) return m ? `${m}m ${pad(sec)}s` : `${sec}s`;
  if (d) return `${d}d ${pad(h)}h ${pad(m)}m`;
  if (h) return `${h}h ${pad(m)}m`;
  return `${m}m`;
}
