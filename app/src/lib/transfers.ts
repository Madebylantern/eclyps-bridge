/**
 * Transfers: the notes one Shield action created, shown together ("Moving in $1,310"), and the one
 * thing the user should do next. Pure functions over a snapshot; no network.
 */
import { usd } from "./deployment";
import { clock, plural } from "./format";
import { claimOdds, type NoteView, type PoolView, type Snapshot, type Stage, slotTime } from "./portfolio";
import { EARLIER, RECOVERED, type TransferKind, type TransferMeta } from "./vault";

export interface TransferView {
  id: string;
  kind: TransferKind;
  createdAt: number;
  /** In planned order. */
  notes: NoteView[];
  /** Everything the transfer set out to move, including notes taken back. */
  total: bigint;
  refundedTotal: bigint;
  count: Record<Stage, number>;
  nextDepositAt?: number;
  /** Every note is on Aztec or was taken back. */
  done: boolean;
}

const EMPTY: Record<Stage, number> = { scheduled: 0, queued: 0, batched: 0, sent: 0, claimable: 0, claimed: 0, refunded: 0, exited: 0 };
const sum = (ns: NoteView[]) => ns.reduce((a, n) => a + BigInt(n.denomination), 0n);

export function groupTransfers(notes: NoteView[], meta: Record<string, TransferMeta>): TransferView[] {
  const by = new Map<string, NoteView[]>();
  for (const n of notes) by.set(n.planId, [...(by.get(n.planId) ?? []), n]);
  const out: TransferView[] = [];
  for (const [id, ns] of by) {
    ns.sort((a, b) => (a.scheduledAt ?? a.depositedAt ?? 0) - (b.scheduledAt ?? b.depositedAt ?? 0) || a.index - b.index);
    const count = { ...EMPTY };
    for (const n of ns) count[n.stage]++;
    const pending = ns.filter((n) => n.stage === "scheduled").map((n) => n.scheduledAt ?? 0);
    const m = meta[id];
    out.push({
      id,
      kind: m?.kind ?? (id === RECOVERED ? "recovered" : id === EARLIER ? "earlier" : "spread"),
      createdAt: m?.createdAt ?? Math.min(...ns.map((n) => n.depositedAt ?? n.scheduledAt ?? Date.now())),
      notes: ns,
      total: sum(ns),
      refundedTotal: sum(ns.filter((n) => n.stage === "refunded")),
      count,
      nextDepositAt: pending.length ? Math.min(...pending) : undefined,
      done: ns.every((n) => n.stage === "claimed" || n.stage === "refunded" || n.stage === "exited"),
    });
  }
  // Unfinished first, newest first.
  return out.sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
}

export function transferTitle(t: TransferView): string {
  if (t.kind === "recovered") return "Recovered notes";
  if (t.kind === "earlier") return "Earlier notes";
  const moving = t.total - t.refundedTotal;
  if (moving === 0n) return `Took back ${usd(t.total)}`;
  return t.done ? `Moved in ${usd(moving)}` : `Moving in ${usd(moving)}`;
}

/** Spread window of each privacy plan (Fast deposits everything at once). */
export const PLAN_HOURS: Partial<Record<TransferKind, number>> = { balanced: 6, private: 72 };

export const PLAN_LABEL: Record<TransferKind, string> = {
  fast: "Fast",
  balanced: "Balanced",
  private: "Private",
  totality: "Totality",
  spread: "Spread",
  recovered: "From your phrase",
  earlier: "Before transfers",
};

/** "2 of 5 on Aztec · 1 to claim · next deposit 14:20". */
export function transferStatus(t: TransferView, now = Date.now()): string {
  const live = t.notes.length - t.count.refunded;
  const parts: string[] = [];
  if (live > 0) parts.push(`${t.count.claimed + t.count.exited} of ${live} on Aztec`);
  if (t.count.claimable) parts.push(`${t.count.claimable} to claim`);
  const crossing = t.count.queued + t.count.batched + t.count.sent;
  if (crossing) parts.push(`${crossing} crossing`);
  if (t.nextDepositAt !== undefined) {
    const due = t.notes.some((n) => n.due);
    parts.push(due ? "a deposit is due" : `next deposit ${clock(t.nextDepositAt, now)}`);
  }
  if (t.count.refunded) parts.push(`${usd(t.refundedTotal)} taken back`);
  return parts.join(" · ");
}

export type NextAction =
  | { kind: "refund"; note: NoteView }
  | { kind: "deposit"; note: NoteView; overdue: NoteView[] }
  | { kind: "claim"; note: NoteView; pool?: PoolView; odds: ReturnType<typeof claimOdds> }
  | { kind: "idle"; until?: number; reason: string }
  | { kind: "empty" };

/**
 * The single most important thing right now: take back a stuck deposit, then deposit a due note,
 * then claim, otherwise when something will next happen.
 */
export function nextAction(snap: Snapshot | undefined, notes: NoteView[], now = Date.now()): NextAction {
  const live = notes.filter((n) => n.stage !== "refunded");
  if (live.length === 0) return { kind: "empty" };

  const refundable = live.find((n) => n.stage === "queued" && n.refund?.refundable);
  if (refundable) return { kind: "refund", note: refundable };

  const scheduled = live.filter((n) => n.stage === "scheduled").sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  const due = scheduled.find((n) => n.due);
  if (due) return { kind: "deposit", note: due, overdue: scheduled.filter((n) => (n.scheduledAt ?? 0) <= now) };

  const claimable = live.filter((n) => n.stage === "claimable").sort((a, b) => a.index - b.index)[0];
  if (claimable) {
    const pool = snap?.pools.find((p) => p.index === claimable.denominationIndex);
    return { kind: "claim", note: claimable, pool, odds: claimOdds(claimable, pool) };
  }

  // Nothing to do: say when the next thing happens, in a few words.
  const events: { at?: number; reason: string }[] = [];
  const next = scheduled.find((n) => (n.scheduledAt ?? 0) > now);
  if (next) events.push({ at: next.scheduledAt, reason: `Then your ${usd(next.denomination)} deposit is due.` });
  const held = scheduled.find((n) => n.heldBy !== undefined);
  if (held) {
    const blocker = live.find((n) => n.index === held.heldBy);
    const end = blocker?.epochEndSlot !== undefined && snap ? slotTime(blocker.epochEndSlot, snap.slot, now) : undefined;
    events.push({ at: end && end > now ? end : undefined, reason: `Your next ${usd(held.denomination)} waits for a new epoch.` });
  }
  const queued = live.filter((n) => n.stage === "queued");
  for (const q of queued) {
    const end = q.epochEndSlot !== undefined && snap ? slotTime(q.epochEndSlot, snap.slot, now) : undefined;
    const pool = snap?.pools.find((p) => p.index === q.denominationIndex);
    events.push({
      at: end && end > now ? end : undefined,
      reason: `Your ${usd(q.denomination)} batch: ${q.epochLeaves ?? 0} of ${pool?.minBatch ?? "?"} deposits.`,
    });
  }
  if (live.some((n) => n.stage === "batched" || n.stage === "sent")) {
    events.push({ reason: "Your notes are crossing to Aztec." });
  }
  const timed = events.filter((e) => e.at !== undefined).sort((a, b) => a.at! - b.at!)[0];
  if (timed) return { kind: "idle", until: timed.at, reason: timed.reason };
  if (events[0]) return { kind: "idle", reason: events[0].reason };
  return { kind: "idle", reason: `${live.length === 1 ? "Your note is" : `All ${plural(live.length, "note")} are`} on Aztec.` };
}
