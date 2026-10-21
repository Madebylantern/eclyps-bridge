import type { FeesConfig } from "@eclyps/sdk";

/** Deployment descriptor (scripts/e2e/deploy-local.ts for the local stack; deployments/testnet.json). */
export interface Deployment {
  /** "mainnet": deployments/mainnet.template.json, not deployed. */
  network: "local" | "testnet" | "mainnet";
  /**
   * `cluster` names the Solana cluster the RPC serves. Absent, it is localnet on the local stack
   * and devnet otherwise (`solanaChain`).
   */
  solana: { rpc: string; gateway: string; usdcMint: string; config: string; cluster?: SolanaCluster; treasury?: string };
  /** `portal` is empty until the Ethereum portal is deployed; deposits stay off until then. */
  l1: { rpc: string; chainId: number; portal: string; mock?: boolean };
  /** `minter`: the token's only minter (ADR 0020); absent on deployments made before it. */
  aztec: { node: string; token: string; minter?: string; claims: Record<string, string> };
  denominations: string[];
  /** As initialized. Fee and deposit cap are read live from the gateway config instead. */
  params: { minBatchSize: number; perEpochCap: number; epochLenSlots: number; feeBps?: number; finisherBps?: number; depositCap?: string };
  /**
   * Protocol legs deployed on this network. `exit` (ADR 0009) opens Move out to Solana;
   * `exitEthereum` (ADR 0014 §4) offers "An Ethereum address" on the bridge screen and in Move
   * out. `crossNow` (ADR 0015) turns the bridge's second choice after Send into "Cross now": one
   * note per express epoch, its express fee paid by the crossing pool while it can ("on us").
   * `fastExit` (ADR 0017) offers "Fast · fee $x" next to "Wait" in Move out to Solana, for notes
   * the liquidity pool can cover. Both need the gateway's V2 lanes (`init_lanes`); without them
   * the app keeps today's choices. All are off unless set to true.
   */
  features?: { exit?: boolean; exitEthereum?: boolean; crossNow?: boolean; fastExit?: boolean };
  /**
   * The liquidity pool's keeper (ADR 0017, finisher/src/keeper.ts): where the app asks for a fast
   * exit after the burn (POST {url}/front). Needed with `features.fastExit`.
   */
  keeper?: { url: string };
  /**
   * Totality: a weekly crossing window when people move in together (src/lib/totality.ts).
   * Configuration only, there is no server. Absent or invalid, every Totality feature is hidden.
   */
  totality?: TotalityConfig;
  /**
   * Pay with SOL (ADR 0011): SOL is swapped to the plan's USDC through this provider first.
   * Validated by `parseSwap` (src/lib/swap.ts) and shown only when `solana.cluster` is "mainnet".
   * Never holds an API key (SPEC §1.2.5).
   */
  swap?: SwapConfigInput;
  /**
   * Who pays Aztec fees (ADR 0018, `resolveFees` in the SDK). Absent: the SponsoredFPC, as on
   * testnet. Mainnet: users through the Eclyps FPC, the finisher with its own Fee Juice.
   */
  fees?: FeesConfig;
}

export type SolanaCluster = "mainnet" | "devnet" | "testnet" | "localnet";

/** As written in deployment.json; `slippageBps` defaults to 50 and `maxAccounts` to 48. */
export interface SwapConfigInput {
  provider: "jupiter";
  /** Base URL of Jupiter's keyless Metis Swap API, e.g. "https://api.jup.ag/swap/v1". */
  api: string;
  slippageBps?: number;
  maxAccounts?: number;
}

/**
 * `first` is the start of Totality #1 (an ISO time in UTC, on the hour); later windows start a
 * whole number of weeks after it. `weekday` (0 = Sunday) and `hourUtc` must agree with `first`.
 * `minutes` is how long each window lasts.
 */
export interface TotalityConfig {
  weekday: number;
  hourUtc: number;
  minutes: number;
  first: string;
}

export const APP_TITLE = "Eclyps · private USDC gateway";

export async function loadDeployment(): Promise<Deployment> {
  const r = await fetch("/deployment.json", { cache: "no-store" });
  if (!r.ok) throw new Error("No deployment.json next to the app. Run scripts/e2e/deploy-local.ts (local stack) or copy deployments/testnet.json.");
  return r.json();
}

export const usd = (baseUnits: string | bigint) =>
  `$${(Number(BigInt(baseUnits)) / 1e6).toLocaleString("en-US")}`;

/** Dollars and cents, exact to the base unit: "$100", "$100.50", "$6.55", "$0.005". */
export function usdExact(baseUnits: string | bigint): string {
  const b = BigInt(baseUnits);
  const whole = (b / 1_000_000n).toLocaleString("en-US");
  const frac = (b % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `$${whole}.${frac.padEnd(2, "0")}` : `$${whole}`;
}

/** "100", "$1,310.50" → base units; undefined when it is not an amount (at most 6 decimals). */
export function parseUsd(s: string): bigint | undefined {
  const m = s.replace(/[$,\s]/g, "").match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!m) return undefined;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** Fixed notes as counts, largest first: "1 × $1,000 · 3 × $100 · 1 × $10". */
export function splitLine(notes: bigint[]): string {
  const counts = new Map<bigint, number>();
  for (const d of [...notes].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts].map(([d, k]) => `${k} × ${usd(d)}`).join(" · ");
}

/**
 * The bridge screen's one quiet line under the amount (ADR 0012: the fee is on top of each note):
 * "1 × $100 · fee $0.50", and what does not fit a note, which stays in the wallet. `fee` is left
 * out while it is unknown or zero.
 */
export function bridgeLine(split: { notes: bigint[]; remainder: bigint }, fee: bigint | undefined, smallest: bigint): { text: string; rest?: string } {
  if (split.notes.length === 0) return { text: `Enter at least ${usd(smallest)}.` };
  const text = `${splitLine(split.notes)}${fee ? ` · fee ${usdExact(fee)}` : ""}`;
  return split.remainder > 0n ? { text, rest: `${usdExact(split.remainder)} stays in your wallet` } : { text };
}

/** Basis points as a percentage: 50 -> "0.5%". */
export const pct = (bps: number) => `${bps / 100}%`;

/** Solana slots are ~400 ms; epochs are measured in slots. */
export const SLOT_MS = 400;
export const epochMs = (dep: Deployment) => dep.params.epochLenSlots * SLOT_MS;

/** The Wallet Standard chain wallets sign for ("solana:mainnet", "solana:devnet", …). */
export function solanaChain(dep: Deployment): `solana:${SolanaCluster}` {
  const c = dep.solana.cluster;
  const known: SolanaCluster[] = ["mainnet", "devnet", "testnet", "localnet"];
  return `solana:${c && known.includes(c) ? c : dep.network === "local" ? "localnet" : "devnet"}`;
}

/** Host of a URL, for messages ("api.devnet.solana.com"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
