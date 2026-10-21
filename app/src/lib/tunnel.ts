/**
 * The bridge screen as a journey through the tunnel (ADR 0007, amended 2026-10-16): which crossing
 * the screen follows, where it is, and the one or two lines it says, all from the state the app
 * already tracks (the vault's notes and exits joined with public chain state, src/lib/portfolio.ts
 * and src/lib/exit-status.ts). Nothing here invents progress: a stage moves only when a real state
 * does, and every count is read from the chain.
 *
 *   amount      nothing in flight: an amount, Send
 *   sign        a deposit of this crossing is due: the user signs it
 *   scheduled   deposits planned for later (the eclipse, or a spread plan)
 *   wait        in the open batch, waiting for others to fill it
 *   transit     the batch closed or was sent through CCTP: crossing
 *   arrived     registered on Aztec: ready to claim
 *   claim       a claim is running
 *   claimed     in the private balance
 *   burning     moving out: the wallet proves the burn on Aztec
 *   leaving     burned; the exit is on its way to Solana or Ethereum
 *   exit-claim  the exit can be claimed at its destination
 *   out         paid at the destination
 *
 * Pure (type imports only), so `node --test test/tunnel.test.ts` runs it as it is.
 */
import type { ExitFacts, ExitStage } from "./exit-status";
import type { NoteView, PoolView } from "./portfolio";
import type { Hold } from "./tunnel-scene";

export type { Hold };

export type TunnelStage =
  | "amount"
  | "sign"
  | "scheduled"
  | "wait"
  | "transit"
  | "arrived"
  | "claim"
  | "claimed"
  | "burning"
  | "leaving"
  | "exit-claim"
  | "out";

/** The fields of a note the journey reads. */
export type JourneyNote = Pick<NoteView, "index" | "stage" | "due" | "denomination" | "denominationIndex"> &
  Partial<Pick<NoteView, "epochId" | "epochLeaves" | "epochEndSlot" | "scheduledAt" | "heldBy" | "claimedAt" | "refundedAt" | "depositedAt" | "refund" | "fee">>;

/** One exit of the journey's notes, with where it is (exit-status.ts). */
export interface JourneyExit {
  id: string;
  note: number;
  to: "solana" | "ethereum";
  destination: string;
  denomination: string;
  stage: ExitStage;
  facts: ExitFacts;
  sentAt?: number;
  claimedAt?: number;
}

/** A finished journey (claimed, or moved out and paid) is followed for this long after its last step. */
export const STALE_MS = 12 * 3_600_000;

const CROSSING = new Set(["scheduled", "queued", "batched", "sent", "claimable"]);

/**
 * Where the journey is. The crossing waits for its slowest note (a note still in the wallet or in
 * the open batch holds the camera there); once every note is on Aztec, an exit in progress leads;
 * then the balance; then, all moved out, the destination. A claim in progress comes first: the user
 * just asked for it.
 */
export function journeyStage(notes: JourneyNote[], exits: JourneyExit[] = [], o: { claiming?: boolean } = {}): TunnelStage {
  const live = notes.filter((n) => n.stage !== "refunded");
  if (live.length === 0) return "amount";
  if (o.claiming) return "claim";
  const crossing = live.filter((n) => CROSSING.has(n.stage));
  if (crossing.length) {
    const stages = new Set(crossing.map((n) => n.stage));
    if (stages.has("scheduled")) return crossing.some((n) => n.stage === "scheduled" && n.due) ? "sign" : "scheduled";
    if (stages.has("queued")) return "wait";
    if (stages.has("batched") || stages.has("sent")) return "transit";
    return "arrived";
  }
  const open = exits.filter((x) => x.stage !== "paid");
  if (open.length) {
    if (open.some((x) => x.stage === "burning")) return "burning";
    if (open.some((x) => x.stage === "burned" || x.stage === "batched" || x.stage === "sent")) return "leaving";
    return "exit-claim";
  }
  if (live.some((n) => n.stage === "claimed")) return "claimed";
  return "out";
}

export const finished = (s: TunnelStage) => s === "claimed" || s === "out" || s === "amount";

/** The last thing that happened to a journey (ms). */
export function lastActivity(createdAt: number, notes: JourneyNote[], exits: JourneyExit[] = []): number {
  return Math.max(createdAt, ...notes.flatMap((n) => [n.depositedAt ?? 0, n.claimedAt ?? 0, n.refundedAt ?? 0]), ...exits.flatMap((x) => [x.sentAt ?? 0, x.claimedAt ?? 0]));
}

