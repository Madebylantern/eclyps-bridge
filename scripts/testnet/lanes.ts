/**
 * The gateway's V2 lanes on testnet (ADR 0015 Cross now, ADR 0017 fronted exits and the liquidity
 * pool), after the program upgrade. Nothing is sent without `--send`.
 *
 *   pnpm exec tsx testnet/lanes.ts status
 *   pnpm exec tsx testnet/lanes.ts init [--send] [--express-fee 0.10] [--front-cap-bps 30]
 *                                       [--pool-fee-bps 10] [--pool-max 100] [--keeper <address>]
 *
 * `init` is the admin's `init_lanes` (one transaction, once): creates Lanes, the crossing pool and
 * the liquidity pool. Without `--send` it prints what it would send. The keeper defaults to the
 * admin key; amounts are in dollars of test USDC. Afterwards anyone tops up the crossing pool with
 * a plain USDC transfer to the address `status` prints, and providers use `lp_deposit`.
 *
 * Keys: SOLANA_KEYPAIR (default ~/.config/eclyps/devnet.json, the admin). DEPLOYMENT (default
 * deployments/testnet.json).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, address } from "@solana/kit";
import {
  crossingPoolPda,
  decodeConfig,
  decodeLanes,
  decodeLiquidity,
  DEFAULT_ADDRESS,
  initLanesIx,
  type LaneParams,
  lanesPda,
  liquidityPda,
  liquidityVaultPda,
  poolCapacity,
} from "@eclyps/sdk";
import { loadSolanaKeypair, solanaClient } from "../../finisher/src/chains.js";

const repo = new URL("../../", import.meta.url);
const DEPLOYMENT = process.env.DEPLOYMENT ? resolve(process.env.DEPLOYMENT) : fileURLToPath(new URL("deployments/testnet.json", repo));
const dep = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as { network: string; solana: { rpc: string; config: string; usdcMint: string } };
const log = (s: string) => console.log(s);
const { rpc, send, accountData } = solanaClient(process.env.SOLANA_RPC_URL ?? dep.solana.rpc, log);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dollars = (s: string | undefined, def: string) => BigInt(Math.round(Number(s ?? def) * 1e6));
const usd = (b: bigint) => `$${(Number(b) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

async function status() {
  const raw = await accountData(await lanesPda());
  if (!raw) return log(`no V2 lanes on ${dep.solana.config} yet (run: init)`);
  const l = decodeLanes(raw);
  const pool = await rpc.getTokenAccountBalance(await crossingPoolPda(), { commitment: "confirmed" }).send().then((r) => BigInt(r.value.amount)).catch(() => 0n);
  const liq = decodeLiquidity((await accountData(await liquidityPda()))!);
  log(`express fee ${usd(l.params.expressFee)} · crossing pool ${await crossingPoolPda()} holds ${usd(pool)} (${pool >= l.params.expressFee && l.params.expressFee > 0n ? "on us" : "users pay"}) · paid so far ${usd(l.poolPaid)}`);
  log(`express crossings per denomination: ${l.expressNext.join(", ")}`);
  log(`fronts: cap ${l.params.frontFeeCapBps} bps · pool fee ${l.params.poolFeeBps} bps · keeper ${l.params.keeper === DEFAULT_ADDRESS ? "none (pool fronts off)" : l.params.keeper}`);
  log(`liquidity ${await liquidityVaultPda()}: idle ${usd(liq.liquid)} · outstanding ${usd(liq.outstanding)} / ${usd(l.params.poolMaxOutstanding)} · capacity ${usd(poolCapacity(liq, l.params))} · fees earned ${usd(liq.feesEarned)} · ${liq.fronts} fronts`);
  if (l.pending) log(`pending change, applicable from ${new Date(Number(l.pending.eta) * 1000).toISOString()}: ${JSON.stringify(l.pending.params, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}

async function init() {
  const admin = await loadSolanaKeypair(process.env.SOLANA_KEYPAIR ?? `${homedir()}/.config/eclyps/devnet.json`);
  const cfgRaw = await accountData(address(dep.solana.config));
  if (!cfgRaw) throw new Error(`no gateway config at ${dep.solana.config}`);
  const cfg = decodeConfig(cfgRaw);
  if (cfg.admin !== admin.address) throw new Error(`the admin is ${cfg.admin}, not ${admin.address}`);
  if (await accountData(await lanesPda())) return log("V2 lanes already exist");
  const params: LaneParams = {
    expressFee: dollars(flag("--express-fee"), "0.10"),
    frontFeeCapBps: Number(flag("--front-cap-bps") ?? 30),
    poolFeeBps: Number(flag("--pool-fee-bps") ?? 10),
    poolMaxOutstanding: dollars(flag("--pool-max"), "100"),
    keeper: address(flag("--keeper") ?? admin.address) as Address,
  };
  log(`init_lanes: express fee ${usd(params.expressFee)} · front cap ${params.frontFeeCapBps} bps · pool fee ${params.poolFeeBps} bps · pool max ${usd(params.poolMaxOutstanding)} · keeper ${params.keeper}`);
  log(`creates: Lanes ${await lanesPda()}, crossing pool ${await crossingPoolPda()}, liquidity ${await liquidityPda()} and its vault ${await liquidityVaultPda()} (rent about 0.01 SOL)`);
  if (!args.includes("--send")) return log("dry run: add --send to send it");
  const sig = await send([await initLanesIx(admin.address, address(dep.solana.usdcMint), params)], [admin.keyPair], admin.address);
  log(`init_lanes: ${sig}`);
}

const cmd = args[0];
if (cmd === "status") await status();
else if (cmd === "init") await init();
else log("usage: lanes.ts status | init [--send] [--express-fee 0.10] [--front-cap-bps 30] [--pool-fee-bps 10] [--pool-max 100] [--keeper <address>]");
