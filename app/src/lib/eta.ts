/**
 * How long a crossing still takes: a small, honest estimate per stage (the bridge screen, ADR 0007;
 * routes, ADR 0014). Every number is a range measured on the network it is shown for, never a
 * promise, and the words always say "about". Where a wait depends on other people (a batch that
 * needs more deposits, an exit batch that needs more exits), it is not estimated at all: the times
 * then count from when that happens, and the screen says so.
 *
 * Where the testnet numbers come from (deployments/testnet.json `runs`, ADR 0009 "Evidence
 * (testnet)", ADR 0017 §1):
 *
 *   carry      batch closed → registered on Aztec → seen by the page: the finisher took 57–93 s
 *              over runs 0, 1, 3, 4, 5 (deposited → registered); the page saw run 5 14 s later.
 *   claim      a private claim proved in the browser: 102 s in run 5 (arrived → claimed, a click
 *              included).
 *   burn       Move out proved in the browser: 142 s in run 5 (claimed → burned, a click included).
 *   epoch      an Aztec epoch is 32 slots of 72 s (38.4 min), read from the rollup on testnet and
 *              mainnet. An exit can be used on Ethereum only once its epoch is proven.
 *   proof      the proof lands on L1 about 5 min after the epoch's last slot on testnet (epochs
 *              216 and 217), 2.6–4.8 min on mainnet.
 *   ethClaim   claimToEthereum from the page: 33 s in run 5 (proven → claimed).
 *   exitEpoch  a Solana exit batch closes once it holds 4 exits and its exit epoch (13 Aztec
 *              blocks) has ended.
 *   iris       exitBatch → Iris → receive_exit: 14 min in run 2 (Sepolia finality; Circle says
 *              15–19 min on mainnet Ethereum).
 *   solClaim   claim_exit on Solana: seconds (run 2), plus the page's next look.
 *
 * The local stack proves epochs within seconds; its numbers are the local e2e demo's.
 *
 * Pure (type imports only), so `node --test test/eta.test.ts` runs it as it is.
 */

/** A span of time in ms, `lo` ≤ `hi`. Absolute (ms since 1970) or a duration, as named. */
export interface Range {
  lo: number;
  hi: number;
}

export interface Profile {
  carry: Range;
  claim: Range;
  burn: Range;
  /** Aztec epoch length, used when the real Aztec clock is not known. 0: proven at once. */
  epochMs: number;
  proof: Range;
  ethClaim: Range;
  /** A full batch waits for the finisher's next pass. */
  pass: Range;
  /** A Solana exit batch, once full, waits for its exit epoch to end. */
  exitEpoch: Range;
  iris: Range;
  solClaim: Range;
}

const s = (lo: number, hi: number): Range => ({ lo: lo * 1000, hi: hi * 1000 });

export const PROFILES: Record<"local" | "testnet", Profile> = {
  testnet: {
    carry: s(60, 110),
    claim: s(90, 120),
    burn: s(120, 160),
    epochMs: 32 * 72_000,
    proof: s(180, 360),
    ethClaim: s(20, 60),
    pass: s(0, 60),
    exitEpoch: s(0, 13 * 72),
    iris: s(780, 1200),
    solClaim: s(15, 60),
  },
  local: {
    carry: s(20, 60),
    claim: s(15, 60),
    burn: s(15, 60),
    epochMs: 0,
    proof: s(5, 60),
    ethClaim: s(5, 30),
    pass: s(0, 15),
    exitEpoch: s(0, 60),
    iris: s(5, 30),
    solClaim: s(5, 30),
  },
};

export const profileOf = (network: string): Profile => (network === "local" ? PROFILES.local : PROFILES.testnet);

/**
 * Where the Aztec chain is in time, read from the rollup on L1 at `at` (ms): the same reads as the
 * finisher's `readAztecClock` (finisher/src/exits.ts, ADR 0017 item 1).
 */
