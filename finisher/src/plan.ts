/**
 * The testnet finisher's record and the rules that decide what to do next. No I/O: every function
 * here is pure (time is passed in), so it is unit-tested (test/plan.test.ts).
 *
 * A batch moves send -> relay -> register -> done. The record only remembers what is slow or
 * costly to find again (the burn signature, Circle's attested message, the L1->L2 message); before
 * each action the finisher checks the chains, so a lost or stale record never causes a double
 * send, relay or register.
 */

export const STATE_VERSION = 1;

export interface Batch {
  /** USDC base units. */
  denomination: string;
  /** Denomination index in the gateway config. */
  index: number;
  epochId: string;
  /** 0x-prefixed field, from the closed epoch. */
  root?: string;
  leafCount?: number;
  /** The epoch is Sent on Solana (by this finisher or another). */
  sent?: boolean;
  /** send_batch: the CCTP burn carrying the batch hook. */
  burnSig?: string;
  sentByUs?: boolean;
  /** This finisher's share of the batch's fees (USDC base units), when it sent the batch. */
  reward?: string;
  /** Circle's attested message and attestation (public). */
  message?: string;
  attestation?: string;
  /** EclypsPortal.relay sent by this finisher, before its receipt is known. */
  relayTx?: string;
  relaySubmittedAt?: number;
  relayedByUs?: boolean;
  /** The L1->L2 message the portal sent to the batch's claim contract. */
  l1ToL2Hash?: string;
  l1ToL2Index?: string;
  /** EclypsClaim.register_batch sent by this finisher, before its receipt is known. */
  registerTx?: string;
  registerSubmittedAt?: number;
  registeredByUs?: boolean;
  registered?: boolean;
  /** Retry bookkeeping for the batch's current step. */
  failures?: number;
  retryAt?: number;
  lastError?: string;
}

export interface FinisherState {
  version: number;
  /** The deployment this record belongs to: gateway config account and portal. */
  config: string;
  portal: string;
  batches: Record<string, Batch>;
  /** Per denomination: every epoch below this id is carried across. */
  doneBelow: Record<string, string>;
  /** Per denomination: every express batch below this counter is carried across (ADR 0015). */
  expressDoneBelow?: Record<string, string>;
  /** Sepolia block where the portal was deployed: log searches start there. */
  portalBlock?: string;
  /** Rollovers this finisher paid for, and their fees (lamports). */
  rollovers?: { count: number; lamports: string };
  /** Exits (ADR 0009), when the deployment has them on: see ExitState below. */
  exits?: ExitState["exits"];
  exitsDoneBelow?: ExitState["exitsDoneBelow"];
  closing?: ExitState["closing"];
  closeHeld?: ExitState["closeHeld"];
  exitLookupTable?: string;
}

export type Stage = "send" | "relay" | "register" | "done";

export const emptyState = (config: string, portal: string): FinisherState => ({
  version: STATE_VERSION,
  config,
  portal: portal.toLowerCase(),
  batches: {},
  doneBelow: {},
});

/** Whether a saved record belongs to this deployment (a redeploy starts a new record). */
export const stateMatches = (s: Partial<FinisherState>, config: string, portal: string) =>
  s.version === STATE_VERSION && s.config === config && s.portal === portal.toLowerCase();

export const batchKey = (denomination: bigint | string, epochId: bigint | string) => `${denomination}:${epochId}`;

export function stageOf(b: Batch): Stage {
  if (b.registered) return "done";
  if (b.l1ToL2Hash) return "register";
  if (b.sent || b.burnSig || b.relayTx) return "relay";
  return "send";
}

/** A relay whose receipt has not appeared after this long is considered dropped. */
export const RELAY_STUCK_MS = 10 * 60_000;
export const relayStuck = (b: Batch, now: number) => Boolean(b.relayTx) && now - (b.relaySubmittedAt ?? 0) >= RELAY_STUCK_MS;

export type CloseAction = "close" | "rollover" | "none";

/**
 * What close_epoch would do for the current epoch of a denomination, and whether to send it:
 * - "close": open, at least the batch minimum, and ended or full. It computes the root.
 * - "rollover": open, ended, and holding fewer than the minimum but at least one deposit. The
 *   epoch keeps its id and gets a new end slot; its first rollover starts the refund clock
 *   (ADR 0010), so a lone deposit can be taken back. Once per end: after a rollover the end slot
 *   is in the future again, so the next pass does nothing until it passes.
 * - "none": not open, empty, or not ended (and not full).
 */
