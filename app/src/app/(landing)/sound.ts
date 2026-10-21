// The landing's sound, made entirely in Web Audio: no files, no samples, no services. A dark bed of
// breathing air and drifting low resonances, and now and then a colossal horn sounding from the
// void. `createEngine` builds the graph on any BaseAudioContext and is driven either by a timeline
// (the offline preview, app/scripts/sound-preview.mjs) or by the page (`mountSound`: time and the
// crossing as it plays). Both ask the same conductor when the calls come, and everything is scheduled in context
// time, so both drive exactly the same sound.
//
// Loaded lazily by sound-gate.ts after the first activation; nothing here runs at first paint.

// ---------- knobs ----------
// Levels are linear gains; times are seconds; pitches are Hz, semitones or cents as named.
export const TUNING = {
  /** Overall level of the layer, before the master limiter. */
  master: 1.05,
  /** Peaks stop near this level (dBFS): the ceiling of the master limiter. */
  ceiling: -12.5,
  /** Fade-in when the sound starts (the first call begins inside it), and after a hidden tab. */
  fadeIn: 1.5,
  bed: {
    /** Level of the resonant bands: the background between calls (near -35 dBFS RMS). */
    level: 0.4,
    /** Each band wanders between [low, high] Hz with a fixed Q, scaled by weight. */
    bands: [
      [44, 72, 3.5, 0.3],
      [72, 135, 3.5, 0.85],
      [125, 235, 3.2, 1],
      [210, 350, 3, 0.7],
    ] as Array<[number, number, number, number]>,
    /** A breath: inhale over `inhale` s to a level in `high`, exhale over `exhale` s to `low`. */
    breath: { inhale: [2.2, 5.5], exhale: [3.5, 8.5], high: [0.8, 1], low: [0.48, 0.64], hold: 0.25 },
    /** Each band drifts in (level in `in`) and, with chance `away`, nearly out (level in `out`). */
    drift: { in: [0.6, 1], out: [0.12, 0.28], away: 0.3 },
    /** Faint air above the bands (its RMS before the breath). */
    air: 0.002,
    /** Lowpass on the bed: at the splash, and at the deepest point of the crossing. */
    tone: [900, 330],
    /** How far the bands sink at the deepest point (cents). */
    sink: -650,
    /** Reverb send of the bed, splash to deepest. */
    wet: [0.25, 0.4],
    /** While a call sounds the void holds its breath: the bed dips to this level, then returns. */
    hush: 0.55,
  },
  horn: {
    /** Fundamental of the first call (Hz). Weight comes from its harmonics at 80-400 Hz. */
    f0: [54, 61] as [number, number],
    /** The tone speaks this many semitones flat and scoops up to pitch. */
    scoop: [1, 2] as [number, number],
    /** The first call (s): air before the tone speaks, the rise, a sustain, the uneven break, the
     *  tail. One long breath: about 8-10 s from the tone to its end. */
    pre: [0.4, 0.7] as [number, number],
    attack: [1.4, 2] as [number, number],
    sustain: [3.8, 4.6] as [number, number],
    breakup: [1, 1.3] as [number, number],
    release: [1.4, 1.8] as [number, number],
    /** Its sustain swells twice, as if a second breath pushed more air: a first swell, a falter
     *  (with a rush of air), then a stronger second swell (breath pressure, 0.86 = steady). */
    swells: { first: [0.04, 0.08] as [number, number], falter: [0.03, 0.07] as [number, number], second: [0.11, 0.17] as [number, number] },
    /** Lip-buzz roughness: depth of the noisy flutter of the lips (it modulates the drive, RMS). */
    rough: 0.22,
    /** Period doubling (the growl an octave down) during the sustain; it grows at the break. */
    growl: 0.2,
    /** Pitch instability: slow walk, irregular wobble and fast jitter (cents, RMS-ish). */
    walk: 20,
    wobble: 10,
    jitter: 9,
    /** How far the pitch sags at the break and falls at the release (cents). */
    sag: [60, 140] as [number, number],
    fall: [90, 220] as [number, number],
    /** Dynamic lowpass: at rest and at full breath (Hz). More breath, more brass. */
    bright: [230, 3600] as [number, number],
    /** Waveshaper drive at rest and at full breath. */
    drive: [0.15, 1] as [number, number],
    /** The horn body: peaking filters [Hz, dB, Q]. A huge horn, not a trumpet. */
    body: [
      [165, 5, 1.0],
      [310, 7, 1.5],
      [560, 4, 2.2],
      [760, -5, 2.0],
      [1080, 6, 3.0],
      [1750, 4, 3.5],
    ] as Array<[number, number, number]>,
    /** Breath noise: the rush before the tone and the puff as it dies; `under` while it sounds. */
    breath: 1.1,
    under: 0.35,
    /** Chance of an overblown crack at the break, and its size (cents). */
    crack: 0.55,
    crackCents: [850, 1150] as [number, number],
    /** Saturation after the body: input gain into tanh (higher = grittier, flatter peaks). */
    grit: 0.85,
    level: 0.21,
    dry: 1,
    wet: 0.5,
    predelay: 0.05,
  },
  /** The answer: lower, further, darker, mostly reverb; about 10-14 s. */
  answer: {
    semis: -1.4, level: 0.3, lowpass: 650, predelay: 0.24, dry: 0.3, wet: 1.0, pan: [0.3, 0.45] as [number, number],
    times: { pre: [0.9, 1.4], attack: [2.2, 3.4], sustain: [4, 5.5], breakup: [1.5, 2.1], release: [2.4, 3.2] } as Times,
  },
  /** The later calls. Each stands somewhere between [nearest, farthest] (distance 0 to 1): a
   *  nearer one in `nearAt`, a far one in `farAt`. Pitch varies by `semis` around the first call.
   *  Without a given distance, one in `near` is a nearer one. */
  distant: {
    semis: [-2.5, -0.3] as [number, number], near: 0.33, nearAt: [0.1, 0.35] as [number, number], farAt: [0.55, 1] as [number, number],
    level: [0.7, 0.22] as [number, number], lowpass: [1400, 480] as [number, number], predelay: [0.08, 0.34] as [number, number],
    dry: [0.7, 0.15] as [number, number], wet: [0.7, 1.2] as [number, number], pan: [0.1, 0.6] as [number, number],
    times: { pre: [0.8, 1.2], attack: [2, 3], sustain: [3, 4.5], breakup: [1.4, 2], release: [2, 2.8] } as Times,
  },
  reverb: { seconds: 7.5, bright: 5200, dark: 240 },
  /** When the calls come, from the moment the sound starts: the first call's breath after `entry`
   *  s; then a call every `every` s (start to start) whatever the scroll, the answer first, then
   *  a nearer one and a far one in turn. Calls never overlap: each waits for `gap` s of quiet
   *  after the last one ends. When the crossing reaches `answerAt`, the answer comes as soon as
   *  the quiet allows, in place of the next timed call (unless the last call was the answer). */
  calls: { entry: [0.5, 0.9] as [number, number], every: [20, 35] as [number, number], gap: 8, answerAt: 0.8 },
};

