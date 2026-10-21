/**
 * The tunnel (the bridge screen's picture, approved by the owner on 2026-10-16): rings of grain
 * seen head-on in real perspective, the black disk further down, and the far ring beyond it. From
 * the mouth the rings read as the corona around the disk; each stage of a crossing flies the camera
 * through them. Ported from the approved prototype (Tunnel mode: the shaders, the particle look,
 * `values()` and `drawFx`), with the eclipse mode and the simulation removed: the app tells the
 * scene where the journey is (src/lib/tunnel.ts), and the scene only draws it.
 *
 * Every grain of light is one WebGL point whose motion runs in the vertex shader, so the CPU does
 * nothing per point per frame. A 2D canvas on top draws the notes as points of light, the crowd,
 * the far side and the diamond-ring flash. Without WebGL the rings are drawn in 2D instead. With
 * `prefers-reduced-motion` every ramp is a step (a state change, never a flight) and a frame is
 * drawn only when something changes. Nothing draws while the tab is hidden.
 */

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** The user's notes sit just outside the limb, on the corona. */
const SEAT = 1.1;
/** World units; every ring has radius 1. Four rings near the mouth, the disk, the far ring. */
export const TUN = { gap: 0.9, zd: 6.0, zf: 15.5, fr: 0.55, mouth: -2.0, arrive: 10.6 };

export type Hold = "amount" | "decide" | "wait" | "transit" | "arrived" | "claim" | "claimed" | "outwait" | "out";
type Flight = "send" | "cross" | "ring" | "arrive" | "moveout" | "back";
export type Visual = Hold | Flight;

const DUR_FULL: Record<Flight, number> = { send: 2.0, cross: 2.4, ring: 1.8, arrive: 2.8, moveout: 2.8, back: 1.6 };
const DUR_REDUCED: Record<Flight, number> = { send: 0.9, cross: 1.2, ring: 1.6, arrive: 1.0, moveout: 1.2, back: 0.6 };
const FLIGHTS = new Set<Visual>(["send", "cross", "ring", "arrive", "moveout", "back"]);

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
const easeOut = (x: number) => {
  x = clamp01(x);
  return 1 - (1 - x) * (1 - x) * (1 - x);
};
const easeIn = (x: number) => {
  x = clamp01(x);
  return x * x;
};
const inOut = (x: number) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function quad(p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number, t: number): [number, number] {
  const u = 1 - t;
  return [u * u * p0x + 2 * u * t * p1x + t * t * p2x, u * u * p0y + 2 * u * t * p1y + t * t * p2y];
}

// ---------------------------------------------------------------- layout

export interface Geometry {
  W: number;
  H: number;
  wide: boolean;
  /** Centre of the disk, its radius (CSS px), and the focal length that puts it exactly R from the mouth. */
  cx: number;
  cy: number;
  R: number;
  F: number;
  /** Top of the words under the disk. */
  lineY: number;
  /**
   * Before the crossing (the choice, the open batch) the camera nears the disk and its ring grows
   * past `lineY`: there the words start at `nearY`, under the ring's edge, and the camera stops at
   * `camNear` so the edge stays above them on any screen.
   */
  nearY: number;
  camNear: number;
}

/**
 * The camera before the crossing: the choice holds at `cam` and drifts `drift` closer; the open
 * batch starts at `cam` and creeps `fill` closer as it fills.
 */
/** How fast the ambient motion runs while the tunnel holds (no flight): about a third. */
const CALM = 0.35;

export const NEAR = { cam: 1.0, drift: 0.2, fill: 0.75 };

/**
 * Where the disk sits: centred, at 46% of the height on a wide screen and 38% on a phone (the
 * owner moved it down from the first prototype; it never sits higher than that while there is
 * room), below whatever is above the screen (`top`: the header and any notice), with room for the
 * words above `bottom` (the footer). Short of room, the disk first gets smaller (down to 72% of
 * its size), and only then moves up.
 */
export function tunnelLayout(W: number, H: number, top: number, bottom: number): Geometry {
  const wide = W >= 760 && W / H >= 1.15;
  const below = wide ? 1.42 : 1.62; // the words start this many radii under the centre, where there is room
  const gap = 1.12; // and never closer than this: just under the disk's edge
  const words = WORDS(wide); // what the lines, the destination and the words need under that (px)
  const approved = wide ? H * 0.46 : H * 0.38;
  const R0 = wide ? Math.min(H * 0.24, W * 0.15) : Math.min(W * 0.32, H * 0.165);
  const fitAt = (cy: number) => (bottom - words - cy) / gap;
  let R = Math.min(R0, Math.max(0.72 * R0, fitAt(Math.max(approved, top + 1.18 * R0))));
  R = Math.max(44, Math.min(R, (bottom - top - words) / (1.18 + gap)));
  let cy = Math.max(approved, top + 1.18 * R);
  cy = Math.max(top + 1.18 * R, Math.min(cy, bottom - words - gap * R));
  const lineY = Math.max(cy + gap * R, Math.min(cy + below * R, bottom - words));
  // Nearer the disk, its edge (`gap` disk radii, as at the mouth) is seen this far from the centre.
  const F = R * (TUN.zd - TUN.mouth);
  const pad = 14;
  const nearY = Math.max(lineY, Math.min(cy + edgeAt({ F }, NEAR.cam + NEAR.drift) + pad, bottom - NEAR_WORDS(wide)));
  const camNear = Math.max(TUN.mouth, TUN.zd - (F * gap) / Math.max(1, nearY - pad - cy));
  return { W, H, wide, cx: W / 2, cy, R, F, lineY, nearY, camNear };
}

/**
 * Room the words under the disk need (px): two lines, the destination (each with its time, and one
 * line on what the chosen one means) and one row of words.
 */