export interface AztecClock {
  slot: bigint;
  epochSlots: number;
  slotSeconds: number;
  at: number;
}

/** When the Aztec epoch holding a moment `t` (ms) ends, from the clock. */
export function epochEnd(t: number, c: AztecClock): number {
  const slotMs = c.slotSeconds * 1000;
  // The clock's slot started at most one slot before `at`; take its start as `at` (±72 s).
  const slotAt = Number(c.slot) + Math.floor((t - c.at) / slotMs);
  const end = (Math.floor(slotAt / c.epochSlots) + 1) * c.epochSlots;
  return c.at + (end - Number(c.slot)) * slotMs;
}

/**
 * When something mined during `t` (absolute) is proven on L1: the end of its Aztec epoch plus the
 * proof. With the real clock, that end is known; without it, it is anywhere within one epoch.
 */
export function provenAt(t: Range, p: Profile, clock?: AztecClock): Range {
  if (p.epochMs === 0) return { lo: t.lo + p.proof.lo, hi: t.hi + p.proof.hi };
  if (!clock) return { lo: t.lo + p.proof.lo, hi: t.hi + p.epochMs + p.proof.hi };
  return { lo: epochEnd(t.lo, clock) + p.proof.lo, hi: epochEnd(t.hi, clock) + clock.slotSeconds * 1000 + p.proof.hi };
}

export type Leg = "fill" | "carry" | "claim" | "burn" | "proof" | "ethClaim" | "exitEpoch" | "iris" | "solClaim";

const add = (a: Range, b: Range): Range => ({ lo: a.lo + b.lo, hi: a.hi + b.hi });

/** Walks `legs` from `start` (absolute) and says when they end (absolute). */
export function walk(start: Range, legs: Leg[], p: Profile, o: { clock?: AztecClock; fill?: Range } = {}): Range {
  let t = start;
  for (const leg of legs) {
    if (leg === "proof") t = provenAt(t, p, o.clock);
    else if (leg === "fill") t = add(t, o.fill ?? { lo: 0, hi: 0 });
    else t = add(t, p[leg]);
  }
  return t;
}

/** The legs left on each route, from (and including) a leg. */
export const ROUTE: Record<"aztec" | "ethereum" | "solana-exit" | "ethereum-exit", Leg[]> = {
  aztec: ["fill", "carry", "claim"],
  ethereum: ["fill", "carry", "claim", "burn", "proof", "ethClaim"],
  "solana-exit": ["burn", "exitEpoch", "proof", "iris", "solClaim"],
  "ethereum-exit": ["burn", "proof", "ethClaim"],
};

// ---------------------------------------------------------------- batch fill

/**
 * How long a batch still waits before it can cross, or undefined when that depends on deposits
 * that have not arrived yet (the honest answer: it crosses when they do). A full batch crosses
 * at its end slot, or at the finisher's next pass once it reached the per-epoch cap.
 */
export function batchWait(o: { leaves: number; minBatch: number; cap: number; endsAt?: number; now: number }, p: Profile): Range | undefined {
  if (o.leaves < o.minBatch) return undefined;
  if (o.leaves >= o.cap || o.endsAt === undefined || o.endsAt <= o.now) return p.pass;
  const d = o.endsAt - o.now;
  return { lo: d + p.pass.lo, hi: d + p.pass.hi };
}

/**
 * Before Send: how long the notes about to be deposited would wait. Cross now (ADR 0015) sends
 * each note alone; otherwise each size's open batch must be full with the new notes in it, and a
 * second note of one size waits for a later batch (one note per batch), which nobody can time.
 */
