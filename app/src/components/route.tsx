"use client";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { clock } from "@/lib/format";
import { type Journey, ROUTE_POS } from "@/lib/journey";
import type { NoteView, Stage } from "@/lib/portfolio";
import { Glyph, Heading, Label, Ref } from "./ui";

/*
 * The route figure: Solana, the bridge (Circle CCTP through Ethereum) and Aztec on one hairline,
 * with a transfer's notes as points of light where their money is. Planned notes wait hollow at
 * the start; the selected note glows. Positions glide when a note moves on (instantly with
 * reduced motion). The notes list next to it is the accessible control; the canvas is decoration
 * with a text summary.
 */

const X0 = 0.08;
const X1 = 0.92;
const LINE_Y = 34;
const STATIONS = [
  { at: 0, name: "Solana" },
  { at: 0.5, name: "Bridge" },
  { at: 1, name: "Aztec" },
];

type Kind = "planned" | "moving" | "back";
interface Spot {
  p: number;
  dx: number;
  dy: number;
  kind: Kind;
}

const kindOf = (s: Stage): Kind => (s === "scheduled" ? "planned" : s === "refunded" || s === "exited" ? "back" : "moving");

/** Notes at the same place: waiting or arrived ones cluster above their station, moving ones spread along the line. */
function layout(notes: NoteView[]): Map<number, Spot> {
  const groups = new Map<number, NoteView[]>();
  for (const n of notes) {
    const p = ROUTE_POS[n.stage];
    groups.set(p, [...(groups.get(p) ?? []), n]);
  }
  const out = new Map<number, Spot>();
  for (const [p, ns] of groups) {
    const above = p === 0 || p === 1;
    const perRow = Math.max(5, Math.ceil(ns.length / 3));
    ns.forEach((n, i) => {
      if (above) {
        const row = Math.floor(i / perRow);
        const inRow = Math.min(perRow, ns.length - row * perRow);
        const col = i % perRow;
        out.set(n.index, { p, dx: (col - (inRow - 1) / 2) * 8 + (row % 2 ? 4 : 0), dy: -13 - row * 7, kind: kindOf(n.stage) });
      } else {
        out.set(n.index, { p, dx: (i - (ns.length - 1) / 2) * 9, dy: 0, kind: kindOf(n.stage) });
      }
    });
  }
  return out;
}

function paint(cv: HTMLCanvasElement, spots: Map<number, Spot>, selected: number | undefined) {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) {
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
  }
  const c = cv.getContext("2d");
  if (!c) return;
  c.setTransform(d, 0, 0, d, 0, 0);
  c.clearRect(0, 0, w, h);
  const x0 = w * X0;
  const x1 = w * X1;
  c.fillStyle = "#1f1f1f";
  c.fillRect(x0, LINE_Y, x1 - x0, 1);
  c.lineWidth = 1;
  for (const s of STATIONS) {
    c.strokeStyle = "#3a3a3a";
    c.beginPath();
    c.arc(x0 + (x1 - x0) * s.at, LINE_Y + 0.5, 3.5, 0, Math.PI * 2);
    c.stroke();
  }
  // The selected note last, so its light sits on top.
  const order = [...spots.entries()].sort(([a], [b]) => Number(a === selected) - Number(b === selected));
  for (const [i, s] of order) {
    const x = Math.min(w - 4, Math.max(4, x0 + (x1 - x0) * s.p + s.dx));
    const y = LINE_Y + 0.5 + s.dy;
    const sel = i === selected;
    if (sel) {
      const g = c.createRadialGradient(x, y, 0, x, y, 22);
      g.addColorStop(0, "rgba(255,255,255,0.28)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, 22, 0, Math.PI * 2);
      c.fill();
    }
    c.beginPath();
    c.arc(x, y, sel ? 3.2 : 2.6, 0, Math.PI * 2);
    if (s.kind === "planned") {
      c.strokeStyle = sel ? "#ffffff" : "#5a5a5a";
      c.stroke();
    } else {
      c.fillStyle = s.kind === "back" ? (sel ? "#8c8c8c" : "#3a3a3a") : sel ? "#ffffff" : "#bdbdbd";
      c.fill();
    }
  }
}

