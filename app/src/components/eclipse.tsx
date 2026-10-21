"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/app";
import { countdown, type EclipseState, eclipseAt, eclipseOffset, localWhen, MINUTE, parseTotality, type Totality, utcClock, utcStart } from "@/lib/totality";
import { TotalityCalendar } from "./totality";
import { DocsLink } from "./ui";

/*
 * The Totality eclipse: a bright disk that a dark disk slowly covers as the next Totality comes
 * (src/lib/totality.ts `eclipseAt`: from full at the end of the previous window to total at the
 * start of the next). While a window is on it is total: the dark disk with a thin stippled corona,
 * in the spirit of the landing's eclipse. Drawn on a canvas at the device's pixel ratio (up to 2),
 * redrawn about once a minute. On first show the dark disk glides the last few percent into place
 * and the corona fades in; with prefers-reduced-motion it is simply drawn.
 */

const TAU = Math.PI * 2;
/** Bright disk radius, as a share of the canvas side; the rest is room for the glow and corona. */
const SUN = 0.33;
/** The dark disk is a touch larger, so that when it is centred nothing of the bright one shows. */
const MOON = 1.03;
/** It arrives from the right, a little above the horizontal. */
const PATH = (-17 * Math.PI) / 180;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The corona as fixed points around the limb, in disk radii: x, y, alpha, size (CSS px). A thin
 * bright ring at the limb, then streamers that reach furthest near the horizontal, as the corona
 * does at solar minimum. The same seed always gives the same corona: nothing flickers.
 */
function coronaPoints(R: number): Float32Array {
  const rng = mulberry32(20261018);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rng());
  };
  const k = Math.max(0.35, Math.min(1.6, R / 80));
  const limb = Math.round(900 * k);
  const corona = Math.round(3200 * k);
  const out = new Float32Array((limb + corona) * 4);
  let o = 0;
  const put = (x: number, y: number, a: number, s: number) => {
    out[o++] = x;
    out[o++] = y;
    out[o++] = a;
    out[o++] = s;
  };
  const dot = Math.max(0.42, Math.min(0.9, R / 110));
  for (let i = 0; i < limb; i++) {
    const th = rng() * TAU;
    const r = MOON + Math.abs(gauss()) * 0.016;
    put(Math.cos(th) * r, Math.sin(th) * r, 0.35 + 0.5 * rng(), dot * (0.8 + 0.5 * rng()));
  }
  for (let i = 0; i < corona; i++) {
    const th0 = rng() * TAU;
    const u = rng();
    const streak = 0.55 + 0.45 * Math.sin(th0 * 7 + 1.3) * Math.sin(th0 * 3 - 0.4);
    const equator = Math.abs(Math.cos(th0)) ** 1.6;
    const reach = (0.12 + 0.3 * equator) * (0.6 + 0.4 * streak);
    const r = MOON + u ** 1.5 * reach * (0.7 + 0.5 * rng());
    const th = th0 + (rng() - 0.5) * 0.1 * u;
    const a = (1 - u) ** 2 * (0.25 + 0.6 * streak);
    put(Math.cos(th) * r, Math.sin(th) * r, a, dot * (0.7 + 0.6 * rng()));
  }
  return out;
}

interface Frame {
  coverage: number;
  total: boolean;
  /** Corona strength, 0 to 1 (its fade-in). */
  corona: number;
}

