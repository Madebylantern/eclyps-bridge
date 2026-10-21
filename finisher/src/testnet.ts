/**
 * Eclyps finisher on a public network (SPEC §5.2): Solana devnet -> Sepolia -> Aztec testnet, or
 * Solana -> Ethereum -> Aztec mainnet. The network, chain, Iris, CCTP domains, endpoints, fee mode
 * and gas cap come from src/network.ts (the deployment and the environment).
 *
 *   pnpm --filter @eclyps/finisher testnet              # a pass every 60 s, until Ctrl-C
 *   pnpm --filter @eclyps/finisher testnet -- --once    # one pass
 *   ECLYPS_MAINNET_OK=1 DEPLOYMENT=deployments/mainnet.json pnpm --filter @eclyps/finisher mainnet
 *   pnpm --filter @eclyps/finisher start                # NETWORK=mainnet|testnet (the Docker image)
 *
 * Each pass, for every denomination:
 *   close_epoch    epochs that ended (or filled) with at least the batch minimum
 *   rollover       close_epoch on an ended epoch below the minimum but not empty, once per end: its
 *                  deposits become refundable (ADR 0010)
 *   send_batch     closed epochs: the CCTP burn; pays this finisher its share of the fees (ADR 0012)
 *   relay          Circle's attested message (Iris) -> EclypsPortal.relay on L1 (gas cap: FINISHER_MAX_GWEI)
 *   register_batch on Aztec, once the L1->L2 message is in a block (fees: the deployment's
 *                  `fees.operator`: the SponsoredFPC on testnet, its own Fee Juice on mainnet)
 * and, when the deployment has exits on (`features.exit`, ADR 0009; src/exits.ts):
 *   close_exit_epoch  on Aztec, for an exit epoch with at least the minimum of exits that has ended
 *   exitBatch         on L1, once the Aztec epoch is proven (the Outbox witness from the node)
 *   receive_exit      on Solana, with Circle's attestation of the exitBatch transaction (Iris)
 * Progress is saved after every step. Before each action the chains are checked (epoch status,
 * portal `received`, `is_registered`), so a restart resumes without sending, relaying or
 * registering anything twice, and several finishers can run at once.
 *
 * Env (defaults per network in src/network.ts): DEPLOYMENT (testnet: deployments/testnet.json;
 * mainnet: required), FINISHER_SOLANA_KEYPAIR, FINISHER_ETHEREUM_KEY (testnet also
 * FINISHER_SEPOLIA_KEY), FINISHER_STATE (the Aztec account keys and wallet database sit next to
 * it), FINISHER_INTERVAL (seconds, default 60), FINISHER_MAX_GWEI (mainnet 20, "off" for none),
 * FINISHER_FEE_JUICE_CHECK (minutes between Fee Juice checks, 30), DEBUG=1 for stack traces.
 * Endpoints: SOLANA_RPC_URL, ETHEREUM_RPC_URL (testnet also SEPOLIA_RPC_URL), AZTEC_NODE_URL,
 * IRIS_URL, else the deployment's, else the network's defaults.
 * Hosted (finisher/RAILWAY.md): ECLYPS_DATA_DIR (state and wallet on a volume), FINISHER_SOLANA_KEY
 * (JSON array or base58), FINISHER_ETHEREUM_PRIVATE_KEY (hex; testnet also
 * FINISHER_SEPOLIA_PRIVATE_KEY), FINISHER_AZTEC_SECRET / _SALT / _SIGNING_KEY (else made once in
 * the data dir). Secrets are never logged.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { isL1ToL2MessageReady } from "@aztec-labs/aztec.js/messaging";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { type Address, address, type Signature } from "@solana/kit";
import { createPublicClient, createWalletClient, type Hex, hexToBytes, http } from "viem";
import {
  associatedTokenAddress,
  closeEpochIx,
  computeUnitLimitIx,
  decodeBatchHook,
  decodeConfig,
  decodeEpoch,
  epochPda,
  decodeExpressEpoch,
  decodeLanes,
  expressPda,
  lanesPda,
  portalMatches,
  refillAmount,
  toHex as fieldHex,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { aztecExitLeg, ethereumExitLeg, type ExitContext, findExitBatchTx, readAztecClock, solanaExitLeg } from "./exits.js";
import {
  type AztecKeys,
  BATCH_FORWARDED,
  connectAztec,
  findSendBatch,
  irisLookup,
  loadSepoliaAccount,
  loadSolanaKeypair,
  sepoliaAccountFromString,
  solanaKeypairFromString,
  newAztecKeys,
  PORTAL_ABI,
  readRelay,
  sendBatchTx,
  sendExpressBatchTx,
  solanaClient,
} from "./chains.js";
import { type Deployment, feeJuiceCheckDue, gasCheck, resolveConfig, deploymentPath as resolveDeploymentPath, requestedNetwork } from "./network.js";
import {
  advanceDone,
  advanceExpressDone,
  expressReward,
  expressToCarry,
  isExpress,
  type Batch,
  closeAction,
  batchKey,
  batchName,
  emptyState,
  epochsToCarry,
  exitsBusy,
  type ExitState,
  exitSummary,
  type FinisherState,
  finisherReward,
  fmtDuration,
  fmtUnits,
  type IrisReply,
  isDue,
  lowBalances,
  nextDelayMs,
  oneLine,
  Quiet,
  RateGate,
  recordFailure,
  recordRollover,
  recordSuccess,
  relayStuck,
  SEND_MIN_LAMPORTS,
  sizeName,
  stageOf,
  stateMatches,
  summarize,
  summaryLine,
  usd,
} from "./plan.js";

// ---------------- configuration ----------------
const repo = new URL("../../", import.meta.url);
const ONCE = process.argv.includes("--once");
const DEBUG = Boolean(process.env.DEBUG);

function fail(e: unknown): never {
  console.error(`error: ${oneLine(e, 400)}`);
  if (DEBUG) console.error(e);
  process.exit(1);
}

// src/network.ts: the network asked for, the deployment, and the mainnet gate (ECLYPS_MAINNET_OK=1).
const { cfg: CFG, dep } = (() => {
  try {
    const network = requestedNetwork(process.argv, process.env);
    const path = resolveDeploymentPath(network, process.env, fileURLToPath(new URL("deployments/testnet.json", repo)));
    if (!existsSync(path)) throw new Error(`no deployment at ${path} (set DEPLOYMENT)`);
    const dep = JSON.parse(readFileSync(path, "utf8")) as Deployment;
    return { cfg: resolveConfig({ argv: process.argv, env: process.env, dep, deploymentPath: path }), dep };
  } catch (e) {
    return fail(e);
  }
})();
const DEPLOYMENT = CFG.deploymentPath;
const NETWORK = CFG.network;
const L1 = CFG.l1Name;
const STATE = CFG.statePath;
const STATE_DIR = dirname(STATE);
const AZTEC_KEYS = `${STATE_DIR}/finisher-aztec.json`;
const PXE_DIR = `${STATE_DIR}/finisher-pxe`;
const LOCK = `${STATE}.lock`;
const INTERVAL_MS = Math.max(5, Number(process.env.FINISHER_INTERVAL ?? 60)) * 1000;
/** ADR 0018 refill loop: how often the Fee Juice balance is checked in "feeJuice" mode. */
const FEE_JUICE_EVERY_MS = Math.max(1, Number(process.env.FINISHER_FEE_JUICE_CHECK ?? 30)) * 60_000;
/** L1 blocks per getLogs request when looking for a relay this finisher did not send. */
const LOG_CHUNK = 10_000n;
/** Leg-level retries (an RPC or node down) back off up to 10 minutes. */
const LEG_RETRY_MAX_MS = 10 * 60_000;

