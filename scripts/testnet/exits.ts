/**
 * The first exits on public testnets (ADR 0009, ADR 0014 §4): Aztec testnet -> Sepolia -> Solana
 * devnet, and Aztec testnet -> Sepolia. The testnet counterpart of e2e/local-roundtrip.ts.
 *
 * Resumable like run.ts: each phase records what it did and is skipped once done.
 *   private (exit seed, PXE db): ~/.config/eclyps/testnet/   never in the repo
 *   public (tx hashes, measures): deployments/testnet.json, `runs` entry with kind "exit"
 *
 * Run from scripts/ with Node >= 24.12 (behind a proxy: NODE_USE_ENV_PROXY=1), after run.ts has
 * carried the batches whose notes leave (two full $1 batches give enough notes):
 *   pnpm exec tsx testnet/exits.ts <phase>
 *     table     create the receive_exit address lookup table once; record solana.exitLookupTable
 *     claim     claim the run's unclaimed notes privately to a fresh seed-derived Aztec account
 *     exit      4 × exit($1), each to a fresh Solana address, and 1 × exit_to_ethereum($1) to a
 *               fresh Ethereum address (Aztec epochs need min_exit_batch = 4 exits)
 *     carry     with the testnet finisher running (features.exit on): follow close_exit_epoch,
 *               the Aztec epoch proof, exitBatch, Iris and receive_exit, and record them
 *     solana    claim_exit to each fresh Solana address (paid by the devnet key); a replay is refused
 *     ethereum  claimToEthereum to the fresh Ethereum address (sent by the Sepolia key); a replay is refused
 *
 *   Re-runnable, for filling an exit epoch next to other exits (the app's Move out, for example):
 *     fill [n]     claim n (default 3) unclaimed $1 notes of the runs to a fresh Aztec account and
 *                  exit each to a fresh Solana address, into the open exit epoch. A new `runs` entry
 *                  (kind "exit", purpose "fill") each time; an unfinished one is resumed first
 *     fill-carry   carry, for the latest fill
 *     fill-solana  claim_exit to the latest fill's addresses (paid by the devnet key); a replay is refused
 *
 * Nothing here prints a key or the exit secrets; the Aztec account that exits is not recorded.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AztecAddress, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { Fr, GrumpkinScalar } from "@aztec-labs/aztec.js/fields";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash";
import { type Address, address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { createPublicClient, createWalletClient, type Hex, hexToBytes, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  associatedTokenAddress,
  CCTP_MESSAGE,
  CLAIM_EXIT_COMPUTE_UNITS,
  claimExitIx,
  computeUnitLimitIx,
  createLookupTableIx,
  decodeConfig,
  decodeEpoch,
  decodeExitBatch,
  decodeExitMessage,
  decodeLookupTable,
  decodeTokenMessengerFeeRecipient,
  cctpReceiveAccounts,
  deriveEthereumExit,
  deriveExit,
  deriveNote,
  DEVNET,
  epochPda,
  ethereumExitContent,
  evmAddressToBytes32,
  exitBatchPda,
  exitClaimed,
  exitClaimInputs,
  exitCustodyPda,
  extendLookupTableIx,
  path as merklePath,
  randomSeed,
  receiveExitLookupTableAddresses,
  seedFromHex,
  seedToHex,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import { TokenContract } from "../../aztec/artifacts/Token.js";
import { connectAztec, loadSolanaKeypair, sleep, solanaClient } from "../../finisher/src/chains.js";
import { l2ToL1Proof, PORTAL_EXIT_ABI } from "../../finisher/src/exits.js";
import { exitKey } from "../../finisher/src/plan.js";

// ---------------- configuration ----------------
const KEYS = process.env.ECLYPS_KEYS ?? `${homedir()}/.config/eclyps`;
const PRIVATE_DIR = `${KEYS}/testnet`;
const PRIVATE_FILE = `${PRIVATE_DIR}/state.json`;
const FINISHER_STATE = process.env.FINISHER_STATE ?? `${PRIVATE_DIR}/finisher-state.json`;
const repo = new URL("../../", import.meta.url);
const PUBLIC_FILE = new URL("deployments/testnet.json", repo);
const AZTEC_WAIT = { timeout: 1_800, interval: 5 };
const D = 1_000_000n; // $1 notes leave
const SOLANA_EXITS = 4; // min_exit_batch
const NOTES_NEEDED = SOLANA_EXITS + 1;

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${s}`);
const hex32 = (x: bigint) => `0x${x.toString(16).padStart(64, "0")}` as Hex;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString(16) : v)).toLowerCase();

interface ExitRun {
  kind: "exit";
  /** "fill": exits that fill an epoch shared with other exits (`fill`); its own account and seed. */
  purpose?: "fill";
  /** fill: how many exits it adds. */
  fill?: number;
  denomination: string;
  /** Notes claimed to the account that exits: forward run index, note index, Aztec tx. */
  claims: { run: number; note: number; tx: string }[];
  destinations?: string[];
  exitTxs?: string[];
  exitFees?: string[];
  exitEpochId?: string;
  /** fill: the exits' leaf indexes in their exit epoch, and how many exits that epoch held. */
  leafIndexes?: number[];
  epochCount?: number;
  closeTx?: string;
  closeBlock?: number;
  closeFee?: string;
  exitBatchTx?: string;
  exitBatchGas?: string;
  outboxEpoch?: string;
  iris?: { nonce: string; finalityThresholdExecuted: number; feeExecuted: string; expirationBlock: string; minFinalityThreshold: number };
  receiveExitSig?: string;
  receiveExitFee?: string;
  claimExitSigs?: string[];
  ethereum?: { recipient: string; exitTx?: string; exitFee?: string; exitBlock?: number; claimTx?: string; claimGas?: string; outboxEpoch?: string };
  checks?: Record<string, boolean>;
  timings: Record<string, number>;
}
interface PrivateState {
  aztecAdmin?: unknown;
  seeds: Record<string, string>;
  /** Seed of the account that exits and of the exit secrets (ADR 0009: domains 3 and 4). */
  exitSeed?: string;
  /** fill: seed of each fill's account and exit secrets, by its index in the public `runs`. */
  fillSeeds?: Record<string, string>;
}