export function sendWait(
  o: { crossNow: boolean; notes: number[]; pools: { index: number; leaves: number; minBatch: number; endsAt?: number }[]; cap: number; now: number },
  p: Profile,
): Range | undefined {
  if (o.crossNow) return p.pass;
  if (o.notes.length === 0) return undefined;
  let out: Range = { lo: 0, hi: 0 };
  const counts = new Map<number, number>();
  for (const i of o.notes) counts.set(i, (counts.get(i) ?? 0) + 1);
  for (const [i, k] of counts) {
    const pool = o.pools.find((x) => x.index === i);
    if (!pool || k > 1) return undefined;
    const w = batchWait({ leaves: pool.leaves + 1, minBatch: pool.minBatch, cap: o.cap, endsAt: pool.endsAt, now: o.now }, p);
    if (!w) return undefined;
    out = { lo: Math.max(out.lo, w.lo), hi: Math.max(out.hi, w.hi) };
  }
  return out;
}

// ---------------------------------------------------------------- the Send choice

export interface RouteTimes {
  aztec: Range;
  ethereum: Range;
  /** The batch's wait is unknown: these count from when it crosses. */
  afterBatch: boolean;
}

/** At Send: how long each destination takes from now (or from when the batch crosses). */
export function routeTimes(o: { now: number; wait?: Range; clock?: AztecClock }, p: Profile): RouteTimes {
  const known = o.wait !== undefined;
  const start = { lo: o.now, hi: o.now };
  // Counted from an unknown moment, the Aztec clock cannot place the burn in an epoch.
  const clock = known ? o.clock : undefined;
  const end = (legs: Leg[]) => {
    const t = walk(start, legs, p, { clock, fill: o.wait });
    return { lo: t.lo - o.now, hi: t.hi - o.now };
  };
  return { aztec: end(ROUTE.aztec), ethereum: end(ROUTE.ethereum), afterBatch: !known };
}

/**
 * Move out, before the burn: how long each destination takes from now. To Solana, exits cross in
 * batches of at least 4 (ADR 0009): its time counts once the batch has them.
 */
export function exitTimes(o: { now: number; clock?: AztecClock }, p: Profile): { solana: Range; ethereum: Range } {
  const start = { lo: o.now, hi: o.now };
  const end = (legs: Leg[]) => {
    const t = walk(start, legs, p, { clock: o.clock });
    return { lo: t.lo - o.now, hi: t.hi - o.now };
  };
  return { solana: end(ROUTE["solana-exit"]), ethereum: end(ROUTE["ethereum-exit"]) };
}

// ---------------------------------------------------------------- the journey

export type EtaStage = "wait" | "transit" | "arrived" | "claim" | "send-on" | "burning" | "leaving" | "exit-claim";

export interface EtaInput {
  stage: EtaStage;
  /** Where the crossing ends: the private balance, or on to Ethereum after the claim. */
  to: "aztec" | "ethereum";
  now: number;
  /** wait: the batch's wait (`batchWait`), undefined while it needs more deposits. */
  fill?: Range;
  /** claim, burning: when the proof in this page started. */
  startedAt?: number;
  /**
   * burning, leaving, exit-claim: the slowest exit. `sentAt`: when its burn went out. `full`: its
   * Solana exit batch holds enough exits to close.
   */
  exit?: { to: "solana" | "ethereum"; stage: string; sentAt?: number; full?: boolean };
  clock?: AztecClock;
}

/** What the current stage waits for, when it is a step of the chains. */
export type Step = "proof" | "iris" | "exit-epoch";

export interface Estimate {
  /** What is left of the current stage, and of the whole journey (durations). */
  stage?: Range;
  total?: Range;
  /** Part of what is left waits for other people; `total` counts from when they come. */
  afterOthers?: boolean;
  /** The stage took longer than its range. */
  late?: boolean;
  step?: Step;
}

const rel = (t: Range, now: number): Range => ({ lo: Math.max(0, t.lo - now), hi: Math.max(0, t.hi - now) });