export function closeAction(
  epoch: { status: string; endSlot: bigint; leaves: readonly unknown[] },
  slot: bigint,
  params: { minBatchSize: number; perEpochCap: number },
  maxLeaves = 256,
): CloseAction {
  const n = epoch.leaves.length;
  if (epoch.status !== "Open" || n === 0) return "none";
  const ended = slot >= epoch.endSlot;
  if (n >= params.minBatchSize) return ended || n >= Math.min(params.perEpochCap, maxLeaves) ? "close" : "none";
  return ended ? "rollover" : "none";
}

export function recordRollover(s: FinisherState, lamports: bigint) {
  const r = (s.rollovers ??= { count: 0, lamports: "0" });
  r.count++;
  r.lamports = (BigInt(r.lamports) + lamports).toString();
}

/** The finisher's share of a batch's fees, as send_batch pays it (ADR 0012). */
export const finisherReward = (denomination: bigint, finisherBps: number, leafCount: number): bigint =>
  BigInt(leafCount) * ((denomination * BigInt(finisherBps)) / 10_000n);

// ---------- retries ----------

export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 30 * 60_000;

/** Exponential backoff: 30 s, 1 min, 2 min, … capped at 30 min. */
export const backoffMs = (failures: number, base = RETRY_BASE_MS, max = RETRY_MAX_MS) =>
  Math.min(max, base * 2 ** Math.max(0, Math.min(failures - 1, 20)));

export const isDue = (r: { retryAt?: number }, now: number) => !r.retryAt || now >= r.retryAt;

/** Records a failed attempt; returns the delay before the next one. */
export function recordFailure(
  r: { failures?: number; retryAt?: number; lastError?: string },
  now: number,
  error: string,
  maxMs = RETRY_MAX_MS,
): number {
  r.failures = (r.failures ?? 0) + 1;
  const wait = backoffMs(r.failures, RETRY_BASE_MS, maxMs);
  r.retryAt = now + wait;
  r.lastError = error.slice(0, 200);
  return wait;
}

export function recordSuccess(r: { failures?: number; retryAt?: number; lastError?: string }) {
  delete r.failures;
  delete r.retryAt;
  delete r.lastError;
}

/** Moves the per-denomination watermark past every batch that is carried across. */
export function advanceDone(s: FinisherState, denomination: string): bigint {
  let id = BigInt(s.doneBelow[denomination] ?? "0");
  while (s.batches[batchKey(denomination, id)]?.registered) id++;
  s.doneBelow[denomination] = id.toString();
  return id;
}

/** Epoch ids to look at for a denomination: from the watermark up to (not including) the current one. */
export function epochsToCarry(s: FinisherState, denomination: string, current: bigint): bigint[] {
  const out: bigint[] = [];
  for (let id = BigInt(s.doneBelow[denomination] ?? "0"); id < current; id++) out.push(id);
  return out;
}

// ---------- express batches (ADR 0015) ----------

/**
 * Express epoch ids carry the top bit (the gateway's EXPRESS_EPOCH_BIT), so an express batch is
 * a batch like any other from send on: its record sits in `batches` under its own id, and the
 * relay and register steps carry it unchanged. Only finding and sending it differ.
 */
export const EXPRESS_BIT = 1n << 63n;
export const isExpress = (epochId: bigint | string) => (BigInt(epochId) & EXPRESS_BIT) !== 0n;

/** Express ids to look at: from the per-denomination counter watermark up to `next` (Lanes). */
export function expressToCarry(s: Pick<FinisherState, "expressDoneBelow">, denomination: string, next: bigint): bigint[] {
  const out: bigint[] = [];
  for (let k = BigInt(s.expressDoneBelow?.[denomination] ?? "0"); k < next; k++) out.push(EXPRESS_BIT | k);
  return out;
}

/** Moves the express watermark past every express batch carried across. */
export function advanceExpressDone(s: Pick<FinisherState, "expressDoneBelow" | "batches">, denomination: string): bigint {
  const done = (s.expressDoneBelow ??= {});
  let k = BigInt(done[denomination] ?? "0");
  while (s.batches[batchKey(denomination, EXPRESS_BIT | k)]?.registered) k++;
  done[denomination] = k.toString();
  return k;
}