export const WORDS = (wide: boolean) => (wide ? 150 : 208);
/** Before the crossing: two lines and the choice (two rows of words on a phone). */
export const NEAR_WORDS = (wide: boolean) => (wide ? 104 : 136);
/** How far from the centre the disk's edge is seen with the camera at `cam` (px). */
export const edgeAt = (g: Pick<Geometry, "F">, cam: number) => (g.F * 1.12) / (TUN.zd - cam);

// ---------------------------------------------------------------- shaders

// The tunnel: rings of grain seen head-on, in real perspective (the approved prototype's shader).
const VS = `
attribute vec4 aA; attribute vec4 aB;
uniform vec2 uRes; uniform vec2 uC;
uniform float uFoc; uniform float uCam; uniform float uT; uniform float uDpr;
uniform float uLight; uniform float uFar; uniform float uSpeed;
uniform float uZD; uniform float uZF; uniform float uFR; uniform float uGap;
varying float vA;
const float TAU = 6.2831853;
void main() {
  float kind = aA.x; float t = uT;
  float breathe = 0.88 + 0.12 * sin(t * 0.42);
  vec3 w = vec3(0.0); float a = aB.z; bool occ = true; bool front = false;
  if (kind < 1.5) {
    float k = aA.y; bool disk = k > 3.5;
    float th0 = aA.z * TAU + t * 0.012 * (mod(k, 2.0) * 2.0 - 1.0);
    float r;
    if (kind < 0.5) {
      r = 1.0 + aA.w * 0.012;
      a *= (0.55 + 0.45 * sin(t * (0.7 + aB.x * 2.6) + aA.z * 157.0)) * breathe * (disk ? 1.5 : 0.62);
    } else {
      float u = fract(aB.x + t * aB.y);
      float rn = fract(aA.z * 7919.0);
      float streak = 0.55 + 0.45 * sin(th0 * 9.0 + k * 1.7 + t * 0.11) * sin(th0 * 4.0 - t * 0.07 + 1.3 + k);
      float reach = disk ? (0.22 + 0.62 * rn) : (0.06 + 0.16 * rn);
      r = 1.0 + pow(u, 1.45) * reach * (0.7 + 0.6 * streak);
      th0 += (aA.w - 0.5) * 0.2 * u;
      a *= (1.0 - u) * (1.0 - u) * (0.3 + 0.7 * streak) * breathe * (disk ? 1.15 : 0.5);
    }
    w = vec3(cos(th0) * r, sin(th0) * r, disk ? uZD : 0.6 + k * uGap);
    if (disk) occ = false;
    a *= uLight;
  } else if (kind < 2.5) {
    w = aA.yzw; front = true;
    a *= uLight * (0.25 + 0.75 * uSpeed);
  } else if (kind < 3.5) {
    float th = aA.y * TAU;
    float r = (1.0 + aA.z * 0.03) * uFR;
    w = vec3(cos(th) * r, sin(th) * r, uZF);
    a *= (0.6 + 0.4 * sin(t * (0.5 + aA.w * 2.0) + aA.y * 97.0)) * uFar;
  } else if (kind < 4.5) {
    float u = fract(aB.x + t * aB.y);
    float th0 = aA.y * TAU;
    float streak = 0.55 + 0.45 * sin(th0 * 7.0 + t * 0.09) * sin(th0 * 3.0 - t * 0.05 + 0.4);
    float r = (1.0 + pow(u, 1.4) * (0.25 + 0.6 * aA.z) * (0.7 + 0.6 * streak)) * uFR;
    th0 += (aA.w - 0.5) * 0.2 * u;
    w = vec3(cos(th0) * r, sin(th0) * r, uZF);
    a *= (1.0 - u) * (1.0 - u) * (0.3 + 0.7 * streak) * uFar;
  } else {
    float th = aA.y * TAU; float r = (0.7 + pow(aA.z, 0.8) * 3.0) * uFR;
    w = vec3(cos(th) * r, sin(th) * r, uZF + 0.5);
    a *= pow(1.0 - aA.z, 2.2) * uFar * (0.6 + 0.4 * sin(t * 0.5 + aA.w * 60.0));
  }
  float dz = w.z - uCam;
  if (dz < 0.03 || a < 0.004) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  if (uCam < uZD) {
    float dd = uZD - uCam;
    float k = length(w.xy) * dd / dz;
    if ((occ && w.z > uZD + 0.001 && k < 1.0) || (front && k < 1.06)) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
  }
  a *= smoothstep(0.03, 0.75, dz);
  vec2 sc = uC + w.xy * (uFoc / dz);
  vec2 cl = sc / uRes * 2.0 - 1.0;
  gl_Position = vec4(cl.x, -cl.y, 0.0, 1.0);
  gl_PointSize = aB.w * uDpr * clamp(0.75 + 1.3 / dz, 0.85, 2.6);
  vA = clamp(a, 0.0, 1.0);
}`;
const FS = "precision mediump float; varying float vA; void main() { gl_FragColor = vec4(1.0, 1.0, 1.0, vA); }";
const UNIFORMS = ["uRes", "uC", "uFoc", "uCam", "uT", "uDpr", "uLight", "uFar", "uSpeed", "uZD", "uZF", "uFR", "uGap"] as const;

/**
 * Every grain, as two vec4 attributes (the prototype's layout). `scale` is the budget: about 110k
 * points at 1, kept lower on phones and small machines.
 */