const log = (s: string) => console.log(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${s}`);
const debug = (e: unknown) => {
  if (DEBUG) console.error(e);
};
const quiet = new Quiet();
/** A waiting line: printed when it changes, or again after 15 minutes. */
const waiting = (key: string, line: string) => {
  if (quiet.shouldLog(key, line, Date.now())) log(line);
};
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 10)}…` : s);

// ---------------- setup ----------------
const SOLANA_RPC = CFG.rpc.solana;
const L1_RPC = CFG.rpc.ethereum;
const AZTEC_NODE = CFG.rpc.aztec;
// ADR 0018: who pays this finisher's Aztec fees (testnet: the SponsoredFPC; mainnet: its own Fee Juice).
const FEES = CFG.fees;
const IRIS = CFG.iris;
const portal = dep.l1.portal as Hex;
const configAddr = address(dep.solana.config);
const usdcMint = address(dep.solana.usdcMint);

const keyFile = (path: string, env: string) => {
  if (!existsSync(path)) fail(`no key at ${path} (set ${env})`);
  return path;
};
// Keys come from the environment when set (FINISHER_SOLANA_KEY, FINISHER_ETHEREUM_PRIVATE_KEY), else from the files.
const me = await (CFG.keys.solanaInline
  ? solanaKeypairFromString(CFG.keys.solanaInline)
  : loadSolanaKeypair(keyFile(CFG.keys.solanaFile, CFG.keys.solanaFileEnv))
).catch(() => fail("FINISHER_SOLANA_KEY is not a valid Solana key"));
const l1Account = (() => {
  try {
    if (CFG.keys.ethereumInline) return sepoliaAccountFromString(CFG.keys.ethereumInline);
    return loadSepoliaAccount(keyFile(CFG.keys.ethereumFile, CFG.keys.ethereumFileEnv));
  } catch (e) {
    return fail(e);
  }
})();
const finisherUsdc = await associatedTokenAddress(me.address, usdcMint);

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, "utf8"));
  if (pid && pid !== process.pid && alive(pid)) fail(`another finisher is running with ${STATE} (pid ${pid})`);
}
writeFileSync(LOCK, String(process.pid), { mode: 0o600 });
process.on("exit", () => {
  try {
    if (readFileSync(LOCK, "utf8") === String(process.pid)) unlinkSync(LOCK);
  } catch {
    /* already gone */
  }
});

