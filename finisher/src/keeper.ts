/**
 * Eclyps reference keeper (ADR 0017, amended): fronts exits to Solana from the liquidity pool, on
 * testnet. Run by the pool's keeper key (`lanes.params.keeper`).
 *
 *   pnpm --filter @eclyps/finisher keeper
 *
 * It listens on 127.0.0.1:8787 (KEEPER_PORT, KEEPER_HOST) for the app:
 *   GET  /quote   the pool's capacity and, per note size, the fee and whether Fast fits now
 *   POST /front   { denomination, exitEpochId, leafIndex, destination, secret, aztecTx }
 *                 -> { status: "fronted", sig, advanced } | { status: "wait" | "refused", reason }
 * Before paying, it checks on Aztec that the exit transaction succeeded in a block checkpointed on
 * L1 and that the claim contract's exit leaf at (exitEpochId, leafIndex) is exactly
 * exitCommitment(destination, secret); on Solana, that the exit batch has not arrived, the leaf is
 * not fronted, and the pool can cover it. Then `front_exit_from_pool`.
 *
 * Every pass (KEEPER_INTERVAL seconds, default 60) it claims the exits it fronted whose batch has
 * arrived on Solana (`claim_exit` repays the pool the whole note). Anyone may send those claims;
 * the keeper sends them so the pool is never left waiting.
 *
 * It keeps no request logs; its record (KEEPER_STATE, default
 * ~/.config/eclyps/testnet/keeper-state.json, private) holds what it needs to claim. Serve it
 * behind a proxy you trust, or over a private channel: it learns destinations before they are
 * public (ADR 0017, "Who runs solvers").
 *
 * Env: DEPLOYMENT (deployments/testnet.json), KEEPER_SOLANA_KEYPAIR (~/.config/eclyps/keeper.json),
 * KEEPER_STATE, KEEPER_PORT, KEEPER_HOST, KEEPER_ALLOW_ORIGIN (CORS, default *), SOLANA_RPC_URL,
 * AZTEC_NODE_URL, DEBUG=1.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { address, type Address } from "@solana/kit";
import {
  bpsOf,
  CLAIM_EXIT_COMPUTE_UNITS,
  claimExitIx,
  computeUnitLimitIx,
  createAssociatedTokenIdempotentIx,
  decodeConfig,
  decodeExitBatch,
  decodeLanes,
  decodeLiquidity,
  exitBatchPda,
  exitClaimInputs,
  exitCommitment,
  frontExitFromPoolIx,
  frontPda,
  lanesPda,
  liquidityPda,
  liquidityVaultPda,
  poolCapacity,
  toHex,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { type AztecKeys, connectAztec, loadSolanaKeypair, newAztecKeys, solanaClient } from "./chains.js";
import {
  decideFront,
  emptyKeeperState,
  type FrontRecord,
  frontsToRepay,
  type KeeperState,
  keeperStateMatches,
  keeperSummary,
  parseFrontRequest,
  quoteLines,
} from "./keeper-plan.js";
import { fmtDuration, isDue, oneLine, recordFailure, recordSuccess, usd } from "./plan.js";

const expand = (p: string) => resolve(p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p);
const repo = new URL("../../", import.meta.url);
const DEPLOYMENT = process.env.DEPLOYMENT ? resolve(process.env.DEPLOYMENT) : fileURLToPath(new URL("deployments/testnet.json", repo));
const KEY = expand(process.env.KEEPER_SOLANA_KEYPAIR ?? "~/.config/eclyps/keeper.json");
const STATE = expand(process.env.KEEPER_STATE ?? "~/.config/eclyps/testnet/keeper-state.json");
const STATE_DIR = dirname(STATE);
const PORT = Number(process.env.KEEPER_PORT ?? 8787);
const HOST = process.env.KEEPER_HOST ?? "127.0.0.1";
const ORIGIN = process.env.KEEPER_ALLOW_ORIGIN ?? "*";
const INTERVAL_MS = Math.max(10, Number(process.env.KEEPER_INTERVAL ?? 60)) * 1000;
const DEBUG = Boolean(process.env.DEBUG);

const log = (s: string) => console.log(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] ${s}`);
const debug = (e: unknown) => {
  if (DEBUG) console.error(e);
};
function fail(e: unknown): never {
  console.error(`error: ${oneLine(e, 400)}`);
  debug(e);
  process.exit(1);
}

interface Deployment {
  network: string;
  solana: { rpc: string; config: string; usdcMint: string };
  aztec: { node: string; claims: Record<string, string> };
  denominations: string[];
}
if (!existsSync(DEPLOYMENT)) fail(`no deployment at ${DEPLOYMENT}`);
const dep: Deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8"));
// Testnet mode only: the local network builds Aztec blocks on demand, so "checkpointed" means little.
if (dep.network !== "testnet") fail(`${DEPLOYMENT} is a "${dep.network}" deployment; the reference keeper runs on testnet only`);
if (!existsSync(KEY)) fail(`no keeper key at ${KEY} (set KEEPER_SOLANA_KEYPAIR)`);

const sol = solanaClient(process.env.SOLANA_RPC_URL ?? dep.solana.rpc, log);
const node = createAztecNodeClient(process.env.AZTEC_NODE_URL ?? dep.aztec.node, { maxBatchSize: 3 });
const me = await loadSolanaKeypair(KEY).catch(fail);
const usdcMint = address(dep.solana.usdcMint);
const configAddr = address(dep.solana.config);

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
function loadState(): KeeperState {
  if (!existsSync(STATE)) return emptyKeeperState(dep.solana.config);
  const saved = JSON.parse(readFileSync(STATE, "utf8")) as Partial<KeeperState>;
  if (keeperStateMatches(saved, dep.solana.config)) return saved as KeeperState;
  const aside = `${STATE}.${Date.now()}.old`;
  renameSync(STATE, aside);
  log(`the saved state belongs to another deployment; moved it to ${aside}`);
  return emptyKeeperState(dep.solana.config);
}
const state = loadState();
function save() {
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STATE);
}

// ---------------- Aztec ----------------
const AZTEC_KEYS = `${STATE_DIR}/keeper-aztec.json`;
const PXE_DIR = `${STATE_DIR}/keeper-pxe`;
function aztecKeys(): AztecKeys {
  if (existsSync(AZTEC_KEYS)) return JSON.parse(readFileSync(AZTEC_KEYS, "utf8"));
  const keys = newAztecKeys();
  writeFileSync(AZTEC_KEYS, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
let az: ReturnType<typeof connectAztec> | undefined;
const registered = new Set<string>();
/** The claim contract of a denomination, through this keeper's wallet (simulations only: no fees). */
async function claimOf(denomination: string) {
  const addr = dep.aztec.claims[denomination];
  if (!addr) throw new Error(`no claim contract for ${denomination}`);
  if (!az) {
    az = connectAztec(process.env.AZTEC_NODE_URL ?? dep.aztec.node, PXE_DIR, aztecKeys());
    az.catch(() => (az = undefined));
  }
  const a = await az;
  if (!registered.has(addr)) {
    await a.register(addr, EclypsClaimContract.artifact);
    registered.add(addr);
  }
  return { claim: EclypsClaimContract.at(AztecAddress.fromStringUnsafe(addr), a.wallet), from: a.account.address };
}