/** `r` minus what already passed since `startedAt`; `late` once the whole range passed. */
function remaining(r: Range, startedAt: number | undefined, now: number): { r: Range; late: boolean } {
  const e = startedAt === undefined ? 0 : Math.max(0, now - startedAt);
  return { r: { lo: Math.max(0, r.lo - e), hi: Math.max(0, r.hi - e) }, late: r.hi - e <= 0 };
}

/**
 * How long is left at a stage of the journey: the current stage's part and the whole. A wait for
 * other people is never timed: the estimate then says what follows it (`afterOthers`).
 */
export function journeyEta(i: EtaInput, p: Profile): Estimate {
  const now: Range = { lo: i.now, hi: i.now };
  const ahead = (start: Range, legs: Leg[]) => rel(walk(start, legs, p, { clock: i.clock }), i.now);
  const onward: Leg[] = i.to === "ethereum" ? ROUTE["ethereum-exit"] : [];
  switch (i.stage) {
    case "wait":
      // Counted from an unknown moment, the Aztec clock cannot place the burn in an epoch.
      if (!i.fill) return { total: rel(walk(now, ["carry", "claim", ...onward], p), i.now), afterOthers: true };
      return { stage: i.fill, total: ahead(add(now, i.fill), ["carry", "claim", ...onward]) };
    case "transit":
      return { stage: p.carry, total: ahead(add(now, p.carry), ["claim", ...onward]) };
    case "arrived":
      return { stage: p.claim, total: ahead(add(now, p.claim), onward) };
    case "claim": {
      const { r, late } = remaining(p.claim, i.startedAt, i.now);
      return { stage: r, total: ahead(add(now, r), onward), late };
    }
    case "send-on":
      return { stage: p.burn, total: ahead(now, ROUTE["ethereum-exit"]) };
    case "burning": {
      const { r, late } = remaining(p.burn, i.startedAt, i.now);
      // To Solana, the exit batch then needs others: only the burn is timed.
      if (i.exit?.to === "solana") return { stage: r, total: ahead(add(now, r), ["exitEpoch", "proof", "iris", "solClaim"]), afterOthers: true, late };
      return { stage: r, total: ahead(add(now, r), ["proof", "ethClaim"]), late };
    }
    case "leaving":
      return leavingEta(i, p);
    case "exit-claim": {
      const r = i.exit?.to === "solana" ? p.solClaim : p.ethClaim;
      return { stage: r, total: r };
    }
  }
}

function leavingEta(i: EtaInput, p: Profile): Estimate {
  const x = i.exit;
  if (!x) return {};
  const now: Range = { lo: i.now, hi: i.now };
  if (x.to === "ethereum") {
    // The burn's Aztec epoch: from when it went out, or now when that is not known.
    const proven = provenAt(x.sentAt !== undefined ? { lo: x.sentAt, hi: x.sentAt } : now, p, i.clock);
    const end = add({ lo: Math.max(i.now, proven.lo), hi: Math.max(i.now, proven.hi) }, p.ethClaim);
    return { stage: rel(proven, i.now), total: rel(end, i.now), late: proven.hi <= i.now, step: "proof" };
  }
  switch (x.stage) {
    case "burned":
      if (!x.full) return { total: rel(walk(now, ["exitEpoch", "proof", "iris", "solClaim"], p, { clock: i.clock }), i.now), afterOthers: true };
      return { stage: p.exitEpoch, total: rel(walk(add(now, p.exitEpoch), ["proof", "iris", "solClaim"], p, { clock: i.clock }), i.now), step: "exit-epoch" };
    case "batched": {
      // Closed in the current Aztec epoch; or, early in an epoch, maybe in the last one with its
      // proof still on the way; or at an unknown time when the clock is not known.
      const proven = provenAt(now, p, i.clock);
      const intoEpoch = i.clock ? Number(i.clock.slot % BigInt(i.clock.epochSlots)) * i.clock.slotSeconds * 1000 + (i.now - i.clock.at) : 0;
      const at = { lo: i.clock && intoEpoch >= p.proof.hi ? proven.lo : i.now, hi: proven.hi };
      return { stage: rel(at, i.now), total: rel(walk(at, ["iris", "solClaim"], p), i.now), step: "proof" };
    }
    case "sent":
      return { stage: p.iris, total: add(p.iris, p.solClaim), step: "iris" };
    default:
      return {};
  }
}