const which = process.argv[2] ?? "";
const fillMode = which.startsWith("fill");
const pub = JSON.parse(readFileSync(PUBLIC_FILE, "utf8"));
const priv: PrivateState = JSON.parse(readFileSync(PRIVATE_FILE, "utf8"));
type AnyRun = { kind?: string; purpose?: string; fill?: number; exitTxs?: string[] };
/** The exit entry this run works on: the first exit run, or (fill phases) the latest fill. */
let exitIndex = fillMode
  ? (pub.runs as AnyRun[]).map((r, i) => (r.kind === "exit" && r.purpose === "fill" ? i : -1)).reduce((x, y) => Math.max(x, y), -1)
  : (pub.runs as AnyRun[]).findIndex((r) => r.kind === "exit" && r.purpose !== "fill");
/**
 * Writes this script's part (the exit entry, the lookup table) into the record as it is on disk
 * now, so phases running side by side (carry next to ethereum) never overwrite each other.
 */
const savePublic = () => {
  const fresh = JSON.parse(readFileSync(PUBLIC_FILE, "utf8"));
  const i = exitIndex;
  if (i >= 0 && fresh.runs[i]?.kind === "exit") {
    const onDisk = fresh.runs[i];
    exitRun.timings = { ...onDisk.timings, ...exitRun.timings };
    exitRun.checks = { ...onDisk.checks, ...exitRun.checks };
    if (onDisk.ethereum || exitRun.ethereum) exitRun.ethereum = { ...onDisk.ethereum, ...exitRun.ethereum } as ExitRun["ethereum"];
    fresh.runs[i] = { ...onDisk, ...exitRun };
  } else exitIndex = fresh.runs.push(exitRun) - 1;
  for (const k of ["exitLookupTable", "exitLookupTableSig", "exitLookupTableCost"]) if (pub.solana[k]) fresh.solana[k] = pub.solana[k];
  writeFileSync(PUBLIC_FILE, `${JSON.stringify(fresh, null, 2)}\n`);
};
const savePrivate = () => writeFileSync(PRIVATE_FILE, JSON.stringify(priv, null, 2), { mode: 0o600 });
if (pub.network !== "testnet" || !pub.l1.portal || !pub.aztec.claims?.[D.toString()]) throw new Error("deploy the testnet first (run.ts)");
if (pub.l1.chainId !== 11155111 || !String(pub.solana.rpc).includes("devnet")) throw new Error("not a testnet deployment");