/** The public exit leaves of an exit epoch (`get_exit_leaves`, as the app reads them). */
async function exitLeaves(denomination: string, id: bigint): Promise<bigint[]> {
  const { claim, from } = await claimOf(denomination);
  const { result } = await claim.methods.get_exit_leaves(id).simulate({ from });
  const v = result as { storage: unknown[]; len: bigint | number };
  return v.storage.slice(0, Number(v.len)).map((x) => BigInt(String(x)));
}

// ---------------- Solana reads ----------------
async function pool() {
  const [lanesRaw, liqRaw] = await Promise.all([sol.accountData(await lanesPda()), sol.accountData(await liquidityPda())]);
  if (!lanesRaw || !liqRaw) throw new Error("the gateway has no V2 lanes (init_lanes) yet");
  const lanes = decodeLanes(lanesRaw);
  const liquidity = decodeLiquidity(liqRaw);
  return { lanes, liquidity, capacity: poolCapacity(liquidity, lanes.params) };
}

// ---------------- POST /front ----------------
let busy = Promise.resolve();
/** One front at a time, so capacity and the record never race. */
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = busy.then(fn, fn);
  busy = run.then(() => undefined, () => undefined);
  return run;
};

async function front(body: unknown): Promise<{ code: number; json: unknown }> {
  const parsed = parseFrontRequest(body, dep.denominations);
  if ("error" in parsed) return { code: 400, json: { status: "refused", reason: parsed.error } };
  const r = parsed.ok;
  const leaf = exitCommitment(address(r.destination), r.secret);
  const key = toHex(leaf);
  const p = await pool();
  if (p.lanes.params.keeper !== me.address) return { code: 503, json: { status: "refused", reason: "this keeper is not the pool's keeper" } };
  const fee = bpsOf(BigInt(r.denomination), p.lanes.params.poolFeeBps);
  const advanced = BigInt(r.denomination) - fee;
  const receipt = await node.getTxReceipt(TxHash.fromString(r.aztecTx)).catch(() => undefined);
  const txOk = !!receipt && receipt.isMined() && receipt.hasExecutionSucceeded();
  const leaves = txOk ? await exitLeaves(r.denomination, r.exitEpochId).catch(() => [] as bigint[]) : [];
  const decision = decideFront({
    txOk,
    txBlock: txOk ? Number(receipt!.blockNumber) : undefined,
    checkpointed: Number(await node.getBlockNumber("checkpointed")),
    leafOnAztec: leaves[r.leafIndex],
    leaf,
    arrived: !!(await sol.accountData(await exitBatchPda(r.denominationIndex, r.exitEpochId))),
    fronted: !!(await sol.accountData(await frontPda(leaf))),
    capacity: p.capacity,
    advanced,
  });
  if (decision.action === "wait") return { code: 202, json: { status: "wait", reason: decision.reason } };
  if (decision.action === "refuse") return { code: 409, json: { status: "refused", reason: decision.reason } };

  const sig = await sol.send(
    [
      computeUnitLimitIx(200_000),
      await createAssociatedTokenIdempotentIx(me.address, address(r.destination), usdcMint),
      await frontExitFromPoolIx({ keeper: me.address, usdcMint, denominationIndex: r.denominationIndex, exitEpochId: r.exitEpochId, destination: address(r.destination), secret: r.secret }),
    ],
    [me.keyPair],
    me.address,
  );
  state.fronts[key] = {
    denomination: r.denomination, index: r.denominationIndex, exitEpochId: r.exitEpochId.toString(), leafIndex: r.leafIndex,
    destination: r.destination, secret: toHex(r.secret), leaf: key, aztecTx: r.aztecTx, frontSig: sig, frontedAt: Date.now(), advanced: advanced.toString(),
  };
  save();
  log(`fronted ${usd(advanced)} of a ${usd(BigInt(r.denomination))} exit (fee ${usd(fee)}) · ${sig.slice(0, 10)}…`);
  return { code: 200, json: { status: "fronted", sig, advanced: advanced.toString(), fee: fee.toString() } };
}

