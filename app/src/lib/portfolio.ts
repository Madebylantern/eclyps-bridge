/**
 * The shielded portfolio: the vault's note book joined with public chain state. Notes move through
 *   scheduled → queued → batched → sent → claimable → claimed → exited (or queued → refunded)
 * asynchronously (epochs fill, CCTP finalises, finishers register roots), so the app polls and
 * renders whatever stage each note has reached. Only public data is read: epoch accounts on Solana
 * and, once the Aztec wallet is open, whether a root is registered on Aztec.
 */
import {
  type ConfigAccount,
  EXPRESS_EPOCH_BIT,
  configPortalAddress,
  depositFeeBps,
  depositRoom,
  type EpochAccount,
  epochNoteFee,
  openEpochBlocker,
  type PoolStats,
  portalMatches,
  type RefundStatus,
  refundStatus,
} from "@eclyps/sdk";
import type { AztecSession } from "./aztec";
import { type Deployment, SLOT_MS } from "./deployment";
import { currentSlot, type LanesView, readConfig, readEpochs, readExpressEpochs, readLanesView } from "./solana";
import type { StoredNote } from "./vault";

export type Stage = "scheduled" | "queued" | "batched" | "sent" | "claimable" | "claimed" | "refunded" | "exited";
export const STAGE_LABEL: Record<Stage, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  batched: "Batched",
  sent: "Sent",
  claimable: "Ready to claim",
  claimed: "On Aztec",
  refunded: "Taken back",
  exited: "Moved out",
};

export interface NoteView extends StoredNote {
  stage: Stage;
  /** Scheduled, its time has come, and no other note of yours is in that denomination's open epoch. */
  due: boolean;
  /** Your note (index) in the open epoch of the same denomination: this one waits for a new epoch. */
  heldBy?: number;
  epochLeaves?: number;
  epochEndSlot?: bigint;
  root?: bigint;
  leaves?: bigint[];
  /** For a deposit still in its denomination's open epoch: whether, and from when, it can be taken back. */
  refund?: RefundStatus & { atMs: number };
  /** The fee this note paid on top at deposit (its epoch's snapshot); a refund returns it too. */
  fee?: bigint;
}

export interface PoolView extends PoolStats {
  index: number;
  openEpochId: bigint;
  openEpochEndSlot?: bigint;
  latestSentEpoch?: bigint;
  /** The fee rate a deposit of this size pays now (the open epoch's snapshot, or the config's). */
  nextFeeBps: number;
}

/**
 * Whether this app may deposit into the gateway it reads. `missing`: deployment.json names no
 * Ethereum portal yet (not fully deployed). `mismatch`: the gateway sends batches to a different
 * portal than the one this app expects.
 */
export interface GatewayStatus {
  portal: "ok" | "missing" | "mismatch";
  onChainPortal: string;
  /** Deposits paused by the guardian until this time (ms); claims and refunds still work. */
  pausedUntil?: number;
  /** User fee and the finisher's part of it, in basis points (ADR 0012). */
  feeBps: number;
  finisherBps: number;
  /** Principal that can still enter before the deposit cap. */
  room: bigint;
  /** Not even the smallest note fits under the deposit cap. */
  capReached: boolean;
}

export interface Snapshot {
  slot: bigint;
  pools: PoolView[];
  notes: NoteView[];
  gateway: GatewayStatus;
  updatedAt: number;
  /** The V2 lanes (Cross now, fast exits), when a V2 feature is on and the gateway has them. */
  lanes?: LanesView;
}

/** Sent epochs never change again; registered roots stay registered. */
export class ChainCache {
  epochs = new Map<string, EpochAccount>();
  registered = new Set<string>();
}

/** Wall-clock estimate for a slot, from the current slot. */
export const slotTime = (slot: bigint, nowSlot: bigint, now = Date.now()) => now + Number(slot - nowSlot) * SLOT_MS;

export function gatewayStatus(dep: Deployment, cfg: ConfigAccount, now = Date.now()): GatewayStatus {
  const onChainPortal = configPortalAddress(cfg);
  const portal = !dep.l1.portal ? "missing" : portalMatches(cfg, dep.l1.portal) ? "ok" : "mismatch";
  const until = Number(cfg.pauseExpiry) * 1000;
  const room = depositRoom(cfg);
  const smallest = dep.denominations.map(BigInt).reduce((a, b) => (a < b ? a : b));
  return {
    portal,
    onChainPortal,
    pausedUntil: cfg.pausedDeposits && until > now ? until : undefined,
    feeBps: cfg.params.feeBps,
    finisherBps: cfg.params.finisherBps,
    room,
    capReached: room < smallest,
  };
}

/**
 * Reads the config and every epoch that can still change (open, closed, or not cached yet) into
 * `cache`. Sent epochs are read once.
 */