/** What send_express_batch pays the finisher: its share of the note's fee plus the express fee. */
export const expressReward = (x: { finisherFee: bigint; expressFee: bigint }) => x.finisherFee + x.expressFee;

/** While a batch waits on Circle or Aztec, look again sooner than the idle interval. */
export const BUSY_INTERVAL_MS = 15_000;
export function nextDelayMs(s: FinisherState, intervalMs: number): number {
  const busy = Object.values(s.batches).some((b) => {
    const st = stageOf(b);
    return st === "relay" || st === "register";
  });
  return busy ? Math.min(intervalMs, BUSY_INTERVAL_MS) : intervalMs;
}

// ---------- summary ----------

export interface Summary {
  sentByUs: number;
  earned: bigint;
  carried: number;
  inFlight: number;
  rollovers: number;
  rolloverLamports: bigint;
}

export function summarize(s: FinisherState): Summary {
  let sentByUs = 0, carried = 0, inFlight = 0;
  let earned = 0n;
  for (const b of Object.values(s.batches)) {
    if (b.sentByUs) {
      sentByUs++;
      earned += BigInt(b.reward ?? "0");
    }
    const st = stageOf(b);
    if (st === "done") carried++;
    else if (st !== "send") inFlight++;
  }
  return {
    sentByUs, earned, carried, inFlight,
    rollovers: s.rollovers?.count ?? 0, rolloverLamports: BigInt(s.rollovers?.lamports ?? "0"),
  };
}

/** "earned $0.012 from 1 batch · 0 carried across · 1 on the way · 2 rollovers (0.00001 SOL)" */
export function summaryLine(x: Summary): string {
  const plural = (n: number, w: string, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
  let line = `earned ${usd(x.earned)} from ${plural(x.sentByUs, "batch", "batches")} sent · ${x.carried} carried across · ${x.inFlight} on the way`;
  if (x.rollovers > 0) line += ` · ${plural(x.rollovers, "rollover")} (${fmtUnits(x.rolloverLamports, 9, 9)} SOL)`;
  return line;
}

/** USDC base units as dollars: at least 2 decimals, up to 6, no trailing zeros beyond 2. */
export function usd(base: bigint): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const whole = v / 1_000_000n;
  let frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${frac}`;
}

/** "$1", "$1,000", "$2.50": a note size. */
export const sizeName = (denomination: bigint | string) => {
  const d = BigInt(denomination);
  return d % 1_000_000n === 0n ? `$${(d / 1_000_000n).toLocaleString("en-US")}` : usd(d);
};

/** "$1 #3": a batch (a denomination's epoch) as the logs name it. */
export const batchName = (b: Pick<Batch, "denomination" | "epochId">) =>
  isExpress(b.epochId) ? `${sizeName(b.denomination)} express #${BigInt(b.epochId) & ~EXPRESS_BIT}` : `${sizeName(b.denomination)} #${b.epochId}`;

// ---------- balances ----------

export const LOW_SOL_LAMPORTS = 50_000_000n; // 0.05 SOL
export const LOW_ETH_WEI = 5_000_000_000_000_000n; // 0.005 ETH
/** send_batch pays the MessageSent rent (≈ 0.0042 SOL) and fees: keep a margin. */
export const SEND_MIN_LAMPORTS = 6_000_000n;

export function lowBalances(b: { lamports: bigint; wei: bigint }, eth = "Sepolia ETH"): string[] {
  const out: string[] = [];
  if (b.lamports < LOW_SOL_LAMPORTS) out.push(`low SOL: ${fmtUnits(b.lamports, 9)} (< 0.05); each batch sent costs about 0.005 SOL`);
  if (b.wei < LOW_ETH_WEI) out.push(`low ${eth}: ${fmtUnits(b.wei, 18)} (< 0.005); each relay costs gas`);
  return out;
}

/** Integer amount with `decimals` as a short decimal string (up to `shown` decimals, default 4). */
export function fmtUnits(v: bigint, decimals: number, shown = 4): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).slice(0, shown).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ---------- Iris (Circle's attestation API) ----------

export type IrisReply =
  | { kind: "attested"; message: `0x${string}`; attestation: `0x${string}` }
  | { kind: "pending"; status: string }
  | { kind: "rate-limited"; retryAfterMs: number }
  | { kind: "error"; status: number; detail: string };

/** Circle blocks a client for 5 minutes after it exceeds 35 requests per second. */
export const IRIS_BLOCK_MS = 5 * 60_000;

/** Reads one GET /v2/messages/{domain}?transactionHash= reply. */
export function readIris(httpStatus: number, body: unknown, retryAfter?: string | null): IrisReply {
  if (httpStatus === 429) {
    const secs = Number(retryAfter);
    return { kind: "rate-limited", retryAfterMs: Number.isFinite(secs) && secs > 0 ? secs * 1000 : IRIS_BLOCK_MS };
  }
  // 404: the burn is not indexed yet.
  if (httpStatus === 404) return { kind: "pending", status: "not indexed yet" };
  if (httpStatus !== 200) return { kind: "error", status: httpStatus, detail: JSON.stringify(body ?? "").slice(0, 120) };
  const m = (body as { messages?: { status?: string; message?: string; attestation?: string }[] } | undefined)?.messages?.[0];
  if (!m) return { kind: "pending", status: "no message yet" };
  const hex = (x?: string) => typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x);
  if (m.status === "complete" && hex(m.message) && hex(m.attestation)) {
    return { kind: "attested", message: m.message as `0x${string}`, attestation: m.attestation as `0x${string}` };
  }
  return { kind: "pending", status: m.status ?? "unknown" };
}

