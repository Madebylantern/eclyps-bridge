// Everything that moves on the landing, from the approved design: the eclipse (WebGL), the two
// stories (canvas 2D), each one screen that plays by itself when the page arrives on it (the
// crossing, then the crowd), the cover that holds the splash until "Enter the darkness" is
// pressed, the eclipse's awakening that the press starts, the lines that emerge from the dark, and
// the docked "Open the app". `mountLanding` starts it inside `root` and returns a cleanup that
// stops every frame loop and listener.

import { emerge, holdForEmerge } from "./emerge";
import { ENTER_EVENT, type EnterDetail } from "./sound-gate";

function mulberry32(a: number) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// The awakening, in seconds after the press. The press starts the horn: its first call breathes
// in after about half a second, speaks within a second, reaches full voice by about 3 s and
// holds about 4 s, one breath of 8-10 s in all (sound.ts TUNING.horn). The ring follows that shape: it swells and brightens with the
// first breath (rise), holds while the call holds, then settles (settle) to a breathing a little
// stronger than before. "Scroll" comes once it has swelled (scroll), and the page lets go then.
const WAKE = { rise: [0.5, 3.4], settle: [7, 12], scroll: [3.4, 4.8] } as const;

// ---------- the eclipse: a living stipple aura on the GPU ----------
// Every dot is one GL point. Its motion is computed in the vertex shader from per-dot seeds and
// the time, so the CPU does nothing per frame: the corona streams outward from the limb along
// slowly turning streamers, light falls from the lower limb to the horizon, the horizon shimmers,
// dust drifts, and the whole scene breathes. Layers shift with the pointer for depth. uWake is the
// swell when the horn first breathes (0, up to 1, back to 0); uLive is what stays after it (0
// before the press, 1 after): a slightly brighter, deeper breathing and a corona that reaches a
// little further.
const VS = [
  'attribute vec4 aA; attribute vec4 aB;',
  'uniform vec2 uRes; uniform vec2 uC; uniform vec2 uPar;',
  'uniform float uR; uniform float uT; uniform float uProg; uniform float uDpr; uniform float uHz;',
  'uniform float uGrow; uniform float uWake; uniform float uLive;',
  'varying float vA;',
  'const float TAU = 6.2831853;',
  'void main() {',
  '  float kind = aA.x; float t = uT;',
  '  float moonOff = 0.0;',
  '  float breathe = (0.86 + 0.04 * uLive) + (0.14 + 0.07 * uLive) * sin(t * 0.42);',
  '  float swell = 1.0 + 0.95 * uWake;',
  '  vec2 p = vec2(0.0); float a = aB.z; float depth = 1.0; bool occlude = true;',
  '  if (kind < 0.5) {',
  '    float th = aA.y * TAU;',
  '    float r = 1.0 + aA.z * (0.010 + 0.022 * max(0.0, sin(th))) * (1.0 + 0.8 * uWake);',
  '    p = vec2(cos(th), sin(th)) * r;',
  '    a *= (0.5 + 0.5 * sin(t * (0.7 + aA.w * 2.6) + aA.y * 157.0)) * breathe * (1.0 + 0.4 * uProg) * (1.0 + 0.7 * uWake);',
  '  } else if (kind < 1.5) {',
  '    float u = fract(aB.x + t * aB.y);',
  '    float th0 = aA.y * TAU;',
  '    float down = max(0.0, sin(th0));',
  '    float reach = (0.14 + 0.70 * down * down + 0.08 * abs(cos(th0))) * (1.0 + 0.5 * uWake + 0.07 * uLive);',
  '    float streak = 0.55 + 0.45 * sin(th0 * 9.0 + t * 0.11) * sin(th0 * 4.0 - t * 0.07 + 1.3);',
  '    float r = 1.0 + pow(u, 1.45) * reach * (0.55 + 0.9 * aA.z) * (0.7 + 0.6 * streak);',
  '    float th = th0 + (aA.w - 0.5) * 0.24 * u + 0.035 * sin(t * 0.33 + u * 5.0 + aA.z * 11.0);',
  '    p = vec2(cos(th), sin(th)) * r;',
  '    a *= (1.0 - u) * (1.0 - u) * (0.3 + 0.7 * streak) * breathe * (1.0 + 0.5 * uProg) * swell;',
  '    depth = 1.0 + 0.35 * u;',
  '  } else if (kind < 2.5) {',
  '    float u = fract(aB.x + t * aB.y);',
  '    float y = 0.86 + u * (uHz - 0.86);',
  '    float sig = 0.26 + 0.32 * (y - 0.86);',
  '    float x = aA.y * sig + 0.05 * sin(t * 0.4 + aA.z * 31.0 + y * 2.5);',
  '    p = vec2(x, y);',
  '    a *= exp(-(y - 0.86) / 1.1) * exp(-0.5 * aA.y * aA.y) * smoothstep(0.0, 0.05, u) * breathe * (1.0 - 0.9 * uProg) * (1.0 + 0.5 * uWake);',
  '    depth = 1.15;',
  '  } else if (kind < 3.5) {',
  '    float x = aA.y * (1.0 + 0.02 * sin(t * 0.22 + aA.z * TAU));',
  '    float y = uHz + aA.w + 0.006 * sin(t * 0.9 + aA.z * 70.0);',
  '    p = vec2(x, y);',
  '    a *= (0.55 + 0.45 * sin(t * (0.5 + aA.z) + aA.z * 90.0)) * exp(-0.5 * (x / 1.2) * (x / 1.2)) * breathe * (1.0 - 0.8 * uProg) * (1.0 + 0.4 * uWake);',
  '    depth = 1.3; occlude = false;',
  '  } else if (kind < 4.5) {',
  '    vec2 s = vec2(aA.y, fract(aA.z - t * aB.y));',
  '    vec2 sc = s * uRes + uPar * 0.35;',
  '    vec2 dd = (sc - uC) / uR;',
  '    if (dot(dd, dd) < 1.02) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }',
  '    vec2 cl = sc / uRes * 2.0 - 1.0;',
  '    gl_Position = vec4(cl.x, -cl.y, 0.0, 1.0);',
  '    gl_PointSize = aB.w * uDpr * uGrow;',
  '    vA = aB.z * (0.5 + 0.5 * sin(t * 0.6 + aA.w * 60.0)) * (1.0 + 0.6 * uWake);',
  '    return;',
  '  } else {',
  '    p = vec2(cos(aA.y), sin(aA.y)) * aA.z + vec2(0.0, moonOff);',
  '    a *= (1.0 - uProg) * (0.6 + 0.4 * sin(t * 0.5 + aA.w * 40.0));',
  '    occlude = false;',
  '  }',
  '  if (occlude) {',
  '    vec2 d = p - vec2(0.0, moonOff);',
  '    if (dot(d, d) < 1.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }',
  '  }',
  '  vec2 sc = uC + p * uR + uPar * depth;',
  '  vec2 cl = sc / uRes * 2.0 - 1.0;',
  '  gl_Position = vec4(cl.x, -cl.y, 0.0, 1.0);',
  '  gl_PointSize = aB.w * uDpr * uGrow;',
  '  vA = clamp(a, 0.0, 1.0);',
  '}',
].join('\n');
const FS = 'precision mediump float; varying float vA; void main() { gl_FragColor = vec4(1.0, 1.0, 1.0, vA); }';

