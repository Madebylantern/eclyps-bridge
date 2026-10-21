// The way in to the landing's sound, loaded with the page: tiny, and silent by itself. The splash
// is a cover (scene.ts) whose cue reads "Enter the darkness"; pressing it enters (ENTER_EVENT),
// which starts the sound while the eclipse wakes. Any other first click, tap or key starts the
// sound too; scrolling does not (wheel, touch, or the keys that scroll or move the focus), nor do
// the owner's T (face.ts) and M. The AudioContext is made then, and only then is the engine
// (sound.ts) imported. M turns the sound off and on, and so does the one word in the footer.
// Turning it off is remembered (localStorage, `eclyps.sound`, shared with the app): a later first
// click, tap or key respects it. Pressing "Enter the darkness" is the visitor asking for sound, so
// it always starts it and clears a stored "off".

import { isFaceKey } from "./face";
import type { SoundPlayer } from "./sound";

const KEY = "eclyps.sound";
/** Fired on the landing's root when the cover is left: `detail.press` is true for the visitor's
 *  own press, false when the page opens past the cover (a link to a section); `detail.cue` is true
 *  when that press was on "Enter the darkness" itself (a click, or Enter or Space on it). */
export const ENTER_EVENT = "landing:enter";
export type EnterDetail = { press: boolean; cue?: boolean };
const NAV_KEYS = new Set(["Tab", "Shift", "Control", "Alt", "Meta", "CapsLock", "Escape", " ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

function storedOff(): boolean {
  try { return localStorage.getItem(KEY) === "off"; } catch { return false; }
}
function store(off: boolean) {
  try { if (off) localStorage.setItem(KEY, "off"); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export function mountSoundGate(root: HTMLElement): () => void {
  const word = root.querySelector<HTMLButtonElement>("[data-sound]");
  const AC = window.AudioContext as typeof AudioContext | undefined;
  if (!AC) {
    if (word) word.hidden = true;
    return () => {};
  }
  let off = storedOff();
  let ctx: AudioContext | null = null;
  let player: SoundPlayer | null = null;
  let loading = false, disposed = false, audible = false, touchMoved = false;

  const label = () => { if (word) word.textContent = audible ? "Sound off" : "Sound on"; };
  const onAudible = (a: boolean) => {
    audible = a;
    label();
  };

  const activations = ["pointerdown", "keydown", "touchend"] as const;
  const listen = (on: boolean) => {
    for (const type of activations) {
      if (on) window.addEventListener(type, onActivate, { capture: true, passive: true });
      else window.removeEventListener(type, onActivate, { capture: true });
    }
  };
  // Once the context runs (a gesture, or a browser that allows sound), the gestures are no longer
  // needed, and the engine comes in if it has not yet.
  const onState = () => {
    if (ctx?.state !== "running") return;
    listen(false);
    if (!player) start();
  };

  function context(): AudioContext | null {
    if (ctx || disposed) return ctx;
    try { ctx = new AC!({ latencyHint: "playback" }); } catch { return null; }
    ctx.addEventListener("statechange", onState);
    onState();
    return ctx;
  }

  function start() {
    if (off || disposed) return;
    // iPhone and iPad (any browser there) mute Web Audio with the ring/silent switch unless the
    // page asks to be played like media.
    try {
      const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (s) s.type = "playback";
    } catch { /* not supported */ }
    const c = context();
    if (!c) return;
    if (c.state === "suspended") c.resume().catch(() => {});
    if (player) { player.setMuted(false); return; }
    if (loading) return;
    loading = true;
    import("./sound").then(
      (m) => { if (!disposed) { player = m.mountSound(root, c, onAudible); if (off) player.setMuted(true); } },
      () => { loading = false; },
    );
  }

  function flip() {
    if (audible) {
      off = true; store(true);
      player?.setMuted(true);
      onAudible(false);
    } else {
      off = false; store(false);
      start();
    }
  }

  function onActivate(e: Event) {
    // The footer word and the M key decide for themselves. Moving around is not asking for
    // sound: a touch that scrolled, and the keys that scroll or move the focus (Space and Enter
    // on the cue still start it, through the press).
    if (e.target instanceof Element && e.target.closest("[data-sound]")) return;
    if (e.type === "keydown" && (isMuteKey(e as KeyboardEvent) || isFaceKey(e as KeyboardEvent) || NAV_KEYS.has((e as KeyboardEvent).key))) return;
    if (e.type === "touchend" && touchMoved) return;
    start();
  }
  function isMuteKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "m" && e.key !== "M")) return false;
    const t = e.target as HTMLElement | null;
    return !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
  }
  const onKey = (e: KeyboardEvent) => { if (!e.repeat && isMuteKey(e)) flip(); };
  // Leaving the cover by a press starts the sound unless it was turned off. A press of "Enter the
  // darkness" itself asks for the sound: it starts, and a stored "off" (set here or in the app) is
  // cleared.
  const onEnter = (e: Event) => {
    const d = (e as CustomEvent<EnterDetail>).detail;
    if (!d?.press) return;
    if (d.cue) { off = false; store(false); }
    start();
  };
  // Opening the app while the sound plays: the sound and the page fade out together, then the
  // app opens (it comes in from black). A new tab, or a press with a modifier, opens at once.
  const LEAVE_S = 1.6;
  const onLeave = (e: MouseEvent) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href^="/app"]') : null;
    if (!a || !player || !audible || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target === "_blank") return;
    e.preventDefault();
    const quick = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const s = quick ? 0.6 : LEAVE_S;
    player.leave(s);
    document.documentElement.style.setProperty("--leave-s", `${s}s`);
    document.documentElement.classList.add("leaving");
    window.setTimeout(() => { window.location.href = a.href; }, s * 1000);
  };
  const onShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    document.documentElement.classList.remove("leaving");
    player?.back();
  };
  const onTouchStart = () => { touchMoved = false; };
  const onTouchMove = () => { touchMoved = true; };

  listen(true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  word?.addEventListener("click", flip);
  root.addEventListener(ENTER_EVENT, onEnter);
  document.addEventListener("click", onLeave);
  window.addEventListener("pageshow", onShow);

  // Some browsers let a site start sound without a gesture (Chrome, for sites people come back
  // to). Try once, as the page settles; if it is not allowed, wait for the first gesture.
  const probe = window.setTimeout(() => {
    if (off || disposed || ctx) return;
    const policy = (navigator as Navigator & { getAutoplayPolicy?: (kind: string) => string }).getAutoplayPolicy?.("audiocontext");
    if (policy !== undefined && policy !== "allowed") return;
    context(); // starts the engine by itself if the context runs (onState)
  }, 0);

  return () => {
    disposed = true;
    clearTimeout(probe);
    listen(false);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    word?.removeEventListener("click", flip);
    root.removeEventListener(ENTER_EVENT, onEnter);
    document.removeEventListener("click", onLeave);
    window.removeEventListener("pageshow", onShow);
    document.documentElement.classList.remove("leaving");
    player?.dispose();
    if (ctx) { ctx.removeEventListener("statechange", onState); void ctx.close().catch(() => {}); }
  };
}