/**
 * Spaces requests to one API: at least `minGapMs` apart, and none while blocked (after a 429).
 * The caller waits `waitMs(now)` before each request and calls `hit(now)` when it sends one.
 */
export class RateGate {
  private last = -Infinity;
  private blockedUntil = 0;
  constructor(private readonly minGapMs: number) {}
  waitMs(now: number): number {
    return Math.max(0, this.last + this.minGapMs - now, this.blockedUntil - now);
  }
  blocked(now: number) {
    return now < this.blockedUntil;
  }
  hit(now: number) {
    this.last = now;
  }
  block(now: number, ms: number) {
    this.blockedUntil = Math.max(this.blockedUntil, now + ms);
  }
}

/**
 * Logs a waiting line only when it changes, or again after `repeatMs`, so a finisher left
 * running for days does not print the same line every minute.
 */
export class Quiet {
  private seen = new Map<string, { line: string; at: number }>();
  constructor(private readonly repeatMs = 15 * 60_000) {}
  shouldLog(key: string, line: string, now: number): boolean {
    const prev = this.seen.get(key);
    if (prev && prev.line === line && now - prev.at < this.repeatMs) return false;
    this.seen.set(key, { line, at: now });
    return true;
  }
  forget(key: string) {
    this.seen.delete(key);
  }
}

/** The first line of an error, short enough for a one-line log. */
export function oneLine(e: unknown, max = 160): string {
  const raw = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e);
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "error";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "45s", "2m", "1h 5m". */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------- exits (ADR 0009): Aztec -> Ethereum -> Solana ----------

/**
 * One closed exit epoch of a denomination, carried prove -> attest -> done:
 * - prove: closed on Aztec; waits for the Aztec epoch's L2->L1 root to reach the Outbox, then
 *   `EclypsPortal.exitBatch` (the CCTP burn);
 * - attest: burned on Ethereum; waits for Circle's attestation, then `receive_exit` on Solana;
 * - done: the ExitBatch account exists on Solana. Each exit in it is then claimed by its owner.
 * As for batches, the record keeps only what is slow to find again; the chains are checked first.
 */
export interface ExitBatch {
  /** USDC base units. */
  denomination: string;
  /** Denomination index in the gateway config (the ExitBatch account's seed). */
  index: number;
  exitEpochId: string;
  /** From get_closed_exit_epoch: 0x field, exit count, L2->L1 content, Aztec block of the message. */
  root?: string;
  count?: number;
  content?: string;
  closedAt?: number;
  /** The close_exit_epoch transaction, when this finisher sent it or found it. */
  closeTx?: string;
  /** EclypsPortal.exitBatch, before and after its receipt. */
  l1Tx?: string;
  l1SubmittedAt?: number;
  exitedByUs?: boolean;
  exited?: boolean;
  /** Circle's attested message and attestation (public). */
  message?: string;
  attestation?: string;
  receiveSig?: string;
  receivedByUs?: boolean;
  received?: boolean;
  failures?: number;
  retryAt?: number;
  lastError?: string;
}

