/**
 * Privacy advisor (SPEC §5.6, §5.9, §10). Pure functions: the app feeds them public chain data and
 * the user's own plan, and shows the result. Nothing here talks to a network.
 *
 * Model: every note is a fixed denomination. A claim on Aztec hides which note of that denomination
 * is being claimed, among all notes that crossed (one claim contract per denomination reads every
 * registered root privately, ADR 0003). What leaks is *timing* and *amount pattern*: notes deposited
 * together, an unusual mix of denominations, a claim right after a batch lands, an exit to an address
 * that deposited.
 */

export type AnonymityLevel = "very weak" | "weak" | "moderate";
export type Severity = "info" | "caution" | "risk";

export interface Advice {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

/** Conservative thresholds on the number of notes of one denomination that have crossed. */
export const ANONYMITY_THRESHOLDS = { weak: 16, moderate: 64 } as const;

export function anonymityLevel(set: number): AnonymityLevel {
  if (set >= ANONYMITY_THRESHOLDS.moderate) return "moderate";
  if (set >= ANONYMITY_THRESHOLDS.weak) return "weak";
  return "very weak";
}

export const fmtUsd = (baseUnits: bigint) => `$${(Number(baseUnits) / 1e6).toLocaleString("en-US")}`;

/** Public state of one denomination's pool, read from the gateway's epoch accounts. */
export interface PoolStats {
  denomination: bigint;
  /** Notes in batches that were sent over CCTP: the anonymity set a claim hides in. */
  crossed: number;
  /** Batches sent. */
  batches: number;
  /** Deposits waiting in the currently open epoch. */
  openEpochLeaves: number;
  minBatch: number;
  cap: number;
}

/**
 * Splits an amount into fixed notes, largest denomination first. `remainder` is what cannot be
 * expressed in notes (it stays in the wallet). Greedy is exact for 10/100/1,000/10,000 systems.
 */
export function splitAmount(amount: bigint, denominations: bigint[], maxNotes = 32): { notes: bigint[]; remainder: bigint } {
  const ds = [...denominations].filter((d) => d > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const notes: bigint[] = [];
  let rest = amount;
  for (const d of ds) {
    while (rest >= d && notes.length < maxNotes) {
      notes.push(d);
      rest -= d;
    }
  }
  return { notes, remainder: rest };
}

export interface ScheduledNote {
  denomination: bigint;
  /** Planned deposit time, ms since epoch. */
  at: number;
}

/**
 * Spreads notes over a window so that any two deposits are at least one epoch apart (SPEC §5.6:
 * "each note in a different, randomly chosen epoch"; never 1×1,000 + 3×100 in one epoch). Times are
 * uniform subject to the minimum gap; the order of denominations is shuffled. `fits` is false when
 * the window cannot hold the notes one epoch apart; `minWindowMs` is the smallest window that can.
 *
 * Wall-clock spacing is only the plan: an under-filled epoch rolls over and keeps its id, so two
 * notes an epoch-length apart can still meet in one on-chain epoch. Callers enforce the separation
 * at deposit time with `openEpochBlocker`, against live epoch state.
 *
 * By default a window that is too short grows to `minWindowMs`. With `withinWindow`, a fixed
 * window (a scheduled crossing window such as the app's Totality) keeps every note inside it
 * instead: the notes are then spread evenly, less than an epoch apart, and `fits` stays false.
 */
export function planSchedule(
  notes: bigint[],
  o: { now: number; windowMs: number; epochMs: number; random?: () => number; withinWindow?: boolean },
): { schedule: ScheduledNote[]; fits: boolean; minWindowMs: number } {
  const rnd = o.random ?? Math.random;
  const n = notes.length;
  const minWindowMs = Math.max(0, (n - 1) * o.epochMs);
  if (n === 0) return { schedule: [], fits: true, minWindowMs };
  const fits = o.windowMs >= minWindowMs;
  const squeeze = !fits && o.withinWindow === true;
  const gap = squeeze ? Math.max(0, o.windowMs) / n : o.epochMs;
  const window = squeeze ? Math.max(0, o.windowMs) : Math.max(o.windowMs, minWindowMs);
  const slack = window - (n - 1) * gap;
  const offsets = Array.from({ length: n }, () => rnd() * slack).sort((a, b) => a - b);
  const order = [...notes];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const schedule = offsets.map((off, i) => ({ denomination: order[i]!, at: Math.round(o.now + off + i * gap) }));
  return { schedule, fits, minWindowMs };
}

const poolOf = (pools: PoolStats[], d: bigint) => pools.find((p) => p.denomination === d);

/**
 * The user's own note (index) already sitting in the open epoch of the same denomination, if any.
 * A scheduled note must wait while this returns a value, or the two share an epoch and are linked.
 */
export function openEpochBlocker(
  note: { index: number; denominationIndex: number },
  own: { index: number; denominationIndex: number; epochId?: bigint }[],
  openEpochId: bigint,
): number | undefined {
  return own.find((o) => o.index !== note.index && o.denominationIndex === note.denominationIndex && o.epochId === openEpochId)?.index;
}

/** One advice per severity for the thin pools among `ds` (so four denominations are one card). */
function thinPools(ds: bigint[], pools: PoolStats[]): Advice[] {
  const out: Advice[] = [];
  for (const severity of ["risk", "caution"] as const) {
    const hit = ds.filter((d) => thinPool(poolOf(pools, d), d)?.severity === severity);
    if (hit.length === 0) continue;
    if (hit.length === 1) {
      out.push(thinPool(poolOf(pools, hit[0]!), hit[0]!)!);
      continue;
    }
    out.push({
      id: `thin-pools-${severity}`,
      severity,
      title: `Thin pools: ${hit.map((d) => `${fmtUsd(d)} (${poolOf(pools, d)?.crossed ?? 0})`).join(", ")}`,
      detail:
        severity === "risk"
          ? `Fewer than ${ANONYMITY_THRESHOLDS.weak} notes have crossed in each; claims are easy to link to deposits by timing alone.`
          : `Fewer than ${ANONYMITY_THRESHOLDS.moderate} notes have crossed in each; spread your deposits and wait before claiming.`,
    });
  }
  return out;
}

function thinPool(pool: PoolStats | undefined, d: bigint): Advice | undefined {
  const set = pool?.crossed ?? 0;
  const level = anonymityLevel(set);
  if (level === "moderate") return undefined;
  return {
    id: `thin-${d}`,
    severity: level === "very weak" ? "risk" : "caution",
    title: `Thin ${fmtUsd(d)} pool: ${set} note${set === 1 ? "" : "s"} crossed`,
    detail:
      level === "very weak"
        ? `With fewer than ${ANONYMITY_THRESHOLDS.weak} notes, a claim is easy to link to a deposit by timing alone.`
        : `Fewer than ${ANONYMITY_THRESHOLDS.moderate} notes have crossed; spread your deposits and wait before claiming.`,
  };
}

export function adviseShield(input: {
  notes: bigint[];
  mode: "now" | "spread";
  pools: PoolStats[];
  scheduleFits?: boolean;
  minWindowMs?: number;
}): Advice[] {
  const out: Advice[] = [];
  const distinct = [...new Set(input.notes)];
  if (input.mode === "now" && input.notes.length > 1) {
    out.push({
      id: "same-epoch",
      severity: "risk",
      title: `${input.notes.length} notes would enter the same epochs together`,
      detail: "Deposits made together are linked by timing: an observer who sees them arrive at once can tie the later claims together. Spread them across epochs.",
    });
  }
  if (input.mode === "now" && distinct.length > 1) {
    out.push({
      id: "amount-pattern",
      severity: "risk",
      title: "Recognisable amount pattern",
      detail: `${input.notes.map(fmtUsd).join(" + ")} at once is a fingerprint. Never cross a mix such as 1 × $1,000 + 3 × $100 in one go.`,
    });
  }
  out.push(...thinPools(distinct, input.pools));
  const opening = distinct.filter((d) => {
    const p = poolOf(input.pools, d);
    return p !== undefined && p.openEpochLeaves === 0 && p.minBatch > 1;
  });
  if (opening.length > 0) {
    const minBatch = poolOf(input.pools, opening[0]!)!.minBatch;
    out.push({
      id: "first-in-epoch",
      severity: "info",
      title: `You would open the next ${opening.map(fmtUsd).join(", ")} epoch${opening.length > 1 ? "s" : ""}`,
      detail: `An epoch sends only once ${minBatch} deposits have arrived; until then it rolls over and your note waits.`,
    });
  }
  if (input.mode === "spread") {
    const repeated = distinct.filter((d) => input.notes.filter((n) => n === d).length > 1);
    if (repeated.length > 0) {
      out.push({
        id: "rollover-hold",
        severity: "info",
        title: "Each note waits for its own epoch",
        detail: `Thin epochs roll over and stay open. A scheduled ${repeated.map(fmtUsd).join(", ")} note is held while another of yours is still in the open epoch, so no two share one.`,
      });
    }
    if (input.scheduleFits === false && input.minWindowMs !== undefined) {
      out.push({
        id: "window-short",
        severity: "caution",
        title: "Window too short for one note per epoch",
        detail: `Widen the window to at least ${Math.ceil(input.minWindowMs / 3_600_000)} h so no two notes share an epoch.`,
      });
    }
    out.push({
      id: "scheduled-needs-you",
      severity: "info",
      title: "Scheduled deposits need you",
      detail: "There is no Eclyps server. Each scheduled note is deposited when it is due and this page is open, with your wallet's signature.",
    });
  }
  return out;
}

export function adviseClaim(input: {
  denomination: bigint;
  epochId: bigint;
  /** Newest sent epoch of this denomination. */
  latestSentEpoch?: bigint;
  pool?: PoolStats;
}): Advice[] {
  const out: Advice[] = [];
  const t = thinPool(input.pool, input.denomination);
  if (t) out.push(t);
  if (input.latestSentEpoch !== undefined && input.epochId === input.latestSentEpoch) {
    out.push({
      id: "newest-batch",
      severity: "caution",
      title: "Your batch is the newest one",
      detail: `Claiming right after it lands suggests your note is one of its notes. Waiting for another ${fmtUsd(input.denomination)} batch widens the set to every note that crossed.`,
    });
  }
  if (out.length === 0) {
    out.push({
      id: "claim-ok",
      severity: "info",
      title: `Hidden among ${input.pool?.crossed ?? 0} notes`,
      detail: "The claim proves membership in some batch of this denomination without revealing which note or which batch.",
    });
  }
  return out;
}

export function adviseExit(input: {
  destination?: string;
  /** Solana addresses that deposited into Eclyps from this vault. */
  depositWallets: string[];
  now: number;
  /** Most recent claim time from this vault (ms). */
  lastClaimAt?: number;
  notes: bigint[];
}): Advice[] {
  const out: Advice[] = [];
  if (input.destination && input.depositWallets.includes(input.destination)) {
    out.push({
      id: "same-wallet",
      severity: "risk",
      title: "This address deposited",
      detail: "Exiting to a wallet that funded your deposits links entry and exit directly. Use a fresh address.",
    });
  }
  if (input.lastClaimAt !== undefined && input.now - input.lastClaimAt < 6 * 3_600_000) {
    out.push({
      id: "exit-soon",
      severity: "caution",
      title: "You claimed recently",
      detail: "An exit shortly after a claim is linked by timing. Waiting hours to days helps.",
    });
  }
  if (new Set(input.notes).size > 1) {
    out.push({
      id: "exit-pattern",
      severity: "caution",
      title: "Mixed exit",
      detail: `Exiting ${input.notes.map(fmtUsd).join(" + ")} together repeats an amount pattern. Exit notes separately over time.`,
    });
  }
  return out;
}

/** Looks for linkage in the user's own note book: notes sharing an epoch, or different denominations
 * deposited within one epoch of each other (an amount pattern). */
export function auditNotes(
  notes: { index: number; denominationIndex: number; denomination: bigint; epochId?: bigint; depositedAt?: number }[],
  epochMs: number,
): Advice[] {
  const out: Advice[] = [];
  const deposited = notes.filter((n) => n.epochId !== undefined);
  const groups = new Map<string, typeof deposited>();
  for (const n of deposited) {
    const k = `${n.denominationIndex}:${n.epochId}`;
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  for (const [k, g] of groups) {
    if (g.length > 1) {
      out.push({
        id: `shared-epoch-${k}`,
        severity: "risk",
        title: `${g.length} of your ${fmtUsd(g[0]!.denomination)} notes share epoch ${g[0]!.epochId}`,
        detail: `Notes ${g.map((n) => `#${n.index}`).join(", ")} entered together; claim them far apart in time, or they can be linked to each other.`,
      });
    }
  }
  const timed = deposited.filter((n) => n.depositedAt !== undefined).sort((a, b) => a.depositedAt! - b.depositedAt!);
  for (let i = 1; i < timed.length; i++) {
    const a = timed[i - 1]!;
    const b = timed[i]!;
    if (a.denomination !== b.denomination && b.depositedAt! - a.depositedAt! < epochMs) {
      out.push({
        id: `mixed-${a.index}-${b.index}`,
        severity: "caution",
        title: `Notes #${a.index} and #${b.index} were deposited close together`,
        detail: `${fmtUsd(a.denomination)} and ${fmtUsd(b.denomination)} within one epoch form an amount pattern. Space future deposits out.`,
      });
    }
  }
  return out;
}