const sol = solanaClient(SOLANA_RPC, log);
const l1 = createPublicClient({ chain: CFG.chain, transport: http(L1_RPC, { retryCount: 3, timeout: 30_000 }) });
const l1w = createWalletClient({ account: l1Account, chain: CFG.chain, transport: http(L1_RPC, { retryCount: 3, timeout: 30_000 }) });
// Public testnet nodes (drpc's free tier) refuse JSON-RPC batches of more than 3 requests.
const aztecNode = createAztecNodeClient(AZTEC_NODE, { maxBatchSize: 3 });
const irisGate = new RateGate(1_000); // Circle allows 35 requests per second; one per second is plenty

// ---------------- state ----------------
function loadState(): FinisherState {
  if (!existsSync(STATE)) return emptyState(dep.solana.config, portal);
  const saved = JSON.parse(readFileSync(STATE, "utf8")) as Partial<FinisherState>;
  if (stateMatches(saved, dep.solana.config, portal)) return saved as FinisherState;
  const aside = `${STATE}.${Date.now()}.old`;
  renameSync(STATE, aside);
  log(`the saved state belongs to another deployment; moved it to ${aside}`);
  return emptyState(dep.solana.config, portal);
}
const state = loadState();
/** Atomic: a kill mid-write never leaves a broken state file. */
function save() {
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STATE);
}

function aztecKeys(): AztecKeys {
  const { FINISHER_AZTEC_SECRET: secret, FINISHER_AZTEC_SALT: salt, FINISHER_AZTEC_SIGNING_KEY: signingKey } = process.env;
  if (secret && salt && signingKey) return { secret, salt, signingKey };
  if (existsSync(AZTEC_KEYS)) return JSON.parse(readFileSync(AZTEC_KEYS, "utf8"));
  const keys = newAztecKeys();
  writeFileSync(AZTEC_KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
  log(`created this finisher's Aztec account keys in ${AZTEC_KEYS} (private; keep it)`);
  return keys;
}
aztecKeys(); // once, at the first start

// ---------------- stop ----------------
let stopping = false;
let wake: (() => void) | undefined;
const onSignal = () => {
  if (stopping) {
    log("stopping now");
    process.exit(130);
  }
  stopping = true;
  log("stopping after the current step (Ctrl-C again to stop now)");
  wake?.();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const pause = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    wake = () => {
      clearTimeout(t);
      r();
    };
  });

// ---------------- startup check ----------------
async function startup() {
  const raw = await sol.accountData(configAddr);
  if (!raw) throw new Error(`the gateway config ${configAddr} does not exist on ${SOLANA_RPC}`);
  const cfg = decodeConfig(raw);
  if (!portalMatches(cfg, portal)) throw new Error(`the gateway sends batches to another portal than ${portal}`);
  const chainId = await l1.getChainId();
  if (chainId !== CFG.chain.id) throw new Error(`${L1_RPC} is chain ${chainId}, the deployment says ${CFG.chain.id}`);

  const lamports = (await sol.rpc.getBalance(me.address, { commitment: "confirmed" }).send()).value;
  const wei = await l1.getBalance({ address: l1Account.address });
  const usdc = await sol.rpc
    .getTokenAccountBalance(finisherUsdc, { commitment: "confirmed" })
    .send()
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n); // created with the first batch this finisher sends
  if (NETWORK === "mainnet") log(`MAINNET: real money · ${DEPLOYMENT}`);
  log(`finisher ${me.address} (Solana) · ${l1Account.address} (${L1})`);
  log(`balances: ${fmtUnits(lamports, 9)} SOL · ${fmtUnits(wei, 18)} ETH · ${usd(usdc)} USDC`);
  for (const w of lowBalances({ lamports, wei }, `${L1} ETH`)) log(`warning: ${w}`);
  for (let idx = 0; idx < cfg.denominations.length; idx++) {
    const d = cfg.denominations[idx]!;
    if (d > 0n && !dep.aztec.claims?.[d.toString()]) {
      log(`warning: no Aztec claim contract for ${sizeName(d)} in the deployment: its batches stop after the relay`);
    }
  }
  log(`so far: ${summaryLine(summarize(state))}`);
  log(`iris ${IRIS} · CCTP domains Ethereum ${CFG.domains.ethereum}, Solana ${CFG.domains.solana} · gas cap ${CFG.maxGwei === undefined ? "off" : `${CFG.maxGwei} gwei`}`);
  log(`state ${STATE} · a pass every ${fmtDuration(INTERVAL_MS)}${ONCE ? " (once)" : ""}`);
}

// ---------------- steps ----------------
/** Runs one step for a batch; a failure is logged on one line and retried later with backoff. */
async function step(b: Batch, what: string, fn: () => Promise<void>) {
  if (!isDue(b, Date.now())) return;
  try {
    await fn();
  } catch (e) {
    const wait = recordFailure(b, Date.now(), oneLine(e));
    save();
    log(`${what} ${batchName(b)} failed: ${oneLine(e)}; retry in ${fmtDuration(wait)}`);
    debug(e);
  }
}

function advanced(b: Batch) {
  recordSuccess(b);
  quiet.forget(batchKey(b.denomination, b.epochId));
  save();
}

const closeRetry: Record<string, { failures?: number; retryAt?: number; lastError?: string }> = {};