function particles(scale: number): { data: Float32Array; n: number } {
  const r = mulberry32(20261016);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * r());
  };
  const s = scale;
  const limbN = Math.round(5200 * s), corN = Math.round(7000 * s), diskCorN = Math.round(34000 * s);
  const dustN = 1400, farLimbN = Math.round(3200 * s), farCorN = Math.round(9000 * s), glowN = Math.round(14000 * s);
  const n = 5 * limbN + 4 * corN + diskCorN + dustN + farLimbN + farCorN + glowN;
  const d = new Float32Array(n * 8);
  let o = 0;
  const put = (a0: number, a1: number, a2: number, a3: number, b0: number, b1: number, b2: number, b3: number) => {
    d[o++] = a0; d[o++] = a1; d[o++] = a2; d[o++] = a3; d[o++] = b0; d[o++] = b1; d[o++] = b2; d[o++] = b3;
  };
  for (let k = 0; k < 5; k++) {
    for (let j = 0; j < limbN; j++) put(0, k, r(), gauss(), r(), 0, 0.4 + 0.55 * r(), 1 + 0.6 * r());
    const cn = k === 4 ? diskCorN : corN;
    for (let j = 0; j < cn; j++) put(1, k, r(), r(), r(), 0.02 + 0.05 * r(), 0.3 + 0.55 * r(), 1 + 0.7 * r());
  }
  for (let j = 0; j < dustN; j++) {
    const th = r() * TAU, rad = 0.35 + 1.3 * Math.sqrt(r());
    put(2, Math.cos(th) * rad, Math.sin(th) * rad, TUN.mouth - 0.5 + r() * (TUN.zd - TUN.mouth + 0.3), 0, 0, 0.08 + 0.3 * r(), 1 + 0.6 * r());
  }
  for (let j = 0; j < farLimbN; j++) put(3, r(), Math.abs(gauss()), r(), 0, 0, 0.4 + 0.55 * r(), 1 + 0.5 * r());
  for (let j = 0; j < farCorN; j++) put(4, r(), r(), r(), r(), 0.03 + 0.06 * r(), 0.3 + 0.5 * r(), 1 + 0.6 * r());
  for (let j = 0; j < glowN; j++) put(5, r(), r(), r(), 0, 0, 0.12 + 0.35 * r(), 1 + 0.6 * r());
  return { data: d, n };
}

// ---------------------------------------------------------------- the scene

/** How bright every part is and where the camera stands, for the current stage and time. */
interface Values {
  cam: number;
  light: number;
  far: number;
  gather: number;
  flash: number;
  bead: number;
  speed: number;
}

interface Mine {
  key: string;
  s: number;
  x: number;
  y: number;
  a: number;
  sz: number;
  dead: boolean;
  i: number;
  th: number;
}
interface Other {
  s: number;
  ang: number;
  jr: number;
  bend: number;
  dir: number;
  /** Scene time it joined; -Infinity when it was there already. */
  at: number;
}
interface FarPoint {
  s: number;
  ang0: number;
  ang1: number;
  rad: number;
  inc: boolean;
  i: number;
}

export interface FarRing {
  x: number;
  y: number;
  r: number;
  vis: boolean;
}

export interface SceneOptions {
  gl: HTMLCanvasElement;
  fx: HTMLCanvasElement;
  reduced: boolean;
  /** `crossing` as the light goes into the disk, `arrival` at the diamond-ring flash. */
  onCue?: (cue: "crossing" | "arrival") => void;
  /** Every frame: where the far ring is (the balance and the claim target follow it). */
  onFar?: (ring: FarRing) => void;
}

export class TunnelScene {
  readonly reduced: boolean;
  private gl: WebGLRenderingContext | null = null;
  private prog?: { p: WebGLProgram; U: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>; buf: WebGLBuffer; n: number; la: number; lb: number };
  private fx: CanvasRenderingContext2D;
  private spark: HTMLCanvasElement;
  private G: Geometry = tunnelLayout(390, 844, 0, 844);
  private dpr = 1;
  private builtFor = "";
  private glCanvas: HTMLCanvasElement;
  private fxCanvas: HTMLCanvasElement;
  private opts: SceneOptions;
  private dur: Record<Flight, number>;

  private t = 0;
  /**
   * Ambient time: the grain's twinkle, the slow drift and the notes' turn. It runs at full speed
   * during a flight and at `CALM` of it while the tunnel holds, so the screen is still at rest.
   */
  private ta = 0;
  private pace = CALM;
  private stage: Visual = "amount";
  private st = 0;
  private target: Hold = "amount";
  private queue: Visual[] = [];
  private fresh = true;
  private from = { cam: TUN.mouth, far: 0 };
  private fill = 0;
  private fillS = 0;
  private hover = false;
  private V: Values = { cam: TUN.mouth, light: 1, far: 0, gather: 0, flash: 0, bead: 0, speed: 0 };
  private lastCam = TUN.mouth;
  private rot = 0;

  private mine: Mine[] = [];
  private others = new Map<string, Other>();
  private seat = 0;
  private far: FarPoint[] = [];
  private farKey = "";

  private raf = 0;
  private last = 0;
  private running = false;
  private paused = false;
  private dirtyUntil = 0;
  private lastDraw = 0;
  private disposed = false;