type Range = [number, number];
type Times = { pre: Range; attack: Range; sustain: Range; breakup: Range; release: Range };

export type HornKind = "first" | "answer" | "distant";

export type SoundEngine = {
  readonly ctx: BaseAudioContext;
  /** Moves the whole layer towards `level` (0..1), starting at `at`, over about `seconds`. */
  fade(level: number, at: number, seconds: number): void;
  /** Schedules the bed's slow random walks up to context time `until`. */
  pump(until: number): void;
  /** The crossing: 0 at the splash, 1 at its deepest. Glides there from `at`. */
  depth(value: number, at: number): void;
  /** A horn call starting at `at` (a later call may be given its distance, 0 near to 1 far).
   *  Returns when it ends; its tail rings on in the reverb. */
  horn(kind: HornKind, at: number, distance?: number): number;
  dispose(): void;
};

// ---------- small tools ----------
type Rng = () => number;
function mulberry32(a: number): Rng {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
const pick = (r: Rng, range: readonly [number, number] | readonly number[]) => between(r, range[0]!, range[1]!);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** A smooth random function of time: knots at random intervals, cosine-interpolated. */
function wander(r: Rng, gap: [number, number], lo: number, hi: number, until: number) {
  const ts: number[] = [0], vs: number[] = [between(r, lo, hi)];
  while (ts[ts.length - 1]! < until) { ts.push(ts[ts.length - 1]! + pick(r, gap)); vs.push(between(r, lo, hi)); }
  let i = 0;
  return (t: number) => {
    if (t <= 0) return vs[0]!;
    while (i > 0 && ts[i]! > t) i--;
    while (i < ts.length - 2 && ts[i + 1]! <= t) i++;
    const k = clamp01((t - ts[i]!) / (ts[i + 1]! - ts[i]!));
    return lerp(vs[i]!, vs[i + 1]!, (1 - Math.cos(Math.PI * k)) / 2);
  };
}

/** RMS of uniform white noise (rate `sr`) after a filter of equivalent noise bandwidth `bw` Hz. */
const noiseRms = (bw: number, sr: number) => 0.577 * Math.sqrt(bw / (sr / 2));

/** A slow random walk written onto an AudioParam as short linear ramps, ahead of time. */
class Walk {
  // (plain fields, not parameter properties, so that Node can strip the types for the tests)
  private readonly param: AudioParam;
  private readonly step: number;
  private readonly next: (v: number) => [number, number];
  private t: number;
  private v: number;
  private nextT: number;
  private nextV: number;
  private written: number;
  constructor(param: AudioParam, step: number, next: (v: number) => [number, number], start: number, v0: number) {
    this.param = param; this.step = step; this.next = next;
    this.t = start; this.v = v0;
    [this.nextT, this.nextV] = this.knot();
    this.written = start;
    param.setValueAtTime(v0, start);
  }
  private knot(): [number, number] {
    const [dt, v] = this.next(this.v);
    return [this.t + dt, v];
  }
  pump(until: number) {
    while (this.written < until) {
      const t = this.written + this.step;
      while (t > this.nextT) { this.t = this.nextT; this.v = this.nextV; [this.nextT, this.nextV] = this.knot(); }
      const k = (t - this.t) / (this.nextT - this.t);
      this.param.linearRampToValueAtTime(lerp(this.v, this.nextV, (1 - Math.cos(Math.PI * k)) / 2), t);
      this.written = t;
    }
  }
}

// ---------- generated material (made once per engine) ----------
function whiteNoise(ctx: BaseAudioContext, r: Rng, seconds: number, rate = ctx.sampleRate): AudioBuffer {
  const b = ctx.createBuffer(1, Math.round(seconds * rate), rate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return b;
}

/** Stereo noise for the bed, at a low rate (it only feeds bands under 400 Hz), the two channels
 *  partly correlated: slightly wide, never two separate sources. */
function bedNoise(ctx: BaseAudioContext, r: Rng, seconds: number): AudioBuffer {
  const rate = 12000;
  const b = ctx.createBuffer(2, Math.round(seconds * rate), rate);
  const L = b.getChannelData(0), R = b.getChannelData(1);
  for (let i = 0; i < L.length; i++) { const a = r() * 2 - 1, c = r() * 2 - 1; L[i] = a; R[i] = 0.55 * a + 0.835 * c; }
  return b;
}

/** A long dark space: decaying stereo noise whose lowpass closes over time, so the highs die
 *  first and the lows ring the full length; a few early reflections; a soft onset. */
function impulse(ctx: BaseAudioContext, r: Rng): AudioBuffer {
  const { seconds, bright, dark } = TUNING.reverb;
  const sr = ctx.sampleRate, n = Math.round(seconds * sr);
  const b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let s1 = 0, s2 = 0, energy = 0, a = 0, g = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) { // the filter and the envelope move slowly: update every 16 samples
        const t = i / sr;
        const fc = bright * Math.pow(dark / bright, Math.pow(t / seconds, 0.6));
        a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
        g = Math.sqrt(bright / fc) * Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.025);
      }
      s1 += a * (r() * 2 - 1 - s1); s2 += a * (s1 - s2);
      d[i] = s2 * g;
      energy += d[i] * d[i];
    }
    for (let k = 0; k < 7; k++) {
      const i = Math.round(between(r, 0.011, 0.075) * sr);
      d[i] = (d[i] ?? 0) + (r() < 0.5 ? -1 : 1) * between(r, 0.05, 0.16) * (1 - k / 9);
    }
    // The energy sits low, so a total energy of -10 dB gives about unity gain at 80-800 Hz.
    const k = 0.316 / Math.sqrt(energy);
    for (let i = 0; i < n; i++) d[i] *= k;
  }
  return b;
}