export interface JourneyCandidate {
  id: string;
  kind: string;
  createdAt: number;
  notes: JourneyNote[];
}

/** The newest crossing made from the bridge that still holds a note (not all taken back). */
export function newestJourney<T extends JourneyCandidate>(transfers: T[]): T | undefined {
  const own = transfers.filter((t) => t.kind !== "recovered" && t.kind !== "earlier" && t.notes.some((n) => n.stage !== "refunded"));
  return [...own].sort((a, b) => b.createdAt - a.createdAt)[0];
}

/**
 * The crossing the bridge screen follows: the newest one made from the bridge (notes found from
 * the phrase and notes from before transfers live on Balance only). A finished one is followed for
 * `STALE_MS` after its last step; after that the screen opens on a new amount.
 */
export function pickJourney<T extends JourneyCandidate>(transfers: T[], exitsOf: (t: T) => JourneyExit[], now: number): T | undefined {
  const t = newestJourney(transfers);
  if (!t) return undefined;
  const ex = exitsOf(t);
  const stage = journeyStage(t.notes, ex);
  if ((stage === "claimed" || stage === "out") && now - lastActivity(t.createdAt, t.notes, ex) > STALE_MS) return undefined;
  return t;
}

/** The screen's hold for a stage, and for the steps that live only on this page (after Send). */
export function holdOf(stage: TunnelStage | "decide" | "depositing" | "move"): Hold {
  switch (stage) {
    case "amount":
      return "amount";
    case "decide":
    case "depositing":
      return "decide";
    case "sign":
    case "scheduled":
    case "wait":
      return "wait";
    case "transit":
      return "transit";
    case "arrived":
      return "arrived";
    case "claim":
      return "claim";
    case "claimed":
    case "move":
    case "burning":
      return "claimed";
    case "leaving":
    case "exit-claim":
      return "outwait";
    case "out":
      return "out";
  }
}

// ---------------------------------------------------------------- the crowd

/** Your own notes sitting in a denomination's open batch. */
const mineInOpen = (own: JourneyNote[], p: Pick<PoolView, "index" | "openEpochId">) =>
  own.filter((n) => n.stage === "queued" && n.denominationIndex === p.index && n.epochId !== undefined && BigInt(n.epochId) === p.openEpochId).length;

/**
 * Other people's notes in the open batches of these denominations, read from the chain: the open
 * epoch's leaves minus your own notes in it. One entry per denomination, in pool order.
 */
export function othersInOpen(pools: Pick<PoolView, "index" | "denomination" | "openEpochId" | "openEpochLeaves">[], own: JourneyNote[], indices: number[]): { index: number; denomination: bigint; epochId: bigint; count: number }[] {
  const want = new Set(indices);
  return pools
    .filter((p) => want.has(p.index))
    .map((p) => ({ index: p.index, denomination: p.denomination, epochId: p.openEpochId, count: Math.max(0, p.openEpochLeaves - mineInOpen(own, p)) }));
}

/** "You're the only one crossing right now." Counted in notes: one person may hold several. */
export function crowdLine(others: number): string {
  if (others <= 0) return "You’re the only one crossing right now.";
  return others === 1 ? "1 other note crossing right now." : `${others.toLocaleString("en-US")} other notes crossing right now.`;
}

/**
 * The batch the journey waits for: among its notes in an open batch, the one with the fewest
 * deposits (the last to cross).
 */
export function slowestBatch<T extends JourneyNote>(notes: T[]): T | undefined {
  return notes
    .filter((n) => n.stage === "queued")
    .sort((a, b) => (a.epochLeaves ?? 0) - (b.epochLeaves ?? 0) || a.index - b.index)[0];
}

// ---------------------------------------------------------------- the far side

/**
 * The light on the far ring, as note sizes (denomination indices): `crowd` crossed before this
 * journey's batches, `batch` crossed with them (your notes and the others in those batches, all
 * equally bright). Counts come from the chain: a pool's notes in sent epochs, and each batch's
 * leaves. Capped for drawing; the cap never adds a point.
 */
