// Renders the landing's sound offline, through the very graph the page plays (sound.ts), on a
// scripted 120-second visit, and writes a WAV, an MP3, a spectrogram and loudness numbers.
//
//   node app/scripts/sound-preview.mjs <out-dir> [--name eclyps-preview] [--seed 7] [--seconds 120]
//                                     [--tune '{"horn":{"rough":0.4},"reverb":{"seconds":9}}']
//                                     [--cues '[{"at":0,"fade":1,"seconds":1.5},{"at":1,"horn":"distant","distance":0.2}]']
//
// --tune overrides any knob of TUNING in sound.ts for this render only, to try a change by ear;
// --cues replaces the scripted visit (horn: first | answer | distant, with an optional distance
// 0..1 for a later call; depth: 0..1; fade). It prints when each call came.
// Needs Chromium for Playwright (PLAYWRIGHT_BROWSERS_PATH) and ffmpeg on PATH. Local use only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import ts from "typescript";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const outDir = resolve(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "sound-preview");
const name = opt("name", "eclyps-preview");
const seed = Number(opt("seed", "7"));
const seconds = Number(opt("seconds", "120"));
const tune = JSON.parse(opt("tune", "{}"));
const sampleRate = 48000;
mkdirSync(outDir, { recursive: true });

// The visit: the sound starts at 0 and the calls come as on the page (the same conductor, seeded
// here): the first call at once, then one every 20-35 s. The visitor lingers on the splash, then
// scrolls the crossing unevenly from 40 s to 80 s, with pauses (the bed deepens); it reaches 0.8
// at 72 s, which brings the answer forward unless the last call was the answer. The preview fades
// out over its last second (the page never ends like this).
const scroll = [[40, 0], [43, 0.08], [46, 0.12], [50, 0.3], [54, 0.36], [59, 0.52], [63, 0.58], [68, 0.72], [72, 0.8], [76, 0.92], [80, 1]];
const fades = [{ at: 0, fade: 1, seconds: 1.5 }, { at: seconds - 1.4, fade: 0, seconds: 1.2 }];
const cues = opt("cues") ? JSON.parse(opt("cues")) : null;

const src = readFileSync(new URL("../src/app/(landing)/sound.ts", import.meta.url), "utf8");
const js = ts
  .transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  .outputText.replace(/^export /gm, "");

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.setContent(`<!doctype html><meta charset="utf-8"><script>${js}
window.render = async ({ seconds, sampleRate, seed, cues, fades, scroll, tune }) => {
  const merge = (to, from) => { for (const [k, v] of Object.entries(from)) { if (v && typeof v === "object" && !Array.isArray(v)) merge(to[k], v); else to[k] = v; } };
  merge(TUNING, tune);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate });
  const engine = createEngine(ctx, seed);
  const progressAt = (t) => {
    for (let i = 0; i < scroll.length - 1; i++) {
      const [a, pa] = scroll[i], [b, pb] = scroll[i + 1];
      if (t <= b) { const k = Math.max(0, (t - a) / (b - a)); return pa + (pb - pa) * k * k * (3 - 2 * k); }
    }
    return scroll[scroll.length - 1][1];
  };
  let calls = (cues ?? []).filter((c) => "horn" in c).map((c) => ({ kind: c.horn, at: c.at, distance: c.distance }));
  if (cues) playTimeline(engine, cues, seconds);
  else { playTimeline(engine, fades, seconds); calls = playVisit(engine, progressAt, seconds, seed); }
  const t = performance.now();
  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
  const pcm = new Float32Array(n * 2);
  let peak = 0;
  for (let i = 0; i < n; i++) { pcm[2 * i] = L[i]; pcm[2 * i + 1] = R[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
  window.pcm = new Uint8Array(pcm.buffer);
  return { frames: n, peak, renderMs: performance.now() - t, calls };
};
window.chunk = (from, to) => {
  let s = "";
  const b = window.pcm.subarray(from, to);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
};
</script>`);
const info = await page.evaluate((o) => window.render(o), { seconds, sampleRate, seed, cues, fades, scroll, tune });
const bytes = info.frames * 8;
const parts = [];
for (let from = 0; from < bytes; from += 4 << 20) parts.push(Buffer.from(await page.evaluate(([a, b]) => window.chunk(a, b), [from, Math.min(bytes, from + (4 << 20))]), "base64"));
await browser.close();
if (errors.length) throw new Error(errors.join("\n"));

// 32-bit float WAV, then 24-bit PCM for listening
const data = Buffer.concat(parts);
const head = Buffer.alloc(44);
head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(2, 22);
head.writeUInt32LE(sampleRate, 24); head.writeUInt32LE(sampleRate * 8, 28); head.writeUInt16LE(8, 32); head.writeUInt16LE(32, 34);
head.write("data", 36); head.writeUInt32LE(data.length, 40);
const float = join(outDir, `${name}.f32.wav`), wav = join(outDir, `${name}.wav`), mp3 = join(outDir, `${name}.mp3`);
writeFileSync(float, Buffer.concat([head, data]));
const ff = (...a) => execFileSync("ffmpeg", ["-hide_banner", "-y", ...a], { stdio: ["ignore", "pipe", "pipe"] });
ff("-i", float, "-c:a", "pcm_s24le", wav);
ff("-i", float, "-c:a", "libmp3lame", "-b:a", "192k", mp3);
ff("-i", float, "-lavfi", "showspectrumpic=s=1600x700:legend=1:scale=log:fscale=lin:stop=4000:color=intensity", join(outDir, `${name}-spectrogram.png`));
// resampled first, so the FFT resolves the horn's harmonics (about 2 Hz per row, 0-1.6 kHz)
ff("-i", float, "-lavfi", "aresample=3200,showspectrumpic=s=1800x800:legend=1:scale=log:color=intensity:win_func=hann", join(outDir, `${name}-spectrogram-low.png`));
const r128 = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", float, "-filter_complex", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const tail = r128.slice(r128.lastIndexOf("Summary:"));
const I = /I:\s+(-?[\d.]+) LUFS/.exec(tail)?.[1], LRA = /LRA:\s+([\d.]+) LU/.exec(tail)?.[1], TP = /Peak:\s+(-?[\d.]+) dBFS/.exec(tail)?.[1];
const s1 = (x) => x.toFixed(1);
const calls = info.calls.map((c) => `${c.kind}${c.distance === undefined ? "" : ` (distance ${c.distance.toFixed(2)})`} at ${s1(c.at)} s${c.end === undefined ? "" : `, ends ${s1(c.end)} s`}`);
console.log(JSON.stringify({ wav, mp3, seed, seconds, renderMs: Math.round(info.renderMs), samplePeakDbfs: +(20 * Math.log10(info.peak)).toFixed(2), integratedLufs: I && +I, truePeakDbfs: TP && +TP, lra: LRA && +LRA, calls }, null, 2));