export interface ExitState {
  exits: Record<string, ExitBatch>;
  /** Per denomination: every exit epoch below this id is received on Solana. */
  exitsDoneBelow: Record<string, string>;
  /** A close_exit_epoch this finisher sent and has not seen mined, per denomination. */
  closing?: Record<string, { tx: string; at: number }>;
  /** A due close this finisher holds for a later Aztec epoch (`exitCloseTiming`), per denomination. */
  closeHeld?: Record<string, string>;
  /** The receive_exit address lookup table this finisher created (when the deployment has none). */
  exitLookupTable?: string;
}

export type ExitStage = "prove" | "attest" | "done";

export const exitKey = (denomination: bigint | string, exitEpochId: bigint | string) => `exit:${denomination}:${exitEpochId}`;

export function exitStageOf(b: ExitBatch): ExitStage {
  if (b.received) return "done";
  if (b.exited) return "attest";
  return "prove";
}

/** "$100 exit #3". */
export const exitName = (b: Pick<ExitBatch, "denomination" | "exitEpochId">) => `${sizeName(b.denomination)} exit #${b.exitEpochId}`;

/**
 * Whether to send close_exit_epoch for the open exit epoch: at least `minExitBatch` exits, and
 * ended (from block `endsAt`) or full. Below the minimum the finisher does nothing: closing would
 * only roll the epoch over (a new end, no message), and the epoch takes exits whether or not it has
 * ended, so the next pass after the minimum is reached closes it at once.
 */
export function exitCloseDue(epoch: { count: number; endsAt: number }, block: number, minExitBatch: number, maxExits = 256): boolean {
  if (epoch.count === 0 || epoch.count < Math.min(minExitBatch, maxExits)) return false;
  return epoch.count >= maxExits || block >= epoch.endsAt;
}

/** A close that reached the minimum but has not ended yet: the epoch ends in this many blocks. */
export const exitBlocksLeft = (epoch: { endsAt: number }, block: number) => Math.max(0, epoch.endsAt - block);

/** Exit epoch ids to look at for a denomination: from the watermark up to the open one. */
export function exitEpochsToCarry(s: ExitState, denomination: string, openId: bigint): bigint[] {
  const out: bigint[] = [];
  for (let id = BigInt(s.exitsDoneBelow[denomination] ?? "0"); id < openId; id++) out.push(id);
  return out;
}

/** Moves the per-denomination exit watermark past every exit epoch received on Solana. */
export function advanceExitsDone(s: ExitState, denomination: string): bigint {
  let id = BigInt(s.exitsDoneBelow[denomination] ?? "0");
  while (s.exits[exitKey(denomination, id)]?.received) id++;
  s.exitsDoneBelow[denomination] = id.toString();
  return id;
}

/** An exitBatch whose receipt has not appeared after this long is considered dropped. */
export const exitL1Stuck = (b: ExitBatch, now: number) => Boolean(b.l1Tx) && !b.exited && now - (b.l1SubmittedAt ?? 0) >= RELAY_STUCK_MS;

/** The Outbox's per-epoch id of a consumed leaf (`hasMessageBeenConsumedAtEpoch`). */
export const outboxLeafId = (pathLength: number, leafIndex: bigint) => (1n << BigInt(pathLength)) + leafIndex;

/**
 * Whether an attested CCTP message carries this exit batch (before spending SOL on receive_exit):
 * Ethereum to Solana, the standard path, and the hook's denomination, exit epoch, count and root.
 * The gateway checks all of it again; this only avoids sending a transaction that must fail.
 * Returns the reason when it does not.
 */
export function exitMessageMismatch(
  m: { sourceDomain: number; destinationDomain: number; finalityExecuted: number; amount: bigint; hook: { denomination: bigint; exitEpochId: bigint; count: number; root: bigint } },
  b: Pick<ExitBatch, "denomination" | "exitEpochId" | "count" | "root">,
): string | undefined {
  if (m.sourceDomain !== 0 || m.destinationDomain !== 5) return "not an Ethereum to Solana message";
  if (m.finalityExecuted < 2000) return `finality ${m.finalityExecuted} (standard is 2000)`;
  const d = BigInt(b.denomination);
  if (m.hook.denomination !== d || m.hook.exitEpochId !== BigInt(b.exitEpochId)) return "another exit batch";
  if (b.count !== undefined && m.hook.count !== b.count) return "another exit count";
  if (b.root !== undefined && m.hook.root !== BigInt(b.root)) return "another exit root";
  if (m.amount !== d * BigInt(m.hook.count)) return "amount is not count × denomination";
  return undefined;
}