async function quote(): Promise<unknown> {
  const p = await pool();
  return {
    keeper: me.address,
    on: p.lanes.params.keeper === me.address,
    capacity: p.capacity.toString(),
    poolFeeBps: p.lanes.params.poolFeeBps,
    notes: quoteLines(dep.denominations, (d) => bpsOf(d, p.lanes.params.poolFeeBps), p.capacity),
  };
}

// ---------------- repayments ----------------
async function repayOne(f: FrontRecord) {
  const frontAddr = await frontPda(BigInt(f.leaf));
  if (!(await sol.accountData(frontAddr))) {
    // The record closed: someone claimed it (it can only pay the pool's vault).
    f.repaid = true;
    recordSuccess(f);
    save();
    log(`repaid: ${usd(BigInt(f.denomination))} exit (claimed by someone)`);
    return;
  }
  const batch = await sol.accountData(await exitBatchPda(f.index, BigInt(f.exitEpochId)));
  if (!batch) return; // the slow path has not landed yet
  const count = decodeExitBatch(batch).count;
  const leaves = (await exitLeaves(f.denomination, BigInt(f.exitEpochId))).slice(0, count);
  const destination = address(f.destination);
  const inputs = exitClaimInputs(leaves, destination, BigInt(f.secret));
  const vault = await liquidityVaultPda();
  const ix = await claimExitIx({
    payer: me.address, usdcMint, denominationIndex: f.index, exitEpochId: BigInt(f.exitEpochId), leafIndex: inputs.leafIndex,
    path: inputs.path, destination, secret: BigInt(f.secret), front: { payee: vault, rentPayer: me.address },
  });
  const sig = await sol.send([computeUnitLimitIx(CLAIM_EXIT_COMPUTE_UNITS), ix], [me.keyPair], me.address);
  Object.assign(f, { repaid: true, claimSig: sig });
  recordSuccess(f);
  save();
  log(`repaid: ${usd(BigInt(f.denomination))} back to the pool · ${sig.slice(0, 10)}…`);
}

