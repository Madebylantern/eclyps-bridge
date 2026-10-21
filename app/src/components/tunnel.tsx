"use client";
import { adviseClaim, adviseExit, MIN_EXIT_BATCH, poolCapacity } from "@eclyps/sdk";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isCancelled, parseAddress, useApp } from "@/lib/app";
import { parseEthAddress } from "@/lib/bridge";
import { bridgeLine, usd, usdExact } from "@/lib/deployment";
import { aboutText, type AztecClock, batchWait, type EtaInput, etaLine, exitTimes, journeyEta, profileOf, routeTimes, sendWait } from "@/lib/eta";
import { exitStage } from "@/lib/exit-status";
import { injectedEthereum, readAztecClock } from "@/lib/exits";
import { clock, shortAddr } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { type NoteView, slotTime } from "@/lib/portfolio";
import { playCue, unlockSound } from "@/lib/sound";
import { solText } from "@/lib/swap";
import { utcClock } from "@/lib/totality";
import { groupTransfers } from "@/lib/transfers";
import {
  crowdLine,
  destNote,
  type Failure,
  failure,
  farLight,
  fastPlan,
  holdOf,
  inText,
  type JourneyExit,
  journeyStage,
  leavingLine,
  newestJourney,
  othersInOpen,
  outLine,
  pickJourney,
  slowestBatch,
  slowestExit,
  thenLine,
  transitLine,
  type TunnelStage,
  waitLines,
} from "@/lib/tunnel";
import { type FarRing, flightPath, type Geometry, TunnelScene, tunnelLayout } from "@/lib/tunnel-scene";
import { CLAIM_STEPS, claimRisk, claimRunning } from "./claim";
import { useExitFacts } from "./exit";
import { CalendarButton } from "./reminders";
import type { BridgeForm } from "./shield";
import { Act, DocsLink, type DocsAnchor, HelpMark, HelpText } from "./ui";

/** Sprite size per denomination (smallest first): bigger notes are bigger points of light. */
const SIZES = [13, 19, 27, 37];
const MAX_DIGITS = 6;

type Step = "decide" | "depositing" | "signing" | "move";
type Shown = TunnelStage | "decide" | "depositing" | "signing" | "move" | "reading" | "settling";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Stages an action leaves when it ends, failed or not: leaving them keeps its error line. */
const AFTER_ACTION = new Set<Shown>(["depositing", "signing", "settling", "claim", "burning"]);

/**
 * The Aztec clock (src/lib/exits.ts `readAztecClock`), read while `on` and again each minute: it
 * places a burn in its Aztec epoch, so the estimate of Aztec's proof follows the real chain. Only
 * where epochs take time to prove (not on the local stack); unread, the estimates keep a range.
 */
function useAztecClock(on: boolean): AztecClock | undefined {
  const { dep } = useApp();
  const [c, setC] = useState<AztecClock>();
  const live = on && profileOf(dep.network).epochMs > 0;
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const look = () => readAztecClock(dep).then((x) => !stop && setC(x), () => undefined);
    void look();
    const t = setInterval(look, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [dep, live]);
  return live ? c : undefined;
}

declare global {
  interface Window {
    /** Set before load to drive the frames by hand (video capture): `__tunnelFrame(dt)`. */
    __tunnelCapture?: boolean;
    __tunnelFrame?: (dt: number) => void;
    /** Where the tunnel is, for tests and captures. */
    __tunnel?: { visual: string; hold: string; settled: boolean; cam: number; ringBottom?: number; gl: boolean };
  }
}

/**
 * The bridge screen: one tunnel of light, and the crossing as a flight through it (ADR 0007,
 * amended 2026-10-16). Each stage is a real state the app tracks, never a timer: the amount typed
 * inside the black disk becomes notes as points of light; Send, then the choice (the eclipse or
 * the next batch); others' notes join as real deposits arrive; the flight into the disk when the
 * batch closes; the diamond ring and the arrival when Aztec registers it; Claim; the balance in the
 * far ring; and Move out, the way back. Returning to the page resumes where the money really is.
 */
