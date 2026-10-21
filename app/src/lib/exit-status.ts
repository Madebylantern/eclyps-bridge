/**
 * Where an exit is (Move out, ADR 0009 and 0014 §4), as words and steps for the journey view. Pure:
 * the facts come from the chains (src/lib/exits.ts); nothing here invents a reference or a time.
 *
 *   To Solana:   burned on Aztec → in an exit batch (closed) → through Ethereum (CCTP burn) →
 *                on Solana (received) → paid (claim_exit, by the user)
 *   To Ethereum: burned on Aztec → proven (the Outbox holds its root) → paid (claimToEthereum)
 */
import type { Journey, JourneyStep, StepState } from "./journey";

// Local copies of deployment.ts `usd` and format.ts `shortAddr`, so this file runs in node tests.
const usd = (base: string | bigint) => `$${(Number(BigInt(base)) / 1e6).toLocaleString("en-US")}`;
const shortAddr = (a: string, n = 4) => (a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
/** Local copy of deployment.ts `usdExact`: "$99.90". */
const usdCents = (b: bigint) => {
  const whole = (b / 1_000_000n).toLocaleString("en-US");
  const frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac.padEnd(2, "0")}` : `$${whole}`;
};

export type ExitStage = "burning" | "burned" | "batched" | "sent" | "arrived" | "proven" | "paid";

export interface ExitFacts {
  /** The burn is mined on Aztec. */
  mined: boolean;
  /** Solana: exits in its exit epoch so far, and the minimum for a batch. */
  inEpoch?: number;
  minBatch?: number;
  /** Solana: its exit epoch is closed on Aztec. */
  closed?: boolean;
  /** Solana: the portal burned the exit batch to Solana. */
  exited?: boolean;
  /** Solana: the exit batch is on Solana (ExitBatch). */
  arrived?: boolean;
  /** Ethereum: the Outbox holds a proven root with this exit. */
  proven?: boolean;
  /** Paid at the destination. */
  paid?: boolean;
  /** Solana: fronted from the liquidity pool (ADR 0017); the destination got this much. */
  frontedAdvanced?: bigint;
}

export function exitStage(to: "solana" | "ethereum", f: ExitFacts): ExitStage {
  if (f.paid) return "paid";
  if (!f.mined) return "burning";
  if (to === "ethereum") return f.proven ? "proven" : "burned";
  if (f.arrived) return "arrived";
  if (f.exited) return "sent";
  if (f.closed) return "batched";
  return "burned";
}

/**
 * Whether the Outbox can hold the root of a burn mined with this Aztec receipt status: only once
 * its epoch is proven. Before that, reading the epoch's blocks and 32 Outbox roots is wasted.
 */
export const outboxMayHold = (status: string): boolean => status === "proven" || status === "finalized";

/** The user's step, when there is one: claim on Solana, or on Ethereum. */
export const exitAction = (s: ExitStage): "claim" | undefined => (s === "arrived" || s === "proven" ? "claim" : undefined);

interface ExitLike {
  to: "solana" | "ethereum";
  denomination: string;
  destination: string;
  tx?: string;
  sentAt?: number;
  claimTx?: string;
  claimedAt?: number;
}

const ORDER: Record<"solana" | "ethereum", ExitStage[]> = {
  solana: ["burned", "batched", "sent", "arrived", "paid"],
  ethereum: ["burned", "proven", "paid"],
};

export function exitJourney(x: ExitLike, stage: ExitStage, f: ExitFacts): Journey {
  // A fronted exit (ADR 0017) paid the note minus the front fee.
  const amount = f.frontedAdvanced !== undefined ? usdCents(f.frontedAdvanced) : usd(x.denomination);
  const dest = shortAddr(x.destination, 4);
  const at = stage === "burning" ? -1 : ORDER[x.to].indexOf(stage);
  const state = (i: number): StepState => (i < at || stage === "paid" ? "done" : i === at ? "now" : "next");
  const titles =
    x.to === "solana"
      ? ["Burned on Aztec", "In an exit batch", "Through Ethereum", "On Solana", `Paid to ${dest}`]
      : ["Burned on Aztec", "Proven on Ethereum", `Paid to ${dest}`];
  const steps: JourneyStep[] = titles.map((title, i) => ({ key: ORDER[x.to][i]!, title, state: state(i) }));
  steps[0]!.ref = x.tx ? { prefix: "tx", value: x.tx } : undefined;
  steps[0]!.at = x.sentAt;
  const last = steps.at(-1)!;
  last.ref = x.claimTx ? { prefix: "tx", value: x.claimTx } : undefined;
  last.at = x.claimedAt;

  const left = f.minBatch !== undefined && f.inEpoch !== undefined ? Math.max(0, f.minBatch - f.inEpoch) : undefined;
  const now: Record<ExitStage, string> = {
    burning: "Your wallet is proving the burn.",
    burned:
      x.to === "ethereum"
        ? "Waiting for Aztec to prove it. Then you claim it."
        : left
          ? `Waiting for ${left} more ${left === 1 ? "exit" : "exits"} to fill the batch.`
          : "The batch closes soon.",
    batched: "Waiting for Aztec to prove the batch.",
    sent: "Crossing to Solana.",
    arrived: `Arrived. Claim it to ${dest}.`,
    proven: `Ready. Claim it to ${dest}.`,
    paid: `${amount} is at ${dest}.`,
  };
  const headline = stage === "paid" ? `${amount} moved out` : `${amount} leaving for ${x.to === "solana" ? "Solana" : "Ethereum"}`;
  return { headline, now: now[stage], steps };
}
