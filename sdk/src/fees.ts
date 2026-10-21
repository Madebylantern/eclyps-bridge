/**
 * Who pays the Aztec fee of each transaction (ADR 0018), from a deployment's `fees` field.
 *
 * - `sponsoredFpc`: Aztec's SponsoredFPC (salt 0) pays. Testnet and the local network only: there
 *   is none on mainnet. The default when `fees` is absent, so testnet behaves as before.
 * - `feeJuice`: the sending account pays from its own Fee Juice (bridged from L1). For the finisher
 *   and the admin on mainnet.
 * - `eclypsFpc`: Eclyps's own FPC (`aztec/fpc`) pays from its Fee Juice. For users on mainnet: each
 *   deposited note pays for a few transactions (its sponsor slots), with capped gas.
 *
 * No Aztec imports here: the app, the finisher and the scripts each build the payment method.
 */

export type UserFeeMode = "sponsoredFpc" | "feeJuice" | "eclypsFpc";
export type OperatorFeeMode = "sponsoredFpc" | "feeJuice";

/** As written in deployments/*.json. */
export interface FeesConfig {
  /** Users' claims and exits. */
  user?: UserFeeMode;
  /** The finisher's register_batch and close_exit_epoch, and the deploy and admin scripts. */
  operator?: OperatorFeeMode;
  /** Needed when `user` is "eclypsFpc". */
  eclypsFpc?: {
    /** The EclypsFPC instance ("" until deployed). */
    address: string;
    /** Sponsor slots per note, by denomination (base units), as in the FPC's constructor. */
    slots: Record<string, number>;
  };
  /**
   * The operator account's Fee Juice, in whole Fee Juice (the token has 18 decimals): warn below
   * `low`; a refill brings it back to `target` (ADR 0018, refill loop).
   */
  operatorFeeJuice?: { low: number; target: number };
  /** The FPC's Fee Juice, same shape. */
  fpcFeeJuice?: { low: number; target: number };
}

export interface ResolvedFees {
  user: UserFeeMode;
  operator: OperatorFeeMode;
  eclypsFpc?: { address: string; slots: Record<string, number> };
}

/**
 * Gas a sponsored transaction declares. Must stay within the FPC's caps (`SPONSOR_MAX_L2_GAS`,
 * `SPONSOR_MAX_DA_GAS` in aztec/fpc/src/main.nr), with no teardown and no priority fee.
 */
export const SPONSORED_GAS = { l2Gas: 3_500_000, daGas: 16_384 } as const;

/** The FPC's most slots per note (`MAX_SLOTS`). */
export const MAX_SPONSOR_SLOTS = 64;

/** Reads and checks `fees`; throws on a configuration the network cannot honour. */
export function resolveFees(dep: { network: string; fees?: FeesConfig }): ResolvedFees {
  const f = dep.fees ?? {};
  const user = f.user ?? "sponsoredFpc";
  const operator = f.operator ?? "sponsoredFpc";
  if (!["sponsoredFpc", "feeJuice", "eclypsFpc"].includes(user)) throw new Error(`fees.user: unknown mode "${user}"`);
  if (!["sponsoredFpc", "feeJuice"].includes(operator)) throw new Error(`fees.operator: unknown mode "${operator}"`);
  if (dep.network === "mainnet" && (user === "sponsoredFpc" || operator === "sponsoredFpc")) {
    throw new Error("fees: Aztec mainnet has no SponsoredFPC; set fees.user and fees.operator (ADR 0018)");
  }
  if (user !== "eclypsFpc") return { user, operator };
  const x = f.eclypsFpc;
  if (!x?.address) throw new Error("fees.user is eclypsFpc but fees.eclypsFpc.address is empty");
  const slots = x.slots ?? {};
  if (Object.keys(slots).length === 0) throw new Error("fees.eclypsFpc.slots is empty");
  for (const [d, n] of Object.entries(slots)) {
    if (!/^[1-9]\d*$/.test(d) || !Number.isInteger(n) || n < 1 || n > MAX_SPONSOR_SLOTS) throw new Error(`fees.eclypsFpc.slots: bad entry ${d}: ${n}`);
  }
  return { user, operator, eclypsFpc: { address: x.address, slots } };
}

/**
 * Slots to try for one transaction, in order: from `first` (a claim starts at 0, an exit at 1)
 * up to the note's allowance, then the earlier ones (an exit whose note was claimed elsewhere).
 */
export function slotsToTry(first: number, allowance: number): number[] {
  const out: number[] = [];
  for (let s = Math.max(0, first); s < allowance; s++) out.push(s);
  for (let s = 0; s < Math.min(first, allowance); s++) out.push(s);
  return out;
}

/** True when a transaction failed because the sponsor slot it spends was spent already. */
export function isSpentSlotError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e);
  return /nullifier/i.test(m) && /(exist|collision|duplicate|already)/i.test(m);
}

/** Fee Juice has 18 decimals. */
export const FEE_JUICE_DECIMALS = 18n;

/** Fee Juice (base units) for `mana` at `feePerL2Gas` (base units per mana; DA is free today). */
export const feeJuiceFor = (mana: bigint, feePerL2Gas: bigint, daGas = 0n, feePerDaGas = 0n) => mana * feePerL2Gas + daGas * feePerDaGas;

/**
 * How much Fee Juice to bridge to bring `balance` back to `target` (whole Fee Juice), or 0n while
 * it is at or above `low`. A refill is an L1 transaction: the owner sends it (ADR 0018).
 */
export function refillAmount(balance: bigint, policy: { low: number; target: number }): bigint {
  const unit = 10n ** FEE_JUICE_DECIMALS;
  const low = BigInt(Math.round(policy.low)) * unit;
  const target = BigInt(Math.round(policy.target)) * unit;
  if (target < low) throw new Error("refill target is below the low mark");
  return balance >= low ? 0n : target - balance;
}
