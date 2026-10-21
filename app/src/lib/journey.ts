/**
 * Where a note's money is at each stage of the crossing, in words, with the public references the
 * app actually holds (ADR 0007, ADR 0010). Pure presentation over a NoteView: no reference, hash or
 * time is ever invented; a step without one shows none.
 *
 *   Scheduled  still in your wallet
 *   Queued     Eclyps gateway escrow on Solana, in the open batch
 *   Batched    gateway escrow, batch closed
 *   Sent       Circle burned the batch on Solana and mints it to the Eclyps portal on Ethereum
 *   Claimable  USDC held by the Eclyps portal on Ethereum; the note is claimable on Aztec
 *   Claimed    your private balance on Aztec, backed by USDC in the portal
 *   Taken back refunded to the wallet that deposited
 */
import { type Deployment, usd, usdExact } from "./deployment";
import { clock, shortAddr } from "./format";
import type { NoteView, Stage } from "./portfolio";

export type StepState = "done" | "now" | "next";

export interface JourneyRef {
  /** What the value is: "tx", "root", "portal". */
  prefix: string;
  value: string;
}

export interface JourneyStep {
  key: string;
  title: string;
  /** Where the money is held, or what has to happen. */
  where?: string;
  ref?: JourneyRef;
  /** A time the app knows (ms). */
  at?: number;
  state: StepState;
}

export interface Journey {
  headline: string;
  now: string;
  steps: JourneyStep[];
}

/** Position on the route figure: 0 is Solana, 0.5 the bridge (Ethereum), 1 Aztec. */
export const ROUTE_POS: Record<Stage, number> = {
  scheduled: 0,
  queued: 0.12,
  batched: 0.26,
  sent: 0.5,
  claimable: 0.74,
  claimed: 1,
  refunded: 0,
  exited: 1,
};

/** The step a stage sits on (index into the five crossing steps); -1 before the deposit. */
const CURRENT: Record<Exclude<Stage, "refunded">, number> = { scheduled: -1, queued: 0, batched: 1, sent: 2, claimable: 3, claimed: 4, exited: 5 };

const rootHex = (r: bigint) => `0x${r.toString(16).padStart(64, "0")}`;

/** One short line for the notes list: where the money is, and the one fact that matters next. */
export function whereShort(n: NoteView, minBatch: number | undefined, aztecOpen: boolean): string {
  switch (n.stage) {
    case "scheduled":
      if (n.heldBy !== undefined) return "Wallet · waits for a new epoch";
      if (n.due) return "Wallet · due now";
      return `Wallet · ${clock(n.scheduledAt ?? 0)}`;
    case "queued":
      if (n.refund?.refundable) return "Escrow · can be taken back";
      return `Escrow · ${n.epochLeaves ?? 0} of ${minBatch ?? "?"} in batch`;
    case "batched":
      return "Escrow · batch closed";
    case "sent":
      return aztecOpen ? "On the bridge" : "On the bridge · open Aztec";
    case "claimable":
      return "Ready to claim";
    case "claimed":
      return `On Aztec${n.claimedAt ? ` · ${clock(n.claimedAt)}` : ""}`;
    case "refunded":
      return `Taken back${n.refundedAt ? ` · ${clock(n.refundedAt)}` : ""}`;
    case "exited":
      return "Moved out";
  }
}