/** What the exits are doing, for the summary line. */
export function exitSummary(s: Partial<ExitState>): { carried: number; inFlight: number } {
  let carried = 0, inFlight = 0;
  for (const b of Object.values(s.exits ?? {})) {
    if (exitStageOf(b) === "done") carried++;
    else inFlight++;
  }
  return { carried, inFlight };
}

/** While an exit waits on Aztec's proof or Circle, look again sooner than the idle interval. */
export const exitsBusy = (s: Partial<ExitState>) => Object.values(s.exits ?? {}).some((b) => exitStageOf(b) !== "done");

// ---------- exit close timing (ADR 0017 item 1) ----------

/**
 * Where the Aztec chain is in time, read from the rollup on L1 (`getCurrentSlot`,
 * `getEpochDuration`, `getSlotDuration`): an Aztec epoch is `epochSlots` slots, and an L2->L1
 * message can be used on Ethereum only once the epoch holding it is proven.
 */
export interface AztecClock {
  slot: bigint;
  epochSlots: number;
  /** Seconds per slot (72 on testnet and mainnet). */
  slotSeconds: number;
}

/** A close must be sent at least this many slots before its Aztec epoch ends. */
export const CLOSE_MARGIN_SLOTS = 2;
/**
 * Once a close has been held past an epoch boundary, it is sent in the last this-many slots before
 * the margin of a later epoch (a pass runs every 15-60 s; a slot is 72 s).
 */
export const CLOSE_WINDOW_SLOTS = 4;

export const aztecEpochOf = (c: Pick<AztecClock, "slot" | "epochSlots">) => c.slot / BigInt(c.epochSlots);
/** Slots left in the current Aztec epoch, the current one included (1..epochSlots). */
export const slotsLeftInEpoch = (c: Pick<AztecClock, "slot" | "epochSlots">) => c.epochSlots - Number(c.slot % BigInt(c.epochSlots));

export type CloseTiming =
  | { action: "close" }
  /** `heldIn`: the Aztec epoch in which the close was first held (kept in the record). */
  | { action: "hold"; heldIn: string; slotsLeft: number; why: "epoch-ending" | "window" };

/**
 * When to send close_exit_epoch for an exit epoch that can close, so that its exits and its close
 * are proven together (ADR 0017 item 1). The exits of an exit epoch become usable on Ethereum only
 * once the Aztec epoch holding the close is proven; a close that lands just after an Aztec epoch
 * boundary makes every exit in it wait one more Aztec epoch (38.4 min), as on testnet.
 *
 * - Not held before: close now if at least CLOSE_MARGIN_SLOTS remain in the Aztec epoch;
 *   otherwise hold, because a close sent now could land just after the boundary.
 * - Held, still in the same Aztec epoch: keep holding.
 * - Held, a later Aztec epoch: whatever is closed in this epoch is proven at its end, so sending
 *   at its start gains nothing and only cuts off exits that would join for free. Close in the
 *   last CLOSE_WINDOW_SLOTS before the margin; past the margin, hold again for the next epoch.
 */
export function exitCloseTiming(clock: Pick<AztecClock, "slot" | "epochSlots">, heldIn?: string, margin = CLOSE_MARGIN_SLOTS, window = CLOSE_WINDOW_SLOTS): CloseTiming {
  const epoch = aztecEpochOf(clock);
  const left = slotsLeftInEpoch(clock);
  if (heldIn === undefined) return left >= margin ? { action: "close" } : { action: "hold", heldIn: epoch.toString(), slotsLeft: left, why: "epoch-ending" };
  if (epoch <= BigInt(heldIn)) return { action: "hold", heldIn, slotsLeft: left, why: "epoch-ending" };
  if (left < margin) return { action: "hold", heldIn: epoch.toString(), slotsLeft: left, why: "epoch-ending" };
  if (left <= margin + window) return { action: "close" };
  return { action: "hold", heldIn, slotsLeft: left, why: "window" };
}

/** Milliseconds until the current Aztec epoch ends (counted from the start of the current slot). */
export const msToEpochEnd = (c: AztecClock) => slotsLeftInEpoch(c) * c.slotSeconds * 1000;
