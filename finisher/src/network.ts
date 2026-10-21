/**
 * Which network the public finisher (src/testnet.ts) runs on, and everything that follows from it:
 * the L1 chain, Circle's Iris API, the CCTP domains, the RPC endpoints, key and state paths, the
 * Aztec fee mode and the Ethereum gas cap. Pure: it reads only what it is given (the deployment,
 * the environment, the arguments), so it is unit-tested without any network (test/network.test.ts).
 *
 * Mainnet safety: the finisher runs on mainnet only when all three agree: it was asked for mainnet
 * (`--mainnet`, `pnpm mainnet`, or NETWORK=mainnet), DEPLOYMENT is set and points at a deployment
 * whose `network` is "mainnet" (not the template), and ECLYPS_MAINNET_OK=1. A mainnet deployment
 * without the request, or the request without the deployment, is refused.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type Chain } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { type FeesConfig, type ResolvedFees, resolveFees } from "@eclyps/sdk";

export type PublicNetwork = "testnet" | "mainnet";

/** The deployment fields the public finisher reads. */
export interface Deployment {
  network: string;
  _template?: string;
  solana: { rpc?: string; config: string; usdcMint: string; exitLookupTable?: string };
  l1: { rpc?: string; chainId: number; portal: string; deployTx?: string };
  aztec: { node?: string; claims: Record<string, string> };
  denominations: string[];
  features?: { exit?: boolean };
  fees?: FeesConfig;
  /** Circle's CCTP: the Iris API and the domain ids. Absent: the network's defaults below. */
  cctp?: { iris?: string; domains?: { ethereum?: number; solana?: number } };
}

/** L1 chains the finisher signs for, by chain id. */
export const CHAINS: Record<number, Chain> = { [mainnet.id]: mainnet, [sepolia.id]: sepolia };

export const IRIS = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
} as const;

/** CCTP domain ids are the same on mainnet and testnet (Ethereum / Sepolia 0, Solana / devnet 5). */
export const DEFAULT_DOMAINS = { ethereum: 0, solana: 5 } as const;

/** Endpoints used when neither the environment nor the deployment names one. */
export const DEFAULT_RPC: Record<PublicNetwork, { solana: string; ethereum: string; aztec?: string }> = {
  mainnet: { solana: "https://api.mainnet-beta.solana.com", ethereum: "https://ethereum-rpc.publicnode.com" },
  testnet: { solana: "https://api.devnet.solana.com", ethereum: "https://ethereum-sepolia-rpc.publicnode.com" },
};

/** Default Ethereum gas cap (gwei): the mainnet budgets run from 1 to 20 gwei (docs/mainnet-checklist.md). */
export const DEFAULT_MAX_GWEI: Record<PublicNetwork, number | undefined> = { mainnet: 20, testnet: undefined };

export interface FinisherConfig {
  network: PublicNetwork;
  deploymentPath: string;
  chain: Chain;
  /** "Sepolia" or "Ethereum", for log lines. */
  l1Name: string;
  iris: string;
  domains: { ethereum: number; solana: number };
  rpc: { solana: string; ethereum: string; aztec: string };
  fees: ResolvedFees;
  /** Relays and exitBatch wait while the L1 gas price is above this (gwei); undefined: no cap. */
  maxGwei?: number;
  keys: {
    /** Inline keys from the environment win over the files. */
    solanaInline?: string;
    ethereumInline?: string;
    solanaFile: string;
    ethereumFile: string;
    /** The env names to mention when a key file is missing. */
    solanaFileEnv: string;
    ethereumFileEnv: string;
  };
  statePath: string;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}
const refuse = (msg: string): never => {
  throw new ConfigError(msg);
};

/** The network asked for: `--mainnet` / `--testnet` win, else NETWORK, else testnet. Both and different: refused. */
export function requestedNetwork(argv: readonly string[], env: Env): PublicNetwork {
  const flag = argv.includes("--mainnet") ? "mainnet" : argv.includes("--testnet") ? "testnet" : undefined;
  if (argv.includes("--mainnet") && argv.includes("--testnet")) refuse("both --mainnet and --testnet given");
  const fromEnv = env.NETWORK?.trim() || undefined;
  if (fromEnv !== undefined && fromEnv !== "mainnet" && fromEnv !== "testnet") refuse(`NETWORK must be "mainnet" or "testnet", not "${fromEnv}"`);
  if (flag && fromEnv && flag !== fromEnv) refuse(`--${flag} given but NETWORK=${fromEnv}`);
  return (flag ?? fromEnv ?? "testnet") as PublicNetwork;
}

