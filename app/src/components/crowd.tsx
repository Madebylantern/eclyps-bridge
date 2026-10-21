"use client";
import { useEffect, useRef } from "react";

/*
 * Crowds as points of light. Every note of one size looks the same once it crosses, so a claim
 * hides among the notes of its size that have crossed: one point per note. Deposits still waiting
 * in the batch that is forming are hollow points.
 */

/** The crowd a full disk stands for. */
export const FULL = 256;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * A sunflower disk whose area grows with the count, against the faint ring a crowd of `full`
 * would fill. `waiting` deposits are hollow points at its edge.
 */
export function CrowdDisk({ n, waiting = 0, full = FULL, className = "" }: { n: number; waiting?: number; full?: number; className?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = cv.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let start = 0;
    const draw = (alpha: number) => {
      const d = Math.min(window.devicePixelRatio || 1, 2);
      const w = el.clientWidth;
      if (!w) return;
      el.width = Math.round(w * d);
      el.height = Math.round(w * d);
      const c = el.getContext("2d");
      if (!c) return;
      c.setTransform(d, 0, 0, d, 0, 0);
      c.clearRect(0, 0, w, w);
      const R = w * 0.46;
      if (n < full) {
        c.strokeStyle = w < 120 ? "#3d3d3d" : "#2a2a2a";
        c.lineWidth = 1;
        c.setLineDash([1, w < 120 ? 3 : 5]);
        c.beginPath();
        c.arc(w / 2, w / 2, R, 0, Math.PI * 2);
        c.stroke();
        c.setLineDash([]);
      }
      const all = n + waiting;
      if (all === 0) return;
      const r = R * Math.sqrt(Math.min(all, full) / full);
      const cell = r / Math.sqrt(all);
      const dot = Math.max(w < 120 ? 1.1 : 1.3, Math.min(3.2, cell * 0.3));
      c.fillStyle = "#ffffff";
      c.strokeStyle = "#ffffff";
      c.lineWidth = 1;
      for (let i = 0; i < all; i++) {
        const rr = cell * Math.sqrt(i + 0.5);
        const th = i * GOLDEN;
        const x = w / 2 + rr * Math.cos(th);
        const y = w / 2 + rr * Math.sin(th);
        // Points appear from the centre outwards.
        const a = Math.max(0, Math.min(1, alpha * 1.6 - (i / all) * 0.6));
        c.beginPath();
        if (i < n) {
          c.globalAlpha = 0.9 * a;
          c.arc(x, y, dot, 0, Math.PI * 2);
          c.fill();
        } else {
          c.globalAlpha = 0.6 * a;
          c.arc(x, y, Math.max(1.8, dot), 0, Math.PI * 2);
          c.stroke();
        }
      }
      c.globalAlpha = 1;
    };
    const frame = (t: number) => {
      if (!start) start = t;
      const k = Math.min(1, (t - start) / 900);
      draw(k);
      if (k < 1) raf = requestAnimationFrame(frame);
    };
    if (reduce) draw(1);
    else raf = requestAnimationFrame(frame);
    const ro = new ResizeObserver(() => draw(1));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [n, waiting, full]);
  return <canvas ref={cv} aria-hidden className={`block aspect-square ${className}`} />;
}

/**
 * Notes as a row of points that wraps: `filled` white, `hollow` outlined. For counts that a row
 * can show (a batch forming, a crowd now and after the next batch).
 */
export function NoteDots({ filled, hollow = 0, testId, className = "" }: { filled: number; hollow?: number; testId?: string; className?: string }) {
  const n = Math.max(0, filled) + Math.max(0, hollow);
  return (
    <span data-testid={testId} aria-hidden className={`flex max-w-[15rem] flex-wrap gap-[7px] ${className}`}>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={`g ${i < filled ? "done" : "next !shadow-[inset_0_0_0_1px_#8c8c8c]"}`} />
      ))}
    </span>
  );
}