/** The full journey of one note, for the "Where it is" column: a headline, one line, the steps. */
export function journeyOf(n: NoteView, dep: Deployment, minBatch: number | undefined, aztecOpen: boolean): Journey {
  const v = usd(n.denomination);
  const need = minBatch ?? dep.params.minBatchSize;
  const portal = dep.l1.portal ? { prefix: "portal", value: dep.l1.portal } : undefined;
  const depositRef = n.depositSig ? { prefix: "tx", value: n.depositSig } : undefined;
  const escrow = n.epochId !== undefined ? `Eclyps escrow, epoch ${n.epochId}` : "Eclyps escrow";

  if (n.stage === "refunded") {
    const to = n.depositWallet ? shortAddr(n.depositWallet) : "the depositing wallet";
    return {
      // The note and the fee it paid: nothing is charged when a batch never crosses (ADR 0012).
      headline: `Your ${usdExact(BigInt(n.denomination) + (n.fee ?? 0n))} is back in your wallet.`,
      now: `Taken back${n.refundedAt ? ` at ${clock(n.refundedAt)}` : ""}.`,
      steps: [
        { key: "deposit", title: "Deposited on Solana", where: escrow, ref: depositRef, at: n.depositedAt, state: "done" },
        { key: "stuck", title: "Batch did not fill", where: `Fewer than ${need} deposits in a day`, state: "done" },
        { key: "refund", title: "Taken back", where: `To ${to}`, ref: n.refundSig ? { prefix: "tx", value: n.refundSig } : undefined, at: n.refundedAt, state: "now" },
      ],
    };
  }

  const cur = CURRENT[n.stage];
  const state = (i: number): StepState => (i < cur ? "done" : i === cur ? "now" : "next");
  const deposited = n.epochId !== undefined;

  const steps: JourneyStep[] = [
    {
      key: "deposit",
      title: deposited ? "Deposited on Solana" : "Deposit on Solana",
      where: deposited
        ? n.recovered && !n.depositSig
          ? `${escrow} · found from your phrase`
          : escrow
        : n.heldBy !== undefined
          ? `Waits for a new ${v} epoch`
          : n.due
            ? "Due now: you sign it"
            : "You sign it when due",
      ref: depositRef,
      at: deposited ? n.depositedAt : n.scheduledAt,
      state: state(0),
    },
    {
      key: "batch",
      title: cur >= 1 ? "Batch closed" : "Batch closes",
      where:
        n.stage === "queued"
          ? `${n.epochLeaves ?? 0} of ${need} deposits`
          : cur >= 1
            ? `Epoch ${n.epochId} · ${n.epochLeaves ?? "its"} ${n.epochLeaves === 1 ? "note" : "notes"}`
            : `At ${need} deposits`,
      ref: n.root !== undefined ? { prefix: "root", value: rootHex(n.root) } : undefined,
      state: state(1),
    },
    {
      key: "bridge",
      title: cur >= 2 ? "Burned by Circle on Solana" : "Crosses through Circle CCTP",
      where: cur >= 2 ? "Minted to the Eclyps portal on Ethereum" : "Burned on Solana, minted on Ethereum",
      state: state(2),
    },
    {
      key: "portal",
      title: cur === 3 ? "Claimable on Aztec" : "Registered on Aztec",
      where: "USDC held by the Eclyps portal",
      ref: portal,
      state: state(3),
    },
    {
      key: "aztec",
      title: n.stage === "claimed" || n.stage === "exited" ? "Claimed on Aztec" : "Claim on Aztec",
      where: "Your private balance",
      ref: n.claimTx ? { prefix: "tx", value: n.claimTx } : undefined,
      at: n.claimedAt,
      state: state(4),
    },
  ];

  const headline: Record<Exclude<Stage, "refunded">, string> = {
    scheduled: `Your ${v} is in your wallet.`,
    queued: `Your ${v} is in the Eclyps escrow.`,
    batched: `Your ${v} is in a closed batch.`,
    sent: `Your ${v} is crossing.`,
    claimable: `Your ${v} is ready to claim.`,
    claimed: `Your ${v} is private on Aztec.`,
    exited: `Your ${v} moved out.`,
  };

  let now: string;
  switch (n.stage) {
    case "scheduled":
      now = n.heldBy !== undefined ? `It waits for your note #${n.heldBy} to cross.` : n.due ? "Due now. Sign it on this page." : `Due ${clock(n.scheduledAt ?? 0)}. You sign it then.`;
      break;
    case "queued":
      now = n.refund?.refundable ? "Its batch did not fill. You can take it back." : `It crosses once ${need} deposits arrive.`;
      break;
    case "batched":
      now = "It crosses when anyone sends the batch.";
      break;
    case "sent":
      now = aztecOpen ? "Claimable on Aztec within minutes." : "Open Aztec to see when it lands.";
      break;
    case "claimable":
      now = "Claim it into your private balance.";
      break;
    case "claimed":
      now = n.claimedAt ? `Claimed ${clock(n.claimedAt)}.` : "Claimed.";
      break;
    case "exited":
      now = "It left Aztec. Move out shows where it is.";
      break;
  }
  return { headline: headline[n.stage], now, steps };
}