/** The deployment file: DEPLOYMENT, or deployments/testnet.json on testnet. Mainnet needs it set. */
export function deploymentPath(network: PublicNetwork, env: Env, testnetDefault: string): string {
  if (env.DEPLOYMENT) return resolve(env.DEPLOYMENT);
  if (network === "mainnet") refuse("mainnet: set DEPLOYMENT to the mainnet deployment file (deployments/mainnet.json)");
  return testnetDefault;
}

/** Ethereum gas cap from FINISHER_MAX_GWEI ("off" for none), else the network's default. */
export function maxGwei(network: PublicNetwork, env: Env): number | undefined {
  const v = env.FINISHER_MAX_GWEI?.trim();
  if (!v) return DEFAULT_MAX_GWEI[network];
  if (v === "off") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) refuse(`FINISHER_MAX_GWEI must be a positive number of gwei or "off", not "${v}"`);
  return n;
}

const httpUrl = (name: string, v: string): string => {
  if (!/^https?:\/\/\S+$/.test(v)) refuse(`${name} is not an http(s) URL: "${v}"`);
  return v.replace(/\/+$/, "");
};

const domainId = (name: string, v: unknown, fallback: number): number => {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffffffff) refuse(`cctp.domains.${name} must be a uint32, not ${JSON.stringify(v)}`);
  return v as number;
};

/**
 * Resolves the whole configuration, or throws a ConfigError saying what to fix. `home` stands for
 * the home directory in key and state defaults (so tests do not depend on the machine).
 */
