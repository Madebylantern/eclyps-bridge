"use client";

import { useEffect, useRef } from "react";
import { useMinBatch } from "./live";
import { gauss, mulberry32, TAU } from "./rng";

// The two drawings that move: the small eclipse at the top and the crossing. Both are canvas
// points of light on black. They draw only while on screen, and with prefers-reduced-motion they
// draw one still frame (again on resize).

type Pt = { x: number; y: number };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x: number) => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function fit(cv: HTMLCanvasElement): { c: CanvasRenderingContext2D; w: number; h: number } | null {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return null;
  cv.width = Math.round(w * d);
  cv.height = Math.round(h * d);
  const c = cv.getContext("2d");
  if (!c) return null;
  c.setTransform(d, 0, 0, d, 0, 0);
  return { c, w, h };
}

/** Runs `draw(t)` every frame while `el` is on screen; once (and on resize) under reduced motion. */
function animate(el: Element, layout: () => void, draw: (t: number) => void): () => void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  let visible = false;
  const t0 = performance.now();
  const frame = (now: number) => {
    raf = 0;
    if (!visible || document.hidden) return;
    draw((now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  const start = () => {
    if (reduce) draw(0);
    else if (!raf && visible) raf = requestAnimationFrame(frame);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = !!e?.isIntersecting;
    start();
  });
  io.observe(el);
  const ro = new ResizeObserver(() => {
    layout();
    if (reduce || !visible) draw(0);
  });
  ro.observe(el);
  const onVis = () => start();
  document.addEventListener("visibilitychange", onVis);
  layout();
  draw(0);
  return () => {
    cancelAnimationFrame(raf);
    io.disconnect();
    ro.disconnect();
    document.removeEventListener("visibilitychange", onVis);
  };
}

// ---------------------------------------------------------------- the eclipse

/** A small stippled eclipse: the limb, and a corona streaming outward, brighter below. */
export function Corona({ className = "" }: { className?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const rnd = mulberry32(20261013);
    const limb = Array.from({ length: 900 }, () => ({ th: rnd() * TAU, r: 1 + Math.abs(gauss(rnd)) * 0.012, a: 0.45 + 0.55 * rnd(), w: rnd() }));
    const rays = Array.from({ length: 2400 }, () => ({ th: rnd() * TAU, z: rnd(), u0: rnd(), sp: 0.018 + 0.05 * rnd(), w: rnd() - 0.5 }));
    let S: ReturnType<typeof fit> = null;
    return animate(
      el,
      () => {
        S = fit(el);
      },
      (t) => {
        if (!S) return;
        const { c, w, h } = S;
        const tt = t + 40; // a still frame already shows a full corona
        const R = Math.min(w, h) * 0.25;
        const cx = w / 2;
        const cy = h * 0.46;
        const breathe = 0.86 + 0.14 * Math.sin(tt * 0.42);
        c.clearRect(0, 0, w, h);
        c.fillStyle = "#fff";
        for (const p of limb) {
          c.globalAlpha = p.a * (0.55 + 0.45 * Math.sin(tt * (0.5 + p.w * 1.6) + p.th * 157)) * breathe;
          c.fillRect(cx + Math.cos(p.th) * p.r * R, cy + Math.sin(p.th) * p.r * R, 1.1, 1.1);
        }
        for (const p of rays) {
          const u = (p.u0 + tt * p.sp) % 1;
          const down = Math.max(0, Math.sin(p.th));
          const reach = 0.16 + 0.62 * down * down + 0.1 * Math.abs(Math.cos(p.th));
          const streak = 0.55 + 0.45 * Math.sin(p.th * 9 + tt * 0.11) * Math.sin(p.th * 4 - tt * 0.07 + 1.3);
          const r = 1 + Math.pow(u, 1.45) * reach * (0.55 + 0.9 * p.z) * (0.7 + 0.6 * streak);
          const th = p.th + p.w * 0.24 * u;
          c.globalAlpha = (1 - u) * (1 - u) * (0.3 + 0.7 * streak) * breathe * 0.9;
          c.fillRect(cx + Math.cos(th) * r * R, cy + Math.sin(th) * r * R, 1.1, 1.1);
        }
        c.globalAlpha = 1;
      },
    );
  }, []);
  return <canvas ref={cv} className={className} aria-hidden="true" />;
}

// ---------------------------------------------------------------- the crossing