/** The lip buzz as harmonics of f0/2: `even` carries the tone (harmonics of f0), `odd` the
 *  period-doubled growl between them. Phases are nearly aligned, so the buzz stays a pulse. */
function buzzWaves(ctx: BaseAudioContext, r: Rng) {
  const N = 96;
  const re = [new Float32Array(N + 1), new Float32Array(N + 1)], im = [new Float32Array(N + 1), new Float32Array(N + 1)];
  for (let m = 1; m <= N; m++) {
    const n = m / 2;
    const odd = m % 2;
    let a = Math.pow(n, -0.62) * Math.exp(-n / 60);
    if (!odd && m === 2) a *= 0.4; // the fundamental, held back: weight comes from the harmonics
    if (odd) a *= m === 1 ? 0.15 : 0.9;
    const ph = between(r, -0.35, 0.35);
    re[odd]![m] = a * Math.cos(ph);
    im[odd]![m] = a * Math.sin(ph);
  }
  return { even: ctx.createPeriodicWave(re[0]!, im[0]!), odd: ctx.createPeriodicWave(re[1]!, im[1]!) };
}

/** tanh over [-2, 2]: fed at half level and made up after, it is unity for small signals. */
function gritCurve(): Float32Array<ArrayBuffer> {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * 2);
  return c;
}

function shaperCurve(): Float32Array<ArrayBuffer> {
  const n = 2048, c = new Float32Array(n);
  const k = 3, top = Math.tanh(k * 1.2);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * (x + 0.2 * x * x)) / top; }
  return c;
}