export function resolveConfig(a: {
  argv: readonly string[];
  env: Env;
  dep: Deployment;
  deploymentPath: string;
  home?: string;
}): FinisherConfig {
  const { argv, env, dep } = a;
  const home = a.home ?? homedir();
  const network = requestedNetwork(argv, env);
  const where = a.deploymentPath;

  // ---- the mainnet gate ----
  if (dep._template !== undefined) refuse(`${where} is the mainnet template, not a deployment (scripts/mainnet writes deployments/mainnet.json)`);
  if (dep.network === "mainnet" && network !== "mainnet") {
    refuse(`${where} is a mainnet deployment; run the mainnet finisher (pnpm --filter @eclyps/finisher mainnet) to use it`);
  }
  if (network === "mainnet") {
    if (dep.network !== "mainnet") refuse(`mainnet asked for, but ${where} is a "${dep.network}" deployment`);
    if (env.ECLYPS_MAINNET_OK !== "1") refuse("mainnet: set ECLYPS_MAINNET_OK=1 to confirm this finisher may send mainnet transactions");
  } else if (dep.network !== "testnet") {
    refuse(`${where} is a "${dep.network}" deployment; this is the testnet finisher`);
  }
  if (!dep.l1?.portal) refuse(`${where} has no portal yet: the ${network} is not fully deployed`);

  // ---- L1 chain ----
  const chain = CHAINS[dep.l1.chainId] ?? refuse(`${where}: unknown l1.chainId ${dep.l1.chainId} (known: ${Object.keys(CHAINS).join(", ")})`);
  if (network === "mainnet" && chain.id !== mainnet.id) refuse(`${where}: a mainnet deployment must be on chain ${mainnet.id}, not ${chain.id}`);
  if (network === "testnet" && chain.id === mainnet.id) refuse(`${where}: a testnet deployment on Ethereum mainnet (chain 1)`);
  const l1Name = chain.id === mainnet.id ? "Ethereum" : "Sepolia";

  // ---- Circle ----
  const iris = httpUrl(env.IRIS_URL ? "IRIS_URL" : "cctp.iris", env.IRIS_URL || dep.cctp?.iris || IRIS[network]);
  if (network === "mainnet" && iris.includes("sandbox")) refuse(`mainnet with the Iris sandbox (${iris}); use ${IRIS.mainnet}`);
  if (network === "testnet" && iris === IRIS.mainnet) refuse(`testnet with the mainnet Iris (${iris}); use ${IRIS.testnet}`);
  const domains = {
    ethereum: domainId("ethereum", dep.cctp?.domains?.ethereum, DEFAULT_DOMAINS.ethereum),
    solana: domainId("solana", dep.cctp?.domains?.solana, DEFAULT_DOMAINS.solana),
  };

  // ---- endpoints: env, else the deployment, else the network's default ----
  // SEPOLIA_RPC_URL is the testnet name kept for existing setups; mainnet reads ETHEREUM_RPC_URL only.
  const ethEnv = env.ETHEREUM_RPC_URL || (network === "testnet" ? env.SEPOLIA_RPC_URL : undefined);
  const aztecNode = env.AZTEC_NODE_URL || dep.aztec?.node || DEFAULT_RPC[network].aztec;
  const rpc = {
    solana: httpUrl("the Solana RPC", env.SOLANA_RPC_URL || dep.solana?.rpc || DEFAULT_RPC[network].solana),
    ethereum: httpUrl("the Ethereum RPC", ethEnv || dep.l1.rpc || DEFAULT_RPC[network].ethereum),
    aztec: httpUrl("the Aztec node", aztecNode ?? refuse(`no Aztec node: set AZTEC_NODE_URL or aztec.node in ${where}`)),
  };

  // ---- Aztec fees (ADR 0018): resolveFees refuses the SponsoredFPC on mainnet ----
  let fees: ResolvedFees;
  try {
    fees = resolveFees(dep);
  } catch (e) {
    return refuse((e as Error).message);
  }

  // ---- keys and state: separate defaults per network, so a mainnet run never picks up test keys ----
  const expand = (p: string) => resolve(p.startsWith("~/") ? `${home}${p.slice(1)}` : p);
  const dir = network === "mainnet" ? "~/.config/eclyps/mainnet" : "~/.config/eclyps";
  const keys = {
    solanaInline: env.FINISHER_SOLANA_KEY || undefined,
    ethereumInline: env.FINISHER_ETHEREUM_PRIVATE_KEY || (network === "testnet" ? env.FINISHER_SEPOLIA_PRIVATE_KEY : undefined) || undefined,
    solanaFile: expand(env.FINISHER_SOLANA_KEYPAIR ?? `${dir}/${network === "mainnet" ? "solana.json" : "devnet.json"}`),
    ethereumFile: expand(env.FINISHER_ETHEREUM_KEY ?? (network === "testnet" ? env.FINISHER_SEPOLIA_KEY : undefined) ?? `${dir}/${network === "mainnet" ? "ethereum.key" : "sepolia.key"}`),
    solanaFileEnv: "FINISHER_SOLANA_KEYPAIR",
    ethereumFileEnv: network === "mainnet" ? "FINISHER_ETHEREUM_KEY" : "FINISHER_SEPOLIA_KEY",
  };
  if (network === "mainnet" && env.FINISHER_SEPOLIA_PRIVATE_KEY && !env.FINISHER_ETHEREUM_PRIVATE_KEY) {
    refuse("mainnet reads FINISHER_ETHEREUM_PRIVATE_KEY, not FINISHER_SEPOLIA_PRIVATE_KEY (use fresh mainnet keys)");
  }
  const statePath = expand(
    env.FINISHER_STATE ??
      (env.ECLYPS_DATA_DIR ? `${env.ECLYPS_DATA_DIR}/finisher-state.json` : `~/.config/eclyps/${network}/finisher-state.json`),
  );

  return {
    network, deploymentPath: where, chain, l1Name, iris, domains, rpc, fees,
    maxGwei: maxGwei(network, env), keys, statePath,
  };
}

/**
 * The gas guard: whether an L1 transaction may be sent at `gasPriceWei`. Above the cap it waits
 * (the step is retried on a later pass); it never raises the price it pays.
 */
export function gasCheck(gasPriceWei: bigint, maxGweiCap: number | undefined): { ok: boolean; gwei: number } {
  const gwei = Number(gasPriceWei) / 1e9;
  return { ok: maxGweiCap === undefined || gwei <= maxGweiCap, gwei };
}

/** Whether the periodic Fee Juice check (ADR 0018 refill loop) is due. */
export function feeJuiceCheckDue(lastAt: number | undefined, now: number, everyMs: number): boolean {
  return lastAt === undefined || now - lastAt >= everyMs;
}
