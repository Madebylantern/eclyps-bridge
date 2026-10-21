/**
 * The owner's control panel (/app/panel/): every wallet Eclyps runs on, its balance and whether it
 * needs topping up, and where the bridge's money is. Public chain data only: no keys, no server.
 * This module is the pure part (which wallets, which levels, how amounts read); panel-read.ts
 * fetches the balances.
 *
 * Levels: `fees.operatorFeeJuice` and `fees.fpcFeeJuice` from the deployment where set (mainnet),
 * else the finisher's own warning levels (finisher/README.md, RAILWAY.md).
 */
import type { Deployment } from "./deployment";

export type Chain = "solana" | "ethereum" | "aztec";
export type Unit = "SOL" | "ETH" | "FJ";

export interface Wallet {
  key: string;
  chain: Chain;
  name: string;
  address: string;
  unit: Unit;
  /** Under this it needs topping up. Absent: no level (a key used once, or rarely). */
  low?: bigint;
  /** A comfortable balance: the gauge is full here. */
  target?: bigint;
}

/** Fields of the deployment record the panel reads beyond what the app needs. */
export type PanelDeployment = Deployment & {
  solana: Deployment["solana"] & { admin?: string };
  l1: Deployment["l1"] & { deployer?: string };
  aztec: Deployment["aztec"] & { admin?: string };
  /** The finisher's public addresses (finisher/RAILWAY.md). */
  finisher?: { solana?: string; ethereum?: string; aztec?: string };
  /** Testnet only: the EclypsFPC of open question 23's test. */
  fpcTest?: { fpc?: string };
};

const DECIMALS: Record<Unit | "USDC", number> = { SOL: 9, ETH: 18, FJ: 18, USDC: 6 };
const units = (whole: number, unit: Unit) => BigInt(Math.round(whole * 1e6)) * 10n ** BigInt(DECIMALS[unit] - 6);

/** Who holds what, from the record and the gateway's own config (admin and guardian live there). */
export function walletsOf(dep: PanelDeployment, gateway?: { admin?: string; guardian?: string }): Wallet[] {
  const mainnet = dep.l1.chainId === 1;
  const fees = dep.fees as (PanelDeployment["fees"] & { operatorFeeJuice?: { low: number; target: number }; fpcFeeJuice?: { low: number; target: number } }) | undefined;
  const operatorPaysFees = fees?.operator === "feeJuice";
  const fpc = fees?.eclypsFpc?.address || dep.fpcTest?.fpc;
  const admin = gateway?.admin ?? dep.solana.admin;
  const list: (Wallet | false | undefined)[] = [
    !!admin && { key: "sol-admin", chain: "solana", name: "Admin", address: admin, unit: "SOL", low: units(0.02, "SOL"), target: units(0.2, "SOL") },
    !!gateway?.guardian && gateway.guardian !== admin && { key: "sol-guardian", chain: "solana", name: "Guardian", address: gateway.guardian, unit: "SOL", low: units(0.01, "SOL"), target: units(0.05, "SOL") },
    !!dep.finisher?.solana && { key: "sol-finisher", chain: "solana", name: "Finisher", address: dep.finisher.solana, unit: "SOL", low: units(0.05, "SOL"), target: units(0.2, "SOL") },
    !!dep.l1.deployer && { key: "eth-deployer", chain: "ethereum", name: "Deployer", address: dep.l1.deployer, unit: "ETH" },
    !!dep.finisher?.ethereum && {
      key: "eth-finisher", chain: "ethereum", name: "Finisher", address: dep.finisher.ethereum, unit: "ETH",
      low: units(mainnet ? 0.02 : 0.005, "ETH"), target: units(mainnet ? 0.1 : 0.02, "ETH"),
    },
    !!dep.aztec.admin && { key: "az-admin", chain: "aztec", name: "Admin", address: dep.aztec.admin, unit: "FJ" },
    // Pays its own Aztec fees only where there is no SponsoredFPC (mainnet).
    operatorPaysFees && !!dep.finisher?.aztec && {
      key: "az-finisher", chain: "aztec", name: "Finisher", address: dep.finisher.aztec, unit: "FJ",
      low: units(fees?.operatorFeeJuice?.low ?? 500, "FJ"), target: units(fees?.operatorFeeJuice?.target ?? 2_000, "FJ"),
    },
    !!fpc && {
      key: "az-fpc", chain: "aztec", name: "Fee payer", address: fpc, unit: "FJ",
      low: units(fees?.fpcFeeJuice?.low ?? 300, "FJ"), target: units(fees?.fpcFeeJuice?.target ?? 1_000, "FJ"),
    },
  ];
  return list.filter((w): w is Wallet => !!w);
}

/** How full the gauge is (0 to 1) and whether the wallet needs topping up. */
export function level(balance: bigint, w: Pick<Wallet, "low" | "target">): { fill?: number; low: boolean } {
  if (w.low === undefined) return { low: false };
  const target = w.target ?? w.low * 4n;
  const fill = target > 0n ? Math.min(1, Number((balance * 1000n) / target) / 1000) : 1;
  return { fill, low: balance < w.low };
}

/** "0.214 SOL", "0.0123 ETH", "1,994 FJ", "$8.02". */
export function amount(value: bigint, unit: Unit | "USDC"): string {
  const d = DECIMALS[unit];
  const shown = unit === "SOL" ? 3 : unit === "ETH" ? 4 : unit === "FJ" ? 0 : 2;
  const scale = 10n ** BigInt(d - shown);
  const rounded = (value + scale / 2n) / scale;
  const whole = rounded / 10n ** BigInt(shown);
  const frac = shown ? (rounded % 10n ** BigInt(shown)).toString().padStart(shown, "0") : "";
  const n = `${whole.toLocaleString("en-US")}${shown ? `.${frac}` : ""}`;
  return unit === "USDC" ? `$${n}` : `${n} ${unit}`;
}

/** Explorer page of an address, where one exists (Aztec has none we rely on). */
export function explorerOf(dep: Deployment, chain: Chain, address: string): string | undefined {
  if (chain === "solana") {
    const cluster = dep.solana.cluster ?? (dep.network === "local" ? "localnet" : "devnet");
    if (cluster === "localnet") return undefined;
    return `https://explorer.solana.com/address/${address}${cluster === "mainnet" ? "" : `?cluster=${cluster}`}`;
  }
  if (chain === "ethereum") {
    if (dep.l1.chainId === 1) return `https://etherscan.io/address/${address}`;
    if (dep.l1.chainId === 11155111) return `https://sepolia.etherscan.io/address/${address}`;
  }
  return undefined;
}

/** USDC on the portal's chain (Circle's own contracts). */
export function l1Usdc(chainId: number): `0x${string}` | undefined {
  if (chainId === 1) return "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  if (chainId === 11155111) return "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
  return undefined;
}