// ---------- the engine ----------
export function createEngine(ctx: BaseAudioContext, seed = (Math.random() * 4294967296) >>> 0): SoundEngine {
  const rng = mulberry32(seed);
  const T = TUNING, sr = ctx.sampleRate;
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const keep = <N extends AudioNode>(n: N) => { nodes.push(n); return n; };
  const gain = (v: number) => { const g = keep(ctx.createGain()); g.gain.value = v; return g; };
  const filter = (type: BiquadFilterType, f: number, q = 0.707, g = 0) => {
    const b = keep(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b;
  };
  const constant = (v: number) => { const c = keep(ctx.createConstantSource()); c.offset.value = v; sources.push(c); return c; };

  // master: level -> soft limiter -> fade -> out
  const out = gain(0);
  const limiter = keep(ctx.createDynamicsCompressor());
  // At this knee and ratio the output stops about 1.7 dB above the threshold. The compressor also
  // adds its own makeup gain (0.57 dB per dB of threshold, less 0.53 dB; measured in Chromium,
  // whose compressor Firefox and Safari share), which is taken back after it.
  const threshold = T.ceiling - 1.7;
  limiter.threshold.value = threshold; limiter.knee.value = 3; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.15;
  const makeup = gain(10 ** ((0.57 * threshold + 0.53) / 20));
  const master = gain(T.master);
  master.connect(limiter).connect(makeup).connect(out).connect(ctx.destination);

  // the space: a mono send into a long generated impulse
  const verbIn = gain(1);
  verbIn.channelCount = 1; verbIn.channelCountMode = "explicit";
  const verb = keep(ctx.createConvolver());
  verb.normalize = false;
  verb.buffer = impulse(ctx, rng);
  verbIn.connect(verb).connect(master);

  const white = whiteNoise(ctx, rng, 6.3);
  const slowNoise = whiteNoise(ctx, rng, 7.7);
  const waves = buzzWaves(ctx, rng);
  const curve = shaperCurve(), grit = gritCurve();
  const t0 = ctx.currentTime;

  // ---- the bed ----
  const bedSrc = keep(ctx.createBufferSource());
  bedSrc.buffer = bedNoise(ctx, rng, 17.3); bedSrc.loop = true; sources.push(bedSrc);
  const breath = constant(0);
  const bedBreath = gain(0); breath.connect(bedBreath.gain);
  const bedTone = filter("lowpass", T.bed.tone[0]!, 0.5);
  const bedOut = gain(1);
  const hush = gain(1);
  const bedWet = gain(T.bed.wet[0]!);
  // The bands drift in and out as colour; a slow leveller keeps their sum steady, so that the
  // breath alone shapes the loudness. (Its automatic makeup, +9 dB, is folded into bedLevel.)
  const bandSum = gain(1);
  const leveller = keep(ctx.createDynamicsCompressor());
  leveller.threshold.value = -26; leveller.knee.value = 12; leveller.ratio.value = 4;
  leveller.attack.value = 0.6; leveller.release.value = 1;
  const bedLevel = gain(T.bed.level * 0.35);
  bandSum.connect(leveller).connect(bedBreath);
  bedBreath.connect(bedTone).connect(bedLevel).connect(bedOut).connect(hush).connect(master);
  hush.connect(bedWet).connect(verbIn);
  const colour = filter("lowpass", 420, 0.6), colour2 = filter("lowpass", 420, 0.6);
  bedSrc.connect(colour).connect(colour2);
  const sink = constant(0); // cents, shared by every band
  const walks: Walk[] = [];
  const bandNorm = (f: number, q: number) => noiseRms(((f / q) * Math.PI) / 2, 12000);
  T.bed.bands.forEach(([lo, hi, q0, w]) => {
    const q = q0 * between(rng, 0.85, 1.15);
    const bp = filter("bandpass", (lo + hi) / 2, q);
    sink.connect(bp.detune);
    const g = gain(0);
    colour2.connect(bp).connect(g).connect(bandSum);
    const scale = (w * 0.06) / bandNorm((lo + hi) / 2, q);
    walks.push(new Walk(bp.frequency, 0.5, (v) => [between(rng, 3, 9), Math.min(hi, Math.max(lo, v + (rng() - 0.5) * (hi - lo) * 0.9))], t0, between(rng, lo, hi)));
    const Dr = T.bed.drift;
    walks.push(new Walk(g.gain, 0.4, () => [between(rng, 4, 11), pick(rng, rng() < Dr.away ? Dr.out : Dr.in) * scale], t0, 0.6 * scale));
  });
  // the breathing: irregular inhale / exhale / hold, never periodic
  const B = T.bed.breath;
  let inhale = true;
  walks.push(new Walk(breath.offset, 0.15, (v) => {
    if (rng() < B.hold) return [between(rng, 0.8, 2.5), v * between(rng, 0.94, 1.04)];
    inhale = !inhale;
    return inhale ? [pick(rng, B.inhale), pick(rng, B.high)] : [pick(rng, B.exhale), pick(rng, B.low)];
  }, t0, 0.4));
  // air: faint, high, moving across the field with the breath
  const airSrc = keep(ctx.createBufferSource());
  airSrc.buffer = white; airSrc.loop = true; airSrc.playbackRate.value = 0.93; sources.push(airSrc);
  const airHp = filter("highpass", 2200, 0.5), airLp = filter("lowpass", 6500, 0.5);
  const airLevel = gain(0), airBreath = gain(0), airDepth = gain(1);
  breath.connect(airBreath.gain);
  const airPan = keep(ctx.createStereoPanner());
  airSrc.connect(airHp).connect(airLp).connect(airLevel).connect(airBreath).connect(airDepth).connect(airPan).connect(bedOut);
  const airScale = T.bed.air / noiseRms(4300, sr);
  walks.push(new Walk(airLevel.gain, 0.3, () => [between(rng, 2, 7), between(rng, 0.25, 1) * airScale], t0, 0.5 * airScale));
  walks.push(new Walk(airPan.pan, 0.3, () => [between(rng, 3, 8), between(rng, -0.55, 0.55)], t0, 0));
  walks.push(new Walk(airSrc.playbackRate, 0.5, () => [between(rng, 3, 9), between(rng, 0.85, 1.12)], t0, 0.93));
  walks.push(new Walk(bedSrc.playbackRate, 0.5, () => [between(rng, 4, 10), between(rng, 0.9, 1.1)], t0, 1));

  for (const s of sources) s.start(t0);

  // ---- the horn ----
  const hornBus = gain(1);
  hornBus.connect(master);
  let baseF0 = pick(rng, T.horn.f0);
  let firstDone = false;
  const DT = 0.01;

  function horn(kind: HornKind, at: number, distance?: number): number {
    const r = mulberry32((rng() * 4294967296) >>> 0);
    const H = T.horn, An = T.answer, Ds = T.distant;
    const far = kind !== "first";
    let f0: number;
    if (kind === "first") { if (firstDone) baseF0 *= 2 ** (between(r, -0.4, 0.4) / 12); f0 = baseF0; firstDone = true; }
    else if (kind === "answer") f0 = baseF0 * 2 ** ((An.semis + between(r, -0.25, 0.25)) / 12);
    else f0 = baseF0 * 2 ** (pick(r, Ds.semis) / 12);
    // Where the call stands: the first is here; the answer far in the dark; a later call anywhere
    // between its nearest and farthest place (a nearer one now and then).
    const d = kind === "first" ? 0 : kind === "answer" ? 1
      : clamp01(distance ?? pick(r, r() < Ds.near ? Ds.nearAt : Ds.farAt));
    const byDistance = (range: Range) => lerp(range[0], range[1], d);
    const place = kind === "answer"
      ? { level: An.level, lowpass: An.lowpass, predelay: An.predelay, dry: An.dry, wet: An.wet, pan: pick(r, An.pan) }
      : kind === "distant"
        ? { level: byDistance(Ds.level), lowpass: byDistance(Ds.lowpass), predelay: byDistance(Ds.predelay), dry: byDistance(Ds.dry), wet: byDistance(Ds.wet), pan: byDistance(Ds.pan) }
        : null;
    const times: Times = kind === "first" ? H : kind === "answer" ? An.times : Ds.times;

    const pre = pick(r, times.pre);
    const A = pick(r, times.attack);
    const S = pick(r, times.sustain);
    const Bk = pick(r, times.breakup);
    const R = pick(r, times.release);
    const tA = pre, tS = tA + A, tB = tS + S, tR = tB + Bk, total = tR + R;
    const N = Math.ceil(total / DT) + 1, dt = total / (N - 1);

    const scoop = pick(r, H.scoop) * 100;
    const sag = pick(r, H.sag), fall = pick(r, H.fall);
    const swell = between(r, 0.07, 0.15), peakAt = between(r, 0.45, 0.8);
    const over = between(r, 4, 12);
    const pWalk = wander(r, [0.35, 1.1], -1, 1, total);
    const cWalk = wander(r, [0.2, 0.7], -1, 1, total);
    const gWalk = wander(r, [0.4, 1.4], 0, 1, total);
    const dips = Array.from({ length: 2 + Math.floor(r() * 3) }, () => ({ t: tB + between(r, 0.12, 0.95) * Bk, w: between(r, 0.035, 0.12), d: between(r, 0.3, 0.7) }));
    const sputter = { t: tR + between(r, 0.15, 0.5) * R, w: between(r, 0.05, 0.1), d: between(r, 0.3, 0.6) };
    const crack = r() < (far ? 0.3 : H.crack) ? { t: tB + between(r, 0.15, 0.45) * Bk, len: between(r, 0.07, 0.15), c: pick(r, H.crackCents) } : null;
    const gBase = H.growl * lerp(1, 0.7, d) * between(r, 0.7, 1.3);
    const ro = H.rough * between(r, 0.8, 1.2);
    const G = (u: number, c: number, w: number) => Math.exp(-(((u - c) / w) ** 2));
    // the first call swells twice, a falter between; later calls swell once
    const sw = H.swells;
    const s1 = pick(r, sw.first), fa = pick(r, sw.falter), s2 = pick(r, sw.second);
    const c1 = between(r, 0.15, 0.3), cf = between(r, 0.42, 0.52), c2 = between(r, 0.68, 0.82);
    const shape = far
      ? (u: number) => swell * G(u, peakAt, 0.35)
      : (u: number) => s1 * G(u, c1, 0.16) - fa * G(u, cf, 0.08) + s2 * G(u, c2, 0.17);
    const falter = (u: number) => (far ? 0 : G(u, cf, 0.07));
    const sustainP = (u: number) => 0.86 + shape(u) - shape(0) * (1 - u) + 0.035 * pWalk(tS + u * S) * clamp01(u / 0.15);
    const Pend = sustainP(1);
    const notch = (t: number, d: { t: number; w: number; d: number }) => 1 - d.d * Math.exp(-(((t - d.t) / d.w) ** 2));
    const crackShape = (t: number) => crack ? smooth((t - crack.t + 0.025) / 0.025) * (1 - smooth((t - crack.t - crack.len) / 0.04)) : 0;

    const amp = new Float32Array(N), cents = new Float32Array(N), air = new Float32Array(N);
    const drive = new Float32Array(N), bright = new Float32Array(N), growl = new Float32Array(N), rough = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const t = k * dt;
      let P = 0, c = 0, br = 0, g = 0, rr = ro;
      if (t < tA) {
        br = 0.22 * Math.pow(smooth(t / pre), 1.5);
      } else if (t < tS) {
        const x = (t - tA) / A;
        P = 0.86 * Math.pow(smooth(x), 0.7);
        c = -scoop * (1 - smooth(x / 0.85)) + over * Math.exp(-(((x - 0.9) / 0.1) ** 2));
        br = lerp(0.22, 0.17 * H.under * 3, smooth(x / 0.6));
        g = gBase * (1 + 1.5 * (1 - x));
        rr = ro * (1 + 0.8 * (1 - x));
      } else if (t < tB) {
        const u = (t - tS) / S;
        P = sustainP(u);
        br = (0.17 + 0.05 * pWalk(t)) * H.under + 0.06 * falter(u);
        g = gBase * (0.6 + 0.8 * gWalk(t) + 1.2 * falter(u));
      } else if (t < tR) {
        const v = (t - tB) / Bk;
        P = lerp(Pend, 0.42, smooth(v));
        for (const d of dips) P *= notch(t, d);
        c = -sag * smooth(v);
        br = (0.19 + 0.2 * v) * H.under * 1.5;
        g = gBase * (0.6 + 0.8 * gWalk(t)) + gBase * 2.4 * smooth(v);
        rr = ro * (1 + 1.2 * v);
      } else {
        const w = clamp01((t - tR) / R);
        P = 0.42 * Math.pow(1 - w, 2.2) * notch(t, sputter);
        c = -sag - fall * smooth(w);
        br = lerp((0.39 * H.under * 1.5), 0.3, smooth(w / 0.12)) * Math.exp(-3 * w) * (1 - w);
        g = gBase * (1.4 + 1.6 * (1 - w));
        rr = ro * 2.2;
      }
      P = Math.max(0, P);
      const cs = crackShape(t);
      amp[k] = Math.pow(P, 1.3) * (1 - 0.45 * cs);
      cents[k] = c + 40 * (P - 0.86) + H.walk * cWalk(t) + (crack ? crack.c * cs : 0);
      air[k] = br * H.breath;
      drive[k] = lerp(H.drive[0], H.drive[1], P * P);
      bright[k] = lerp(H.bright[0], H.bright[1], Math.pow(P, 2.2)) * lerp(1, 0.75, d) * (1 + 0.5 * cs);
      growl[k] = g;
      rough[k] = rr;
    }

    const made: AudioNode[] = [];
    const own = <N extends AudioNode>(n: N) => { made.push(n); return n; };
    const g = (v: number) => { const x = own(ctx.createGain()); x.gain.value = v; return x; };
    const f = (type: BiquadFilterType, fr: number, q = 0.707, gn = 0) => {
      const b = own(ctx.createBiquadFilter()); b.type = type; b.frequency.value = fr; b.Q.value = q; b.gain.value = gn; return b;
    };
    const end = at + total + 0.05;

    // the buzz: two phase-locked oscillators at f0/2, one pitch for both
    const tone = own(ctx.createOscillator()), sub = own(ctx.createOscillator());
    tone.setPeriodicWave(waves.even); sub.setPeriodicWave(waves.odd);
    tone.frequency.value = sub.frequency.value = f0 / 2;
    const pitch = own(ctx.createConstantSource());
    pitch.offset.value = cents[0]!;
    pitch.offset.setValueCurveAtTime(cents, at, total);
    pitch.connect(tone.detune); pitch.connect(sub.detune);
    // slow noise (played slowed down) for wobble, jitter and lip flutter
    const mod = own(ctx.createBufferSource());
    mod.buffer = slowNoise; mod.loop = true; mod.playbackRate.value = 0.25;
    const msr = sr * 0.25;
    const wob = f("lowpass", 3, 0.707), jit = f("bandpass", 14, 1.2), flut = f("bandpass", 42, 0.6);
    const wobG = g(H.wobble / noiseRms(3 * 1.11, msr)), jitG = g(H.jitter / noiseRms((14 / 1.2) * 1.57, msr));
    mod.connect(wob).connect(wobG); mod.connect(jit).connect(jitG);
    for (const p of [tone.detune, sub.detune]) { wobG.connect(p); jitG.connect(p); }
    const flutG = g(0);
    flutG.gain.setValueCurveAtTime(rough.map((x) => x / noiseRms((42 / 0.6) * 1.57, msr)), at, total);
    mod.connect(flut).connect(flutG);

    const growlG = g(0);
    growlG.gain.setValueCurveAtTime(growl, at, total);
    const driveG = g(0);
    driveG.gain.setValueCurveAtTime(drive, at, total);
    const shaper = own(ctx.createWaveShaper());
    shaper.curve = curve; shaper.oversample = "2x";
    const lp = f("lowpass", bright[0]!, 0.6);
    lp.frequency.setValueCurveAtTime(bright, at, total);
    const ampG = g(0);
    ampG.gain.setValueCurveAtTime(amp, at, total);
    const flutter = g(1);
    flutG.connect(flutter.gain);
    tone.connect(driveG); sub.connect(growlG).connect(driveG);
    driveG.connect(flutter).connect(shaper).connect(lp).connect(ampG);

    // breath: air in the mouthpiece, coloured by the same body
    const air0 = own(ctx.createBufferSource());
    air0.buffer = white; air0.loop = true; air0.playbackRate.value = between(r, 0.85, 1.15);
    const airBp = f("bandpass", between(r, 1000, 1400), 0.5), airHp = f("highpass", 250, 0.6);
    const airG = g(0);
    airG.gain.setValueCurveAtTime(air, at, total);
    air0.connect(airBp).connect(airHp).connect(airG);

    // the body, then the bell
    const bodyIn = g(1);
    ampG.connect(bodyIn); airG.connect(bodyIn);
    let node: AudioNode = bodyIn;
    for (const [fr, db, q] of H.body) { const b = f("peaking", fr * between(r, 0.95, 1.05), q, db); node.connect(b); node = b; }
    const hp = f("highpass", 48, 0.6), top = f("highshelf", 3200, 0.707, -8);
    const gritIn = g(H.grit / 2), gritOut = g(1 / H.grit), sat = own(ctx.createWaveShaper());
    sat.curve = grit; sat.oversample = "2x";
    node.connect(hp).connect(top).connect(gritIn).connect(sat).connect(gritOut); node = gritOut;
    if (place) { const absorb = f("lowpass", place.lowpass * between(r, 0.9, 1.1), 0.6); node.connect(absorb); node = absorb; }
    const level = g(H.level * (place ? place.level : 1));
    const pan = own(ctx.createStereoPanner());
    pan.pan.value = place ? (r() < 0.5 ? -1 : 1) * place.pan : between(r, -0.12, 0.12);
    const dry = g(place ? place.dry : H.dry), wet = g(place ? place.wet : H.wet);
    const delay = own(ctx.createDelay(1));
    delay.delayTime.value = place ? place.predelay : H.predelay;
    node.connect(level).connect(pan).connect(dry).connect(hornBus);
    level.connect(wet).connect(delay).connect(verbIn);

    for (const s of [tone, sub, pitch]) s.start(at);
    // each call reads the noise from its own place, so no two flutter or breathe alike
    mod.start(at, between(r, 0, slowNoise.duration));
    air0.start(at, between(r, 0, white.duration));
    for (const s of [tone, sub, pitch, mod, air0]) s.stop(end);
    hush.gain.cancelScheduledValues(at);
    hush.gain.setTargetAtTime(T.bed.hush, at, 0.8);
    hush.gain.setTargetAtTime(1, at + total, 2.5);
    tone.onended = () => { for (const n of made) n.disconnect(); };
    return at + total;
  }

  // ---- control ----
  const DEPTH_TC = 1.6;
  function glide(p: AudioParam, v: number, at: number, tc: number) {
    p.cancelScheduledValues(at);
    p.setTargetAtTime(v, at, tc);
  }
  let lastDepth = -1;
  return {
    ctx,
    fade(level, at, seconds) { glide(out.gain, level, at, Math.max(0.01, seconds / 3)); },
    pump(until) { for (const w of walks) w.pump(until); },
    depth(value, at) {
      const v = clamp01(value);
      if (Math.abs(v - lastDepth) < 0.005) return;
      lastDepth = v;
      glide(sink.offset, T.bed.sink * v, at, DEPTH_TC);
      glide(bedTone.frequency, T.bed.tone[0]! * Math.pow(T.bed.tone[1]! / T.bed.tone[0]!, v), at, DEPTH_TC);
      glide(airDepth.gain, lerp(1, 0.35, v), at, DEPTH_TC);
      glide(bedWet.gain, lerp(T.bed.wet[0]!, T.bed.wet[1]!, v), at, DEPTH_TC);
      glide(bedOut.gain, lerp(1, 1.1, v), at, DEPTH_TC);
    },
    horn,
    dispose() {
      for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } }
      for (const n of nodes) n.disconnect();
    },
  };
}