// ---------------------------------------------------------------- words

/**
 * A duration in the app's words: "under a minute", "about 3 min", "about 8–55 min",
 * "about 40 min–1.5 h". Never more precise than the range: the ends are rounded outwards, to the
 * minute under 10 min, to 5 min under an hour, to the half hour above.
 */
export function aboutText(r: Range): string {
  const lo = r.lo / 60_000, hi = r.hi / 60_000;
  if (hi < 1) return "under a minute";
  const step = (x: number) => (x < 10 ? 1 : x < 60 ? 5 : 30);
  let a = Math.max(1, Math.floor(lo / step(lo)) * step(lo));
  let b = Math.ceil(hi / step(hi)) * step(hi);
  // A narrow range (half a step or less) is one number.
  if (hi - lo <= step(hi) / 2) {
    const mid = (lo + hi) / 2;
    a = b = Math.max(1, Math.round(mid / step(mid)) * step(mid));
  }
  const h = (m: number) => String(Math.round((m / 60) * 10) / 10);
  if (a === b) return b >= 60 ? `about ${h(b)} h` : `about ${b} min`;
  if (a >= 60) return `about ${h(a)}–${h(b)} h`;
  if (b >= 60) return `about ${a} min–${h(b)} h`;
  return `about ${a}–${b} min`;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The stage's words, with its time (`s`), or alone when it is all that is left. */
const PHRASE: Record<EtaStage | Step, { with: (s: string) => string; alone: string }> = {
  wait: { with: (s) => `it crosses in ${s}`, alone: "then it crosses" },
  transit: { with: (s) => `on Aztec in ${s}`, alone: "landing on Aztec" },
  arrived: { with: (s) => `the claim takes ${s}`, alone: "the claim is the last step" },
  claim: { with: (s) => `${s} in this tab`, alone: "keep this tab open" },
  "send-on": { with: () => "most of it is Aztec’s proof", alone: "most of it is Aztec’s proof" },
  burning: { with: (s) => `${s} in this tab`, alone: "keep this tab open" },
  leaving: { with: (s) => `${s} for this step`, alone: "on its way" },
  "exit-claim": { with: (s) => `the claim takes ${s}`, alone: "the claim is the last step" },
  proof: { with: (s) => `Aztec proves it in ${s}`, alone: "Aztec is proving it" },
  "exit-epoch": { with: (s) => `the exit batch closes in ${s}`, alone: "the exit batch closes soon" },
  iris: { with: (s) => `on Solana in ${s}`, alone: "crossing to Solana" },
};

/**
 * The journey's one line: "About 22 min left · Aztec is proving it" when the current stage is all
 * that is left, "About 30–50 min left · on Aztec in about 1–2 min" when it is a part. When what
 * follows waits for other people: "then about 3 min" (said after what it waits for), or the
 * current stage alone when it is timed. A stage past its range says so.
 */
export function etaLine(stage: EtaStage, e: Estimate): string | undefined {
  const p = PHRASE[e.step ?? stage];
  if (e.late) return e.step === "proof" ? "Aztec’s proof is taking longer than usual" : `Taking longer than usual · ${p.alone}`;
  if (e.afterOthers) return e.stage ? `${cap(aboutText(e.stage))} left · ${p.alone}` : e.total ? `then ${aboutText(e.total)}` : undefined;
  if (!e.total) return undefined;
  const total = aboutText(e.total);
  const s = e.stage ? aboutText(e.stage) : undefined;
  return !s || s === total ? `${cap(total)} left · ${p.alone}` : `${cap(total)} left · ${p.with(s)}`;
}