  constructor(opts: SceneOptions) {
    this.opts = opts;
    this.reduced = opts.reduced;
    this.dur = opts.reduced ? DUR_REDUCED : DUR_FULL;
    this.glCanvas = opts.gl;
    this.fxCanvas = opts.fx;
    this.fx = opts.fx.getContext("2d")!;
    this.spark = document.createElement("canvas");
    this.spark.width = this.spark.height = 64;
    const c = this.spark.getContext("2d")!;
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(255,255,255,0.85)");
    g.addColorStop(0.5, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    this.initGL();
    opts.gl.addEventListener("webglcontextlost", this.onLost);
    opts.gl.addEventListener("webglcontextrestored", this.onRestored);
  }

  /** Whether the WebGL rings are drawn (else the 2D fallback). */
  get hasGL(): boolean {
    return !!this.gl;
  }

  /** The stage on screen, and whether it has settled (no flight running or queued). */
  /** Where the scene is; `ringBottom` is the lowest point of the disk's edge on screen (px, before the disk is passed). */
  get state(): { visual: Visual; hold: Hold; settled: boolean; cam: number; ringBottom?: number } {
    const ringBottom = this.V.cam < TUN.zd - 0.05 ? Math.round(this.G.cy + edgeAt(this.G, this.V.cam)) : undefined;
    return { visual: this.stage, hold: this.target, settled: !FLIGHTS.has(this.stage) && this.queue.length === 0, cam: Math.round(this.V.cam * 100) / 100, ringBottom };
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.gl = null;
    this.prog = undefined;
    this.invalidate();
  };
  private onRestored = () => {
    this.builtFor = "";
    this.initGL();
    this.layout(this.G.W, this.G.H, 0, 0, this.G);
  };

  private initGL() {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = this.glCanvas.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: false, powerPreference: "high-performance" });
    } catch {
      gl = null;
    }
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(s) || "shader");
      return s;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
      const U = Object.fromEntries(UNIFORMS.map((n) => [n, gl!.getUniformLocation(p, n)])) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
      this.prog = { p, U, buf: gl.createBuffer()!, n: 0, la: gl.getAttribLocation(p, "aA"), lb: gl.getAttribLocation(p, "aB") };
    } catch (e) {
      console.warn("tunnel shader", e);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    this.gl = gl;
  }

  /** Sizes the canvases to the viewport and places the disk (see `tunnelLayout`). */
  layout(W: number, H: number, top: number, bottom: number, given?: Geometry) {
    this.G = given ?? tunnelLayout(W, H, top, bottom);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(W * this.dpr), h = Math.round(H * this.dpr);
    if (this.fxCanvas.width !== w || this.fxCanvas.height !== h) {
      this.fxCanvas.width = w;
      this.fxCanvas.height = h;
    }
    const gl = this.gl;
    if (gl && this.prog) {
      if (this.glCanvas.width !== w || this.glCanvas.height !== h) {
        this.glCanvas.width = w;
        this.glCanvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      // The budget: grains scale with the disk's size in device pixels, lower on phones and on
      // machines with few cores.
      const cores = navigator.hardwareConcurrency || 8;
      let s = Math.max(0.55, Math.min(1.25, (this.G.R * this.dpr) / 260));
      if (!this.G.wide) s = Math.min(s, 0.8);
      if (cores <= 4) s = Math.min(s, 0.7);
      const key = `${s.toFixed(2)}`;
      if (key !== this.builtFor) {
        this.builtFor = key;
        const p = particles(s);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.prog.buf);
        gl.bufferData(gl.ARRAY_BUFFER, p.data, gl.STATIC_DRAW);
        this.prog.n = p.n;
      }
    }
    for (const m of this.mine) m.x = NaN;
    this.invalidate();
  }

  get geometry(): Geometry {
    return this.G;
  }

  /**
   * Moves the journey to `target`. Live (`animate`), it flies there through the stages in between
   * (into the disk, the diamond ring, the arrival, the way back); the first call, or a jump the
   * journey never makes forwards, just shows the stage.
   */
  hold(target: Hold, animate: boolean) {
    if (target === this.target && !this.fresh) return;
    const prev = this.target;
    this.target = target;
    if (this.fresh || !animate) {
      this.fresh = false;
      this.queue = [];
      this.enter(target, true);
      return;
    }
    const path = flightPath(prev, target);
    this.queue = [...path, target];
    if (!FLIGHTS.has(this.stage)) this.advance();
    this.invalidate();
  }

  /** How full the batch the journey waits for is (0..1): the camera creeps towards the disk as it fills. */
  setFill(f: number) {
    const v = clamp01(f);
    if (v !== this.fill) {
      this.fill = v;
      this.invalidate();
    }
  }

  setHover(on: boolean) {
    if (on !== this.hover) {
      this.hover = on;
      this.invalidate();
    }
  }

  /** The user's notes as points of light (`d` names the size, `s` the sprite size in px). Typing moves points, never redraws them. */
  setMine(notes: { d: string; s: number }[]) {
    const want = new Map<string, number>();
    const counts: Record<string, number> = {};
    for (const n of notes) {
      counts[n.d] = (counts[n.d] ?? 0) + 1;
      want.set(`${n.d}:${counts[n.d]}`, n.s);
    }
    let changed = false;
    for (const m of this.mine) {
      const dead = !want.has(m.key);
      if (dead !== m.dead) changed = true;
      m.dead = dead;
    }
    for (const [key, s] of want) {
      if (!this.mine.some((m) => m.key === key)) {
        this.mine.push({ key, s, x: NaN, y: NaN, a: 0, sz: 0, dead: false, i: 0, th: 0 });
        changed = true;
      }
    }
    const alive = this.mine.filter((m) => !m.dead).sort((p, q) => q.s - p.s || +p.key.split(":")[1]! - +q.key.split(":")[1]!);
    alive.forEach((m, i) => {
      m.i = i;
      m.th = -Math.PI / 2 + (i * TAU) / alive.length;
    });
    if (changed) this.invalidate();
  }

  /**
   * Other people's notes in the batch, one entry each (keys stay the same while they wait). New
   * keys fly in from the dark, as real deposits arrive; on the first call they are simply there.
   */
  setOthers(list: { key: string; s: number }[], arriving: boolean) {
    const keys = new Set(list.map((o) => o.key));
    let changed = false;
    for (const k of [...this.others.keys()]) {
      if (!keys.has(k)) {
        this.others.delete(k);
        changed = true;
      }
    }
    for (const o of list) {
      if (this.others.has(o.key)) continue;
      const r = mulberry32(hash(o.key));
      this.others.set(o.key, { s: o.s, ang: 0.35 + this.seat++ * GOLDEN, jr: r() * 2 - 1, bend: r() < 0.5 ? -1 : 1, dir: r() * TAU, at: arriving ? this.t : -Infinity });
      changed = true;
    }
    if (changed) this.invalidate(arriving ? 2 : 0);
  }

  /** The far side: `crowd` crossed before, `batch` crossed with the journey (sprite sizes). */
  setFar(crowd: number[], batch: number[]) {
    const key = `${crowd.join(",")}|${batch.join(",")}`;
    if (key === this.farKey) return;
    this.farKey = key;
    const r = mulberry32(1717);
    const pt = (s: number, ang: number, inc: boolean, i: number): FarPoint => ({ s, ang0: ang, ang1: ang + (r() - 0.5) * 2.8, rad: 0.88 + r() * 0.26, inc, i });
    this.far = [...crowd.map((s, i) => pt(s, i * GOLDEN + r() * 0.3, false, 0)), ...batch.map((s, i) => pt(s, r() * TAU, true, i))];
    this.invalidate();
  }

  private enter(next: Visual, settled: boolean) {
    const V = this.V;
    this.from = { cam: V.cam, far: V.far };
    if (next === "send") this.rot = 0;
    if (next === "cross") this.opts.onCue?.("crossing");
    if (next === "ring") this.opts.onCue?.("arrival");
    this.stage = next;
    this.st = settled ? 100 : 0;
    if (settled && next === "wait") this.fillS = this.fill;
    this.invalidate();
  }

  private advance() {
    const next = this.queue.shift();
    if (next) this.enter(next, false);
  }

  private tick() {
    if (FLIGHTS.has(this.stage) && this.st >= this.dur[this.stage as Flight]) this.advance();
  }

  // ---------------------------------------------------------------- values

  private values(dt: number): Values {
    const st = this.st, s = this.stage, RM = this.reduced, t = this.ta;
    const E = RM ? (x: number) => (x > 0 ? 1 : 0) : smooth;
    const v: Values = { cam: TUN.mouth, light: 1, far: 0, gather: 0, flash: 0, bead: 0, speed: 0 };
    const drift = (a: number, w: number) => (RM ? 0 : a * Math.sin(t * w));
    switch (s) {
      case "amount":
      case "out":
      case "outwait":
        v.cam = TUN.mouth + drift(0.03, 0.35);
        if (s !== "amount") v.far = 0.5;
        break;
      case "send":
        v.cam = lerp(this.from.cam, Math.min(NEAR.cam, this.G.camNear), RM ? 1 : inOut(st / 1.9));
        v.light = lerp(1, 0.85, E(st / 1.6));
        break;
      case "decide":
        v.cam = lerp(this.from.cam, Math.min(this.G.camNear, NEAR.cam + (RM ? 0 : Math.min(NEAR.drift, st * 0.012))), RM ? 1 : smooth(st / 1.2));
        v.light = 0.85;
        break;
      case "wait": {
        // The camera creeps towards the disk as the real batch fills; nothing moves on its own.
        this.fillS = RM ? this.fill : this.fillS + (this.fill - this.fillS) * (1 - Math.exp(-dt * 1.4));
        // It stops short of the words under the ring (Geometry.camNear).
        const lo = Math.min(NEAR.cam, this.G.camNear), hi = Math.min(NEAR.cam + NEAR.fill, this.G.camNear);
        v.cam = lerp(this.from.cam, lo + (hi - lo) * this.fillS, RM ? 1 : smooth(st / 1.6));
        v.light = 0.85;
        break;
      }
      case "cross":
        v.cam = lerp(this.from.cam, TUN.zd + 0.1, RM ? 1 : inOut(st / 2.3));
        v.light = 0.85 * (1 - E((st - 0.5) / 1.7));
        break;
      case "transit":
        // Totality: the disk passed, the far ring faint ahead while the batch crosses.
        v.cam = TUN.zd + 0.1;
        v.light = 0;
        v.far = 0.14 * E(st / 2.0);
        break;
      case "ring": {
        v.cam = lerp(TUN.zd + 0.1, TUN.zd + 0.6, RM ? 1 : easeOut(st / 1.8));
        const up = E((st - 0.5) / 0.35), down = RM ? 0 : smooth((st - 0.95) / 0.85);
        v.flash = up * (1 - 0.75 * down);
        v.bead = up * (1 - 0.45 * down);
        v.light = 0;
        v.far = lerp(this.from.far, 0.35, up);
        break;
      }
      case "arrive":
        v.cam = lerp(TUN.zd + 0.6, TUN.arrive, RM ? 1 : easeOut(st / 2.6));
        v.flash = 0.25 * (1 - E(st / 0.8));
        v.bead = 0.55 * (1 - E(st / 0.7));
        v.light = 0;
        v.far = lerp(0.35, 1, E(st / 2.0));
        break;
      case "arrived":
      case "claim":
      case "claimed":
        v.cam = TUN.arrive + drift(0.04, 0.3);
        v.light = 0;
        v.far = 1;
        if (s === "arrived" && this.hover) v.far += 0.3;
        if (s === "claim") {
          v.gather = E(st / 1.3);
          v.far = 1 + 0.4 * Math.sin(Math.PI * clamp01(st / 1.8));
        } else if (s === "claimed") v.gather = 1;
        break;
      case "moveout":
        v.cam = lerp(this.from.cam, TUN.mouth, RM ? 1 : inOut(st / 2.6));
        v.far = lerp(1, 0.5, E(st / 1.5));
        v.light = E((st - 0.9) / 1.4);
        v.gather = 1 - E(st / 0.8);
        break;
      case "back":
        v.cam = lerp(this.from.cam, TUN.mouth, RM ? 1 : inOut(st / 1.5));
        v.far = lerp(this.from.far, 0, E(st / 1.0));
        v.light = this.from.cam > TUN.zd ? E((st - 0.5) / 1.0) : 1;
        break;
    }
    v.speed = RM ? 0 : clamp01(Math.abs(v.cam - this.lastCam) / Math.max(dt, 1e-3) / 2.5);
    this.lastCam = v.cam;
    return v;
  }

  private farRing(V: Values): FarRing {
    const dz = Math.max(0.25, TUN.zf - V.cam);
    return { x: this.G.cx, y: this.G.cy, r: (this.G.F * TUN.fr) / dz, vis: V.cam > TUN.zd - 0.005 };
  }

  // ---------------------------------------------------------------- drawing

  private drawGL(V: Values) {
    const gl = this.gl, P = this.prog;
    if (!gl || !P) return;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(P.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, P.buf);
    gl.enableVertexAttribArray(P.la);
    gl.vertexAttribPointer(P.la, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(P.lb);
    gl.vertexAttribPointer(P.lb, 4, gl.FLOAT, false, 32, 16);
    const U = P.U, d = this.dpr;
    gl.uniform2f(U.uRes, this.glCanvas.width, this.glCanvas.height);
    gl.uniform2f(U.uC, this.G.cx * d, this.G.cy * d);
    gl.uniform1f(U.uT, this.reduced ? 6.0 : this.ta);
    gl.uniform1f(U.uDpr, d);
    gl.uniform1f(U.uFoc, this.G.F * d);
    gl.uniform1f(U.uCam, V.cam);
    gl.uniform1f(U.uLight, V.light);
    gl.uniform1f(U.uFar, V.far);
    gl.uniform1f(U.uSpeed, V.speed);
    gl.uniform1f(U.uZD, TUN.zd);
    gl.uniform1f(U.uZF, TUN.zf);
    gl.uniform1f(U.uFR, TUN.fr);
    gl.uniform1f(U.uGap, TUN.gap);
    gl.drawArrays(gl.POINTS, 0, P.n);
  }

  private dot(x: number, y: number, s: number, a: number, halo: number) {
    if (a <= 0.003 || s <= 0.2) return;
    const fx = this.fx;
    fx.globalAlpha = Math.min(1, a);
    fx.drawImage(this.spark, x - s / 2, y - s / 2, s, s);
    if (halo) {
      fx.globalAlpha = Math.min(1, a) * halo;
      fx.drawImage(this.spark, x - s * 1.6, y - s * 1.6, s * 3.2, s * 3.2);
    }
  }

  private glow(x: number, y: number, r0: number, r1: number, a: number) {
    if (a <= 0.003 || r1 <= 0) return;
    const fx = this.fx;
    const g = fx.createRadialGradient(x, y, 0, x, y, r1);
    const o = clamp01(r0 / r1);
    if (o > 0) {
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(Math.max(0, o - 0.001), "rgba(255,255,255,0)");
    }
    g.addColorStop(o, `rgba(255,255,255,${a})`);
    g.addColorStop(o + (1 - o) * 0.3, `rgba(255,255,255,${a * 0.32})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    fx.globalAlpha = 1;
    fx.fillStyle = g;
    fx.beginPath();
    fx.arc(x, y, r1, 0, TAU);
    // A ring of light fills only its ring: the clear centre is never painted.
    if (o > 0) fx.arc(x, y, r0 * 0.999, 0, TAU, true);
    fx.fill();
  }

  /** Without WebGL: the rings, the disk and the far ring as soft 2D strokes, in the same perspective. */
  private drawRings2D(V: Values) {
    const fx = this.fx, { cx, cy, F } = this.G;
    const ring = (z: number, rad: number, a: number, width: number) => {
      const dz = z - V.cam;
      if (dz < 0.05 || a <= 0.003) return;
      const r = (F * rad) / dz;
      fx.globalAlpha = Math.min(1, a * smooth(dz / 0.75));
      fx.lineWidth = width;
      fx.beginPath();
      fx.arc(cx, cy, r, 0, TAU);
      fx.stroke();
      this.glow(cx, cy, r * 0.985, r * 1.18, 0.08 * a);
    };
    fx.strokeStyle = "#ffffff";
    // far to near: the far ring, the disk (its black face hides what is behind it), then the rings
    ring(TUN.zf, TUN.fr, 0.9 * V.far, 1.4);
    const dzD = TUN.zd - V.cam;
    if (dzD > 0.05) {
      const r = F / dzD;
      fx.globalCompositeOperation = "source-over";
      fx.globalAlpha = 1;
      fx.fillStyle = "#000";
      fx.beginPath();
      fx.arc(cx, cy, r, 0, TAU);
      fx.fill();
      fx.globalCompositeOperation = "lighter";
      ring(TUN.zd, 1, 0.95 * V.light, 1.6);
      this.glow(cx, cy, r, r * 1.6, 0.22 * V.light);
    }
    for (let k = 3; k >= 0; k--) ring(0.6 + k * TUN.gap, 1, 0.32 * V.light, 1);
  }

  private mineTargets(V: Values, dt: number) {
    const s = this.stage, st = this.st, { R, cx, cy } = this.G, RM = this.reduced;
    const E = RM ? (x: number) => (x > 0 ? 1 : 0) : smooth;
    const k = RM ? 1 : 1 - Math.exp(-dt * 8);
    if (s !== "amount" && s !== "out" && s !== "outwait" && s !== "send") this.rot += RM ? 0 : dt * 0.12 * this.pace;
    const rot = this.rot;
    for (const m of this.mine) {
      let x = cx, y = cy, a = 0, sz = m.s, smoothIt = false;
      if (s === "amount" || s === "out" || s === "outwait") {
        x = cx + Math.cos(m.th) * R * SEAT;
        y = cy + Math.sin(m.th) * R * SEAT;
        a = m.dead ? 0 : 1;
        smoothIt = true;
      } else if (s === "send") {
        const q = clamp01((st - m.i * 0.05) / 1.25);
        const e = RM ? 1 : smooth(q);
        const r = lerp(R * SEAT, R * 1.32, e);
        x = cx + Math.cos(m.th + rot) * r;
        y = cy + Math.sin(m.th + rot) * r;
        sz *= lerp(1, 0.85, e);
        a = m.dead ? 0 : 1;
      } else if (s === "decide" || s === "wait" || s === "cross") {
        let r = R * 1.32;
        a = m.dead ? 0 : 1;
        if (s === "cross") {
          r *= 1 + 0.15 * (RM ? 1 : smooth(st / 2));
          a *= 1 - E((st - 0.6) / 1.4);
        } else smoothIt = true;
        x = cx + Math.cos(m.th + rot) * r;
        y = cy + Math.sin(m.th + rot) * r;
        sz *= 0.85;
      } else if (s === "moveout") {
        const fg = this.farRing(V);
        const q = RM ? 1 : clamp01((st - 0.35 - Math.min(m.i * 0.07, 1)) / 1.4);
        const r = lerp(fg.r * 0.1, R * SEAT, inOut(q));
        x = cx + Math.cos(m.th) * r;
        y = cy + Math.sin(m.th) * r;
        a = q > 0 && !m.dead ? 1 : 0;
      }
      if (Number.isNaN(m.x)) {
        m.x = x;
        m.y = y;
      }
      if (smoothIt) {
        m.x += (x - m.x) * k;
        m.y += (y - m.y) * k;
        m.a += (a - m.a) * k;
        m.sz += (sz - m.sz) * k;
      } else {
        m.x = x;
        m.y = y;
        m.a = a;
        m.sz = sz;
      }
    }
    this.mine = this.mine.filter((m) => !(m.dead && m.a < 0.01));
  }

  private drawOthers() {
    const s = this.stage, st = this.st, { R, cx, cy, W, H } = this.G, RM = this.reduced;
    if (s !== "send" && s !== "decide" && s !== "wait" && s !== "cross") return;
    const E = RM ? (x: number) => (x > 0 ? 1 : 0) : smooth;
    const D = Math.max(W, H) * 0.75;
    for (const o of this.others.values()) {
      let q = o.at === -Infinity ? 1 : (this.t - o.at) / 1.6;
      let fade = 1;
      if (s === "send") fade = o.at === -Infinity ? E((st - 1.2) / 0.7) : 0;
      if (s === "cross") {
        q = 1;
        fade *= 1 - E((st - 0.2) / 1.4);
      }
      if (q < 0) continue;
      q = RM ? 1 : clamp01(q);
      const r = R * 1.32 * (1.09 + o.jr * 0.06), th = o.ang + this.rot;
      const sx = cx + Math.cos(th) * r, sy = cy + Math.sin(th) * r;
      const e = inOut(q);
      const ox = cx + Math.cos(o.dir) * D, oy = cy + Math.sin(o.dir) * D;
      const kx = (ox + sx) / 2 + Math.sin(o.dir) * D * 0.25 * o.bend, ky = (oy + sy) / 2 - Math.cos(o.dir) * D * 0.25 * o.bend;
      const [x, y] = quad(ox, oy, kx, ky, sx, sy, e);
      this.dot(x, y, o.s * 0.8, (0.55 + 0.4 * (1 - e)) * fade, 0.08);
    }
  }

  private drawFar(V: Values) {
    const s = this.stage, st = this.st, fg = this.farRing(V), RM = this.reduced, { R } = this.G;
    if (!fg.vis) return;
    const E = RM ? (x: number) => (x > 0 ? 1 : 0) : smooth;
    const after = s === "arrived" || s === "claim" || s === "claimed" || s === "moveout" || s === "outwait" || s === "out";
    const shuffle = s === "arrive" ? (RM ? 1 : smooth((st - 1.6) / 1.0)) : after ? 1 : 0;
    const scale = Math.max(0.4, Math.min(1.15, fg.r / (0.9 * R)));
    const drift = RM ? 0 : this.ta * 0.02;
    const bx = fg.x + Math.cos(-0.75) * fg.r, by = fg.y + Math.sin(-0.75) * fg.r;
    for (const p of this.far) {
      const ang = lerp(p.ang0, p.ang1, inOut(shuffle)) + drift;
      const tx = fg.x + Math.cos(ang) * fg.r * p.rad, ty = fg.y + Math.sin(ang) * fg.r * p.rad;
      let x = tx, y = ty, a: number;
      const sz = p.s * 0.66 * scale;
      if (p.inc) {
        // the batch: hidden until the arrival, then every point alike
        if (!after && s !== "arrive") continue;
        if (s === "arrive") {
          const q = RM ? 1 : clamp01((st - 0.15 - Math.min(p.i * 0.045, 1.2)) / 1.1);
          if (q <= 0) continue;
          const e = inOut(q);
          const kx = (bx + tx) / 2 + (ty - by) * 0.18, ky = (by + ty) / 2 - (tx - bx) * 0.18;
          [x, y] = quad(bx, by, kx, ky, tx, ty, e);
          a = lerp(1, 0.78, E((st - 1.3) / 0.6));
        } else a = 0.78;
      } else if (s === "arrive") a = lerp(0.4, 0.78, E((st - 0.6) / 1.2));
      else if (after) a = 0.78;
      else if (s === "transit") a = 0.4 * clamp01(V.far / 0.14) * 0.6;
      else a = 0.4 * (s === "cross" ? 1 - E((st - 0.3) / 1.5) : s === "ring" ? 0 : 1);
      if (s === "claimed" || s === "moveout" || s === "outwait" || s === "out") a = 0.6;
      this.dot(x, y, sz, a, 0);
      // claiming: light flows from every point to the centre, never from yours alone
      if (s === "claim" && !RM && st < 1.45) {
        const ph = (st * 0.85 + p.ang0 * 0.37) % 1;
        const e = easeIn(ph);
        this.dot(lerp(x, fg.x, e), lerp(y, fg.y, e), sz * 0.55, 0.5 * Math.sin(Math.PI * ph), 0);
      }
    }
    if (V.gather > 0) this.glow(fg.x, fg.y, 0, fg.r * 0.95, 0.2 * V.gather);
  }

  private drawFx(V: Values) {
    const fx = this.fx, { W, H, R } = this.G;
    fx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    fx.clearRect(0, 0, W, H);
    if (!this.gl) {
      fx.globalCompositeOperation = "source-over";
      fx.globalAlpha = 1;
      fx.fillStyle = "#000";
      fx.fillRect(0, 0, W, H);
    }
    fx.globalCompositeOperation = "lighter";
    if (!this.gl) this.drawRings2D(V);
    const fg = this.farRing(V);
    if (fg.vis) this.glow(fg.x, fg.y, fg.r * 0.9, fg.r * 3.2, 0.1 * V.far);
    this.drawOthers();
    for (const m of this.mine) this.dot(m.x, m.y, m.sz, m.a, 0.22);
    this.drawFar(V);
    if (V.bead > 0) {
      // the diamond ring: one bright point on the rim as the light comes back
      const bx = fg.x + Math.cos(-0.75) * fg.r, by = fg.y + Math.sin(-0.75) * fg.r;
      this.glow(bx, by, 0, R * 0.75, 0.32 * V.bead);
      this.dot(bx, by, 30, V.bead, 0.35);
    }
    fx.globalCompositeOperation = "source-over";
    fx.globalAlpha = 1;
  }

  /** Advances the scene by `dt` seconds and draws it. */
  frame(dt: number) {
    if (this.disposed) return;
    this.t += dt;
    this.st += dt;
    const moving = FLIGHTS.has(this.stage) || this.queue.length > 0;
    this.pace += ((moving ? 1 : CALM) - this.pace) * (1 - Math.exp(-dt * 1.5));
    this.ta += dt * this.pace;
    this.tick();
    const V = this.values(dt);
    this.V = V;
    this.mineTargets(V, dt);
    this.drawGL(V);
    this.drawFx(V);
    this.opts.onFar?.(this.farRing(V));
  }

  // ---------------------------------------------------------------- the loop

  /** Keeps drawing for a while (every change; with reduced motion, nothing moves otherwise). */
  invalidate(seconds = 0) {
    const until = performance.now() + 400 + seconds * 1000;
    if (until > this.dirtyUntil) this.dirtyUntil = until;
    if (this.running && !this.raf && !this.paused) this.raf = requestAnimationFrame(this.loop);
  }

  private wantsFrame(now: number): boolean {
    if (!this.reduced) return true;
    return now < this.dirtyUntil || FLIGHTS.has(this.stage) || this.queue.length > 0;
  }

  /** The longest wait between frames: smooth during flights, calmer while holding, slow while the wallet proves. */
  private interval(): number {
    if (FLIGHTS.has(this.stage) || this.queue.length > 0 || this.st < 2.5) return 0;
    if (this.stage === "claim" || this.stage === "claimed") return 1000 / 20;
    return 1000 / 40;
  }

  private loop = (now: number) => {
    this.raf = 0;
    if (!this.running || this.paused || document.hidden) return;
    if (!this.wantsFrame(now)) return;
    if (now - this.lastDraw >= this.interval() - 2) {
      // Real time down to 4 frames a second; slower than that, the flight slows instead of jumping.
      const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.lastDraw = now;
      this.frame(dt);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private onVisibility = () => {
    if (!document.hidden) {
      this.last = performance.now();
      this.invalidate();
    }
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.invalidate();
  }

  /** Stops drawing (a sheet covers the screen, or the page asks); `resume` picks up where it was. */
  pause(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    if (!p) {
      this.last = performance.now();
      this.invalidate();
    } else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.glCanvas.removeEventListener("webglcontextlost", this.onLost);
    this.glCanvas.removeEventListener("webglcontextrestored", this.onRestored);
    const gl = this.gl;
    if (gl && this.prog) {
      gl.deleteBuffer(this.prog.buf);
      gl.deleteProgram(this.prog.p);
    }
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** The flights between two holds when the journey moves forward live; none for a jump. */
export function flightPath(from: Hold, to: Hold): Flight[] {
  const before = from === "decide" || from === "wait";
  const onAztec = from === "arrived" || from === "claim" || from === "claimed";
  if (from === "amount" && (to === "decide" || to === "wait")) return ["send"];
  if (from === "amount" && to === "transit") return ["send", "cross"];
  if (before && to === "transit") return ["cross"];
  if (before && (to === "arrived" || to === "claim" || to === "claimed")) return ["cross", "ring", "arrive"];
  if (from === "transit" && (to === "arrived" || to === "claim" || to === "claimed")) return ["ring", "arrive"];
  if (onAztec && (to === "outwait" || to === "out")) return ["moveout"];
  if (to === "amount" && from !== "amount") return ["back"];
  return [];
}