// ---------- a scripted visit (the offline preview) ----------
export type Cue =
  | { at: number; horn: HornKind; distance?: number }
  | { at: number; depth: number }
  | { at: number; fade: number; seconds: number };

/** Plays a whole timeline on an engine: everything is scheduled up front, in context time. */
export function playTimeline(engine: SoundEngine, cues: Cue[], until: number) {
  engine.pump(until);
  for (const c of [...cues].sort((a, b) => a.at - b.at)) {
    if ("horn" in c) engine.horn(c.horn, c.at, c.distance);
    else if ("depth" in c) engine.depth(c.depth, c.at);
    else engine.fade(c.fade, c.at, c.seconds);
  }
}

// ---------- when the calls come (the page and the preview share it) ----------
export type Call = { kind: HornKind; at: number; distance?: number };
export type Conductor = {
  /** Called every quarter second or so with the context time and the crossing's progress (0..1).
   *  When a call is due it is passed to `play`, which sounds it and returns when it ends. */
  tick(now: number, progress: number, play: (call: Call) => number): Call | null;
};

/** The first call at once; then one every `calls.every` s whatever the scroll: the answer (lower,
 *  far), then a nearer one and a far one in turn. Each waits for `calls.gap` s of quiet after the
 *  last one ends. The crossing reaching `calls.answerAt` brings the answer forward, as soon as the
 *  quiet allows, in place of the next timed call: it never adds one. */
