// A small seeded random generator, so every drawing places its points the same way on the
// server and in the browser (no hydration differences, no flicker between builds).

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal sample from `rnd`, clipped to ±`lim`. */
export function gauss(rnd: () => number, lim = 3): number {
  for (;;) {
    let u = 0;
    while (u === 0) u = rnd();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
    if (Math.abs(g) <= lim) return g;
  }
}

export const TAU = Math.PI * 2;
export const GOLDEN = Math.PI * (3 - Math.sqrt(5));