// How strongly the corona swells with the horn (1 = the study's swell; the owner asked for less).
const WAKE_GAIN = 0.5;
const UNIFORMS = ['uRes', 'uC', 'uPar', 'uR', 'uT', 'uProg', 'uDpr', 'uHz', 'uGrow', 'uWake', 'uLive'] as const;
type Uniform = (typeof UNIFORMS)[number];

function smooth(a: number, b: number, x: number) { let k = (x - a) / (b - a); k = k < 0 ? 0 : k > 1 ? 1 : k; return k * k * (3 - 2 * k); }

function need<T extends Element>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`landing: missing ${selector}`);
  return el;
}

export function mountLanding(root: HTMLElement): () => void {
  const frames = new Set<number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const offs: Array<() => void> = [];
  let stopped = false;
  function frame(cb: FrameRequestCallback) {
    if (stopped) return;
    const id = requestAnimationFrame((now) => { frames.delete(id); cb(now); });
    frames.add(id);
  }
  function on<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  function on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  function on(target: Window | HTMLElement, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  }
  function debounce(fn: () => void, ms: number) {
    let id: ReturnType<typeof setTimeout> | undefined;
    return () => {
      if (id !== undefined) { clearTimeout(id); timers.delete(id); }
      id = setTimeout(() => { timers.delete(id!); fn(); }, ms);
      timers.add(id);
    };
  }

  const hero = need<HTMLElement>(root, '.hero');
  const canvas = need<HTMLCanvasElement>(root, '#sky');
  const wordmark = need<HTMLElement>(root, '#wordmark');
  const cueAway = hero.querySelector<HTMLElement>('[data-scroll]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const HZ = 1.66; // horizon, in disk radii below the centre

  const rng = mulberry32(20261012);
  function gauss() { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }
  function gaussWithin(lim: number) { let g; do { g = gauss(); } while (Math.abs(g) > lim); return g; }

  let gl: WebGLRenderingContext | null = null;
  let prog: WebGLProgram | null = null;
  let buf: WebGLBuffer | null = null;
  const U = {} as Record<Uniform, WebGLUniformLocation | null>;
  let count = 0;
  let cssW = 0, cssH = 0, dpr = 1, geo = { cx: 0, cy: 0, R: 1 };
  let progress = 0, onScreen = true;
  let pressedAt = -1; // when "Enter the darkness" was pressed (performance.now), -1 before
  const t0 = performance.now();
  const par = { x: 0, y: 0 }, parT = { x: 0, y: 0 };

  function initGL() {
    try { gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, powerPreference: 'high-performance' }); } catch { gl = null; }
    if (!gl) return false;
    const g = gl;
    function sh(type: number, src: string) {
      const s = g.createShader(type);
      if (!s) throw new Error('createShader');
      g.shaderSource(s, src); g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader');
      return s;
    }
    try {
      prog = g.createProgram();
      if (!prog) throw new Error('createProgram');
      g.attachShader(prog, sh(g.VERTEX_SHADER, VS));
      g.attachShader(prog, sh(g.FRAGMENT_SHADER, FS));
      g.linkProgram(prog);
      if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog) ?? 'link');
    } catch (e) { console.warn('eclipse shader', e); gl = null; return false; }
    g.useProgram(prog);
    for (const n of UNIFORMS) U[n] = g.getUniformLocation(prog, n);
    buf = g.createBuffer();
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE);
    g.disable(g.DEPTH_TEST);
    return true;
  }

  function particles(Rdev: number, W: number, H: number) {
    const k = Math.min(1.8, Math.pow(Rdev / 300, 2));
    const c = { limb: 18000 * k, corona: 120000 * k, spill: 60000 * k, horizon: 40000 * k, rim: 0, dust: Math.min(3000, W * H / 2200) };
    for (const key of Object.keys(c) as Array<keyof typeof c>) c[key] = Math.round(c[key]);
    const n = c.limb + c.corona + c.spill + c.horizon + c.rim + c.dust;
    const d = new Float32Array(n * 8);
    let o = 0, j;
    function put(k0: number, a1: number, a2: number, a3: number, b0: number, b1: number, b2: number, b3: number) { d[o++] = k0; d[o++] = a1; d[o++] = a2; d[o++] = a3; d[o++] = b0; d[o++] = b1; d[o++] = b2; d[o++] = b3; }
    for (j = 0; j < c.limb; j++) put(0, rng(), Math.abs(gauss()), rng(), 0, 0, 0.45 + 0.55 * rng(), 1 + 0.6 * rng());
    for (j = 0; j < c.corona; j++) put(1, rng(), rng(), rng(), rng(), 0.022 + 0.06 * rng(), 0.3 + 0.55 * rng(), 1 + 0.7 * rng());
    for (j = 0; j < c.spill; j++) put(2, gaussWithin(3), rng(), 0, rng(), 0.012 + 0.03 * rng(), 0.18 + 0.42 * rng(), 1 + 0.6 * rng());
    for (j = 0; j < c.horizon; j++) {
      const x = gaussWithin(2.9) * 1.3, y = rng() < 0.12 ? Math.abs(gauss()) * 0.16 : gauss() * 0.024 * (1 + 0.4 * Math.abs(x));
      put(3, x, rng(), y, 0, 0, 0.2 + 0.6 * rng(), 1 + 0.5 * rng());
    }
    for (j = 0; j < c.rim; j++) put(5, Math.PI * (0.12 + 0.76 * rng()), 1 - Math.abs(gauss()) * 0.06, rng(), 0, 0, 0.08 + 0.2 * rng(), 1);
    for (j = 0; j < c.dust; j++) put(4, rng(), rng(), rng(), 0, 0.002 + 0.008 * rng(), 0.06 + 0.3 * rng() * rng(), 1 + 0.5 * rng());
    return { data: d, n };
  }

  function layout() {
    const w = hero.clientWidth, h = hero.clientHeight;
    // A phone's toolbar showing or hiding changes only the height, a little: keep the eclipse as
    // it is (the canvas has a fixed pixel height, so it is cropped or bordered by black, never
    // stretched into an oval). A real resize (width, rotation) lays it out again.
    if (cssW && w === cssW && Math.abs(h - cssH) < cssH * 0.25) return;
    cssW = w; cssH = h;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const R = Math.min(cssH * 0.29, cssW * 0.40);
    const cy = cssH * 0.44;
    geo = { cx: cssW / 2, cy, R };
    hero.style.setProperty('--mx', geo.cx + 'px');
    hero.style.setProperty('--my', cy + 'px');
    hero.style.setProperty('--mr', R + 'px');
    hero.style.setProperty('--hz', (cy + HZ * R) + 'px');
    if (!gl || !prog) return;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    gl.viewport(0, 0, canvas.width, canvas.height);
    const p = particles(R * dpr, canvas.width, canvas.height);
    count = p.n;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, p.data, gl.STATIC_DRAW);
    const la = gl.getAttribLocation(prog, 'aA'), lb = gl.getAttribLocation(prog, 'aB');
    gl.enableVertexAttribArray(la); gl.vertexAttribPointer(la, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(lb); gl.vertexAttribPointer(lb, 4, gl.FLOAT, false, 32, 16);
  }

  // The awakening's two values at `now`: the swell (wake) and what stays after it (live).
  function wakeState(now: number) {
    if (pressedAt < 0) return { wake: 0, live: 0 };
    if (reduce) return { wake: 0, live: 1 };
    const dt = (now - pressedAt) / 1000;
    const rise = smooth(WAKE.rise[0], WAKE.rise[1], dt);
    return { wake: rise * (1 - smooth(WAKE.settle[0], WAKE.settle[1], dt)), live: rise };
  }

  function draw(now: number) {
    if (!gl) return;
    const t = reduce ? 6.0 : (now - t0) / 1000;
    const w = wakeState(now);
    wordmark.style.setProperty('--wm-glow', (0.32 * WAKE_GAIN * w.wake).toFixed(3));
    par.x += (parT.x - par.x) * 0.05; par.y += (parT.y - par.y) * 0.05;
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(U.uGrow, 1 + 0.18 * w.wake);
    gl.uniform1f(U.uWake, w.wake * WAKE_GAIN);
    gl.uniform1f(U.uLive, w.live);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform2f(U.uC, geo.cx * dpr, geo.cy * dpr);
    gl.uniform2f(U.uPar, par.x * dpr, par.y * dpr);
    gl.uniform1f(U.uR, geo.R * dpr);
    gl.uniform1f(U.uT, t);
    gl.uniform1f(U.uProg, progress);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform1f(U.uHz, HZ);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  function readScroll() {
    const h = hero.offsetHeight;
    progress = Math.max(0, Math.min(1, window.scrollY / (h * 0.75)));
    onScreen = window.scrollY < h;
    wordmark.style.opacity = String(Math.max(0, 1 - progress * 1.5));
    wordmark.style.setProperty('--lift', (progress * 36) + 'px');
    hero.style.setProperty('--my', geo.cy + 'px');
    // "Scroll" goes the moment the page moves, so it never rides over the next screen.
    cueAway?.classList.toggle('away', window.scrollY > 4);
  }

  function loop(now: number) {
    if (onScreen && !document.hidden) draw(now);
    frame(loop);
  }

  const hasGL = initGL();
  if (!hasGL) hero.classList.add('no-gl');
  layout(); readScroll(); draw(performance.now());
  hero.classList.add('lit'); // the name and the cue appear with the eclipse's first frame (landing.css)
  if (!reduce && hasGL) frame(loop);

  on(window, 'resize', debounce(() => { layout(); readScroll(); draw(performance.now()); }, 120));
  on(window, 'scroll', () => { readScroll(); if (reduce) draw(performance.now()); }, { passive: true });

  // ---------- the two stories ----------
  function clamp01(x: number) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function ease(x: number) { x = clamp01(x); return x * x * (3 - 2 * x); }
  function easeOut(x: number) { x = clamp01(x); return 1 - (1 - x) * (1 - x) * (1 - x); }
  function lerp(a: number, b: number, k: number) { return a + (b - a) * k; }
  // Each story is one screen that plays by itself once the page has arrived on it (most of it in
  // view), never driven by the scroll; with reduced motion it shows its last frame at once.
  // `arrivedAt` is when it started (performance.now), -1 until then.
  const story = { crossing: -1, crowd: -1 };
  // The crossing, in seconds after arrival: the notes drift in and gather at Solana, then travel
  // at one slow, even pace (no easing on the way) into the dark of the bridge and out onto Aztec,
  // trailing a little like a comet, and take their seats in the crowd there. The pace is the
  // eclipse's: about as slow as its breath.
  const CROSS = { gather: 2.6, depart: 3.0, travel: 9.5, lag: 1.1, settle: 2.6 } as const;
  // The crowd: its dots fill the disk from the centre out, then the first line emerges, then the
  // second.
  const CROWD = { grow: 5.2, first: 4.4, second: 7.0 } as const;
  type Surface = { c: CanvasRenderingContext2D; w: number; h: number };
  function fitCanvas(cv: HTMLCanvasElement): Surface | null {
    const d = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.max(1, Math.round(w * d)); cv.height = Math.max(1, Math.round(h * d));
    const c = cv.getContext('2d');
    if (!c) return null;
    c.setTransform(d, 0, 0, d, 0, 0);
    return { c, w, h };
  }

  // tagline: the second line lights up as it reaches the middle of the screen
  const tagline = need<HTMLElement>(root, '#tagline');
  function updateTagline() {
    const r = tagline.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    tagline.classList.toggle('lit', mid < window.innerHeight * 0.62);
  }

  // the crossing: a batch of notes travels Solana -> bridge -> Aztec by itself, once arrived
  const crossing = need<HTMLElement>(root, '#crossing');
  const ccv = need<HTMLCanvasElement>(root, '#crossing-canvas');
  const stationEls = Array.from(root.querySelectorAll<HTMLElement>('.station'));
  let C: Surface | null = null;
  // Each note of the batch has a seat in a small sunflower disk (golden angle), a lag behind the
  // batch's head (so it streams like a comet while moving), and a seat in the crowd at Aztec.
  type Note = { r: number; th: number; jx: number; jy: number; sx: number; sy: number; d: number; lag: number; tx: number; ty: number; ph: number; b: number };
  const notes: Note[] = [];
  const crowdAtAztec: Array<{ gx: number; gy: number; ph: number; b: number }> = [];
  const crng = mulberry32(7);
  function cgauss() { let u = 0; while (u === 0) u = crng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * crng()); }
  const BATCH_N = 120, SEAT_ANGLE = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < BATCH_N; i++) {
    const l = crng();
    notes.push({
      r: Math.sqrt((i + 0.5) / BATCH_N), th: i * SEAT_ANGLE, jx: cgauss(), jy: cgauss(),
      sx: crng(), sy: cgauss(), d: crng() * 0.14, lag: l * l, tx: cgauss(), ty: cgauss(),
      ph: crng() * 6.28, b: 0.55 + 0.45 * crng(),
    });
  }
  for (let j = 0; j < 260; j++) crowdAtAztec.push({ gx: cgauss(), gy: cgauss(), ph: crng() * 6.28, b: 0.15 + 0.25 * crng() });
  // a soft point of light, drawn once and stamped for every note
  const spark = document.createElement('canvas');
  spark.width = spark.height = 32;
  const sc = spark.getContext('2d');
  if (sc) {
    const g = sc.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.28, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    sc.fillStyle = g; sc.fillRect(0, 0, 32, 32);
  }

  // `e` is the seconds since the page arrived on the crossing (below 0: not yet), `t` the time for
  // the shimmer.
  function drawCrossing(e: number, t: number) {
    if (!C) return;
    const c = C.c, W = C.w, H = C.h, Y = H * 0.5;
    const S1 = W * 0.15, S2 = W * 0.5, S3 = W * 0.85;
    const unit = Math.max(6, Math.min(W, 900) * 0.016);
    // The dark of the bridge: a black disk on the route, which the notes pass behind.
    const Rb = Math.min(40, unit * 2.6);
    // One even pace: the head moves the same number of pixels every second, from Solana to Aztec.
    const v = (S3 - S1) / CROSS.travel;
    const along = (lag: number) => S1 + v * Math.max(0, Math.min(CROSS.travel, e - CROSS.depart - lag));
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = reduce ? '#000' : 'rgba(0,0,0,0.3)';
    c.fillRect(0, 0, W, H);
    // the route, lit behind the batch as it crosses
    c.fillStyle = '#1d1d1d';
    c.fillRect(S1, Y, S3 - S1, 1);
    const head = along(0), last = along(CROSS.lag), formed = ease(e / CROSS.gather);
    if (formed > 0 && head > S1 + 1) {
      const lit = c.createLinearGradient(S1, 0, head, 0);
      lit.addColorStop(0, 'rgba(255,255,255,0.06)'); lit.addColorStop(1, `rgba(255,255,255,${0.32 * formed})`);
      c.fillStyle = lit; c.fillRect(S1, Y, head - S1, 1);
    }
    // Each word lights as the notes reach it: Solana once they have gathered, the bridge as they
    // enter its dark, Aztec as they come out onto it.
    const reached = [e >= CROSS.gather * 0.6, head >= S2 - Rb, head >= S3 - 0.5];
    const active = reached[2] ? 2 : reached[1] ? 1 : reached[0] ? 0 : -1;
    [S1, S3].forEach((x, i) => {
      const k = i === 0 ? 0 : 2;
      if (k === active) {
        const g = c.createRadialGradient(x, Y, 0, x, Y, 46);
        g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.beginPath(); c.arc(x, Y, 46, 0, 6.2832); c.fill();
      }
      c.strokeStyle = k === active ? '#ffffff' : '#3a3a3a'; c.lineWidth = 1;
      c.beginPath(); c.arc(x, Y + 0.5, 4, 0, 6.2832); c.stroke();
    });
    // the crowd already on Aztec
    for (const q of crowdAtAztec) {
      const ax = S3 + q.gx * unit * 3.0 + Math.sin(t * 0.5 + q.ph) * 1.5;
      const ay = Y + q.gy * unit * 1.8 + Math.cos(t * 0.45 + q.ph) * 1.5;
      c.globalAlpha = q.b * (0.75 + 0.25 * Math.sin(t * 1.3 + q.ph * 3));
      c.fillStyle = '#fff'; c.fillRect(ax, ay, 1.4, 1.4);
    }
    // the batch: notes drift in from wallets on the left and settle into a disk at the gateway;
    // then it streams along the route at one pace, through the dark, and each note takes a seat in
    // the crowd on Aztec
    const R = unit * 2.1, rot = t * 0.06, dotK = Math.min(1, Math.max(0.6, unit / 14));
    const tighten = ease((e - CROSS.gather * 0.45) / (CROSS.gather * 0.55));
    if (formed > 0) {
      const hx = along(CROSS.lag * 0.35); // the batch's centre of mass, a little behind its head
      const halo = c.createRadialGradient(hx, Y, 0, hx, Y, R * 2.4);
      const a = 0.09 * formed * (1 - ease((e - CROSS.depart - CROSS.travel) / CROSS.settle));
      halo.addColorStop(0, `rgba(255,255,255,${a})`); halo.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = halo; c.beginPath(); c.arc(hx, Y, R * 2.4, 0, 6.2832); c.fill();
    }
    c.globalCompositeOperation = 'lighter';
    for (const o of notes) {
      const arr = easeOut((e - o.d * 6) / (CROSS.gather * 0.8));
      if (arr <= 0) continue;
      const lag = o.lag * CROSS.lag;
      const bx = along(lag);
      const done = (e - CROSS.depart - lag) / CROSS.travel;
      // on the way the batch is a comet: flatter, its trailing notes fainter
      const go = ease(done / 0.06) * (1 - ease((done - 0.94) / 0.06));
      const join = easeOut((e - CROSS.depart - lag - CROSS.travel) / CROSS.settle);
      const dx = o.r * R * Math.cos(o.th + rot) + o.jx * unit * 1.1 * (1 - tighten);
      const dy = (o.r * R * Math.sin(o.th + rot) + o.jy * unit * 1.1 * (1 - tighten)) * (1 - 0.45 * go) * (1 - 0.5 * go * o.lag);
      const seatX = S3 + o.tx * unit * 3.0 + Math.sin(t * 0.5 + o.ph) * 1.5;
      const seatY = Y + o.ty * unit * 1.8 + Math.cos(t * 0.45 + o.ph) * 1.5;
      const gx = lerp(bx + dx, seatX, join) + Math.sin(t * 0.9 + o.ph) * 0.8 * (1 - join);
      const gy = lerp(Y + dy, seatY, join) + Math.cos(t * 0.8 + o.ph * 1.3) * 0.8 * (1 - join);
      // the way in: a gentle curve from off-screen, levelling out onto the route
      const sx = -12 - o.sx * W * 0.12, sy = Y + o.sy * H * 0.28;
      const kx = lerp(sx, gx, 0.6), ky = lerp(sy, gy, 0.2), u = 1 - arr;
      const x = u * u * sx + 2 * u * arr * kx + arr * arr * gx;
      const y = u * u * sy + 2 * u * arr * ky + arr * arr * gy;
      const s = (2.0 + 1.4 * o.b) * dotK * (1 - 0.3 * join) * (1 - 0.35 * go * o.lag);
      c.globalAlpha = arr * lerp(o.b, 0.32, join) * (1 - 0.5 * go * o.lag);
      c.drawImage(spark, x - s / 2, y - s / 2, s, s);
    }
    c.globalCompositeOperation = 'source-over';
    // The dark itself, drawn over the notes so they vanish into it: a thin rim that brightens while
    // the batch is inside, around a black disk.
    const inside = ease((head - (S2 - Rb)) / Rb) * (1 - ease((last - (S2 + Rb)) / Rb));
    if (inside > 0) {
      const g = c.createRadialGradient(S2, Y, Rb, S2, Y, Rb * 1.9);
      g.addColorStop(0, `rgba(255,255,255,${0.14 * inside})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(S2, Y, Rb * 1.9, 0, 6.2832); c.fill();
    }
    c.fillStyle = '#000';
    c.beginPath(); c.arc(S2, Y, Rb, 0, 6.2832); c.fill();
    c.strokeStyle = `rgba(255,255,255,${0.2 + 0.55 * inside + (reached[1] ? 0.1 : 0)})`; c.lineWidth = 1;
    c.beginPath(); c.arc(S2, Y, Rb, 0, 6.2832); c.stroke();
    c.globalAlpha = 1;
    stationEls.forEach((el, k) => {
      el.classList.toggle('lit', reached[k]!);
      el.classList.toggle('on', k === active);
    });
  }

  // the crowd: dots fill a disk by themselves once arrived; no counts, no ratings
  const crowd = need<HTMLElement>(root, '#crowd');
  const kcv = need<HTMLCanvasElement>(root, '#crowd-canvas');
  const crowdLines = Array.from(crowd.querySelectorAll<HTMLElement>('.crowd-lines p'));
  let K: Surface | null = null;
  const born: Array<number | undefined> = [];
  const CROWD_N = 760, GOLDEN = Math.PI * (3 - Math.sqrt(5));
  function drawCrowd(e: number, t: number) {
    if (!K) return;
    const c = K.c, W = K.w, H = K.h;
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    const R = Math.min(W, H) * 0.42, cx = W / 2, cy = H / 2;
    const shown = Math.floor(ease(e / CROWD.grow) * CROWD_N);
    const cs = R / Math.sqrt(CROWD_N), dot = Math.max(0.9, cs * 0.24);
    for (let i = 0; i < CROWD_N; i++) {
      if (i >= shown) { born[i] = undefined; continue; }
      if (born[i] === undefined) born[i] = t;
      const age = reduce ? 10 : t - born[i]!;
      const r = cs * Math.sqrt(i + 0.5), th = i * GOLDEN + 0.02 * Math.sin(t * 0.3);
      const x = cx + r * Math.cos(th) + Math.sin(t * 0.7 + i) * 0.6;
      const y = cy + r * Math.sin(th) + Math.cos(t * 0.6 + i * 1.7) * 0.6;
      c.globalAlpha = Math.min(1, age / 0.5) * (0.55 + 0.35 * Math.max(0, 1 - age / 1.2) + 0.1 * Math.sin(t * 1.1 + i));
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(x, y, dot, 0, 6.2832); c.fill();
    }
    c.globalAlpha = 1;
    // then its two lines, one after the other; once said, they stay
    if (e >= CROWD.first && crowdLines[0]) playLine(crowdLines[0]);
    if (e >= CROWD.second && crowdLines[1]) playLine(crowdLines[1]);
  }

  function relayout() { C = fitCanvas(ccv); K = fitCanvas(kcv); }
  // A canvas follows its box on the frame the box changes: iOS Safari's toolbar changes the screen
  // (100dvh) while scrolling, and a stale bitmap would draw the crowd's disk as an oval until the
  // resize settled.
  const fresh = (s: Surface | null, cv: HTMLCanvasElement) => (s && s.w === cv.clientWidth && s.h === cv.clientHeight ? s : fitCanvas(cv));
  relayout();
  const tStart = performance.now();
  // The last frame of each story, shown at once with reduced motion.
  const CROSS_END = CROSS.depart + CROSS.lag + CROSS.travel + CROSS.settle + 1;
  const CROWD_END = CROWD.second + 1;
  /** A story has arrived once most of its screen is in view (the page rests on it). */
  function arrived(r: DOMRect, vh: number) {
    return r.height > 0 && (Math.min(vh, r.bottom) - Math.max(0, r.top)) / Math.min(r.height, vh) >= 0.6;
  }
  function storyFrame(now: number) {
    const t = (now - tStart) / 1000;
    const vh = window.innerHeight;
    const rc = crossing.getBoundingClientRect(), rk = crowd.getBoundingClientRect();
    if (story.crossing < 0 && !covered && arrived(rc, vh)) story.crossing = now;
    if (story.crowd < 0 && !covered && arrived(rk, vh)) story.crowd = now;
    const ec = story.crossing < 0 ? -1 : reduce ? CROSS_END : (now - story.crossing) / 1000;
    const ek = story.crowd < 0 ? -1 : reduce ? CROWD_END : (now - story.crowd) / 1000;
    // The sound follows the crossing (sound.ts): its bed deepens on the way, the answer comes near Aztec.
    crossing.dataset.progress = String(clamp01((ec - CROSS.depart) / CROSS.travel));
    if (rc.bottom > 0 && rc.top < vh) { C = fresh(C, ccv); drawCrossing(ec, reduce ? 0 : t); }
    if (rk.bottom > 0 && rk.top < vh) { K = fresh(K, kcv); drawCrowd(ek, reduce ? 10 : t); }
    updateTagline();
    updateDock();
    if (!reduce) frame(storyFrame);
  }
  frame(storyFrame);
  if (reduce) on(window, 'scroll', () => { frame(storyFrame); }, { passive: true });
  on(window, 'resize', debounce(() => { relayout(); if (reduce) frame(storyFrame); }, 120));

  // ---------- the cover ----------
  // The splash comes first and holds the page: no scrolling (wheel, touch, keys or scrollbar; the
  // rest of the page is inert) until the visitor enters. Entering is a press of "Enter the
  // darkness", a tap or click anywhere, or a key that would scroll (Space, Enter, Page Down, Arrow
  // Down, End); the first Tab lands on the word. The press starts the sound (sound-gate.ts) and
  // wakes the eclipse, which stays on screen; once it has swelled, "Scroll" comes with its line and
  // the page lets go. A link to a section opens past the cover.
  const html = document.documentElement;
  const holds = [root.querySelector<HTMLElement>('main'), root.querySelector<HTMLElement>('footer')];
  const enterCue = hero.querySelector<HTMLButtonElement>('[data-enter]');
  const scrollCue = hero.querySelector<HTMLAnchorElement>('[data-scroll]');
  const ENTER_KEYS = new Set([' ', 'Spacebar', 'Enter', 'PageDown', 'ArrowDown', 'End']);
  const STILL_KEYS = new Set(['PageUp', 'ArrowUp', 'Home']);
  let covered = false, entered = false, scrollShown = false;
  function cover(on: boolean) {
    covered = on;
    html.classList.toggle('covered', on);
    for (const el of holds) if (el) el.inert = on;
  }
  function hashTarget(): HTMLElement | null {
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
    const el = id ? document.getElementById(id) : null;
    return el && root.contains(el) && !hero.contains(el) ? el : null;
  }
  // "Enter the darkness" fades as it is pressed (at once when the page opens past the cover).
  function leaveCue(instant: boolean) {
    if (!enterCue || enterCue.classList.contains('gone')) return;
    enterCue.classList.add('gone');
    if (instant) enterCue.classList.add('now');
    enterCue.tabIndex = -1;
    enterCue.setAttribute('aria-hidden', 'true');
  }
  // "Scroll" comes with its line, and the page lets go.
  function showScroll(instant: boolean) {
    if (scrollShown) return;
    scrollShown = true;
    cover(false);
    if (!scrollCue) return;
    if (instant) scrollCue.classList.add('now');
    scrollCue.classList.add('shown');
    scrollCue.removeAttribute('tabindex');
    scrollCue.removeAttribute('aria-hidden');
    const a = document.activeElement;
    if (a === enterCue || a === document.body || a === null) scrollCue.focus({ preventScroll: true });
  }
  function enter(press: boolean, cue = false) {
    if (entered) return;
    entered = true;
    // A press is told inside the gesture, so the sound may start (sound-gate.ts; a press of the
    // cue itself always starts it); opening past the cover is told once every part of the page
    // is listening.
    const tell = () => root.dispatchEvent(new CustomEvent<EnterDetail>(ENTER_EVENT, { detail: { press, cue } }));
    if (!press) {
      leaveCue(true);
      showScroll(true);
      queueMicrotask(() => { if (!stopped) tell(); });
      return;
    }
    tell();
    pressedAt = performance.now();
    leaveCue(false);
    // With reduced motion (or no eclipse to watch) the page lets go at once.
    if (reduce || !hasGL) { draw(performance.now()); showScroll(false); return; }
    const id = setTimeout(() => { timers.delete(id); showScroll(false); }, WAKE.scroll[0] * 1000);
    timers.add(id);
  }
  const held = (e: Event) => { if (covered) e.preventDefault(); };
  on(window, 'wheel', held, { passive: false });
  on(window, 'touchmove', held, { passive: false });
  on(window, 'click', (e) => {
    if (!covered) return;
    if (e.target instanceof Element && e.target.closest('a')) e.preventDefault();
    enter(true, !!enterCue && e.target instanceof Node && enterCue.contains(e.target));
  });
  on(window, 'keydown', (e) => {
    if (!covered || e.metaKey || e.ctrlKey || e.altKey) return;
    if (STILL_KEYS.has(e.key)) { e.preventDefault(); return; }
    if (!ENTER_KEYS.has(e.key)) return;
    e.preventDefault();
    enter(true, !!enterCue && document.activeElement === enterCue && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar'));
  });
  // A section's link, then or later (back and forward through hashes), opens past the cover,
  // even while the eclipse is still waking.
  on(window, 'hashchange', () => {
    const el = hashTarget();
    if (!el || !covered) return;
    enter(false);
    leaveCue(true);
    showScroll(true);
    el.scrollIntoView();
  });
  // Coming back through the history: the cover always shows the splash.
  on(window, 'pageshow', () => { if (covered) window.scrollTo(0, 0); });
  try { history.scrollRestoration = 'manual'; } catch { /* older browsers */ }
  {
    const el = hashTarget();
    if (el) { enter(false); el.scrollIntoView(); }
    else { window.scrollTo(0, 0); cover(true); }
  }

  // ---------- the docked way in ----------
  // When the tagline's "Open the app" scrolls up to the top it hands over to its fixed twin at the
  // same place, which stays through every section after; it dims while a title passes under it.
  const dock = root.querySelector<HTMLAnchorElement>('[data-dock]');
  const enterLink = tagline.querySelector<HTMLElement>('.enter');
  const titles = Array.from(root.querySelectorAll<HTMLElement>('.tagline .bridge-line, .tagline > span, .stage-head .label, .stage-head h2, .crowd-lines p, .verify .route, .verify h2, .verify p, footer .mark'));
  let docked = false, under = false;
  function updateDock() {
    if (!dock || !enterLink) return;
    const d = dock.getBoundingClientRect();
    const now = !covered && enterLink.getBoundingClientRect().top <= d.top + 6;
    if (now !== docked) {
      docked = now;
      dock.classList.add('snap');
      dock.classList.toggle('on', now);
      enterLink.classList.toggle('docked', now);
      void dock.offsetWidth;
      dock.classList.remove('snap');
    }
    const u = now && titles.some((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > d.top - 6 && r.top < d.bottom + 6; });
    if (u !== under) { under = u; dock.classList.toggle('under', u); }
  }
  if (reduce) on(window, 'resize', debounce(updateDock, 120));

  // ---------- lines that emerge from the dark ----------
  // A few lines come out of the dark (emerge.ts): `view` once when scrolled in, `lit` once when
  // the tagline lights, `play` when its story says (the crowd's two lines, drawCrowd). With reduced
  // motion each line fades in whole, and a `play` line is simply there (the story's last frame).
  const emergeCancels = new Set<() => void>();
  const observers: Array<{ disconnect(): void }> = [];
  const played = new WeakSet<HTMLElement>();
  function playLine(el: HTMLElement) {
    if (played.has(el) || stopped) return;
    played.add(el);
    if (reduce) el.classList.remove('em-hold');
    else emergeCancels.add(emerge(el, reduce));
  }
  {
    const run = (el: HTMLElement) => { if (!stopped) emergeCancels.add(emerge(el, reduce)); };
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-emerge]'));
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        run(e.target as HTMLElement);
      }
    }, { threshold: 0.35 });
    observers.push(io);
    for (const el of els.filter((x) => x.dataset.emerge === 'view')) { holdForEmerge(el); io.observe(el); }
    for (const el of els.filter((x) => x.dataset.emerge === 'lit')) {
      holdForEmerge(el);
      const holder = el.closest<HTMLElement>('.tagline') ?? el;
      const mo = new MutationObserver(() => {
        if (!holder.classList.contains('lit')) return;
        mo.disconnect();
        run(el);
      });
      mo.observe(holder, { attributes: true, attributeFilter: ['class'] });
      observers.push(mo);
    }
    // Held unseen until their story plays them; with reduced motion they are there from the start.
    for (const el of els.filter((x) => x.dataset.emerge === 'play')) if (!reduce) holdForEmerge(el);
  }

  return () => {
    stopped = true;
    cover(false);
    for (const id of frames) cancelAnimationFrame(id);
    for (const id of timers) clearTimeout(id);
    for (const off of offs) off();
    for (const o of observers) o.disconnect();
    for (const cancel of emergeCancels) cancel();
    for (const el of root.querySelectorAll<HTMLElement>('[data-emerge].em-hold')) el.classList.remove('em-hold');
    const g = gl as WebGLRenderingContext | null;
    if (g) { g.deleteBuffer(buf); g.deleteProgram(prog); }
  };
}