/** Solana: close ended epochs that reached the batch minimum, then send closed ones. */
async function solanaLeg() {
  const raw = await sol.accountData(configAddr);
  if (!raw) throw new Error("gateway config not found");
  let cfg = decodeConfig(raw);
  const slot = await sol.rpc.getSlot({ commitment: "confirmed" }).send();
  for (let idx = 0; idx < cfg.denominations.length && !stopping; idx++) {
    const d = cfg.denominations[idx]!;
    if (d === 0n) continue;
    const denom = d.toString();
    let current = cfg.currentEpoch[idx]!;

    // At most one close_epoch per denomination per pass: a close (the batch minimum is reached)
    // or a rollover (an ended epoch below it, so its deposits become refundable, ADR 0010).
    const openRaw = await sol.accountData(await epochPda(idx, current));
    const cr = (closeRetry[denom] ??= {});
    if (openRaw && isDue(cr, Date.now())) {
      const e = decodeEpoch(openRaw);
      const action = closeAction(e, slot, cfg.params);
      if (action !== "none") {
        const name = batchName({ denomination: denom, epochId: current.toString() });
        const what = action === "close" ? "close_epoch" : "rollover";
        try {
          const sig = await sol.send([computeUnitLimitIx(400_000), await closeEpochIx(idx, current)], [me.keyPair], me.address);
          recordSuccess(cr);
          if (action === "close") log(`close_epoch ${name}: ${e.leaves.length} notes (${short(sig)})`);
          else {
            const fee = await txFee(sig);
            recordRollover(state, fee);
            save();
            const after = await sol.accountData(await epochPda(idx, current));
            const until = after ? ` until slot ${decodeEpoch(after).endSlot}` : "";
            log(`rollover ${name}: ${e.leaves.length} of ${cfg.params.minBatchSize} notes, open${until} (rollover ${e.rollovers + 1}, ${fmtUnits(fee, 9, 9)} SOL)`);
          }
        } catch (err) {
          // Another finisher may have closed or rolled it first: the reads below and next pass tell.
          const wait = recordFailure(cr, Date.now(), oneLine(err), LEG_RETRY_MAX_MS);
          log(`${what} ${name} failed: ${oneLine(err)}; retry in ${fmtDuration(wait)}`);
          debug(err);
        }
        cfg = decodeConfig((await sol.accountData(configAddr))!);
        current = cfg.currentEpoch[idx]!;
      }
    }

    for (const id of epochsToCarry(state, denom, current)) {
      if (stopping) return;
      const key = batchKey(denom, id);
      const b = (state.batches[key] ??= { denomination: denom, index: idx, epochId: id.toString() });
      if (stageOf(b) !== "send") continue;
      await step(b, "send_batch", () => sendOne(b, cfg.params.treasury));
    }
  }
  await expressLeg(cfg.denominations, cfg.params.treasury);
}

/**
 * Express batches (ADR 0015), once the gateway has its V2 lanes: every express epoch is closed
 * when it is made, so it is sent at once. The relay and register steps then carry it like any
 * batch.
 */
async function expressLeg(denominations: bigint[], treasury: Address) {
  const raw = await sol.accountData(await lanesPda());
  if (!raw) return; // V2 not on this gateway
  const lanes = decodeLanes(raw);
  for (let idx = 0; idx < denominations.length && !stopping; idx++) {
    const d = denominations[idx]!;
    if (d === 0n) continue;
    const denom = d.toString();
    for (const id of expressToCarry(state, denom, lanes.expressNext[idx] ?? 0n)) {
      if (stopping) return;
      const b = (state.batches[batchKey(denom, id)] ??= { denomination: denom, index: idx, epochId: id.toString() });
      if (stageOf(b) !== "send") continue;
      await step(b, "send_express_batch", () => sendExpressOne(b, treasury));
    }
  }
}

async function sendExpressOne(b: Batch, treasury: Address) {
  const name = batchName(b);
  const id = BigInt(b.epochId);
  const addr = await expressPda(b.index, id);
  const raw = await sol.accountData(addr);
  if (!raw) throw new Error(`express epoch ${addr} not found`);
  const x = decodeExpressEpoch(raw);
  Object.assign(b, { root: fieldHex(x.root), leafCount: 1 });
  const adoptSent = async () => {
    const found = await findSendBatch(sol.rpc, addr);
    b.sent = true;
    if (found) b.burnSig = found.sig;
    if (found?.feePayer === me.address) Object.assign(b, { sentByUs: true, reward: expressReward(x).toString() });
    log(found?.feePayer === me.address ? `send_express_batch ${name}: found this finisher's burn` : `${name}: sent by another finisher; carrying it on`);
    advanced(b);
  };
  if (x.status === "Sent") return adoptSent();
  const lamports = (await sol.rpc.getBalance(me.address, { commitment: "confirmed" }).send()).value;
  if (lamports < SEND_MIN_LAMPORTS) {
    waiting(batchKey(b.denomination, b.epochId), `send_express_batch ${name}: needs about 0.006 SOL at ${me.address}`);
    return;
  }
  const { ixs, event } = await sendExpressBatchTx({ payer: me.address, usdcMint, treasury, denominationIndex: b.index, expressId: id });
  let sig: string;
  try {
    sig = await sol.send(ixs, [me.keyPair, event.keyPair], me.address);
  } catch (err) {
    const after = await sol.accountData(addr);
    if (after && decodeExpressEpoch(after).status === "Sent") return adoptSent();
    throw err;
  }
  const reward = expressReward(x);
  Object.assign(b, { sent: true, burnSig: sig, sentByUs: true, reward: reward.toString() });
  advanced(b);
  log(`send_express_batch ${name}: CCTP burn ${short(sig)} · 1 note${x.paidByPool ? " (express fee from the crossing pool)" : ""} · earned ${usd(reward)}`);
}