let exitRun: ExitRun = pub.runs[exitIndex];
// `fill` starts a new entry unless the latest one is unfinished.
const fillCount = Number(process.argv[3] ?? "3");
if (which === "fill" && exitRun && (exitRun.exitTxs?.length ?? 0) >= exitRun.fill!) exitIndex = -1;
if (which === "fill" && !(fillCount >= 1 && fillCount <= 16)) throw new Error("fill <n>: 1 to 16 exits");
if (exitIndex < 0) {
  if (fillMode && which !== "fill") throw new Error("no fill yet (fill <n>)");
  exitRun = { kind: "exit", ...(fillMode ? { purpose: "fill" as const, fill: fillCount } : {}), denomination: D.toString(), claims: [], timings: { start: Date.now() } };
  savePublic();
}
let exitSeed: Uint8Array;
if (fillMode) {
  priv.fillSeeds ??= {};
  if (!priv.fillSeeds[exitIndex]) {
    priv.fillSeeds[exitIndex] = seedToHex(randomSeed());
    savePrivate();
  }
  exitSeed = seedFromHex(priv.fillSeeds[exitIndex]!);
} else {
  if (!priv.exitSeed) {
    priv.exitSeed = seedToHex(randomSeed());
    savePrivate();
  }
  exitSeed = seedFromHex(priv.exitSeed);
}

// ---------------- chains ----------------
const sol = solanaClient(pub.solana.rpc, log);
const usdcMint = address(pub.solana.usdcMint);
const payer = () => loadSolanaKeypair(process.env.SOLANA_KEYPAIR ?? `${KEYS}/devnet.json`);
const l1 = createPublicClient({ chain: sepolia, transport: http(pub.l1.rpc, { retryCount: 3 }) });
const l1Wallet = () =>
  createWalletClient({
    account: privateKeyToAccount((process.env.SEPOLIA_PRIVATE_KEY ?? readFileSync(`${KEYS}/sepolia.key`, "utf8").trim()) as Hex),
    chain: sepolia,
    transport: http(pub.l1.rpc, { retryCount: 3 }),
  });
const usdcOf = async (a: Address) =>
  BigInt((await sol.rpc.getTokenAccountBalance(a, { commitment: "confirmed" }).send().catch(() => ({ value: { amount: "0" } }))).value.amount);
/** Devnet's public RPC answers 429 under load: retry reads. */
async function retry<T>(f: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(2_000 * (i + 1));
    }
  }
}

const seedScalar = (label: string) => createHash("sha256").update(exitSeed).update(`eclyps/aztec/exit/${label}`).digest();
async function aztec() {
  const keys = {
    secret: Fr.fromBufferReduce(seedScalar("secret")).toString(),
    salt: Fr.fromBufferReduce(seedScalar("salt")).toString(),
    signingKey: GrumpkinScalar.fromBufferReduce(seedScalar("signing")).toString(),
  };
  // Its own wallet database, so it can run next to run.ts and the finisher.
  const a = await connectAztec(pub.aztec.node, `${PRIVATE_DIR}/exit-pxe`, keys);
  await a.register(pub.aztec.token, TokenContract.artifact);
  await a.register(pub.aztec.claims[D.toString()], EclypsClaimContract.artifact);
  const token = TokenContract.at(AztecAddress.fromStringUnsafe(pub.aztec.token), a.wallet);
  const claim = EclypsClaimContract.at(AztecAddress.fromStringUnsafe(pub.aztec.claims[D.toString()]), a.wallet);
  const holder = a.account.address;
  const balance = async () => BigInt((await token.methods.balance_of_private(holder).simulate({ from: holder })).result);
  return { ...a, token, claim, holder, balance };
}

