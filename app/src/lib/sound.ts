"use client";
/**
 * The bridge screen's sound: two calls of the landing's engine (src/app/(landing)/sound.ts), never
 * a soundtrack. As the light goes into the disk, a horn call; at the diamond-ring flash, a distant
 * answer. The same switch as the landing: `eclyps.sound` in localStorage ("off" once turned off),
 * the `M` key and one quiet word among the header's words ("Sound off" / "Sound on").
 *
 * The AudioContext is made at the first click, tap or key on the bridge screen (Send is one) and
 * suspended at once; it runs only while a call sounds. The engine is loaded with the first call.
 * Nothing plays while the sound is off or the tab is hidden.
 */
import { useSyncExternalStore } from "react";
import type { SoundEngine } from "@/app/(landing)/sound";

const KEY = "eclyps.sound";
/** The layer's level for a call: well under the landing's. */
const LEVEL = 0.62;

const listeners = new Set<() => void>();
let off = readOff();
let ctx: AudioContext | null = null;
let engine: Promise<SoundEngine | null> | null = null;
let ringsUntil = 0;
let lastEnd = 0;
let idle: ReturnType<typeof setTimeout> | undefined;

function readOff(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

/** The switch as it is now (outside React). */
export const soundIsOn = () => !off;

export const soundAvailable = () => typeof window !== "undefined" && typeof window.AudioContext === "function";

function emit() {
  for (const l of listeners) l();
}

/** Whether the sound is on (the landing's switch). */
export function useSoundOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => !off,
    () => true,
  );
}

export function setSoundOn(on: boolean) {
  off = !on;
  try {
    if (off) localStorage.setItem(KEY, "off");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: this page remembers it */
  }
  if (off) silence();
  else unlockSound();
  emit();
}

function silence() {
  clearTimeout(idle);
  const c = ctx;
  if (!c) return;
  void engine?.then((e) => e?.fade(0, c.currentTime, 0.4));
  idle = setTimeout(() => void c.suspend().catch(() => undefined), 700);
  ringsUntil = 0;
}

function onVisibility() {
  if (document.hidden) silence();
}

/** Call from a user gesture: makes the context, so a later call may sound. Suspended until then. */
export function unlockSound() {
  if (off || ctx || !soundAvailable()) return;
  try {
    ctx = new AudioContext({ latencyHint: "playback" });
  } catch {
    return;
  }
  document.addEventListener("visibilitychange", onVisibility);
  const c = ctx;
  c.resume()
    .then(() => {
      if (Date.now() >= ringsUntil) void c.suspend().catch(() => undefined);
    })
    .catch(() => undefined);
}

function getEngine(c: AudioContext): Promise<SoundEngine | null> {
  engine ??= import("@/app/(landing)/sound").then(
    (m) => m.createEngine(c),
    () => null,
  );
  return engine;
}

/** A call for a moment of the journey: `crossing` (a horn), `arrival` (the distant answer). */
export async function playCue(cue: "crossing" | "arrival") {
  const c = ctx;
  if (off || !c || document.hidden) return;
  try {
    await c.resume();
  } catch {
    return;
  }
  if (c.state !== "running" || off) return;
  const e = await getEngine(c);
  if (!e || off || document.hidden) return;
  const now = c.currentTime;
  // Calls never overlap: a second one waits for the first to end.
  const at = Math.max(now + 0.3, lastEnd + 1);
  e.pump(at + 30);
  e.fade(LEVEL, Math.max(now, at - 1.2), 1.2);
  const end = cue === "crossing" ? e.horn("distant", at, 0.3) : e.horn("answer", at);
  lastEnd = end;
  e.fade(0, end + 1.5, 4.5);
  const ms = (end - now + 8) * 1000;
  ringsUntil = Date.now() + ms;
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (Date.now() >= ringsUntil - 50) void c.suspend().catch(() => undefined);
  }, ms);
}

/** `M` turns the sound off and on (not while typing, not with a modifier). */
export function isMuteKey(e: KeyboardEvent): boolean {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "m" && e.key !== "M")) return false;
  const t = e.target as HTMLElement | null;
  return !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}