export function farLight(
  notes: JourneyNote[],
  pools: Pick<PoolView, "index" | "crossed">[],
  cap = { crowd: 200, batch: 64 },
): { crowd: number[]; batch: number[] } {
  const epochs = new Map<string, { index: number; leaves: number; sent: boolean }>();
  for (const n of notes) {
    if (n.epochId === undefined || n.stage === "refunded" || n.stage === "scheduled") continue;
    const sent = n.stage === "sent" || n.stage === "claimable" || n.stage === "claimed" || n.stage === "exited";
    epochs.set(`${n.denominationIndex}:${n.epochId}`, { index: n.denominationIndex, leaves: n.epochLeaves ?? 1, sent });
  }
  const batch: number[] = [];
  const inCrossed = new Map<number, number>();
  for (const e of epochs.values()) {
    for (let k = 0; k < e.leaves; k++) batch.push(e.index);
    if (e.sent) inCrossed.set(e.index, (inCrossed.get(e.index) ?? 0) + e.leaves);
  }
  const indices = new Set([...notes.map((n) => n.denominationIndex)]);
  const crowd: number[] = [];
  for (const p of pools) {
    if (!indices.has(p.index)) continue;
    const before = Math.max(0, p.crossed - (inCrossed.get(p.index) ?? 0));
    for (let k = 0; k < before; k++) crowd.push(p.index);
  }
  return { crowd: thin(crowd, cap.crowd), batch: thin(batch, cap.batch) };
}

/** At most `n` items, keeping the mix of sizes. */
function thin(xs: number[], n: number): number[] {
  if (xs.length <= n) return xs;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor((i * xs.length) / n)]!);
  return out;
}

// ---------------------------------------------------------------- words

/** Local copy of deployment.ts `usd`, so this file runs in node tests. */
const usd = (base: string | bigint) => `$${(Number(BigInt(base)) / 1e6).toLocaleString("en-US")}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** How long until something, in the eclipse's words: "2d 04h", "4h 12m", "12m", "under a minute". */
export function inText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${pad(h)}h`;
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m`;
  return "under a minute";
}

export interface Lines {
  l1: string;
  l2?: string;
}

/**
 * Waiting in the open batch: how full the slowest batch is and what makes it cross. `endsAt` is
 * when its epoch can close (from the slot clock), `multi` when the journey holds several sizes.
 */
export function waitLines(n: JourneyNote, o: { minBatch: number; multi: boolean; endsAt?: number; now: number; at?: (ms: number) => string }): Lines {
  if (n.refund?.refundable) return { l1: "Your batch did not fill in a day.", l2: `You can take back ${usdCents(BigInt(n.denomination) + (n.fee ?? 0n))}.` };
  const k = n.epochLeaves ?? 0;
  const head = o.multi ? `Your ${usd(n.denomination)} batch` : "Your batch";
  const l1 = `${head}: ${k} of ${o.minBatch} deposits.`;
  if (k < o.minBatch) {
    const left = o.minBatch - k;
    return { l1, l2: `It crosses when ${left} more ${left === 1 ? "arrives" : "arrive"}.` };
  }
  if (o.endsAt !== undefined && o.endsAt > o.now) return { l1, l2: `It can cross from ${o.at ? o.at(o.endsAt) : new Date(o.endsAt).toISOString().slice(11, 16)}.` };
  return { l1, l2: "It crosses as soon as anyone sends it." };
}

/** Local copy of deployment.ts `usdExact`. */
function usdCents(b: bigint): string {
  const whole = (b / 1_000_000n).toLocaleString("en-US");
  const frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac.padEnd(2, "0")}` : `$${whole}`;
}

/** Crossing: what it waits for. */
export function transitLine(notes: JourneyNote[], aztecOpen: boolean): string {
  if (notes.some((n) => n.stage === "batched")) return "Waiting for anyone to send the batch.";
  return aztecOpen ? "It lands on Aztec within minutes." : "Open Aztec to see it land.";
}

/**
 * Moving out: what the slowest exit waits for. Aztec proves epochs slowly on its testnet (about
 * 40 to 75 minutes), and the line says so there.
 */
export function leavingLine(x: JourneyExit, o: { testnet: boolean; canRead: boolean }): string {
  const proving = o.testnet ? ": about 40–75 min on testnet." : ".";
  if (x.to === "ethereum") return x.stage === "burned" ? `Aztec is proving it${proving}` : "It is on its way.";
  if (!o.canRead) return "Open Aztec to follow it.";
  switch (x.stage) {
    case "burned": {
      const left = x.facts.minBatch !== undefined && x.facts.inEpoch !== undefined ? Math.max(0, x.facts.minBatch - x.facts.inEpoch) : undefined;
      return left ? `Waiting for ${left} more ${left === 1 ? "exit" : "exits"} to fill the batch.` : "The batch closes soon.";
    }
    case "batched":
      return `Aztec is proving the batch${proving}`;
    case "sent":
      return "Crossing to Solana.";
    default:
      return "It is on its way.";
  }
}

