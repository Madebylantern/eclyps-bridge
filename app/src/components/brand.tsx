"use client";
import { type ReactNode, useEffect, useState } from "react";
import { isMuteKey, setSoundOn, soundAvailable, soundIsOn, useSoundOn } from "@/lib/sound";
import { Wordmark } from "./wordmark";

/** The eclipse mark: a thin white ring with the black disk slightly in front of it. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 34 34" aria-hidden className="shrink-0">
      <circle cx="17" cy="17" r="13" fill="none" stroke="var(--color-white)" strokeWidth="1.4" />
      <circle cx="17" cy="15.4" r="12.2" fill="var(--color-black)" />
    </svg>
  );
}

/**
 * The top bar: the mark (back to the landing) on the left, the section words beside it, and one
 * or two quiet words on the right. Everything else lives in the Menu sheet (src/components/menu.tsx).
 */
export function Header({ nav, right }: { nav?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex items-center gap-x-[clamp(18px,4vw,48px)] py-7">
      <a href="/?landing" className="brand-word flex shrink-0 items-center gap-3 text-white" aria-label="Eclyps home" data-testid="home">
        <Mark />
        <Wordmark className="h-[13px] w-auto max-[459px]:hidden" hairline={1} />
      </a>
      {nav}
      <div className="ml-auto flex items-baseline justify-end gap-x-[clamp(16px,2.6vw,28px)]">{right}</div>
    </header>
  );
}

/** "Docs" among the header words: a plain link to the Docs page, in the same tab. */
export function DocsWord() {
  return <a href="/docs/" className="nav-word" data-testid="nav-docs">Docs</a>;
}

/** `M` turns the sound on and off anywhere in the app (the landing's switch, remembered here). */
export function useMuteKey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMuteKey(e)) setSoundOn(!soundIsOn());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * The sound's state as a word in the Menu ("On", "Off"); a tap switches it. The bridge plays two
 * calls on it (src/lib/sound.ts), nothing else.
 */
export function SoundWord({ className = "" }: { className?: string }) {
  const on = useSoundOn();
  const [can, setCan] = useState(false);
  useEffect(() => setCan(soundAvailable()), []);
  if (!can) return null;
  return (
    <button type="button" className={className} data-testid="sound-toggle" data-on={on} aria-pressed={on} title={on ? "Turn the sound off (M)" : "Turn the sound on (M)"} onClick={() => setSoundOn(!on)}>
      {on ? "On" : "Off"}
    </button>
  );
}

/** One quiet line: what this is, and where everything is explained. */
export function Footer() {
  return (
    <footer className="flex flex-wrap items-baseline gap-x-2 pb-10 pt-8 text-[0.6875rem] tracking-[0.04em] text-dim" data-testid="warning">
      <span>Unaudited · No Eclyps server ·</span>
      <a href="/docs/" className="transition-[color,text-shadow] duration-300 hover:text-white hover:[text-shadow:var(--glow)]">Docs</a>
    </footer>
  );
}