export function conductor(rng: () => number = Math.random): Conductor {
  const C = TUNING.calls, Ds = TUNING.distant;
  let started = false, crossed = false;
  let busyUntil = -Infinity, nextAt = Infinity;
  let next: "answer" | "near" | "far" = "answer";
  let last: HornKind | null = null;
  const sound = (call: Call, play: (call: Call) => number) => {
    busyUntil = play(call);
    last = call.kind;
    if (call.kind !== "first") next = next === "near" ? "far" : "near";
    nextAt = call.at + pick(rng, C.every);
    return call;
  };
  return {
    tick(now, progress, play) {
      if (!started) { started = true; return sound({ kind: "first", at: now + pick(rng, C.entry) }, play); }
      const free = busyUntil + C.gap;
      if (!crossed && progress >= C.answerAt) {
        crossed = true;
        if (last !== "answer") { next = "answer"; nextAt = Math.min(nextAt, Math.max(now, free)); }
      }
      if (now < nextAt || now < free) return null;
      const at = now + 0.05;
      if (next === "answer") return sound({ kind: "answer", at }, play);
      return sound({ kind: "distant", at, distance: pick(rng, next === "near" ? Ds.nearAt : Ds.farAt) }, play);
    },
  };
}

/** A visit on a timeline (the offline preview): the calls come as they would on the page, the
 *  crossing's progress at each moment given by `progressAt`. Returns the calls and their ends. */