/**
 * Under a destination choice (Send, Move out), one line on what the chosen one means: the private
 * balance is the end; Ethereum waits mostly for Aztec's proof; Solana exits leave in batches.
 * `afterOthers`: the times shown start once others fill the batch.
 */
export function destNote(to: "aztec" | "ethereum" | "solana", afterOthers: boolean, minExitBatch = 4): string {
  if (to === "solana") return `Times start once ${minExitBatch} exits fill the batch.`;
  const head = to === "aztec" ? "Ends in your private balance." : "Most of the wait is Aztec’s proof.";
  return afterOthers ? `${head} Times start once your batch crosses.` : head;
}

/** A wait for others, then how long after them: "It crosses when 3 more arrive · then about 3 min". */
export function thenLine(line: string, then?: string): string {
  return then ? `${line.replace(/\.$/, "")} · ${then}` : line;
}

/** The exit the journey waits for: the least advanced one still open. */
export function slowestExit(exits: JourneyExit[]): JourneyExit | undefined {
  const order: ExitStage[] = ["burning", "burned", "batched", "proven", "sent", "arrived", "paid"];
  return exits.filter((x) => x.stage !== "paid").sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))[0];
}

/**
 * Fast exits (ADR 0017): which notes the liquidity pool can front now. Largest first, each
 * advancing its note minus the pool's fee, until the pool's capacity runs out; the rest take the
 * normal path. `fee` is what the fast notes pay in all.
 */
export function fastPlan<T extends { denomination: string }>(notes: T[], capacity: bigint, feeBps: number): { fast: T[]; wait: T[]; fee: bigint } {
  const fast: T[] = [];
  const wait: T[] = [];
  let left = capacity;
  let fee = 0n;
  for (const n of [...notes].sort((a, b) => (BigInt(b.denomination) > BigInt(a.denomination) ? 1 : BigInt(b.denomination) < BigInt(a.denomination) ? -1 : 0))) {
    const d = BigInt(n.denomination);
    const f = (d * BigInt(feeBps)) / 10_000n;
    if (d - f <= left) {
      fast.push(n);
      left -= d - f;
      fee += f;
    } else {
      wait.push(n);
    }
  }
  return { fast, wait, fee };
}

/** What reached the destination: the note, or the note minus the front fee when it was fronted. */
const received = (x: JourneyExit) => x.facts.frontedAdvanced ?? BigInt(x.denomination);

/** "$100 at 7xKX…sAsU", "$110 sent to 0x5290…9EE7": where the money went. */
export function outLine(exits: JourneyExit[]): string {
  const total = exits.reduce((a, x) => a + received(x), 0n);
  const dests = [...new Set(exits.map((x) => x.destination))];
  const short = (s: string) => (s.length > 11 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
  if (dests.length !== 1) return `${usdCents(total)} moved out.`;
  return exits[0]!.to === "ethereum" ? `${usdCents(total)} sent to ${short(dests[0]!)}` : `${usdCents(total)} at ${short(dests[0]!)}`;
}

/** What a failed action shows: one short line, and the reason behind Details when it differs. */
export interface Failure {
  line: string;
  why?: string;
}

/**
 * A failed action in one short line (minimal text). A short, plain reason written for
 * people ("Already claimed, maybe from another device…") is the line itself; a long or technical
 * one ("Invalid tx: Block header not found") becomes `failed` ("Claim failed. Try again."), and
 * the reason waits behind Details. Without `failed`, the reason is the line.
 */
export function failure(e: unknown, failed?: string): Failure {
  const why = (e instanceof Error ? e.message : String(e ?? "")).trim();
  if (!failed) return { line: why || "Something went wrong. Try again." };
  const technical =
    why.length > 100 ||
    /0x[0-9a-f]{6,}|[{}[\]<>]|\bat \S+:\d+/i.test(why) ||
    /\b[A-Z][A-Z_]{4,}\b|\w+Error\b|Invalid tx/.test(why);
  return technical || !why ? { line: failed, why: why || undefined } : { line: why };
}