// ---------------- phases ----------------
async function phaseTable() {
  if (pub.solana.exitLookupTable) return log(`lookup table ${pub.solana.exitLookupTable} (already created)`);
  const me = await payer();
  const tm = (await cctpReceiveAccounts({ usdcMint, burnToken: new Uint8Array(32), feeRecipient: me.address })).tokenMessenger;
  const feeRecipient = decodeTokenMessengerFeeRecipient((await retry(() => sol.accountData(tm)))!);
  const burnToken = evmAddressToBytes32(await l1.readContract({ address: pub.l1.portal, abi: PORTAL_EXIT_ABI, functionName: "usdc" }));
  const want = await receiveExitLookupTableAddresses({ usdcMint, burnToken, cctpFeeRecipient: feeRecipient });
  const before = (await sol.rpc.getBalance(me.address, { commitment: "confirmed" }).send()).value;
  const recentSlot = await sol.rpc.getSlot({ commitment: "finalized" }).send();
  const { ix, table } = await createLookupTableIx({ authority: me.address, payer: me.address, recentSlot });
  const sig = await sol.send([ix, extendLookupTableIx({ table, authority: me.address, payer: me.address, addresses: want })], [me.keyPair], me.address);
  for (let i = 0; i < 20; i++) {
    const raw = await retry(() => sol.accountData(table));
    if (raw && want.every((x) => decodeLookupTable(raw).includes(x))) break;
    await sleep(1_000);
  }
  const after = (await sol.rpc.getBalance(me.address, { commitment: "confirmed" }).send()).value;
  Object.assign(pub.solana, { exitLookupTable: table, exitLookupTableSig: sig, exitLookupTableCost: (before - after).toString() });
  savePublic();
  log(`receive_exit lookup table ${table}: ${want.length} accounts, ${Number(before - after) / 1e9} SOL (${sig})`);
}

async function phaseClaim(need = NOTES_NEEDED, given?: Awaited<ReturnType<typeof aztec>>) {
  const a = given ?? (await aztec());
  let have = await a.balance();
  log(`account that exits: private balance ${Number(have) / 1e6} USDC`);
  // Notes already claimed by any exit entry (the first exit run, earlier fills).
  const taken = (JSON.parse(readFileSync(PUBLIC_FILE, "utf8")).runs as ExitRun[]).flatMap((r) => (r.kind === "exit" ? r.claims : []));
  for (const [runIndex, run] of (pub.runs as { kind?: string; denomination: string; epochId: string; deposits: string[]; registerTx?: string; claimedNote?: number; root?: string }[]).entries()) {
    if (have >= BigInt(need) * D) break;
    if (run.kind === "exit" || !run.registerTx || run.denomination !== D.toString() || !priv.seeds[runIndex]) continue;
    const seed = seedFromHex(priv.seeds[runIndex]!);
    const leaves = decodeEpoch((await retry(() => epochPda(0, BigInt(run.epochId)).then((x) => sol.accountData(x))))!).leaves;
    for (let k = 0; k < run.deposits.length && have < BigInt(need) * D; k++) {
      if (k === run.claimedNote || [...taken, ...exitRun.claims].some((c) => c.run === runIndex && c.note === k)) continue;
      const note = await deriveNote(seed, k);
      const i = leaves.indexOf(note.commitment);
      if (i < 0) throw new Error(`note ${runIndex}/${k} not in its epoch`);
      const { receipt } = await a.claim.methods
        .claim(new Fr(BigInt(run.root!)), new Fr(note.nullifierKey), new Fr(note.secret), new Fr(i), merklePath(leaves, i).map((x) => new Fr(x)), a.holder)
        .send({ from: a.holder, fee: a.fee, wait: AZTEC_WAIT });
      exitRun.claims.push({ run: runIndex, note: k, tx: receipt.txHash.toString() });
      savePublic();
      have = await a.balance();
      log(`claim run ${runIndex} note ${k}: ${receipt.txHash} (block ${receipt.blockNumber}); balance ${Number(have) / 1e6}`);
    }
  }
  if (have < BigInt(need) * D) throw new Error(`need ${need} notes; deposit and carry another batch (run.ts deposit, finish)`);
  exitRun.timings.claimed ??= Date.now();
  savePublic();
}