/** The Solana account a batch's send touched: its epoch, or its express epoch. */
const batchAccount = (b: Batch) => (isExpress(b.epochId) ? expressPda(b.index, BigInt(b.epochId)) : epochPda(b.index, BigInt(b.epochId)));

/** The fee a confirmed transaction paid (lamports); 5,000 per signature if it cannot be read. */
async function txFee(sig: string): Promise<bigint> {
  const tx = await sol.rpc
    .getTransaction(sig as Signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
    .send()
    .catch(() => null);
  return tx?.meta?.fee ?? 5_000n;
}

async function sendOne(b: Batch, treasury: Address) {
  const name = batchName(b);
  const id = BigInt(b.epochId);
  const epochAddr = await epochPda(b.index, id);
  const raw = await sol.accountData(epochAddr);
  if (!raw) throw new Error(`epoch account ${epochAddr} not found`);
  const e = decodeEpoch(raw);
  if (e.status === "Open") return;
  Object.assign(b, { root: fieldHex(e.root), leafCount: e.leaves.length });

  // Sent before this finisher looked: by another finisher, or by this one before a crash.
  const adoptSent = async () => {
    const found = await findSendBatch(sol.rpc, epochAddr);
    b.sent = true;
    if (found) b.burnSig = found.sig;
    if (found?.feePayer === me.address) {
      Object.assign(b, { sentByUs: true, reward: finisherReward(e.denomination, e.finisherBps, e.leaves.length).toString() });
      log(`send_batch ${name}: found this finisher's burn ${short(found.sig)}`);
    } else {
      log(`${name}: sent by another finisher${found ? ` (${short(found.sig)})` : ""}; carrying it on`);
    }
    advanced(b);
  };
  if (e.status === "Sent") return adoptSent();

  const lamports = (await sol.rpc.getBalance(me.address, { commitment: "confirmed" }).send()).value;
  if (lamports < SEND_MIN_LAMPORTS) {
    waiting(batchKey(b.denomination, b.epochId), `send_batch ${name}: needs about 0.006 SOL at ${me.address} (has ${fmtUnits(lamports, 9)})`);
    return;
  }
  const { ixs, event } = await sendBatchTx({ payer: me.address, usdcMint, treasury, denominationIndex: b.index, epochId: id });
  let sig: string;
  try {
    sig = await sol.send(ixs, [me.keyPair, event.keyPair], me.address);
  } catch (err) {
    // Sent anyway (this transaction landed late, or another finisher was first)?
    const after = await sol.accountData(epochAddr);
    if (after && decodeEpoch(after).status === "Sent") return adoptSent();
    throw err;
  }
  const reward = finisherReward(e.denomination, e.finisherBps, e.leaves.length);
  Object.assign(b, { sent: true, burnSig: sig, sentByUs: true, reward: reward.toString() });
  advanced(b);
  log(`send_batch ${name}: CCTP burn ${short(sig)} · ${e.leaves.length} notes · earned ${usd(reward)}`);
}

/**
 * The gas guard: a reason to wait while the L1 gas price is above FINISHER_MAX_GWEI (the step is
 * retried on a later pass), or undefined to go ahead.
 */
async function gasWait(): Promise<string | undefined> {
  if (CFG.maxGwei === undefined) return undefined;
  const g = gasCheck(await l1.getGasPrice(), CFG.maxGwei);
  return g.ok ? undefined : `gas ${g.gwei.toFixed(1)} gwei is above FINISHER_MAX_GWEI ${CFG.maxGwei}; waiting`;
}

/** Ethereum: Circle's attestation, then EclypsPortal.relay. */
async function ethereumLeg() {
  for (const b of Object.values(state.batches)) {
    if (stopping) return;
    if (stageOf(b) === "relay") await step(b, "relay", () => relayOne(b));
  }
}

async function iris(burnSig: string): Promise<IrisReply> {
  const now = Date.now();
  if (irisGate.blocked(now)) return { kind: "rate-limited", retryAfterMs: irisGate.waitMs(now) };
  const wait = irisGate.waitMs(now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  irisGate.hit(Date.now());
  const r = await irisLookup(IRIS, burnSig, CFG.domains.solana);
  if (r.kind === "rate-limited") irisGate.block(Date.now(), r.retryAfterMs);
  return r;
}

async function relayOne(b: Batch) {
  const name = batchName(b);
  const key = batchKey(b.denomination, b.epochId);
  const d = BigInt(b.denomination);
  const id = BigInt(b.epochId);

  // 1. This finisher's relay, if sent: its receipt.
  if (b.relayTx) {
    const receipt = await l1.getTransactionReceipt({ hash: b.relayTx as Hex }).catch(() => undefined);
    if (receipt?.status === "success") return relayed(b, receipt.logs, b.relayTx);
    if (receipt) log(`relay ${name}: ${L1} tx ${short(b.relayTx)} reverted; checking the portal`);
    else if (!relayStuck(b, Date.now())) return waiting(key, `relay ${name}: waiting for ${L1} tx ${short(b.relayTx)}`);
    else log(`relay ${name}: ${L1} tx ${short(b.relayTx)} not mined after 10 min; checking the portal`);
    delete b.relayTx;
    delete b.relaySubmittedAt;
    save();
  }

  // 2. Already received by the portal (another finisher, or a lost record): read its L1->L2 message.
  if (await l1.readContract({ address: portal, abi: PORTAL_ABI, functionName: "received", args: [d, id] })) {
    const f = await findForwarded(d, id);
    if (!f) throw new Error("the portal received this batch but its BatchForwarded event was not found");
    Object.assign(b, { l1ToL2Hash: f.messageKey, l1ToL2Index: f.messageIndex.toString(), relayedByUs: f.from === l1Account.address.toLowerCase() });
    advanced(b);
    log(`relay ${name}: already on ${L1} (${short(f.tx)}); L1→L2 leaf ${b.l1ToL2Index}`);
    return;
  }

  // 3. Circle's attestation of the burn.
  if (!b.message || !b.attestation) {
    if (!b.burnSig) {
      const found = await findSendBatch(sol.rpc, await batchAccount(b));
      if (!found) throw new Error("cannot find the batch's send_batch transaction");
      b.burnSig = found.sig;
      save();
    }
    const r = await iris(b.burnSig);
    if (r.kind === "rate-limited") return waiting(key, `iris ${name}: rate limited; next try in ${fmtDuration(r.retryAfterMs)}`);
    if (r.kind === "error") throw new Error(`Iris HTTP ${r.status} ${r.detail}`);
    if (r.kind === "pending") return waiting(key, `iris ${name}: waiting for Circle's attestation (${r.status})`);
    const hook = decodeBatchHook(hexToBytes(r.message).subarray(376));
    if (hook.denomination !== d || hook.epochId !== id || (b.root && hook.root !== BigInt(b.root))) {
      throw new Error("Circle's message does not carry this batch");
    }
    Object.assign(b, { message: r.message, attestation: r.attestation });
    save();
    log(`iris ${name}: attested`);
  }

  // 4. Relay.
  const wei = await l1.getBalance({ address: l1Account.address });
  if (wei === 0n) return waiting(key, `relay ${name}: needs ${L1} ETH at ${l1Account.address}`);
  const gas = await gasWait();
  if (gas) return waiting(key, `relay ${name}: ${gas}`);
  const hash = await l1w.writeContract({
    address: portal, abi: PORTAL_ABI, functionName: "relay", args: [b.message as Hex, b.attestation as Hex],
  });
  Object.assign(b, { relayTx: hash, relaySubmittedAt: Date.now() });
  save();
  log(`relay ${name}: ${L1} tx ${short(hash)} sent`);
  const receipt = await l1.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(() => undefined);
  if (!receipt) return waiting(key, `relay ${name}: waiting for ${L1} tx ${short(hash)}`);
  if (receipt.status !== "success") {
    delete b.relayTx;
    delete b.relaySubmittedAt;
    save();
    throw new Error(`relay tx ${hash} reverted`);
  }
  relayed(b, receipt.logs, hash);
}

function relayed(b: Batch, logs: Parameters<typeof readRelay>[0], tx: string) {
  const r = readRelay(logs);
  if (!r) throw new Error(`relay ${tx}: no BatchReceived / MessageSent in the receipt`);
  if (b.root && BigInt(r.root) !== BigInt(b.root)) throw new Error("the portal decoded another root");
  Object.assign(b, { l1ToL2Hash: r.l1ToL2Hash, l1ToL2Index: r.l1ToL2Index.toString(), relayedByUs: true });
  delete b.relaySubmittedAt;
  advanced(b);
  log(`relay ${batchName(b)}: done (${short(tx)}); L1→L2 leaf ${b.l1ToL2Index}`);
}

/** The portal's BatchForwarded event for a batch, searched from the newest block back to the deploy block. */
async function findForwarded(d: bigint, id: bigint) {
  const latest = await l1.getBlockNumber();
  const floor = await portalBlock(latest);
  for (let to = latest; to >= floor; to -= LOG_CHUNK) {
    const from = to - LOG_CHUNK + 1n > floor ? to - LOG_CHUNK + 1n : floor;
    const logs = await l1.getLogs({ address: portal, event: BATCH_FORWARDED, args: { denomination: d, epochId: id }, fromBlock: from, toBlock: to });
    const l = logs[0];
    if (l) {
      const tx = await l1.getTransaction({ hash: l.transactionHash }).catch(() => undefined);
      return { messageKey: l.args.messageKey!, messageIndex: l.args.messageIndex!, tx: l.transactionHash, from: tx?.from.toLowerCase() };
    }
  }
  return undefined;
}

async function portalBlock(latest: bigint): Promise<bigint> {
  if (state.portalBlock) return BigInt(state.portalBlock);
  let block = latest > 200_000n ? latest - 200_000n : 0n;
  if (dep.l1.deployTx) {
    const r = await l1.getTransactionReceipt({ hash: dep.l1.deployTx as Hex }).catch(() => undefined);
    if (r) block = r.blockNumber;
  }
  state.portalBlock = block.toString();
  save();
  return block;
}

// ---------------- Aztec ----------------
type Aztec = Awaited<ReturnType<typeof connectAztec>>;

/**
 * ADR 0018 refill loop: logs the account's Fee Juice and, below `fees.operatorFeeJuice.low`, how
 * much to bridge to it. Bridging is an L1 transaction the owner sends; the finisher never does.
 */
async function reportFeeJuice(a: Aztec) {
  const balance = await a.feeJuice().catch(() => undefined);
  if (balance === undefined) return log("Fee Juice: balance unreadable");
  const whole = (b: bigint) => (Number(b / 10n ** 15n) / 1_000).toLocaleString("en-US");
  const policy = dep.fees?.operatorFeeJuice;
  const refill = policy ? refillAmount(balance, policy) : 0n;
  log(`Fee Juice: ${whole(balance)}${refill > 0n ? ` · LOW: bridge ${whole(refill)} to ${a.account.address}` : ""}`);
}
let feeJuiceCheckedAt: number | undefined;
/** The refill loop itself: in "feeJuice" mode, every FINISHER_FEE_JUICE_CHECK minutes (starts the wallet if needed). */
async function feeJuiceLeg() {
  if (FEES.operator !== "feeJuice" || !feeJuiceCheckDue(feeJuiceCheckedAt, Date.now(), FEE_JUICE_EVERY_MS)) return;
  const a = await aztec();
  feeJuiceCheckedAt = Date.now();
  await reportFeeJuice(a);
}
let az: Promise<Aztec> | undefined;
const pxeContracts = new Set<string>();
/** The Aztec wallet starts only when a batch is ready to register (it proves locally). */
function aztec(): Promise<Aztec> {
  if (!az) {
    log(`starting the Aztec wallet (real proofs; fees paid by ${FEES.operator === "feeJuice" ? "its own Fee Juice" : "the SponsoredFPC"})`);
    const p = connectAztec(AZTEC_NODE, PXE_DIR, aztecKeys(), FEES.operator).then(async (a) => {
      log(`Aztec account ${a.account.address} (no deployment needed)`);
      if (a.feeMode === "feeJuice") {
        feeJuiceCheckedAt = Date.now();
        await reportFeeJuice(a);
      }
      return a;
    });
    p.catch(() => {
      az = undefined;
    });
    az = p;
  }
  return az;
}

async function aztecLeg() {
  for (const b of Object.values(state.batches)) {
    if (stopping) return;
    if (stageOf(b) !== "register") continue;
    await step(b, "register_batch", () => registerOne(b));
    if (b.registered) {
      if (isExpress(b.epochId)) advanceExpressDone(state, b.denomination);
      else advanceDone(state, b.denomination);
      save();
      log(`${batchName(b)} carried across · so far: ${summaryLine(summarize(state))}`);
    }
  }
}

async function registerOne(b: Batch) {
  const name = batchName(b);
  const key = batchKey(b.denomination, b.epochId);
  const claimAddr = dep.aztec.claims?.[b.denomination];
  if (!claimAddr) return waiting(key, `register_batch ${name}: no Aztec claim contract for this size in the deployment`);

  // 1. This finisher's register_batch, if sent: its receipt.
  if (b.registerTx) {
    const receipt = await aztecNode.getTxReceipt(TxHash.fromString(b.registerTx));
    if (receipt.isMined() && receipt.hasExecutionSucceeded()) {
      Object.assign(b, { registered: true, registeredByUs: true });
      advanced(b);
      log(`register_batch ${name}: in Aztec block ${receipt.blockNumber}`);
      return;
    }
    if (receipt.isPending()) return waiting(key, `register_batch ${name}: waiting for Aztec tx ${short(b.registerTx)}`);
    log(`register_batch ${name}: Aztec tx ${short(b.registerTx)} ${receipt.isDropped() ? "dropped" : "reverted"}; checking again`);
    delete b.registerTx;
    delete b.registerSubmittedAt;
    save();
  }

  // 2. The L1->L2 message must be in an Aztec block before it can be consumed.
  if (!(await isL1ToL2MessageReady(aztecNode, Fr.fromString(b.l1ToL2Hash!)))) {
    return waiting(key, `register_batch ${name}: waiting for Aztec to include the L1→L2 message`);
  }

  // 3. Registered already (another finisher, or a lost record)?
  const a = await aztec();
  if (!pxeContracts.has(claimAddr)) {
    await a.register(claimAddr, EclypsClaimContract.artifact);
    pxeContracts.add(claimAddr);
  }
  const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(claimAddr), a.wallet);
  const root = new Fr(BigInt(b.root!));
  const { result: known } = await claim.methods.is_registered(root).simulate({ from: a.account.address });
  if (known) {
    b.registered = true;
    advanced(b);
    log(`register_batch ${name}: already registered on Aztec`);
    return;
  }

  // 4. Register: prove locally, send, and look for the receipt on the next passes.
  const { txHash } = await claim.methods
    .register_batch(root, BigInt(b.epochId), b.leafCount!, new Fr(BigInt(b.l1ToL2Index!)))
    .send({ from: a.account.address, fee: a.fee, wait: NO_WAIT });
  Object.assign(b, { registerTx: txHash.toString(), registerSubmittedAt: Date.now() });
  advanced(b);
  log(`register_batch ${name}: Aztec tx ${short(txHash.toString())} sent`);
}

// ---------------- loop ----------------
const legs: Record<string, { failures?: number; retryAt?: number; lastError?: string }> = {};
async function leg(name: string, fn: () => Promise<void>) {
  const r = (legs[name] ??= {});
  if (stopping || !isDue(r, Date.now())) return;
  try {
    await fn();
    if (r.failures) log(`${name}: back`);
    recordSuccess(r);
  } catch (e) {
    const wait = recordFailure(r, Date.now(), oneLine(e), LEG_RETRY_MAX_MS);
    log(`${name}: ${oneLine(e)}; retry in ${fmtDuration(wait)}`);
    debug(e);
  }
}

// ---------------- exits (ADR 0009) ----------------
const exitsOn = dep.features?.exit === true;
state.exits ??= {};
state.exitsDoneBelow ??= {};
const exitState = state as FinisherState & ExitState;
let gatewayDenominations: bigint[] | undefined;
const exitCtx: ExitContext = {
  log,
  waiting,
  debug,
  stopping: () => stopping,
  state: exitState,
  save,
  get denominations() {
    return gatewayDenominations ?? dep.denominations.map(BigInt);
  },
  claims: dep.aztec.claims ?? {},
  portal,
  node: aztecNode,
  aztec: async () => {
    const a = await aztec();
    return { wallet: a.wallet, from: a.account.address, fee: a.fee, register: (addr, artifact) => a.register(addr, artifact) };
  },
  waitForClose: false,
  // ADR 0017 item 1: closes land at least two Aztec slots before the Aztec epoch ends.
  aztecClock: () => readAztecClock(aztecNode, l1),
  gasWait,
  l1,
  l1w,
  sol,
  payer: me,
  usdcMint,
  lookupTable: dep.solana.exitLookupTable ? address(dep.solana.exitLookupTable) : undefined,
  async attest(b) {
    if (!b.l1Tx) {
      b.l1Tx = await findExitBatchTx(l1, portal, BigInt(b.denomination), BigInt(b.exitEpochId), await portalBlock(await l1.getBlockNumber()));
      if (!b.l1Tx) throw new Error("the portal exited this epoch but its ExitBatchSent event was not found");
      save();
    }
    const now = Date.now();
    if (irisGate.blocked(now)) return { pending: `rate limited; next try in ${fmtDuration(irisGate.waitMs(now))}` };
    const wait = irisGate.waitMs(now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    irisGate.hit(Date.now());
    const r = await irisLookup(IRIS, b.l1Tx, CFG.domains.ethereum);
    if (r.kind === "rate-limited") {
      irisGate.block(Date.now(), r.retryAfterMs);
      return { pending: "rate limited" };
    }
    if (r.kind === "error") throw new Error(`Iris HTTP ${r.status} ${r.detail}`);
    if (r.kind === "pending") return { pending: `waiting for Circle's attestation (${r.status})` };
    return { message: r.message, attestation: r.attestation };
  },
};
async function exitsLeg() {
  if (!gatewayDenominations) {
    const raw = await sol.accountData(configAddr);
    if (!raw) throw new Error("gateway config not found");
    gatewayDenominations = decodeConfig(raw).denominations;
  }
  await aztecExitLeg(exitCtx);
  await ethereumExitLeg(exitCtx);
  await solanaExitLeg(exitCtx);
}
const exitsLine = () => {
  const x = exitSummary(state);
  return x.carried + x.inFlight > 0 ? ` · exits: ${x.carried} received on Solana, ${x.inFlight} on the way` : "";
};

try {
  await startup();
  if (exitsOn) log(`exits on: close_exit_epoch, exitBatch and receive_exit${dep.solana.exitLookupTable ? "" : " (creates the receive_exit lookup table at the first exit)"}`);
} catch (e) {
  fail(e);
}
while (!stopping) {
  await leg("fee juice", feeJuiceLeg);
  await leg("solana", solanaLeg);
  await leg("ethereum", ethereumLeg);
  await leg("aztec", aztecLeg);
  if (exitsOn) await leg("exits", exitsLeg);
  if (ONCE) break;
  await pause(exitsOn && exitsBusy(state) ? Math.min(INTERVAL_MS, 15_000) : nextDelayMs(state, INTERVAL_MS));
}
log(`stopped · ${summaryLine(summarize(state))}${exitsLine()} (resumes from ${STATE})`);
process.exit(0);