async function repayPass() {
  for (const f of frontsToRepay(state)) {
    if (!isDue(f, Date.now())) continue;
    try {
      await repayOne(f);
    } catch (e) {
      const wait = recordFailure(f, Date.now(), oneLine(e));
      save();
      log(`claim of a fronted exit failed: ${oneLine(e)}; retry in ${fmtDuration(wait)}`);
      debug(e);
    }
  }
}

// ---------------- server ----------------
function reply(res: ServerResponse, code: number, json: unknown) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": ORIGIN,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(json));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === "OPTIONS") return reply(res, 204, {});
      if (req.method === "GET" && req.url === "/quote") return reply(res, 200, await quote());
      if (req.method === "POST" && req.url === "/front") {
        const body = await readBody(req).catch(() => undefined);
        const r = await serial(() => front(body));
        return reply(res, r.code, r.json);
      }
      reply(res, 404, { status: "refused", reason: "not found" });
    } catch (e) {
      debug(e);
      reply(res, 500, { status: "wait", reason: oneLine(e) });
    }
  })();
});

// ---------------- start ----------------
try {
  const raw = await sol.accountData(configAddr);
  if (!raw) throw new Error(`the gateway config ${configAddr} does not exist`);
  decodeConfig(raw);
  const p = await pool();
  log(`keeper ${me.address} · pool capacity ${usd(p.capacity)} · fee ${p.lanes.params.poolFeeBps / 100}%`);
  if (p.lanes.params.keeper !== me.address) log(`warning: the pool's keeper is ${p.lanes.params.keeper}, not this key: fronts are refused`);
  const s = keeperSummary(state);
  log(`so far: ${s.fronted} fronted, ${s.repaid} repaid, ${usd(s.outstanding)} outstanding · state ${STATE}`);
} catch (e) {
  fail(e);
}
server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (GET /quote, POST /front)`));
let stopping = false;
const stop = () => {
  if (stopping) process.exit(130);
  stopping = true;
  log("stopping");
  server.close();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
while (!stopping) {
  await repayPass();
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
export type { Address };