const PLACE: Record<Stage, string> = {
  scheduled: "in your wallet",
  queued: "in the gateway escrow",
  batched: "in a closed batch",
  sent: "on the bridge",
  claimable: "in the portal, claimable",
  claimed: "private on Aztec",
  refunded: "taken back",
  exited: "moved out",
};

/** "Your notes along the route: 1 private on Aztec, 4 in your wallet." */
function describe(notes: NoteView[]): string {
  const count = new Map<Stage, number>();
  for (const n of notes) count.set(n.stage, (count.get(n.stage) ?? 0) + 1);
  return `Your notes along the route from Solana to Aztec: ${[...count].map(([s, k]) => `${k} ${PLACE[s]}`).join(", ")}.`;
}

export function RouteFigure({ notes, selected, onPick, testId }: { notes: NoteView[]; selected?: number; onPick?: (index: number) => void; testId?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(new Map<number, Spot>());
  const sel = useRef(selected);
  const key = notes.map((n) => `${n.index}:${n.stage}`).join(",");
  const targets = useMemo(() => layout(notes), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    sel.current = selected;
    const el = cv.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = new Map(drawn.current);
    const start = performance.now();
    const dur = reduce ? 0 : 900;
    let raf = 0;
    const frame = (t: number) => {
      const k = dur ? Math.min(1, (t - start) / dur) : 1;
      const e = 1 - (1 - k) ** 3;
      const now = new Map<number, Spot>();
      for (const [i, to] of targets) {
        const f = from.get(i) ?? to;
        now.set(i, { p: f.p + (to.p - f.p) * e, dx: f.dx + (to.dx - f.dx) * e, dy: f.dy + (to.dy - f.dy) * e, kind: to.kind });
      }
      drawn.current = now;
      paint(el, now, selected);
      if (k < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [targets, selected]);

  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const ro = new ResizeObserver(() => paint(el, drawn.current, sel.current));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onPick) return;
    const r = e.currentTarget.getBoundingClientRect();
    const w = r.width;
    let best: [number, number] | undefined;
    for (const [i, s] of drawn.current) {
      const x = x0At(w) + (x1At(w) - x0At(w)) * s.p + s.dx;
      const y = LINE_Y + s.dy;
      const dist = Math.hypot(e.clientX - r.left - x, e.clientY - r.top - y);
      if (dist < 14 && (!best || dist < best[1])) best = [i, dist];
    }
    if (best) onPick(best[0]);
  };

  return (
    <div className="route" role="img" aria-label={describe(notes)} data-testid={testId}>
      <canvas ref={cv} aria-hidden onClick={pick} />
      {STATIONS.map((s) => (
        <span key={s.name} className="st" style={{ left: `${(X0 + (X1 - X0) * s.at) * 100}%` }} aria-hidden>{s.name}</span>
      ))}
    </div>
  );
}
const x0At = (w: number) => w * X0;
const x1At = (w: number) => w * X1;

/** "Where it is": one note's journey as a vertical hairline with a dot per stage. */
export function JourneyView({ j, testId, children }: { j: Journey; testId?: string; children?: ReactNode }) {
  return (
    <motion.section className="flex min-w-0 flex-col gap-5" data-testid={testId} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Label>Where it is</Label>
      <div className="space-y-2" aria-live="polite">
        <Heading as="h3">{j.headline}</Heading>
        <p className="max-w-[44ch] text-grey">{j.now}</p>
      </div>
      <ol className="steps">
        {j.steps.map((s) => (
          <li key={s.key} className={s.state === "next" ? "future" : undefined} data-step={s.key} data-state={s.state}>
            <Glyph state={s.state} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="t">{s.title}</span>
              {s.where && <span className="w">{s.where}</span>}
              {s.ref && <Ref value={s.ref.value} prefix={s.ref.prefix} />}
            </span>
            <time dateTime={s.at ? new Date(s.at).toISOString() : undefined}>{s.at ? clock(s.at) : ""}</time>
          </li>
        ))}
      </ol>
      {children}
    </motion.section>
  );
}