export function Tunnel({ form: f, sheetOpen, onMore }: { form: BridgeForm; sheetOpen: boolean; onMore: () => void }) {
  const app = useApp();
  const { dep, vault, data, stored, snap, rev, solana, aztec, claims, modal, setModal, deposit, ensureVault } = app;
  const now = useNow(1000);
  const sizeOf = useCallback((idx: number) => SIZES[Math.max(0, Math.min(SIZES.length - 1, idx))]!, []);
  const indexOf = useCallback((d: bigint | string) => dep.denominations.indexOf(String(d)), [dep.denominations]);

  // ---------------------------------------------------------------- which crossing, and where
  const notes = useMemo(() => snap?.notes ?? [], [snap]);
  const transfers = useMemo(() => groupTransfers(notes, data.transfers), [notes, data.transfers, rev]); // eslint-disable-line react-hooks/exhaustive-deps
  const newest = useMemo(() => newestJourney(transfers), [transfers]);
  const newestExits = useMemo(
    () => (newest ? data.exits.filter((x) => newest.notes.some((n) => n.index === x.note)) : []),
    [newest, data.exits, rev], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const { facts, mark } = useExitFacts(newestExits);
  const jExits: JourneyExit[] = newestExits.map((x) => ({
    id: x.id, note: x.note, to: x.to, destination: x.destination, denomination: x.denomination,
    stage: exitStage(x.to, facts[x.id]!), facts: facts[x.id]!, sentAt: x.sentAt, claimedAt: x.claimedAt,
  }));
  const picked = pickJourney(transfers, () => jExits, now);
  // A claim that just went through counts before the next poll sees it.
  const jNotes: NoteView[] = (picked?.notes ?? []).map((n) => (claims[n.index]?.stage === "done" && n.stage === "claimable" ? { ...n, stage: "claimed" as const } : n));
  const claiming = jNotes.some((n) => claimRunning(claims[n.index]));
  const derived = picked ? journeyStage(jNotes, jExits, { claiming }) : "amount";

  // ---------------------------------------------------------------- what this page is doing
  const [step, setStep] = useState<Step | null>(null);
  const [freshFor, setFreshFor] = useState<string | null>(null);
  // After an action, what it led to shows once a snapshot taken after it says so; until then one
  // line says what was done, with nothing to click twice.
  const [settle, setSettle] = useState<{ since: number; line: string; hold: "decide" | "wait" } | null>(null);
  const [progress, setProgress] = useState<string>();
  const [err, setErr] = useState<Failure>();
  const [whyOpen, setWhyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveTo, setMoveTo] = useState<"solana" | "ethereum">("solana");
  const [movedAt, setMovedAt] = useState(0);
  const [destText, setDestText] = useState("");
  /** The step's "?" is open: its one sentence shows under the lines. */
  const [help, setHelp] = useState(false);

  const settling = !!settle && (!snap || snap.updatedAt < settle.since);
  useEffect(() => {
    if (settle && !settling) setSettle(null);
  }, [settle, settling]);

  let shown: Shown;
  if (!snap && data.notes.length > 0) shown = "reading";
  else if (step === "decide" || step === "depositing" || step === "signing") shown = step;
  else if (settling) shown = "settling";
  else if (!picked || freshFor === picked.id) shown = "amount";
  else if (step === "move" && derived === "claimed") shown = "move";
  else shown = derived;
  useEffect(() => {
    if (step === "move" && derived !== "claimed" && derived !== "burning") setStep(null);
  }, [step, derived]);
  // A new stage clears the last error, except right after the action that failed: a failed claim
  // falls back from "claim" to "arrived", a failed burn from "burning" to the balance, and the
  // line saying so must stay there.
  const lastShown = useRef(shown);
  useEffect(() => {
    if (lastShown.current !== shown && !settling && step === null && !AFTER_ACTION.has(lastShown.current)) setErr(undefined);
    lastShown.current = shown;
  }, [shown, settling, step]);
  useEffect(() => setWhyOpen(false), [err]);
  // Each step's "?" starts closed, and closes under a sheet (Escape then reaches the sheet).
  useEffect(() => setHelp(false), [shown, sheetOpen, modal]);

  // ---------------------------------------------------------------- the picture
  const glRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const ringRef = useRef<HTMLButtonElement>(null);
  const balRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TunnelScene | null>(null);
  /** Whether a stage was shown yet: the first is a resume (no flight), the rest are live. */
  const held = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [geo, setGeo] = useState<Geometry & { bottom: number }>();
  const [hasGL, setHasGL] = useState(true);
  // While the camera flies, the words wait for it (as in the approved prototype).
  const [flying, setFlying] = useState(false);
  const flyingRef = useRef(false);
  useEffect(() => {
    setMounted(true);
    document.documentElement.dataset.tunnel = "on";
    return () => {
      delete document.documentElement.dataset.tunnel;
    };
  }, []);

  const placeFar = useCallback((r: FarRing) => {
    const ring = ringRef.current, bal = balRef.current, scene = sceneRef.current;
    const size = 2 * Math.max(28, r.r * 1.2);
    if (ring) Object.assign(ring.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${size}px`, height: `${size}px` });
    if (bal) {
      Object.assign(bal.style, { left: `${r.x}px`, top: `${r.y}px` });
      bal.style.setProperty("--bfs", `${Math.max(22, r.r * 0.44).toFixed(1)}px`);
    }
    if (scene && rootRef.current) {
      const s = scene.state;
      if (rootRef.current.dataset.visual !== s.visual) rootRef.current.dataset.visual = s.visual;
      if (flyingRef.current !== !s.settled) {
        flyingRef.current = !s.settled;
        setFlying(!s.settled);
      }
      window.__tunnel = { ...s, gl: scene.hasGL };
    }
  }, []);

  const relayout = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const W = window.innerWidth, H = window.innerHeight;
    // A phone keyboard shrinks the viewport while typing: keep the tunnel where it was.
    const typing = root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement;
    const g = sceneRef.current?.geometry;
    if (typing && g && g.W === W && H < g.H) return;
    const r = root.getBoundingClientRect();
    const next = tunnelLayout(W, H, Math.max(0, r.top), Math.min(H, r.bottom));
    for (const c of [glRef.current, fxRef.current]) if (c) Object.assign(c.style, { width: `${W}px`, height: `${H}px` });
    // The grain dims behind the header and notices, so their words stay readable over it.
    canvasRef.current?.style.setProperty("--tunnel-top", `${Math.max(0, r.top)}px`);
    sceneRef.current?.layout(W, H, r.top, r.bottom, next);
    setGeo({ ...next, bottom: Math.min(H, r.bottom) });
  }, []);

  useEffect(() => {
    if (!mounted || !glRef.current || !fxRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = new TunnelScene({ gl: glRef.current, fx: fxRef.current, reduced, onCue: (c) => void playCue(c), onFar: placeFar });
    sceneRef.current = scene;
    setHasGL(scene.hasGL);
    relayout();
    if (window.__tunnelCapture) window.__tunnelFrame = (dt) => scene.frame(dt);
    else scene.start();
    return () => {
      scene.dispose();
      sceneRef.current = null;
      held.current = false;
    };
  }, [mounted, placeFar, relayout]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    relayout();
    const ro = new ResizeObserver(() => relayout());
    ro.observe(root);
    window.addEventListener("resize", relayout);
    void document.fonts?.ready.then(() => relayout());
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", relayout);
    };
  }, [relayout]);

  // The context for the two calls is made at the first gesture here (Send is one).
  useEffect(() => {
    const on = () => unlockSound();
    window.addEventListener("pointerdown", on, { capture: true, passive: true });
    window.addEventListener("keydown", on, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", on, { capture: true });
      window.removeEventListener("keydown", on, { capture: true });
    };
  }, []);

  // What the picture shows: your notes, the others in the batch, the far side, how full it is.
  const pools = useMemo(() => snap?.pools ?? [], [snap]);
  const splitIdx = [...new Set(f.split.notes.map(indexOf))];
  const live = jNotes.filter((n) => n.stage !== "refunded");
  const exitedNotes = new Set(jExits.map((x) => x.note));
  const before = shown === "amount" || shown === "decide" || shown === "depositing" || shown === "reading";
  const leaving = shown === "burning" || shown === "leaving" || shown === "exit-claim" || shown === "out";
  const mine = before
    ? f.split.notes.map((d) => ({ d: String(d), s: sizeOf(indexOf(d)) }))
    : leaving
      ? jExits.map((x) => ({ d: x.denomination, s: sizeOf(indexOf(x.denomination)) }))
      : live.filter((n) => !exitedNotes.has(n.index)).map((n) => ({ d: n.denomination, s: sizeOf(n.denominationIndex) }));
  const others = useMemo(() => {
    const out: { key: string; s: number }[] = [];
    if (shown === "wait" || shown === "transit" || shown === "signing") {
      // The batches the journey's notes are in: their leaves, minus your own notes there.
      const epochs = new Map<string, { idx: number; leaves: number; mine: number }>();
      for (const n of notes) {
        if (n.epochId === undefined || !["queued", "batched", "sent"].includes(n.stage)) continue;
        const k = `${n.denominationIndex}:${n.epochId}`;
        const e = epochs.get(k) ?? { idx: n.denominationIndex, leaves: n.epochLeaves ?? 0, mine: 0 };
        e.mine++;
        epochs.set(k, e);
      }
      const ours = new Set(live.filter((n) => n.epochId !== undefined).map((n) => `${n.denominationIndex}:${n.epochId}`));
      for (const [k, e] of epochs) if (ours.has(k)) for (let i = 0; i < Math.max(0, e.leaves - e.mine); i++) out.push({ key: `${k}:${i}`, s: sizeOf(e.idx) });
    } else if (shown === "decide" || shown === "depositing" || shown === "sign" || shown === "scheduled") {
      const idx = shown === "decide" || shown === "depositing" ? splitIdx : [...new Set(live.map((n) => n.denominationIndex))];
      for (const o of othersInOpen(pools, notes, idx)) for (let i = 0; i < o.count; i++) out.push({ key: `${o.index}:${o.epochId}:${i}`, s: sizeOf(o.index) });
    }
    return out;
  }, [shown, notes, pools, live.length, splitIdx.join(), sizeOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const far = useMemo(() => farLight(live, pools), [live.map((n) => `${n.index}:${n.stage}:${n.epochLeaves}`).join(), pools]); // eslint-disable-line react-hooks/exhaustive-deps
  const batch = slowestBatch(jNotes);
  const minBatchOf = (idx: number) => pools.find((p) => p.index === idx)?.minBatch ?? dep.params.minBatchSize;
  const fill = shown === "wait" && batch ? (batch.epochLeaves ?? 0) / minBatchOf(batch.denominationIndex) : 0;

  const ready = !!snap || data.notes.length === 0;
  // A vault that opens with notes (an unlock) shows where its money is as a resume, without a
  // flight: nothing moved, the page only learned where it is. A new vault keeps the live flight.
  const lastVault = useRef(vault);
  useEffect(() => {
    if (lastVault.current === vault) return;
    lastVault.current = vault;
    if (vault && vault.data.notes.length > 0) held.current = false;
  }, [vault]);
  const currentHold = shown === "settling" ? settle!.hold : holdOf(shown === "signing" ? "sign" : shown === "reading" ? "amount" : shown);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const hold = currentHold;
    scene.setMine(mine);
    scene.setOthers(others, held.current && (scene.state.hold === "decide" || scene.state.hold === "wait"));
    scene.setFar(far.crowd.map(sizeOf), far.batch.map(sizeOf));
    scene.setFill(fill);
    if (ready) {
      // The first stage shown is where the money is (a resume): no flight. After that, live.
      scene.hold(hold, held.current);
      held.current = true;
    }
    scene.pause(sheetOpen || modal !== null);
  });

  // ---------------------------------------------------------------- actions
  const z = f.z;
  // ADR 0015: "Cross now" (an express epoch per note) once the flag is on and the gateway has its
  // V2 lanes; until then the second choice stays "Cross with the next batch".
  const crossNow = dep.features?.crossNow === true && !!f.crossNow;
  const decides = !!z || crossNow;
  const eclipseOn = !!z && !!f.tWindow && f.tWindow.start <= now;

  /**
   * Send: the vault step first when no vault is open (wallet first, ADR 0016 amended: it is created
   * here, or unlocked), then the choice. Closing the vault step leaves the amount as it was.
   */
  const send = async () => {
    unlockSound();
    setErr(undefined);
    try {
      await ensureVault();
    } catch (e) {
      if (!isCancelled(e)) setErr({ line: message(e) });
      return;
    }
    setFreshFor(null);
    if (decides) setStep("decide");
    else void crossBatch();
  };

  /**
   * Today's Fast plan: deposits now, each signed, and the batch crosses when it fills. With
   * `express` (Cross now, ADR 0015) each note crosses alone, right away.
   */
  const crossBatch = async (express = false) => {
    unlockSound();
    setErr(undefined);
    setProgress(undefined);
    setStep("depositing");
    let line = "Deposited.";
    try {
      await f.submit("fast", setProgress, { express });
      f.setAmountText("");
      f.setEthText("");
    } catch (e) {
      setErr({ line: message(e) });
      line = "Not deposited.";
    }
    setSettle({ since: Date.now(), line, hold: "decide" });
    setStep(null);
    setProgress(undefined);
  };

  /** The Totality plan: the deposits are planned inside the eclipse; each is signed when due. */
  const waitEclipse = async () => {
    unlockSound();
    setErr(undefined);
    let line = "Planned for the eclipse.";
    try {
      await f.submit("totality", setProgress);
      f.setAmountText("");
      f.setEthText("");
    } catch (e) {
      setErr({ line: message(e) });
      line = "Not planned.";
    }
    setSettle({ since: Date.now(), line, hold: "decide" });
    setStep(null);
    setProgress(undefined);
  };

  const signDue = async () => {
    if (!solana.signer) return setModal("solana");
    const due = jNotes.filter((n) => n.stage === "scheduled" && n.due).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0) || a.index - b.index);
    // A Fast crossing signs what is left of it now; a plan signs one deposit at a time, as planned.
    const list = picked?.kind === "fast" ? due : due.slice(0, 1);
    setErr(undefined);
    setStep("signing");
    try {
      for (const [k, n] of list.entries()) {
        setProgress(list.length > 1 ? `Confirm in your wallet · ${k + 1} of ${list.length}` : "Confirm in your wallet.");
        await deposit([n.index], (m) => {
          if (/already deposited/.test(m)) setProgress(m);
        });
      }
      setSettle({ since: Date.now(), line: "Deposited.", hold: "wait" });
    } catch (e) {
      setErr({ line: message(e) });
    }
    setStep(null);
    setProgress(undefined);
  };

  /** Runs an action; if it fails, one short line says so (`failed`), and Details holds the reason. */
  const run = async (fn: () => Promise<unknown>, failed?: string) => {
    setErr(undefined);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(failure(e, failed));
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };

  const claimAll = () => {
    unlockSound();
    if (!aztec.session) return setModal("aztec");
    void run(async () => {
      for (const n of jNotes.filter((x) => x.stage === "claimable")) await app.claim(n);
    }, "Claim failed. Try again.");
  };

  const claimedNotes = live.filter((n) => n.stage === "claimed" && !exitedNotes.has(n.index));
  const claimedTotal = claimedNotes.reduce((a, n) => a + BigInt(n.denomination), 0n);
  const sendOnTo = picked ? data.transfers[picked.id]?.to : undefined;
  // Fast exits (ADR 0017): offered for the notes the liquidity pool can front now, when the flag,
  // the keeper and the gateway's pool are all there. The other notes take the normal path.
  const pool = dep.features?.fastExit === true && dep.keeper?.url ? snap?.lanes : undefined;
  const capacity = pool?.liquidity ? poolCapacity(pool.liquidity, pool.lanes.params) : 0n;
  const fast = pool ? fastPlan(claimedNotes, capacity, pool.lanes.params.poolFeeBps) : undefined;
  const moveOut = (to: "solana" | "ethereum", dest: string, quick = false) => {
    unlockSound();
    if (!aztec.session) return setModal("aztec");
    void run(async () => {
      setProgress("Preparing…");
      setMovedAt(Date.now());
      // "Burning $100 on Aztec: proving…" → "Proving…": the title already names the burn.
      const step = (m: string) => {
        const t = m.replace(/^Burning \$[\d,.]+(?: on Aztec)?: /, "");
        setProgress(t.charAt(0).toUpperCase() + t.slice(1));
      };
      await app.moveOut(claimedNotes, to, dest, step, quick && fast ? { fast: fast.fast.map((n) => n.index) } : undefined);
      setStep(null);
      setDestText("");
    }, "Not moved out. Try again.");
  };

  const readyExits = jExits.filter((x) => x.stage === "arrived" || x.stage === "proven");
  const claimExits = () => {
    unlockSound();
    void run(async () => {
      for (const j of readyExits) {
        const x = data.exits.find((e) => e.id === j.id)!;
        if (x.to === "solana") {
          if (!solana.signer) return setModal("solana");
          setProgress("Confirm the claim in your wallet…");
          await app.claimExit(x, facts[x.id]!.view!);
        } else {
          setProgress("Confirm the claim in your Ethereum wallet…");
          await app.claimToEthereum(x, facts[x.id]!.proof!);
        }
        mark(x.id, { paid: true });
      }
    }, "Claim failed. Try again.");
  };

  const newCrossing = () => {
    setFreshFor(picked?.id ?? null);
    setStep(null);
    setErr(undefined);
  };

  // Keyboard: Enter sends, Escape steps back from the choice.
  const keyboard = useRef(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key === "Enter" || e.key === " ") keyboard.current = true;
      if (e.key === "Escape" && (step === "decide" || step === "move") && !sheetOpen && modal === null) setStep(null);
    };
    const p = () => (keyboard.current = false);
    window.addEventListener("keydown", k);
    window.addEventListener("pointerdown", p);
    return () => {
      window.removeEventListener("keydown", k);
      window.removeEventListener("pointerdown", p);
    };
  }, [step, sheetOpen, modal]);
  const blockRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (shown === "amount") {
      if (window.matchMedia("(pointer: fine)").matches && !sheetOpen && modal === null) inputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!keyboard.current) return;
    const t = setTimeout(() => blockRef.current?.querySelector<HTMLElement>("button, a, input")?.focus({ preventScroll: true }), 260);
    return () => clearTimeout(t);
  }, [shown, !!solana.signer, modal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- words
  const valid = f.count > 0;
  const id = (t: string) => (sheetOpen ? undefined : t);
  let l1: ReactNode = null;
  let l2: ReactNode = null;
  let acts: ReactNode = null;
  let dest: ReactNode = null;
  let end: ReactNode = null;
  let note: ReactNode = null;
  const sep = <span className="sep" aria-hidden>·</span>;
  const inline = "!text-[length:inherit]";

  // How long is left (src/lib/eta.ts): measured ranges, and Aztec's clock where its proof matters.
  const prof = profileOf(dep.network);
  const ethOn = dep.features?.exitEthereum === true;
  const journeyTo: EtaInput["to"] = sendOnTo && ethOn ? "ethereum" : "aztec";
  const needClock =
    (shown === "amount" && f.routes.includes("ethereum")) || shown === "move" || shown === "burning" || shown === "leaving" ||
    (journeyTo === "ethereum" && (shown === "transit" || shown === "arrived" || shown === "claim" || shown === "claimed"));
  const aztecClock = useAztecClock(needClock);
  const eta = (i: Omit<EtaInput, "now" | "clock" | "to">) => etaLine(i.stage, journeyEta({ to: journeyTo, now, clock: aztecClock, ...i }, prof));
  const exitEta = (x: JourneyExit): EtaInput["exit"] => ({
    to: x.to, stage: x.stage, sentAt: x.sentAt,
    full: x.facts.inEpoch !== undefined && x.facts.minBatch !== undefined && x.facts.inEpoch >= x.facts.minBatch,
  });

  /**
   * What each step's "?" says: one plain sentence or two for someone crossing for the first time
   * (≤ 2 short lines), and the Docs section with the rest. Explanations live on Docs.
   */
  const helpFor = (s: Shown): { text: string; docs?: DocsAnchor } | undefined => {
    switch (s) {
      case "amount":
        return solana.signer
          ? { text: `Money crosses as fixed notes (${dep.denominations.map((d) => usd(BigInt(d))).join(", ")}), the same as everyone's, so nobody can tell how much you sent.`, docs: "how" }
          : { text: "Your Solana wallet holds the USDC you send. You approve each payment in it; Eclyps never holds your money.", docs: "what" };
      case "decide":
        return z
          ? { text: "The more people cross with you, the harder it is to tell which money is yours. The eclipse is a weekly hour when many cross together.", docs: "totality" }
          : { text: "The more people cross with you, the harder it is to tell which money is yours. Waiting for others hides you better.", docs: "crowd" };
      case "sign":
        return { text: "A planned deposit waits for your OK in your wallet when it is due. Nothing moves until you sign.", docs: "how" };
      case "scheduled":
        return { text: "Your deposits are planned for later, spread out so they are harder to link. Come back and sign each one when it is due.", docs: "how" };
      case "wait":
        return { text: "Your deposit waits for others of the same size. When the batch is full, it crosses together; the line shows how long.", docs: "crowd" };
      case "transit":
        return { text: `The batch travels from Solana through Ethereum to Aztec, ${aboutText(prof.carry)} once it leaves. Nothing to do meanwhile.`, docs: "how" };
      case "arrived":
        return { text: "Claim moves the money into your private balance on Aztec. Nobody can tell which deposit it came from.", docs: "how" };
      case "claim":
        return { text: `This device proves the money is yours without saying which deposit: ${aboutText(prof.claim)}.`, docs: "how" };
      case "claimed":
        return { text: "Your money is in your private balance on Aztec. Move out sends it to Solana or Ethereum when you need it.", docs: "public" };
      case "move":
        return { text: "Use a fresh address that never touched your deposit wallet. Reusing one links the two in public.", docs: "public" };
      case "burning":
        return { text: `This device burns the notes on Aztec so they can be paid at your address: ${aboutText(prof.burn)}.`, docs: "how" };
      case "leaving":
        return { text: "Your exit waits for a few others, then they leave together. You claim it at your address when it arrives.", docs: "how" };
      case "exit-claim":
        return { text: "The money has arrived. Claim sends it to the address you chose.", docs: "how" };
      default:
        return undefined;
    }
  };

  switch (shown) {
    case "reading":
      l1 = "Waiting for Solana.";
      break;
    case "amount": {
      // A vault in this browser, still locked: one quiet word opens it, to see your crossings.
      const unlockWord = stored && !vault ? <Act quiet small testId={id("bridge-unlock")} onClick={() => void ensureVault().catch(() => undefined)}>Unlock</Act> : null;
      if (!solana.signer) {
        // Wallet first: the first action is the wallet; the amount waits for it.
        l1 = <Act big testId={id("shield-connect")} onClick={() => setModal("solana")}>Connect wallet</Act>;
        end = unlockWord;
        break;
      }
      const line = bridgeLine(f.split, f.feesNow, f.smallest);
      const inWallet = solana.usdc ? `${usdExact(solana.usdc.amount)} USDC in your wallet` : "No USDC in this wallet yet";
      l1 = f.amountText === "" ? "Type an amount" : !valid ? `At least ${usd(f.smallest)}` : <span data-testid={id("shield-split")}>{line.text}</span>;
      l2 = valid && line.rest ? line.rest : <span data-testid={id("bridge-usdc")}>{inWallet}</span>;
      if (valid) {
        // Each destination with its time: from now when the batch's wait is known (Cross now, or a
        // batch this deposit fills), else from when it crosses (src/lib/eta.ts).
        const wait = sendWait({
          crossNow: dep.features?.crossNow === true && !!f.crossNow,
          notes: f.split.notes.map(indexOf),
          pools: pools.map((p) => ({ index: p.index, leaves: p.openEpochLeaves, minBatch: p.minBatch, endsAt: p.openEpochEndSlot !== undefined && snap ? slotTime(p.openEpochEndSlot, snap.slot, now) : undefined })),
          cap: dep.params.perEpochCap,
          now,
        }, prof);
        const times = routeTimes({ now, wait, clock: aztecClock }, prof);
        const opt = (to: "aztec" | "ethereum", word: string) => (
          <>{word}<span className="dim"> · {aboutText(times[to])}</span></>
        );
        dest = (
          <div className="tunnel-dest" data-testid="bridge-to">
            <p className="choice">
              {f.routes.length > 1 ? (
                <span role="radiogroup" aria-label="To" className="routes">
                  <button type="button" role="radio" className="opt" aria-checked={f.to === "aztec"} data-testid="bridge-to-aztec" onClick={() => f.setTo("aztec")}>{opt("aztec", "Aztec")}</button>
                  <button type="button" role="radio" className="opt" aria-checked={f.to === "ethereum"} data-testid="bridge-to-ethereum" onClick={() => f.setTo("ethereum")}>{opt("ethereum", "Ethereum")}</button>
                </span>
              ) : (
                <span className="opt on" data-testid="bridge-to-aztec">{opt("aztec", "Aztec")}</span>
              )}
            </p>
            {times.afterBatch && <p className="means" data-testid="bridge-to-note">Times start once your batch crosses.</p>}
            {f.toEth && (
              <input className="eth" data-testid="bridge-eth-address" placeholder="0x…" value={f.ethText} onChange={(e) => f.setEthText(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Ethereum address"
                onKeyDown={(e) => e.key === "Enter" && f.eth && send()} />
            )}
            {f.swapCfg && (
              <p className="pay" role="radiogroup" aria-label="Pay with" data-testid="pay-with">
                <span className="to">Pay with </span>
                <button type="button" className="opt" aria-checked={f.pay === "usdc"} role="radio" data-testid="pay-usdc" onClick={() => f.setPay("usdc")}>USDC</button>
                <span className="dotsep" aria-hidden>·</span>
                <button type="button" className="opt" aria-checked={f.pay === "sol"} role="radio" data-testid="pay-sol" onClick={() => f.setPay("sol")}>SOL</button>
              </p>
            )}
            {f.paySol && (
              <p className="to" data-testid="pay-sol-quote" aria-live="polite">
                {f.price.error ? <>{f.price.error} <Act quiet small onClick={f.price.retry}>Retry</Act></> : <>≈ {f.price.quote ? solText(f.price.quote.inLamports) : "…"} SOL · swapped to USDC first</>}
              </p>
            )}
          </div>
        );
        const hint = (t: string, testId?: string) => <span className="hint" data-testid={testId}>{t}</span>;
        if (f.toEth && !f.eth) acts = hint(f.ethText ? "Not an Ethereum address" : "Paste an Ethereum address");
        else if (f.blocked) acts = hint(f.blocked, id("shield-log"));
        else if (!f.paySol && solana.usdc && !f.enoughNow) acts = hint(`More than your ${usdExact(solana.usdc.amount)} USDC, with fees.`);
        else if (f.paySol && f.solShort) acts = hint(`More than your ${solText(f.sol ?? 0n)} SOL, with fees.`, "pay-sol-short");
        else acts = <Act big arrow testId={id("shield-submit")} onClick={() => void send()} disabled={f.paySol && !f.price.quote}>Send</Act>;
        if (!decides) {
          const risk = f.advice.find((a) => a.severity === "risk");
          if (risk) note = <p className="note" data-testid="bridge-risk" data-severity={risk.severity} title={risk.detail}>{risk.title}<DocsLink to="crowd" className="ml-3" /></p>;
        }
      }
      end = <>{unlockWord}<Act quiet small testId={id("bridge-more")} onClick={onMore}>More options</Act></>;
      break;
    }
    case "decide": {
      const count = othersInOpen(pools, notes, splitIdx).reduce((a, o) => a + o.count, 0);
      l1 = crowdLine(count);
      l2 = z ? (
        <>{eclipseOn ? `The eclipse is on · until ${utcClock(f.tWindow!.end)}` : "Waiting for the eclipse hides you better."}<DocsLink to="totality" className="ml-3" /></>
      ) : (
        <>Crossing alone is easy to link by timing.<DocsLink to="crowd" className="ml-3" /></>
      );
      acts = (
        <>
          {z && (
            <Act big testId="tunnel-wait-eclipse" onClick={waitEclipse}>
              {eclipseOn ? "Cross in the eclipse" : "Wait for the eclipse"}
              <span className="dim">· {eclipseOn ? "now" : inText(z.next.start - now)}</span>
            </Act>
          )}
          {crossNow ? (
            // ADR 0015: the express lane. The price is shown even while the pool pays it.
            <Act quiet big={!z} testId="tunnel-cross-now" onClick={() => crossBatch(true)}>
              Cross now
              <span className="dim" data-testid="tunnel-cross-now-price">
                · {usdExact(f.crossNow!.total)}{f.crossNow!.onUs ? " · on us" : ""}
              </span>
            </Act>
          ) : (
            <Act quiet big={!z} testId="tunnel-cross-batch" onClick={() => crossBatch()}>Cross with the next batch</Act>
          )}
        </>
      );
      end = <Act quiet small testId="tunnel-back" onClick={() => setStep(null)}>Back</Act>;
      break;
    }
    case "depositing":
    case "signing":
      l1 = progress ?? "Confirm in your wallet.";
      break;
    case "settling":
      l1 = settle!.line;
      break;
    case "sign": {
      const due = jNotes.filter((n) => n.stage === "scheduled" && n.due).sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
      const all = picked?.kind === "fast" && due.length > 1;
      l1 = all ? `${due.length} deposits to sign.` : `Your ${usd(due[0]!.denomination)} deposit is due.`;
      acts = solana.signer ? (
        <Act big arrow testId="tunnel-sign" onClick={signDue} disabled={!!f.blocked}>{all ? `Sign ${due.length} deposits` : "Sign it"}</Act>
      ) : (
        <Act big arrow testId="tunnel-connect" onClick={() => setModal("solana")}>Connect a Solana wallet</Act>
      );
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
    }
    case "scheduled": {
      const sched = jNotes.filter((n) => n.stage === "scheduled").sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
      const next = sched.find((n) => n.heldBy === undefined);
      const heldNote = sched.find((n) => n.heldBy !== undefined);
      const nextAt = next?.scheduledAt ?? 0;
      if (!next && heldNote) {
        l1 = `Your next ${usd(heldNote.denomination)} waits for a new epoch.`;
      } else {
        const toEclipse = picked?.kind === "totality" && !!z && !z.on && nextAt >= z.next.start;
        l1 = toEclipse ? `Waiting for the eclipse · ${inText(z!.next.start - now)}` : `Next deposit at ${clock(nextAt)} · you sign it then`;
      }
      acts = <CalendarButton times={sched.map((n) => n.scheduledAt ?? 0).filter((t) => t > now)} testId="tunnel-calendar" />;
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
    }
    case "wait": {
      const b = batch!;
      const multi = new Set(live.map((n) => n.denominationIndex)).size > 1;
      const endsAt = b.epochEndSlot !== undefined && snap ? slotTime(b.epochEndSlot, snap.slot, now) : undefined;
      const w = waitLines(b, { minBatch: minBatchOf(b.denominationIndex), multi, endsAt, now, at: (ms) => clock(ms, now) });
      // One line: how full the batch is, then how long after it fills (a full batch is timed by
      // its end slot).
      const fill = batchWait({ leaves: b.epochLeaves ?? 0, minBatch: minBatchOf(b.denominationIndex), cap: dep.params.perEpochCap, endsAt, now }, prof);
      const left = eta({ stage: "wait", fill });
      const head = w.l1.replace(/^Your (\$[\d,]+ )?batch: /, (_m, d?: string) => (d ? `${d}batch: ` : "")).replace(/\.$/, "");
      l1 = left && fill ? left : left ? `${head} · ${left}` : w.l1;
      if (b.refund?.refundable) {
        l1 = w.l1;
        acts = <Act big arrow testId="tunnel-refund" disabled={busy} onClick={() => run(() => app.refund(b))} title={b.depositWallet ? `It goes back to ${shortAddr(b.depositWallet)}.` : undefined}>Take back {usdExact(BigInt(b.denomination) + (b.fee ?? 0n))}</Act>;
      }
      const ready = jNotes.filter((n) => n.stage === "claimable");
      if (ready.length) acts = <Act big arrow testId="tunnel-claim" onClick={claimAll}>Claim {usd(ready.reduce((a, n) => a + BigInt(n.denomination), 0n))}</Act>;
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
    }
    case "transit":
      // The single line: how long is left, else what it waits for.
      l1 = jNotes.some((n) => n.stage === "batched") ? transitLine(jNotes, !!aztec.session) : (eta({ stage: "transit" }) ?? transitLine(jNotes, !!aztec.session));
      if (!aztec.session && aztec.state !== "warming") acts = <Act quiet testId="tunnel-open-aztec" onClick={() => setModal("aztec")}>Open Aztec</Act>;
      {
        const ready = jNotes.filter((n) => n.stage === "claimable");
        if (ready.length) acts = <Act big arrow testId="tunnel-claim" onClick={claimAll}>Claim {usd(ready.reduce((a, n) => a + BigInt(n.denomination), 0n))}</Act>;
      }
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
    case "arrived": {
      const ready = jNotes.filter((n) => n.stage === "claimable");
      const n = ready[0]!;
      const pool = pools.find((p) => p.index === n.denominationIndex);
      const risk = n.epochId ? claimRisk(adviseClaim({ denomination: BigInt(n.denomination), epochId: BigInt(n.epochId), latestSentEpoch: pool?.latestSentEpoch, pool }), usd(n.denomination)) : undefined;
      l1 = (
        <>
          Arrived
          {aztec.session ? (
            <>{sep}<Act className={inline} testId="tunnel-claim" disabled={busy} onClick={claimAll}>Claim</Act></>
          ) : aztec.state !== "warming" ? (
            <>{sep}<Act className={inline} testId="tunnel-open-aztec" onClick={() => setModal("aztec")}>Open Aztec</Act></>
          ) : (
            <span className="dim">{sep}Aztec starting</span>
          )}
        </>
      );
      // The one risk that matters before claiming stays, as one quiet line.
      l2 = risk && aztec.state !== "warming" ? <span data-testid="tunnel-claim-risk" data-severity={risk.severity} title={risk.detail}>{risk.title}<DocsLink to="crowd" className="ml-3" /></span> : null;
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
    }
    case "claim": {
      const active = jNotes.find((n) => claimRunning(claims[n.index]));
      const p = active ? claims[active.index]! : undefined;
      const all = jNotes.filter((n) => n.stage === "claimable" || claims[n.index]);
      const k = active ? all.findIndex((n) => n.index === active.index) + 1 : 0;
      const label = CLAIM_STEPS.find((s) => s.key === p?.stage)?.label ?? "Preparing";
      l1 = (p ? eta({ stage: "claim", startedAt: p.startedAt }) : undefined) ?? `Claiming${all.length > 1 ? ` ${k} of ${all.length}` : ""} · ${label}`;
      break;
    }
    case "claimed":
      if (sendOnTo && dep.features?.exitEthereum) {
        l1 = `Next: send it on to ${shortAddr(sendOnTo, 6)}`;
        acts = <Act big arrow testId="tunnel-send-on" disabled={busy} onClick={() => moveOut("ethereum", sendOnTo)}>Send on</Act>;
      } else if (dep.features?.exit) {
        acts = <Act big arrow testId="tunnel-move-out" onClick={() => setStep("move")}>Move out</Act>;
      }
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
    case "move": {
      const toEth = moveTo === "ethereum" && ethOn;
      const solDest = toEth ? undefined : parseAddress(destText);
      const ethDest = toEth ? parseEthAddress(destText) : undefined;
      const target = solDest ?? ethDest;
      const depositWallets = [...new Set(data.notes.map((n) => n.depositWallet).filter((w): w is string => !!w))];
      const lastClaimAt = Math.max(0, ...data.notes.map((n) => n.claimedAt ?? 0)) || undefined;
      const advice = adviseExit({ destination: solDest, depositWallets, now, lastClaimAt, notes: claimedNotes.map((n) => BigInt(n.denomination)) });
      const worst = advice.find((a) => a.severity === "risk") ?? advice.find((a) => a.severity === "caution");
      l1 = "Where to?";
      l2 = worst ? <span data-testid="tunnel-exit-advice" data-severity={worst.severity} title={worst.detail}>{worst.title}<DocsLink to="public" className="ml-3" /></span> : null;
      // Each destination with its time, before the burn (src/lib/eta.ts).
      const times = exitTimes({ now, clock: aztecClock }, prof);
      const opt = (to: "solana" | "ethereum", word: string) => (
        <>{word}<span className="dim"> · {aboutText(times[to])}</span></>
      );
      dest = (
        <div className="tunnel-dest">
          <p className="choice">
            {ethOn ? (
              <span role="radiogroup" aria-label="To" className="routes">
                <button type="button" role="radio" className="opt" aria-checked={!toEth} data-testid="tunnel-exit-to-solana" onClick={() => setMoveTo("solana")}>{opt("solana", "Solana")}</button>
                <button type="button" role="radio" className="opt" aria-checked={toEth} data-testid="tunnel-exit-to-ethereum" onClick={() => setMoveTo("ethereum")}>{opt("ethereum", "Ethereum")}</button>
              </span>
            ) : (
              <span className="opt on">{opt("solana", "Solana")}</span>
            )}
          </p>
          {!toEth && <p className="means" data-testid="tunnel-exit-note">{destNote("solana", false, MIN_EXIT_BATCH)}</p>}
          <input className="eth" data-testid="tunnel-exit-destination" placeholder={toEth ? "0x…" : "A new account in your wallet"} value={destText} onChange={(e) => setDestText(e.target.value)}
            autoComplete="off" spellCheck={false} aria-label={toEth ? "Ethereum address" : "Solana address"} onKeyDown={(e) => e.key === "Enter" && target && moveOut(toEth ? "ethereum" : "solana", target)} />
        </div>
      );
      const fastTotal = fast?.fast.reduce((a, n) => a + BigInt(n.denomination), 0n) ?? 0n;
      acts = destText && !target ? (
        <span className="hint">{toEth ? "Not an Ethereum address" : "Not a valid Solana address"}</span>
      ) : !toEth && fast && fast.fast.length > 0 ? (
        // ADR 0017: Fast (fronted from the pool, the fee shown) or Wait (the normal path, free).
        <>
          <Act big arrow testId="tunnel-exit-fast" disabled={!target || busy} onClick={() => target && moveOut("solana", target, true)} title={`The pool can front ${usdExact(capacity)} now.`}>
            Fast{fast.wait.length > 0 ? ` ${usd(fastTotal)}` : ""}<span className="dim"> · fee {usdExact(fast.fee)}</span>
          </Act>
          <Act quiet testId="tunnel-exit-submit" disabled={!target || busy} onClick={() => target && moveOut("solana", target)}>
            Wait<span className="dim"> · {aboutText(times.solana)}</span>
          </Act>
        </>
      ) : (
        <Act big arrow testId="tunnel-exit-submit" disabled={!target || busy} onClick={() => target && moveOut(toEth ? "ethereum" : "solana", target)}>Move out {usd(claimedTotal)}</Act>
      );
      end = <Act quiet small testId="tunnel-back" onClick={() => setStep(null)}>Back</Act>;
      break;
    }
    case "burning": {
      const burning = jExits.filter((x) => x.stage === "burning");
      const amount = usd(burning.reduce((a, x) => a + BigInt(x.denomination), 0n));
      l1 = progress ? `Burning ${amount} · ${progress}` : ((movedAt ? eta({ stage: "burning", startedAt: movedAt, exit: burning[0] && exitEta(burning[0]) }) : undefined) ?? `Burning ${amount} on Aztec`);
      break;
    }
    case "leaving": {
      const x = slowestExit(jExits)!;
      const e = x.to === "ethereum" || aztec.session ? journeyEta({ stage: "leaving", to: journeyTo, now, clock: aztecClock, exit: exitEta(x) }, prof) : {};
      const left = etaLine("leaving", e);
      const need = x.facts.minBatch !== undefined && x.facts.inEpoch !== undefined ? Math.max(0, x.facts.minBatch - x.facts.inEpoch) : 0;
      // An exit batch still filling waits for others: how many, then how long after them.
      l1 = left && e.afterOthers && need ? thenLine(`Needs ${need} more ${need === 1 ? "exit" : "exits"}`, left) : left && !e.afterOthers ? left : leavingLine(x, { testnet: dep.network === "testnet", canRead: !!aztec.session });
      if (x.to === "solana" && !aztec.session && aztec.state !== "warming") acts = <Act quiet testId="tunnel-open-aztec" onClick={() => setModal("aztec")}>Open Aztec</Act>;
      break;
    }
    case "exit-claim": {
      const x = readyExits[0]!;
      const noEth = x.to === "ethereum" && !injectedEthereum();
      const depositWallets = data.notes.map((n) => n.depositWallet).filter(Boolean);
      const linked = x.to === "solana" && !!solana.signer && depositWallets.includes(solana.signer.address);
      l1 = noEth ? "Arrived" : (
        <>Arrived{sep}<Act className={inline} testId="tunnel-exit-claim" disabled={busy} onClick={claimExits}>{x.to === "solana" && !solana.signer ? "Connect a Solana wallet" : "Claim"}</Act></>
      );
      if (noEth) l2 = <>Claiming needs an Ethereum wallet in this browser.<DocsLink to="how" className="ml-3">Docs</DocsLink></>;
      else if (linked) l2 = <span data-testid="tunnel-exit-linked">Your deposit wallet sends this claim: that links the two.<DocsLink to="public" className="ml-3" /></span>;
      else if (progress) l2 = progress;
      break;
    }
    case "out":
      l1 = outLine(jExits);
      end = <Act quiet small testId="tunnel-new" onClick={newCrossing}>New crossing</Act>;
      break;
  }
  // A flight that is about to start (this render asks for it) or running: the words wait for it.
  const scene = sceneRef.current;
  const pending = !!scene && held.current && flightPath(scene.state.hold, currentHold).length > 0;
  if ((flying || pending) && shown !== "amount") {
    if (currentHold === "arrived" || currentHold === "claim" || currentHold === "claimed") {
      l1 = "Crossing";
      l2 = null;
    } else if (currentHold === "outwait" || currentHold === "out") {
      l1 = "Moving out";
      l2 = null;
    }
    acts = null;
    dest = null;
    end = null;
    note = null;
  }
  // The step's "?": one short sentence under its line, for someone crossing for the first time.
  const explain = flying || pending ? undefined : helpFor(shown);
  if (explain && l1 !== null) l1 = <>{l1}<HelpMark open={help} onToggle={() => setHelp((o) => !o)} /></>;
  const helpLine = explain && help && l1 !== null ? <HelpText docs={explain.docs}>{explain.text}</HelpText> : null;
  let why: ReactNode = null;
  if (err) {
    l2 = (
      <>
        <span className="err" role="alert" data-testid="tunnel-error" title={err.why}>{err.line}</span>
        {err.why && (
          <button type="button" className="why" data-testid="tunnel-error-details" aria-expanded={whyOpen} onClick={() => setWhyOpen((o) => !o)}>Details</button>
        )}
      </>
    );
    if (whyOpen && err.why) why = <p className="why-text" data-testid="tunnel-error-why">{err.why}</p>;
  } else if (busy && progress && shown !== "burning" && shown !== "exit-claim") l2 = progress;

  // ---------------------------------------------------------------- layout
  const fs = useMemo(() => {
    if (!geo) return 48;
    const v = f.amountText || "0";
    const digits = v.replace(/\D/g, "").length || 1, commas = (v.match(/,/g) ?? []).length;
    const em = digits * 0.6 + commas * 0.27 + 0.42;
    return Math.min(geo.R * 0.46, (geo.R * 1.5) / em);
  }, [geo, f.amountText]);
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [iw, setIw] = useState(0);
  useLayoutEffect(() => {
    if (mirrorRef.current) setIw(mirrorRef.current.getBoundingClientRect().width + 1);
  }, [f.amountText, fs, shown]);

  const onAmount = (raw: string) => {
    const digits = raw.replace(/\D/g, "").replace(/^0+/, "").slice(0, MAX_DIGITS);
    f.setAmountText(digits ? Number(digits).toLocaleString("en-US") : "");
  };

  const box = (y: number, w: number): React.CSSProperties => {
    if (!geo) return { visibility: "hidden" };
    const width = Math.min(w, geo.W - 32);
    return { left: Math.max(16, Math.min(geo.W - 16 - width, geo.cx - width / 2)), top: y, width };
  };
  // The words stay on screen: a block taller than the room under the disk (a "?" opened, a long
  // error) rises by what it lacks, never above the header.
  const blockY = geo ? (currentHold === "decide" || currentHold === "wait" ? geo.nearY : geo.lineY) : 0;
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    const el = blockRef.current;
    if (!el || !geo) return;
    const over = blockY + el.offsetHeight - (window.innerHeight - 12);
    const next = Math.max(0, Math.min(over, blockY - 96));
    if (Math.abs(next - lift) > 1) setLift(next);
  });
  const onAztecSide = shown === "arrived" || shown === "claim" || shown === "claimed" || shown === "move" || shown === "burning";
  const canvases = mounted
    ? createPortal(
        <div ref={canvasRef} className="tunnel-canvas" aria-hidden data-gl={hasGL}>
          <canvas ref={glRef} />
          <canvas ref={fxRef} />
        </div>,
        document.body,
      )
    : null;

  return (
    <section ref={rootRef} className="tunnel" data-testid="bridge" data-stage={shown} data-settled={String(!(flying || pending))} aria-label="Bridge">
      {canvases}
      <label className={`tunnel-ov tunnel-amount ${shown === "amount" ? "" : "off"}`} htmlFor="tunnel-amount"
        style={geo ? { left: geo.cx, top: geo.cy, width: geo.R * 1.9, height: geo.R * 1.9, fontSize: fs } : { visibility: "hidden" }}>
        <span className="amt">
        <span className="cur" aria-hidden>$</span>
        <input ref={inputRef} id="tunnel-amount" data-testid={id("shield-amount")} type="text" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="0" aria-label="Amount in dollars" enterKeyHint="go"
          value={f.amountText} disabled={shown !== "amount" || !solana.signer} onChange={(e) => onAmount(e.target.value)} style={{ width: iw || undefined }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (valid && solana.signer && !f.blocked && !(f.toEth && !f.eth)) send();
            }
          }} />
        <i className="caret" aria-hidden />
        <span ref={mirrorRef} className="mirror" aria-hidden>{f.amountText || "0"}</span>
        </span>
      </label>

      <div ref={blockRef} className="tunnel-ov tunnel-block" style={geo ? box(blockY - lift, 560) : { visibility: "hidden" }}>
        <div key={shown} className="tunnel-lines" aria-live="polite">
          {l1 !== null && <p className="l1" data-testid="tunnel-line">{l1}</p>}
          {l2 !== null && <p className="l2" data-testid="tunnel-line2">{l2}</p>}
          {why}
          {helpLine}
        </div>
        {dest}
        {(acts || end) && (
          <div className="acts tunnel-acts">
            {acts}
            {end && <span className="tunnel-end">{end}</span>}
          </div>
        )}
        {note}
      </div>

      <button ref={ringRef} type="button" className={`tunnel-ov tunnel-ring ${shown === "arrived" && aztec.session ? "" : "off"}`} data-testid="tunnel-far-ring" aria-label="Claim" tabIndex={-1}
        onClick={claimAll} onPointerEnter={() => sceneRef.current?.setHover(true)} onPointerLeave={() => sceneRef.current?.setHover(false)} />

      <div ref={balRef} className={`tunnel-ov tunnel-balance ${onAztecSide && shown !== "arrived" && shown !== "claim" && claimedTotal > 0n ? "" : "off"}`} data-testid="tunnel-balance">
        <b className="tabular">{usd(claimedTotal)}</b>
        <span>private</span>
      </div>
    </section>
  );
}