export async function syncChain(dep: Deployment, cache: ChainCache): Promise<{ cfg: ConfigAccount; slot: bigint; lanes?: LanesView }> {
  // V2 lanes (ADR 0015, 0017) are read only where a V2 feature is on.
  const v2 = dep.features?.crossNow === true || dep.features?.fastExit === true;
  const [cfg, slot, lanes] = await Promise.all([readConfig(dep), currentSlot(dep), v2 ? readLanesView(dep).catch(() => undefined) : undefined]);
  const wanted: { idx: number; id: bigint }[] = [];
  for (let idx = 0; idx < dep.denominations.length; idx++) {
    for (let id = 0n; id <= cfg.currentEpoch[idx]!; id++) {
      const e = cache.epochs.get(`${idx}:${id}`);
      if (!e || e.status !== "Sent") wanted.push({ idx, id });
    }
  }
  const fetched = await readEpochs(dep, wanted);
  wanted.forEach((k, i) => {
    const e = fetched[i];
    if (e) cache.epochs.set(`${k.idx}:${k.id}`, e);
  });
  // Express epochs (Cross now) as batches of one, under their own ids (top bit set): the stage,
  // root and leaves of an express note read like any other, and recovery finds them.
  if (lanes && dep.features?.crossNow === true) {
    const xs: { idx: number; id: bigint }[] = [];
    for (let idx = 0; idx < dep.denominations.length; idx++) {
      for (let k = 0n; k < (lanes.lanes.expressNext[idx] ?? 0n); k++) {
        const id = EXPRESS_EPOCH_BIT | k;
        if (cache.epochs.get(`${idx}:${id}`)?.status !== "Sent") xs.push({ idx, id });
      }
    }
    const got = await readExpressEpochs(dep, xs);
    xs.forEach((k, i) => {
      const e = got[i];
      if (e) cache.epochs.set(`${k.idx}:${k.id}`, e);
    });
  }
  return { cfg, slot, lanes };
}

/** Every epoch account read so far (all denominations). */
export const knownEpochs = (cache: ChainCache): EpochAccount[] => [...cache.epochs.values()];

export const isDeposited = (n: StoredNote) => n.epochId !== undefined;

export async function takeSnapshot(dep: Deployment, notes: StoredNote[], cache: ChainCache, aztec?: AztecSession): Promise<Snapshot> {
  const { cfg, slot, lanes } = await syncChain(dep, cache);
  const now = Date.now();

  const pools: PoolView[] = dep.denominations.map((d, idx) => {
    let crossed = 0;
    let batches = 0;
    let latestSentEpoch: bigint | undefined;
    for (let id = 0n; id <= cfg.currentEpoch[idx]!; id++) {
      const e = cache.epochs.get(`${idx}:${id}`);
      if (e?.status === "Sent") {
        crossed += e.leaves.length;
        batches++;
        latestSentEpoch = id;
      }
    }
    const open = cache.epochs.get(`${idx}:${cfg.currentEpoch[idx]}`);
    return {
      index: idx,
      denomination: BigInt(d),
      crossed,
      batches,
      latestSentEpoch,
      openEpochId: cfg.currentEpoch[idx]!,
      openEpochLeaves: open?.status === "Open" ? open.leaves.length : 0,
      openEpochEndSlot: open?.status === "Open" ? open.endSlot : undefined,
      minBatch: cfg.params.minBatchSize,
      cap: cfg.params.perEpochCap,
      nextFeeBps: depositFeeBps(cfg, open),
    };
  });

  const own = notes
    .filter((n) => !n.refundedAt)
    .map((n) => ({ index: n.index, denominationIndex: n.denominationIndex, epochId: n.epochId !== undefined ? BigInt(n.epochId) : undefined }));
  const views: NoteView[] = [];
  for (const n of notes) {
    if (!isDeposited(n)) {
      const heldBy = openEpochBlocker(n, own, cfg.currentEpoch[n.denominationIndex]!);
      views.push({ ...n, stage: "scheduled", heldBy, due: (n.scheduledAt ?? 0) <= now && heldBy === undefined });
      continue;
    }
    const e = cache.epochs.get(`${n.denominationIndex}:${n.epochId}`);
    let stage: Stage = e?.status === "Closed" ? "batched" : e?.status === "Sent" ? "sent" : "queued";
    if (stage === "sent" && e) {
      const key = `${n.denomination}:${e.root}`;
      if (!cache.registered.has(key) && aztec && (await aztec.isRegistered(n.denomination, e.root).catch(() => false))) {
        cache.registered.add(key);
      }
      if (cache.registered.has(key)) stage = "claimable";
    }
    if (n.claimTx) stage = "claimed";
    if (n.refundedAt) stage = "refunded";
    if (n.exitId) stage = "exited";
    const inOpenEpoch = stage === "queued" && e?.status === "Open" && BigInt(n.epochId!) === cfg.currentEpoch[n.denominationIndex];
    const refund = inOpenEpoch && e ? refundStatus(e, slot) : undefined;
    views.push({
      ...n,
      stage,
      due: false,
      epochLeaves: e?.leaves.length,
      epochEndSlot: e?.endSlot,
      root: e && e.status !== "Open" ? e.root : undefined,
      leaves: e?.leaves,
      refund: refund && { ...refund, atMs: slotTime(refund.fromSlot, slot, now) },
      fee: e ? epochNoteFee(e) : undefined,
    });
  }
  return { slot, pools, notes: views, gateway: gatewayStatus(dep, cfg, now), updatedAt: now, lanes };
}

/**
 * The crowd a claim hides in, now and after the next batch. Claiming right after your own batch
 * lands points at that batch (the advisor's "newest batch" caution), so "now" is then only your
 * batch; after another batch, it is every note that crossed. The next batch has at least
 * `minBatch` notes, so "later" is a lower bound.
 */
export function claimOdds(n: NoteView, pool: PoolView | undefined): { now: number; later: number; newest: boolean } {
  const crossed = pool?.crossed ?? 0;
  const newest = pool?.latestSentEpoch !== undefined && n.epochId !== undefined && BigInt(n.epochId) === pool.latestSentEpoch;
  const now = newest ? (n.epochLeaves ?? crossed) : crossed;
  const later = crossed + Math.max(pool?.minBatch ?? 1, pool?.openEpochLeaves ?? 0);
  return { now, later, newest };
}