export interface CrossingStage {
  n: string;
  title: string;
  /** The chain, shown under the title where the drawing doesn't name it (narrow screens). */
  chain: string;
  /** "{min}" becomes this network's smallest batch. */
  line: string;
  held: string;
  check: string;
}

/**
 * How money crosses. The stages are text; the canvas behind them draws the route through each
 * stage's marker (measured from the page, so the drawing follows the text on any screen): across
 * on wide screens, down the left edge on narrow ones. Notes leave wallets, wait in the escrow,
 * close as one batch, vanish at Circle's burn and reappear at the mint, and rest in the portal.
 * Only a message travels on to Aztec, where private notes light up in the crowd: no line joins a
 * deposit to a claim.
 */
export function Crossing({ stages }: { stages: CrossingStage[] }) {
  const min = String(useMinBatch());
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const root = wrap.current;
    const el = cv.current;
    if (!root || !el) return;
    let S: ReturnType<typeof fit> = null;
    let P: Pt[] = [];
    let vertical = false;
    let A = 40; // how far notes spread across the route
    let u: Pt = { x: 1, y: 0 }; // along the route
    let n: Pt = { x: 0, y: 1 }; // across it
    let crowdC: Pt = { x: 0, y: 0 };
    let crowdR: Pt = { x: 1, y: 1 };
    const glow = [0, 0, 0, 0, 0, 0];

    const srnd = mulberry32(31);
    const reserve = Array.from({ length: 30 }, () => ({ a: gauss(srnd, 2.2), b: gauss(srnd, 2.2), al: 0.18 + 0.22 * srnd(), ph: srnd() * TAU }));
    const crowd = Array.from({ length: 90 }, (_, i) => {
      const r = Math.sqrt((i + 0.5) / 90);
      const th = i * 2.399963 + srnd() * 0.3;
      return { a: r * Math.cos(th), b: r * Math.sin(th), al: 0.16 + 0.3 * srnd(), ph: srnd() * TAU };
    });

    // A batch: 8 notes from different wallets. Its shape is drawn fresh each cycle.
    const batch = (seed: number) => {
      const r = mulberry32(seed);
      return Array.from({ length: 8 }, (_, k) => ({
        o: gauss(r, 1.6) * 0.8,
        cx: gauss(r, 2),
        cy: gauss(r, 2),
        d: 0.02 + (k / 8) * 0.17 + r() * 0.02,
        b: 0.7 + 0.3 * r(),
        claim: r() < 0.4 ? 0.88 + r() * 0.08 : -1,
        ca: Math.sqrt(r()) * 0.9,
        cth: r() * TAU,
      }));
    };

    const at = (s: number): Pt => {
      const i = Math.max(0, Math.min(P.length - 2, Math.floor(s)));
      const f = s - i;
      const a = P[i]!;
      const b = P[i + 1]!;
      return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
    };

    const layout = () => {
      S = fit(el);
      if (!S) return;
      const r = el.getBoundingClientRect();
      P = Array.from(root.querySelectorAll<HTMLElement>(".x-mark")).map((m) => {
        const b = m.getBoundingClientRect();
        return { x: b.left + b.width / 2 - r.left, y: b.top + b.height / 2 - r.top };
      });
      if (P.length < 6) return;
      const first = P[0]!;
      const last = P[P.length - 1]!;
      vertical = Math.abs(last.y - first.y) > Math.abs(last.x - first.x);
      u = vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
      n = vertical ? { x: 1, y: 0 } : { x: 0, y: 1 };
      A = vertical ? Math.max(8, Math.min(15, S.w / 2 - 6)) : Math.max(20, Math.min(54, S.h * 0.24));
      if (vertical) {
        crowdC = { x: last.x, y: last.y + Math.min(52, Math.max(30, S.h - last.y - 40)) };
        crowdR = { x: A + 2, y: Math.min(40, Math.max(22, S.h - crowdC.y - 8)) };
      } else {
        const room = S.w - last.x;
        crowdC = { x: last.x + Math.min(96, room * 0.52), y: last.y };
        const rr = Math.max(26, Math.min(A * 1.15, room * 0.42));
        crowdR = { x: rr, y: rr };
      }
    };

    const dot = (c: CanvasRenderingContext2D, p: Pt, a: number, size: number) => {
      if (a <= 0.004) return;
      c.globalAlpha = Math.min(1, a);
      c.beginPath();
      c.arc(p.x, p.y, size, 0, TAU);
      c.fill();
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const T = 12; // seconds per batch
    const STILL = [0.1, 0.3, 0.5, 0.6, 0.72, 0.84, 0.94]; // a still frame shows every stage at once

    const draw = (t: number) => {
      if (!S || P.length < 6) return;
      const { c, w, h } = S;
      const size = vertical ? 1.15 : 1.35;
      if (reduce) c.clearRect(0, 0, w, h);
      else {
        // a short trail behind moving notes
        c.globalCompositeOperation = "destination-out";
        c.globalAlpha = 0.42;
        c.fillRect(0, 0, w, h);
        c.globalCompositeOperation = "source-over";
      }
      c.globalAlpha = 1;

      // chain boundaries: Solana | Ethereum at Circle's station, Ethereum | Aztec before the last
      if (!vertical) {
        c.strokeStyle = "#1d1d1d";
        c.lineWidth = 1;
        c.setLineDash([2, 5]);
        for (const x of [P[3]!.x, (P[4]!.x + P[5]!.x) / 2]) {
          c.beginPath();
          c.moveTo(Math.round(x) + 0.5, 36);
          c.lineTo(Math.round(x) + 0.5, h - 10);
          c.stroke();
        }
        c.setLineDash([]);
      }

      // the route: solid while money moves, dashed where only a message goes (portal to Aztec)
      c.strokeStyle = "#262626";
      c.lineWidth = 1;
      const off = vertical ? { x: 0.5, y: 0 } : { x: 0, y: 0.5 };
      c.beginPath();
      P.slice(0, 5).forEach((p, i) => (i ? c.lineTo(p.x + off.x, p.y + off.y) : c.moveTo(p.x + off.x, p.y + off.y)));
      c.stroke();
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(P[4]!.x + off.x, P[4]!.y + off.y);
      c.lineTo(P[5]!.x + off.x, P[5]!.y + off.y);
      c.stroke();
      c.setLineDash([]);

      const tt = reduce ? 0 : t;
      c.fillStyle = "#fff";

      // what the portal already holds, and the crowd already on Aztec
      for (const q of reserve) {
        const p = { x: P[4]!.x + (u.x * q.a + n.x * q.b) * A * 0.2, y: P[4]!.y + (u.y * q.a + n.y * q.b) * A * 0.2 };
        dot(c, p, q.al * (0.8 + 0.2 * Math.sin(tt * 0.9 + q.ph)), size * 0.9);
      }
      for (const q of crowd) {
        const p = {
          x: crowdC.x + q.a * crowdR.x + Math.sin(tt * 0.5 + q.ph) * 0.8,
          y: crowdC.y + q.b * crowdR.y + Math.cos(tt * 0.45 + q.ph) * 0.8,
        };
        dot(c, p, q.al * (0.8 + 0.2 * Math.sin(tt * 1.1 + q.ph * 3)), size * 0.9);
      }

      const lit = [0, 0, 0, 0, 0, 0];
      const slots = reduce ? STILL.map((tau, i) => ({ tau, seed: 101 + i * 7 })) : [0, 0.5].map((ph, b) => {
        const g = t / T + ph;
        const cyc = Math.floor(g);
        return { tau: g - cyc, seed: cyc * 7919 + b * 13 + 5 };
      });

      for (const { tau, seed } of slots) {
        const notes = batch(seed);
        let s = -1;
        for (const q of notes) {
          let p: Pt | null = null;
          let a = q.b;
          const cluster = (sv: number, spread: number): Pt => {
            const base = at(sv);
            return {
              x: base.x + (n.x * q.cy + u.x * q.cx * 0.7) * A * spread + Math.sin(tt * 0.9 + q.d * 40) * 0.6,
              y: base.y + (n.y * q.cy + u.y * q.cx * 0.7) * A * spread + Math.cos(tt * 0.8 + q.d * 50) * 0.6,
            };
          };
          if (tau < q.d) {
            p = null;
          } else if (tau < q.d + 0.14) {
            const f = ease((tau - q.d) / 0.14);
            const from = { x: P[0]!.x + n.x * q.o * A * 1.25, y: P[0]!.y + n.y * q.o * A * 1.25 - (vertical ? 30 : 0) };
            const to = cluster(1, 0.4);
            p = { x: lerp(from.x, to.x, f), y: lerp(from.y, to.y, f) };
            a *= Math.min(1, f * 3);
            s = Math.max(s, f < 0.5 ? 0 : 1);
          } else if (tau < 0.38) {
            p = cluster(1, 0.4);
            s = Math.max(s, 1);
          } else if (tau < 0.48) {
            const f = ease((tau - 0.38) / 0.1);
            p = cluster(1 + f, lerp(0.4, 0.18, f));
            s = Math.max(s, 1 + f);
          } else if (tau < 0.53) {
            p = cluster(2, 0.18);
            s = Math.max(s, 2);
          } else if (tau < 0.64) {
            const f = ease((tau - 0.53) / 0.11);
            p = cluster(2 + f, 0.18);
            a *= 1 - ease((f - 0.72) / 0.28); // burned on Solana
            s = Math.max(s, 2 + f);
          } else if (tau < 0.76) {
            const f = ease((tau - 0.64) / 0.12);
            p = cluster(3 + f, 0.18);
            a *= ease(f / 0.28); // minted on Ethereum
            s = Math.max(s, 3 + f);
          } else {
            p = cluster(4, lerp(0.18, 0.3, ease((tau - 0.76) / 0.2)));
            a *= 1 - ease((tau - 0.8) / 0.2); // joins what the portal holds
            s = Math.max(s, 4);
          }
          if (p) dot(c, p, a, size);
          // a claim: a private note lights up somewhere in the crowd, unconnected to the batch
          if (q.claim > 0 && tau > q.claim) {
            const k = (tau - q.claim) / (1 - q.claim);
            const cp = { x: crowdC.x + Math.cos(q.cth) * q.ca * crowdR.x, y: crowdC.y + Math.sin(q.cth) * q.ca * crowdR.y };
            dot(c, cp, Math.min(1, k * 4) * (1 - ease((k - 0.45) / 0.55)), size * 1.05);
          }
        }
        // the message from the portal to Aztec
        if (tau > 0.78 && tau < 0.9) {
          const f = ease((tau - 0.78) / 0.12);
          const p = at(4 + f);
          c.globalAlpha = 0.85 * Math.min(1, f * 5) * (1 - ease((f - 0.85) / 0.15));
          c.strokeStyle = "#fff";
          c.beginPath();
          c.arc(p.x, p.y, 2.6, 0, TAU);
          c.stroke();
          lit[5] = Math.max(lit[5]!, f > 0.7 ? 1 : 0);
        }
        if (tau > 0.88) lit[5] = Math.max(lit[5]!, 1 - ease((tau - 0.9) / 0.1));
        if (s >= 0) for (let i = 0; i < 5; i++) lit[i] = Math.max(lit[i]!, 1 - Math.abs(s - i) / 0.4);
      }

      // the stations
      for (let i = 0; i < 6; i++) {
        glow[i] = reduce ? clamp01(lit[i]!) : lerp(glow[i]!, clamp01(lit[i]!), 0.12);
        const p = P[i]!;
        const g = glow[i]!;
        if (g > 0.02) {
          const rg = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, 30);
          rg.addColorStop(0, `rgba(255,255,255,${0.16 * g})`);
          rg.addColorStop(1, "rgba(255,255,255,0)");
          c.globalAlpha = 1;
          c.fillStyle = rg;
          c.beginPath();
          c.arc(p.x, p.y, 30, 0, TAU);
          c.fill();
        }
        const v = Math.round(58 + (255 - 58) * g);
        c.globalAlpha = 1;
        c.fillStyle = "#000";
        c.strokeStyle = `rgb(${v},${v},${v})`;
        c.beginPath();
        c.arc(p.x, p.y, 4, 0, TAU);
        c.fill();
        c.stroke();
      }
      c.fillStyle = "#fff";
      c.globalAlpha = 1;
    };

    return animate(root, layout, draw);
  }, []);

  return (
    <div className="x" ref={wrap}>
      <canvas className="x-cv" ref={cv} aria-hidden="true" />
      <div className="x-zones" aria-hidden="true">
        <span className="x-z0">Solana</span>
        <span className="x-z1">Ethereum</span>
        <span className="x-z2">Aztec</span>
      </div>
      <ol className="x-stages">
        {stages.map((s) => (
          <li className="x-stage" key={s.n}>
            <span className="x-n">
              {s.n}
              <span className="x-chain"> · {s.chain}</span>
            </span>
            <h3>
              <i className="x-mark" aria-hidden="true" />
              {s.title}
            </h3>
            <p>{s.line.replace("{min}", min)}</p>
            <dl>
              <div>
                <dt>Held by</dt>
                <dd>{s.held}</dd>
              </div>
              <div>
                <dt>Anyone can check</dt>
                <dd>{s.check}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}