export function playVisit(engine: SoundEngine, progressAt: (t: number) => number, until: number, seed: number) {
  const calls: Array<Call & { end: number }> = [];
  const c = conductor(mulberry32(seed + 1));
  engine.pump(until);
  for (let t = 0; t < until; t += 0.25) {
    const p = progressAt(t);
    engine.depth(p, t);
    c.tick(t, p, (call) => { const end = engine.horn(call.kind, call.at, call.distance); calls.push({ ...call, end }); return end; });
  }
  return calls;
}

// ---------- the page: time and the crossing drive the same engine ----------
export type SoundPlayer = {
  setMuted(muted: boolean): void;
  /** Fades everything out over `seconds` (leaving for the app); `back` undoes it (the page came
   *  back from the browser's history). */
  leave(seconds: number): void;
  back(): void;
  dispose(): void;
};

/** Starts the sound on a running (or about to run) context: the first call as soon as the sound
 *  starts, then a call every 20-35 s (the conductor); the crossing, as it plays, deepens the bed
 *  and brings the answer near Aztec. Calls never overlap. */
export function mountSound(root: HTMLElement, ctx: AudioContext, onAudible: (audible: boolean) => void): SoundPlayer {
  const engine = createEngine(ctx);
  const calls = conductor();
  const play = (c: Call) => engine.horn(c.kind, c.at, c.distance);
  const crossing = root.querySelector<HTMLElement>("#crossing");
  let muted = false, disposed = false, started = false;
  let suspendTimer: ReturnType<typeof setTimeout> | undefined;

  // The crossing plays by itself once the page rests on it (scene.ts writes its progress on the
  // section); above it, before the page gets there, it is 0.
  const progress = () => {
    if (!crossing) return 0;
    if (crossing.getBoundingClientRect().top > window.innerHeight * 0.5) return 0;
    return clamp01(Number(crossing.dataset.progress ?? 0) || 0);
  };
  const audible = () => !muted && !document.hidden && ctx.state === "running";

  function tick() {
    if (disposed || !audible()) return;
    const now = ctx.currentTime;
    engine.pump(now + 8);
    const p = progress();
    engine.depth(p, now);
    if (!started) { started = true; engine.fade(1, now, TUNING.fadeIn); }
    calls.tick(now, p, play);
  }

  function wake() {
    if (disposed || muted || document.hidden) return;
    clearTimeout(suspendTimer);
    const go = () => {
      if (disposed || muted || document.hidden) return;
      if (started) engine.fade(1, ctx.currentTime, TUNING.fadeIn / 2);
      tick();
      onAudible(audible());
    };
    if (ctx.state === "running") go();
    else ctx.resume().then(go, () => {});
  }
  function sleep() {
    engine.fade(0, ctx.currentTime, 0.6);
    onAudible(false);
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => { if (!disposed && (muted || document.hidden)) void ctx.suspend().catch(() => {}); }, 900);
  }

  const onVisibility = () => (document.hidden ? sleep() : wake());
  const onState = () => { if (ctx.state === "running") wake(); else onAudible(false); };
  document.addEventListener("visibilitychange", onVisibility);
  ctx.addEventListener("statechange", onState);
  const timer = setInterval(tick, 250);
  wake();

  return {
    leave(seconds) {
      if (!disposed) engine.fade(0, ctx.currentTime, seconds);
    },
    back() {
      if (!disposed && audible()) engine.fade(1, ctx.currentTime, TUNING.fadeIn / 2);
    },
    setMuted(m) {
      if (m === muted) return;
      muted = m;
      if (m) sleep(); else wake();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      clearTimeout(suspendTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      ctx.removeEventListener("statechange", onState);
      engine.dispose();
    },
  };
}