async function phaseExit() {
  const a = await aztec();
  // Fresh destinations: Solana addresses whose keys nobody keeps (the test only checks they are
  // paid), and a random Ethereum address.
  if (!exitRun.destinations) {
    exitRun.destinations = await Promise.all(Array.from({ length: SOLANA_EXITS }, async () => (await generateKeyPairSigner()).address));
    exitRun.ethereum = { recipient: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex")}` };
    savePublic();
  }
  exitRun.exitTxs ??= [];
  exitRun.exitFees ??= [];
  const burnVia = async (method: "exit" | "exit_to_ethereum", commitment: bigint, nonce: bigint) => {
    const call = await a.token.methods.burn_private(a.holder, D, new Fr(nonce)).getFunctionCall();
    const witness = await a.wallet.createAuthWit(a.holder, { caller: a.claim.address, call });
    const { receipt } = await a.claim.methods[method](new Fr(commitment), new Fr(nonce))
      .with({ authWitnesses: [witness] })
      .send({ from: a.holder, fee: a.fee, wait: AZTEC_WAIT });
    return receipt;
  };
  for (let i = exitRun.exitTxs.length; i < SOLANA_EXITS; i++) {
    const e = await deriveExit(exitSeed, i, address(exitRun.destinations[i]!));
    const started = Date.now();
    const r = await burnVia("exit", e.commitment, 1_000n + BigInt(i));
    exitRun.exitTxs.push(r.txHash.toString());
    exitRun.exitFees.push(String(r.transactionFee ?? ""));
    savePublic();
    log(`exit #${i} -> fresh Solana address: ${r.txHash} (block ${r.blockNumber}, ${((Date.now() - started) / 1000).toFixed(0)} s incl. proving)`);
  }
  if (!exitRun.ethereum!.exitTx) {
    const e = await deriveEthereumExit(exitSeed, 0, exitRun.ethereum!.recipient);
    const r = await burnVia("exit_to_ethereum", e.commitment, 2_000n);
    Object.assign(exitRun.ethereum!, { exitTx: r.txHash.toString(), exitFee: String(r.transactionFee ?? ""), exitBlock: Number(r.blockNumber) });
    savePublic();
    log(`exit_to_ethereum -> fresh Ethereum address: ${r.txHash} (block ${r.blockNumber})`);
  }
  exitRun.timings.exited ??= Date.now();
  savePublic();
  log(`private balance left ${Number(await a.balance()) / 1e6} USDC`);
}

/**
 * fill: n notes to this fill's fresh account, then n exits to fresh Solana addresses into the open
 * exit epoch, which other exits (the app's) share. The finisher closes it once it holds the minimum.
 */
async function phaseFill() {
  const n = exitRun.fill!;
  const a = await aztec();
  exitRun.exitTxs ??= [];
  exitRun.exitFees ??= [];
  if (exitRun.exitTxs.length < n) await phaseClaim(n - exitRun.exitTxs.length, a);
  if (!exitRun.destinations) {
    exitRun.destinations = await Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
    savePublic();
  }
  const before = (await a.claim.methods.get_exit_epoch().simulate({ from: a.holder })).result as { id: bigint; count: bigint };
  log(`open exit epoch ${before.id}: ${before.count} exits so far`);
  for (let i = exitRun.exitTxs.length; i < n; i++) {
    const e = await deriveExit(exitSeed, i, address(exitRun.destinations[i]!));
    const nonce = new Fr(1_000n + BigInt(i));
    const call = await a.token.methods.burn_private(a.holder, D, nonce).getFunctionCall();
    const witness = await a.wallet.createAuthWit(a.holder, { caller: a.claim.address, call });
    const started = Date.now();
    const { receipt: r } = await a.claim.methods.exit(new Fr(e.commitment), nonce).with({ authWitnesses: [witness] }).send({ from: a.holder, fee: a.fee, wait: AZTEC_WAIT });
    exitRun.exitTxs.push(r.txHash.toString());
    exitRun.exitFees.push(String(r.transactionFee ?? ""));
    savePublic();
    log(`exit #${i} -> fresh Solana address: ${r.txHash} (block ${r.blockNumber}, ${((Date.now() - started) / 1000).toFixed(0)} s incl. proving)`);
  }
  exitRun.timings.exited ??= Date.now();
  // Which exit epoch holds them (it may have closed meanwhile): searched from the newest.
  const open = (await a.claim.methods.get_exit_epoch().simulate({ from: a.holder })).result as { id: bigint; count: bigint };
  const mine = await Promise.all(exitRun.destinations.map(async (d, i) => (await deriveExit(exitSeed, i, address(d))).commitment));
  for (let k = BigInt(open.id); k >= 0n; k--) {
    const { result: bv } = await a.claim.methods.get_exit_leaves(k).simulate({ from: a.holder });
    const leaves = (bv.storage as bigint[]).slice(0, Number(bv.len)).map(BigInt);
    if (!leaves.includes(mine[0]!)) continue;
    Object.assign(exitRun, { exitEpochId: k.toString(), leafIndexes: mine.map((c) => leaves.indexOf(c)), epochCount: leaves.length });
    log(`exit epoch ${k}: ${leaves.length} exits (these at ${exitRun.leafIndexes!.join(", ")})${k < BigInt(open.id) ? ", closed" : ", open"}`);
    break;
  }
  savePublic();
  log(`private balance left ${Number(await a.balance()) / 1e6} USDC`);
}

/** Follows what the finisher does for the exit batch (it must be running with features.exit). */
async function phaseCarry() {
  const node = (await import("@aztec-labs/aztec.js/node")).createAztecNodeClient(pub.aztec.node, { maxBatchSize: 3 });
  const pda = await exitBatchPda(0, BigInt(exitRun.exitEpochId ?? "0"));
  const fin = () => (existsSync(FINISHER_STATE) ? JSON.parse(readFileSync(FINISHER_STATE, "utf8")) : {});
  const t = exitRun.timings;
  let lastLine = "";
  for (;;) {
    const s = fin();
    const b = s.exits?.[exitKey(D, exitRun.exitEpochId ?? "0")];
    if (s.closing?.[D.toString()] && !exitRun.closeTx && !fillMode) exitRun.closeTx = s.closing[D.toString()].tx;
    if (b?.closeTx) exitRun.closeTx = b.closeTx;
    if (b?.root && exitRun.exitEpochId === undefined) Object.assign(exitRun, { exitEpochId: b.exitEpochId, closeBlock: b.closedAt });
    if (exitRun.closeTx && !exitRun.closeFee) {
      const r = await node.getTxReceipt(TxHash.fromString(exitRun.closeTx));
      if (r.isMined()) {
        exitRun.closeFee = String(r.transactionFee);
        exitRun.closeBlock ??= Number(r.blockNumber);
        t.closeMined ??= Date.now();
      }
    }
    if (exitRun.closeBlock && !t.closeProven) {
      const proven = Number(await node.getBlockNumber("proven"));
      if (proven >= exitRun.closeBlock) {
        t.closeProven = Date.now();
        const blk = await node.getBlock(exitRun.closeBlock as never);
        t.closeBlockTime = Number(blk?.header.globalVariables.timestamp ?? 0n) * 1000;
        log(`Aztec proved block ${exitRun.closeBlock} (proven tip ${proven})`);
      }
    }
    if (b?.l1Tx && !exitRun.exitBatchGas) {
      const r = await l1.getTransactionReceipt({ hash: b.l1Tx }).catch(() => undefined);
      if (r?.status === "success") {
        exitRun.exitBatchTx = b.l1Tx;
        exitRun.exitBatchGas = r.gasUsed.toString();
        const blk = await l1.getBlock({ blockNumber: r.blockNumber });
        t.exitBatch = Number(blk.timestamp) * 1000;
        log(`exitBatch ${b.l1Tx} (gas ${r.gasUsed})`);
      }
    }
    if (b?.message && !exitRun.iris) {
      const m = hexToBytes(b.message as Hex);
      const dm = decodeExitMessage(m);
      const u256 = (o: number) => m.slice(o, o + 32).reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
      exitRun.iris = {
        nonce: hex32(u256(CCTP_MESSAGE.nonce)),
        minFinalityThreshold: new DataView(m.buffer, m.byteOffset).getUint32(CCTP_MESSAGE.minFinality),
        finalityThresholdExecuted: dm.finalityExecuted,
        feeExecuted: dm.feeExecuted.toString(),
        expirationBlock: u256(CCTP_MESSAGE.expirationBlock).toString(),
      };
      t.attested ??= Date.now();
      log(`Iris: finalityThresholdExecuted ${dm.finalityExecuted}, feeExecuted ${dm.feeExecuted}, expirationBlock ${exitRun.iris.expirationBlock}`);
    }
    if (b?.receiveSig && !exitRun.receiveExitSig) {
      exitRun.receiveExitSig = b.receiveSig;
      const tx = await retry(() => sol.rpc.getTransaction(b.receiveSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send());
      exitRun.receiveExitFee = String(tx?.meta?.fee ?? "");
      t.received = Number(tx?.blockTime ?? 0) * 1000 || Date.now();
    }
    savePublic();
    const raw = await retry(() => sol.accountData(pda));
    if (raw && exitRun.receiveExitSig) {
      const eb = decodeExitBatch(raw);
      log(`ExitBatch on Solana: $${Number(eb.denomination) / 1e6} × ${eb.count}, exit epoch ${eb.exitEpochId}`);
      break;
    }
    const line = `waiting: close ${exitRun.closeTx ? "sent" : "-"} · proven ${t.closeProven ? "yes" : "-"} · exitBatch ${b?.l1Tx ? "sent" : "-"} · iris ${b?.message ? "yes" : "-"} · receive_exit ${b?.receiveSig ? "yes" : "-"}`;
    if (line !== lastLine) log((lastLine = line));
    await sleep(15_000);
  }
  savePublic();
}

async function phaseSolana() {
  const me = await payer();
  const raw = await retry(() => exitBatchPda(0, BigInt(exitRun.exitEpochId ?? "0")).then((x) => sol.accountData(x)));
  if (!raw) throw new Error("the exit batch is not on Solana yet (carry)");
  const node = (await import("@aztec-labs/aztec.js/node")).createAztecNodeClient(pub.aztec.node, { maxBatchSize: 3 });
  // The leaves are public storage of the claim contract; read them through any wallet.
  const a = await aztec();
  const { result: bv } = await a.claim.methods.get_exit_leaves(BigInt(exitRun.exitEpochId ?? "0")).simulate({ from: a.holder });
  const leaves = (bv.storage as bigint[]).slice(0, Number(bv.len)).map(BigInt);
  const exits = await Promise.all(exitRun.destinations!.map((d, i) => deriveExit(exitSeed, i, address(d))));
  exitRun.claimExitSigs ??= [];
  const custody = await exitCustodyPda();
  const ixFor = async (e: (typeof exits)[number]) => {
    const inputs = exitClaimInputs(leaves, e.destination, e.secret);
    return [
      computeUnitLimitIx(CLAIM_EXIT_COMPUTE_UNITS),
      await claimExitIx({ payer: me.address, usdcMint, denominationIndex: 0, exitEpochId: BigInt(exitRun.exitEpochId ?? "0"), leafIndex: inputs.leafIndex, path: inputs.path, destination: e.destination, secret: e.secret }),
    ];
  };
  for (let i = exitRun.claimExitSigs.length; i < exits.length; i++) {
    const e = exits[i]!;
    const batch = decodeExitBatch((await retry(() => exitBatchPda(0, BigInt(exitRun.exitEpochId ?? "0")).then((x) => sol.accountData(x))))!);
    if (exitClaimed(batch, exitClaimInputs(leaves, e.destination, e.secret).leafIndex)) throw new Error(`exit ${i} claimed but not recorded`);
    const sig = await sol.send(await ixFor(e), [me.keyPair], me.address);
    exitRun.claimExitSigs.push(sig);
    savePublic();
    log(`claim_exit -> ${e.destination}: ${sig}`);
  }
  exitRun.timings.claimedOnSolana ??= Date.now();
  const paid = await Promise.all(exitRun.destinations!.map(async (d) => usdcOf(await associatedTokenAddress(address(d), usdcMint))));
  const after = decodeExitBatch((await retry(() => exitBatchPda(0, BigInt(exitRun.exitEpochId ?? "0")).then((x) => sol.accountData(x))))!);
  let replay = true;
  try {
    await sol.send(await ixFor(exits[0]!), [me.keyPair], me.address);
  } catch {
    replay = false;
  }
  const hexOf = (x: string) => Buffer.from(getAddressEncoder().encode(address(x))).toString("hex");
  if (!exitRun.closeTx && existsSync(FINISHER_STATE)) {
    exitRun.closeTx = JSON.parse(readFileSync(FINISHER_STATE, "utf8")).exits?.[exitKey(D, exitRun.exitEpochId ?? "0")]?.closeTx;
  }
  const effects = json(await Promise.all([...exitRun.exitTxs!, exitRun.closeTx].filter((h): h is string => !!h).map((h) => node.getTxEffect(TxHash.fromString(h)))));
  const allPaid = leaves.every((_, i) => exitClaimed(after, i));
  const mine = exits.map((e) => exitClaimInputs(leaves, e.destination, e.secret).leafIndex);
  exitRun.checks = {
    ...exitRun.checks,
    "each fresh Solana address holds exactly $1": paid.every((x) => x === D),
    // A fill shares its epoch with other exits, which their owners claim when they like.
    ...(fillMode
      ? { "these exits marked paid": mine.every((i) => exitClaimed(after, i)), ...(allPaid ? { "every exit of the epoch paid; exit custody back to 0": (await usdcOf(custody)) === 0n } : {}) }
      : { "all exits marked paid; exit custody back to 0": allPaid && (await usdcOf(custody)) === 0n }),
    "a second claim_exit of the same exit is refused": !replay,
    "no Solana destination (nor either half) in the exits' or the close's public effects on Aztec": exitRun.destinations!.every(
      (d) => !effects.includes(hexOf(d)) && !effects.includes(hexOf(d).slice(0, 32)) && !effects.includes(hexOf(d).slice(32)),
    ),
    "the account that exits is absent from those public effects": !effects.includes(a.holder.toString().slice(2).toLowerCase()),
  };
  savePublic();
  for (const [n, ok] of Object.entries(exitRun.checks)) log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}

async function phaseEthereum() {
  const eth = exitRun.ethereum;
  if (!eth?.exitTx) throw new Error("run the exit phase first");
  const a = await aztec();
  const info = await a.node.getNodeInfo();
  const e = await deriveEthereumExit(exitSeed, 0, eth.recipient);
  const msg = computeL2ToL1MessageHash({
    l2Sender: a.claim.address,
    l1Recipient: EthAddress.fromString(pub.l1.portal),
    content: new Fr(await ethereumExitContent(e.commitment, D)),
    rollupVersion: new Fr(BigInt(info.rollupVersion)),
    chainId: new Fr(BigInt(info.l1ChainId)),
  });
  const fx = await a.node.getTxEffect(TxHash.fromString(eth.exitTx));
  const sentExactly = fx?.data.l2ToL1Msgs.some((m) => m.equals(msg)) === true;
  const outbox = info.l1ContractAddresses.outboxAddress.toString() as Hex;
  const usdc = await l1.readContract({ address: pub.l1.portal, abi: PORTAL_EXIT_ABI, functionName: "usdc" });
  const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const usdcOfL1 = (who: Hex) => l1.readContract({ address: usdc, abi: balAbi, functionName: "balanceOf", args: [who] });
  let proof;
  for (;;) {
    proof = await l2ToL1Proof(a.node, l1 as never, outbox, msg, eth.exitTx);
    if (proof) break;
    log(`waiting for Aztec to prove the epoch of block ${eth.exitBlock} (proven tip ${await a.node.getBlockNumber("proven")})`);
    await sleep(60_000);
  }
  exitRun.timings.ethereumProven ??= Date.now();
  const wallet = l1Wallet();
  const send = async () => {
    const hash = await wallet.writeContract({ address: pub.l1.portal, abi: PORTAL_EXIT_ABI, functionName: "claimToEthereum", args: [D, eth.recipient as Hex, hex32(e.secret), proof] });
    const r = await l1.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`claimToEthereum reverted: ${hash}`);
    return r;
  };
  if (!eth.claimTx) {
    const portalBefore = await usdcOfL1(pub.l1.portal);
    const r = await send();
    Object.assign(eth, { claimTx: r.transactionHash, claimGas: r.gasUsed.toString(), outboxEpoch: proof.epoch.toString() });
    exitRun.timings.claimedOnEthereum = Date.now();
    savePublic();
    log(`claimToEthereum ${r.transactionHash} (gas ${r.gasUsed}, Outbox epoch ${proof.epoch}, path of ${proof.path.length})`);
    exitRun.checks = { ...exitRun.checks, "the portal paid out exactly $1": portalBefore - (await usdcOfL1(pub.l1.portal)) === D };
  }
  let replay = true;
  try {
    await send();
  } catch {
    replay = false;
  }
  const effects = json([fx]);
  exitRun.checks = {
    ...exitRun.checks,
    "exit_to_ethereum sent exactly this L2->L1 message": sentExactly,
    "the fresh Ethereum address holds exactly $1": (await usdcOfL1(eth.recipient as Hex)) === D,
    "a second claimToEthereum of the same exit is refused": !replay,
    "the Ethereum recipient is absent from the exit's public effects on Aztec": !effects.includes(eth.recipient.slice(2).toLowerCase()),
  };
  savePublic();
  for (const [n, ok] of Object.entries(exitRun.checks)) log(`${ok ? "PASS" : "FAIL"}  ${n}`);
}

const phases: Record<string, () => Promise<unknown>> = {
  table: phaseTable,
  claim: () => phaseClaim(),
  fill: phaseFill,
  "fill-carry": phaseCarry,
  "fill-solana": phaseSolana,
  exit: phaseExit,
  carry: phaseCarry,
  solana: phaseSolana,
  ethereum: phaseEthereum,
};
try {
  if (!phases[which]) throw new Error(`usage: exits.ts <${Object.keys(phases).join("|")}>`);
  await phases[which]();
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