function paint(cv: HTMLCanvasElement, f: Frame, pts: { R: number; p: Float32Array } | undefined) {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  if (!w) return;
  // Both sides: a fresh canvas is 300 × 150, and 300 may already be the width wanted.
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(w * d)) {
    cv.width = Math.round(w * d);
    cv.height = Math.round(w * d);
  }
  const c = cv.getContext("2d");
  if (!c) return;
  c.setTransform(d, 0, 0, d, 0, 0);
  c.clearRect(0, 0, w, w);
  const cx = w / 2;
  const cy = w / 2;
  const R = w * SUN;

  if (!f.total) {
    const off = eclipseOffset(f.coverage, MOON) * R;
    const mx = cx + off * Math.cos(PATH);
    const my = cy + off * Math.sin(PATH);
    // The bright disk, its limb a shade darker, with a soft glow around it.
    c.save();
    c.shadowColor = "rgba(255,255,255,0.4)";
    c.shadowBlur = R * 0.36 * d;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.7, "#fbfbfb");
    g.addColorStop(1, "#d6d6d6");
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, R, 0, TAU);
    c.fill();
    c.restore();
    // The dark disk takes the light it covers, glow included, so only the lit crescent glows.
    c.fillStyle = "#000000";
    c.beginPath();
    c.arc(mx, my, R * MOON, 0, TAU);
    c.fill();
    // Its rim, faintly lit where it nears the bright disk (outside it only).
    c.save();
    c.beginPath();
    c.rect(0, 0, w, w);
    c.arc(cx, cy, R, 0, TAU, true);
    c.clip("evenodd");
    const rim = c.createRadialGradient(cx, cy, R, cx, cy, R * 1.6);
    rim.addColorStop(0, "rgba(255,255,255,0.2)");
    rim.addColorStop(1, "rgba(255,255,255,0)");
    c.strokeStyle = rim;
    c.lineWidth = 0.8;
    c.beginPath();
    c.arc(mx, my, R * MOON - 0.4, 0, TAU);
    c.stroke();
    c.restore();
    return;
  }

  // Total: a faint light around the dark disk, the stippled corona, and the disk itself on top.
  const k = f.corona;
  const halo = c.createRadialGradient(cx, cy, R * MOON, cx, cy, R * 1.5);
  halo.addColorStop(0, `rgba(255,255,255,${0.16 * k})`);
  halo.addColorStop(0.35, `rgba(255,255,255,${0.05 * k})`);
  halo.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = halo;
  c.fillRect(0, 0, w, w);
  if (pts) {
    c.fillStyle = "#ffffff";
    const p = pts.p;
    for (let i = 0; i < p.length; i += 4) {
      c.globalAlpha = Math.min(1, p[i + 2]! * k);
      c.beginPath();
      c.arc(cx + p[i]! * R, cy + p[i + 1]! * R, p[i + 3]!, 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  }
  c.fillStyle = "#000000";
  c.beginPath();
  c.arc(cx, cy, R * MOON, 0, TAU);
  c.fill();
}

function EclipseCanvas({ state, size }: { state: EclipseState; size: number }) {
  // A ten-thousandth of a week is about a minute: the drawing changes no faster than that.
  const coverage = Math.round(state.coverage * 1e4) / 1e4;
  const cv = useRef<HTMLCanvasElement>(null);
  const shown = useRef(false);
  const last = useRef<Frame>({ coverage, total: state.phase === "total", corona: 1 });
  const corona = useRef<{ R: number; p: Float32Array }>(undefined);
  const total = state.phase === "total";

  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const points = () => {
      const R = el.clientWidth * SUN;
      if (!corona.current || Math.abs(corona.current.R - R) > 4) corona.current = { R, p: coronaPoints(R) };
      return corona.current;
    };
    const target: Frame = { coverage, total, corona: 1 };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (shown.current || reduce) {
      shown.current = true;
      last.current = target;
      paint(el, target, total ? points() : undefined);
      return;
    }
    // First show: the dark disk glides the last few percent into place, or the corona fades in.
    shown.current = true;
    const from = Math.max(0, coverage - 0.14);
    const start = performance.now();
    const dur = 1600;
    let raf = 0;
    const frame = (t: number) => {
      const x = Math.min(1, (t - start) / dur);
      const e = 1 - (1 - x) ** 3;
      last.current = total ? { coverage: 1, total, corona: e } : { coverage: from + (coverage - from) * e, total, corona: 1 };
      paint(el, last.current, total ? points() : undefined);
      if (x < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [coverage, total]);

  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (last.current.total && el.clientWidth) {
        const R = el.clientWidth * SUN;
        if (!corona.current || Math.abs(corona.current.R - R) > 4) corona.current = { R, p: coronaPoints(R) };
      }
      paint(el, last.current, corona.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // From a phone's width up, the canvas reaches into the margin so that the disk, not the room
  // left around it for the glow, lines up with the text.
  return <canvas ref={cv} aria-hidden className="block aspect-square sm:-ml-[calc(var(--ew)*0.15)]" style={{ width: "var(--ew)", ["--ew" as string]: `min(${size}px, 62vw)` }} />;
}

/** When a moment is, for the tooltip: "Totality #1 · Sunday 20:00 UTC · 22:00 your time". */
function when(n: number, label: string, ms: number): string {
  const local = localWhen(ms);
  return `Totality #${n} · ${label}${local ? ` · ${local}` : ""}`;
}

/** "Next eclipse in 4d 06h 12m", or "Eclipse now · until 21:00 UTC"; digits in mono, local time on hover. */
function EclipseLine({ state, now }: { state: EclipseState; now: number }) {
  const w = state.window;
  if (state.phase === "total") {
    return (
      <p className="text-text" data-testid="eclipse-line" title={when(w.number, `until ${utcClock(w.end)}`, w.end)}>
        Eclipse now · until <span className="mono">{utcClock(w.end)}</span>
      </p>
    );
  }
  return (
    <p className="text-text" data-testid="eclipse-line" title={when(w.number, utcStart(w, now), w.start)}>
      Next eclipse in <span className="mono">{countdown(w.start - now)}</span>
    </p>
  );
}

/**
 * The deployment's Totality, validated. The clock ticks when the countdown's last unit changes:
 * each minute, each second in the last ten minutes. Undefined when the deployment has none.
 */
function useEclipse(): { t: Totality; now: number; state: EclipseState } | undefined {
  const { dep } = useApp();
  const t = useMemo(() => parseTotality(dep.totality), [dep.totality]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!t) return;
    let id: ReturnType<typeof setTimeout>;
    const step = () => {
      const n = Date.now();
      setNow(n);
      const e = eclipseAt(t, n);
      const left = (e.phase === "total" ? e.window.end : e.window.start) - n;
      const unit = e.phase === "approach" && left <= 10 * MINUTE + 1000 ? 1000 : 60_000;
      id = setTimeout(step, Math.min(left + 20, (left % unit || unit) + 20));
    };
    step();
    return () => clearTimeout(id);
  }, [t]);
  return t ? { t, now, state: eclipseAt(t, now) } : undefined;
}

/**
 * The eclipse with its one line under it and, optionally, two quiet words: add Totality to the
 * calendar, and why (Docs). Hidden when the deployment has no valid Totality.
 */
export function Eclipse({ size = 160, testId = "eclipse", actions = true, className = "" }: { size?: number; testId?: string; actions?: boolean; className?: string }) {
  const z = useEclipse();
  if (!z) return null;
  const { state } = z;
  const pct = Math.round(state.coverage * 100);
  return (
    <figure data-testid={testId} data-phase={state.phase} data-coverage={state.coverage.toFixed(4)} className={`m-0 flex flex-col items-start gap-3 ${className}`}
      aria-label={state.phase === "total" ? "The eclipse is total now" : `The eclipse is ${pct}% covered`}>
      <EclipseCanvas state={state} size={size} />
      <figcaption className="flex flex-col gap-1.5">
        <EclipseLine state={state} now={z.now} />
        {actions && (
          <span className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <TotalityCalendar t={z.t} testId={`${testId}-calendar`} />
            <DocsLink to="totality" />
          </span>
        )}
      </figcaption>
    </figure>
  );
}
