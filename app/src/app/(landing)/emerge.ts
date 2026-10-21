// Text that comes out of the dark: each word goes from blur to focus while its light rises, one
// after another, and a faint glow passes over it as if the corona reached it. No glyph changes and
// nothing flickers: every value only rises. With reduced motion the line fades in whole. Used on a
// few lines of the landing; when a line is done its original text node is put back, so the settled
// page is exactly the static one.

const WORD = { dur: 2100, stagger: 170, blur: 0.2, glow: 0.42 };
const LINE_FADE = 600;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => { const k = clamp01((x - a) / (b - a)); return k * k * (3 - 2 * k); };
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

// One word's arrival, sampled once into keyframes. Blur and glow are in em, so they follow the
// line's size (and the face it is set in).
let keyframes: Keyframe[] | null = null;
function wordFrames(): Keyframe[] {
  if (keyframes) return keyframes;
  const n = 28;
  keyframes = [];
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    const light = Math.pow(smooth(0, 0.92, p), 1.35); // brightness rising
    const focus = Math.pow(1 - easeOut(p / 0.95), 1.6); // blur falling, slowest at the end
    const glow = WORD.glow * Math.pow(Math.sin(Math.PI * clamp01((p - 0.25) / 0.75)), 2);
    keyframes.push({
      offset: p,
      opacity: light.toFixed(4),
      filter: `blur(${(focus * WORD.blur).toFixed(4)}em)`,
      textShadow: `0 0 0.28em rgba(255,255,255,${glow.toFixed(4)})`,
    });
  }
  return keyframes;
}

const running = new WeakMap<HTMLElement, () => void>();

/** Hides an element until it emerges. */
export function holdForEmerge(el: HTMLElement) {
  el.classList.add("em-hold");
}

/**
 * Brings the element's own text out of the dark (word by word, or the whole line with
 * `reduce`). Returns a cancel function that shows the text at once. The element must contain
 * text only (no child elements).
 */
export function emerge(el: HTMLElement, reduce: boolean): () => void {
  running.get(el)?.();
  const text = el.dataset.emergeText ?? el.textContent ?? "";
  el.dataset.emergeText = text;
  el.textContent = text;
  el.classList.remove("em-hold");

  const anims: Animation[] = [];
  const finish = () => {
    if (running.get(el) !== finish) return;
    running.delete(el);
    for (const a of anims) a.cancel();
    el.textContent = text;
  };
  running.set(el, finish);
  if (typeof el.animate !== "function") { finish(); return finish; }

  if (reduce) {
    anims.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LINE_FADE, easing: "ease-out" }));
  } else {
    el.textContent = "";
    const frames = wordFrames();
    let i = 0;
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { el.appendChild(document.createTextNode(part)); continue; }
      const w = document.createElement("span");
      w.className = "ew";
      w.textContent = part;
      el.appendChild(w);
      anims.push(w.animate(frames, { duration: WORD.dur, delay: i++ * WORD.stagger, fill: "backwards", easing: "linear" }));
    }
  }
  Promise.all(anims.map((a) => a.finished)).then(finish, () => { /* cancelled */ });
  return finish;
}
