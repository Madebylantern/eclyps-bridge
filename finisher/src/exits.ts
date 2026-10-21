/**
 * The finisher's exit steps (ADR 0009), shared by the local and testnet modes. Each pass:
 *
 *   Aztec     close_exit_epoch for a denomination whose open exit epoch has at least the minimum
 *             of exits and has ended (or is full); then reads each closed exit epoch (root, count,
 *             content, block)
 *   Ethereum  once the Aztec epoch holding the close is proven and its L2->L1 root is in the
 *             Outbox: the membership witness from the Aztec node, then EclypsPortal.exitBatch (the
 *             CCTP burn to Solana); skipped when the portal says `exited`
 *   Solana    Circle's attested message (Iris by the exitBatch transaction; substituted on the
 *             local stack), then receive_exit as a v0 transaction with the address lookup table
 *             (created once if the deployment has none); skipped when the ExitBatch exists
 *
 * claim_exit is each user's own step (the app). Every step is permissionless and checked on chain
 * first, so several finishers can run, and a lost record never sends anything twice.
 */
import { type AztecAddress, AztecAddress as AztecAddressClass, EthAddress } from "@aztec-labs/aztec.js/addresses";
import { NO_WAIT } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import type { AztecNode } from "@aztec-labs/aztec.js/node";
import { TxHash } from "@aztec-labs/aztec.js/tx";
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash";
import { computeL2ToL1MembershipWitness } from "@aztec-labs/stdlib/messaging";
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import type { Address, KeyPairSigner } from "@solana/kit";
import { type Account, type Chain, type Hex, hexToBytes, parseAbi, parseAbiItem, type PublicClient, toHex, type Transport, type WalletClient } from "viem";
import {
  cctpReceiveAccounts,
  computeUnitLimitIx,
  createLookupTableIx,
  decodeExitMessage,
  decodeLookupTable,
  decodeTokenMessengerFeeRecipient,
  evmAddressToBytes32,
  exitBatchPda,
  extendLookupTableIx,
  RECEIVE_EXIT_COMPUTE_UNITS,
  receiveExitIx,
  receiveExitLookupTableAddresses,
} from "@eclyps/sdk";
import { EclypsClaimContract } from "../../aztec/artifacts/EclypsClaim.js";
import type { solanaClient } from "./chains.js";
import {
  advanceExitsDone,
  type AztecClock,
  CLOSE_MARGIN_SLOTS,
  CLOSE_WINDOW_SLOTS,
  type CloseTiming,
  exitCloseTiming,
  msToEpochEnd,
  type ExitBatch,
  exitCloseDue,
  exitBlocksLeft,
  exitEpochsToCarry,
  exitKey,
  exitL1Stuck,
  exitMessageMismatch,
  exitName,
  exitStageOf,
  type ExitState,
  isDue,
  oneLine,
  outboxLeafId,
  recordFailure,
  recordSuccess,
  fmtDuration,
  sizeName,
} from "./plan.js";

export const PORTAL_EXIT_ABI = parseAbi([
  "struct OutboxProof { uint256 epoch; uint256 numCheckpointsInEpoch; uint256 leafIndex; bytes32[] path; }",
  "function exitBatch(bytes32 root, uint16 count, uint64 exitEpochId, uint64 denomination, OutboxProof proof) returns (uint256)",
  "function exited(uint64 denomination, uint64 exitEpochId) view returns (bool)",
  "function usdc() view returns (address)",
  "function claimToEthereum(uint64 denomination, address recipient, bytes32 exitSecret, OutboxProof proof)",
]);
export const EXIT_BATCH_SENT = parseAbiItem(
  "event ExitBatchSent(uint64 indexed denomination, uint64 indexed exitEpochId, bytes32 indexed root, uint16 count, uint256 amount, bytes32 content)",
);
export const OUTBOX_ABI = parseAbi([
  "function getRootData(uint256 epoch, uint256 numCheckpointsInEpoch) view returns (bytes32)",
  "function hasMessageBeenConsumedAtEpoch(uint256 epoch, uint256 leafId) view returns (bool)",
]);

/** An Aztec L2->L1 membership witness as EclypsPortal's OutboxProof. */
export interface OutboxProof {
  epoch: bigint;
  numCheckpointsInEpoch: bigint;
  leafIndex: bigint;
  path: Hex[];
}

/** The Outbox's roots for an Aztec epoch, as computeL2ToL1MembershipWitness reads them. */
export const outboxRoots = (l1: PublicClient, outbox: Hex) => ({
  getRoots: async (epoch: bigint | number) =>
    Promise.all(
      Array.from({ length: 32 }, async (_, i) =>
        Fr.fromHexString(await l1.readContract({ address: outbox, abi: OUTBOX_ABI, functionName: "getRootData", args: [BigInt(epoch), BigInt(i + 1)] })),
      ),
    ),
});

/**
 * The witness that the L2->L1 message `msg`, sent by transaction `tx`, is in a root the Outbox
 * holds; undefined until the Aztec epoch is proven.
 */
export async function l2ToL1Proof(node: AztecNode, l1: PublicClient, outbox: Hex, msg: Fr, tx: string): Promise<OutboxProof | undefined> {
  const w = await computeL2ToL1MembershipWitness(node, outboxRoots(l1, outbox), msg, TxHash.fromString(tx));
  if (!w) return undefined;
  return {
    epoch: BigInt(w.epochNumber),
    numCheckpointsInEpoch: BigInt(w.numCheckpointsInEpoch),
    leafIndex: w.leafIndex,
    path: w.siblingPath.toBufferArray().map((b) => toHex(b)),
  };
}

/** The transaction of block `block` that sent the L2->L1 message `msg` (a close sent by anyone). */
export async function findL2ToL1Tx(node: AztecNode, block: number, msg: Fr): Promise<string | undefined> {
  const b = await node.getBlock(block as never, { includeTransactions: true });
  const fx = b?.body.txEffects.find((e) => e.l2ToL1Msgs.some((m) => m.equals(msg)));
  return fx?.txHash.toString();
}

export interface AztecHandle {
  wallet: EmbeddedWallet;
  from: AztecAddress;
  /** Fee payment for close_exit_epoch (testnet: the SponsoredFPC); undefined on the local network. */
  fee?: unknown;
  /** Registers a deployed contract with the wallet (testnet); local wallets read from the node. */
  register?(addr: string, artifact: typeof EclypsClaimContract.artifact): Promise<void>;
}

export interface ExitContext {
  log(s: string): void;
  waiting(key: string, line: string): void;
  debug(e: unknown): void;
  stopping(): boolean;
  state: ExitState;
  save(): void;
  /** The gateway config's denominations, in order (0 for an unused slot). */
  denominations: bigint[];
  claims: Record<string, string>;
  portal: Hex;
  node: AztecNode;
  aztec(): Promise<AztecHandle>;
  /** Wait for close_exit_epoch to be mined (local) or send it and look for its receipt later (testnet). */
  waitForClose: boolean;
  l1: PublicClient;
  l1w: WalletClient<Transport, Chain, Account>;
  sol: ReturnType<typeof solanaClient>;
  payer: KeyPairSigner;
  usdcMint: Address;
  /** The deployment's receive_exit lookup table, if it has one. */
  lookupTable?: Address;
  /** Circle's attestation for an exit batch burned on Ethereum (Iris, or the local substitute). */
  attest(b: ExitBatch): Promise<{ message: Hex; attestation: Hex } | { pending: string }>;
  /** Local network only: produce a block (it builds blocks on demand). */
  nudge?(): Promise<void>;
  /** The L1 gas guard: a reason to wait (gas above the cap), or undefined to send. Not set: no cap. */
  gasWait?(): Promise<string | undefined>;
  /**
   * Where Aztec is in its epoch (`readAztecClock`). When set, a due close is timed to land at
   * least two slots before an Aztec epoch ends (`exitCloseTiming`, ADR 0017 item 1); when not
   * (the local network, which builds blocks on demand), a due close is sent at once.
   */
  aztecClock?(): Promise<AztecClock>;
}

export const ROLLUP_CLOCK_ABI = parseAbi([
  "function getCurrentSlot() view returns (uint256)",
  "function getEpochDuration() view returns (uint256)",
  "function getSlotDuration() view returns (uint256)",
]);

let clockShape: { rollup: Hex; epochSlots: number; slotSeconds: number } | undefined;
/** The current Aztec slot and the epoch shape, from the rollup contract on L1. */
export async function readAztecClock(node: AztecNode, l1: PublicClient): Promise<AztecClock> {
  if (!clockShape) {
    const rollup = (await node.getNodeInfo()).l1ContractAddresses.rollupAddress.toString() as Hex;
    const [e, s] = await Promise.all([
      l1.readContract({ address: rollup, abi: ROLLUP_CLOCK_ABI, functionName: "getEpochDuration" }),
      l1.readContract({ address: rollup, abi: ROLLUP_CLOCK_ABI, functionName: "getSlotDuration" }),
    ]);
    clockShape = { rollup, epochSlots: Number(e), slotSeconds: Number(s) };
  }
  const slot = await l1.readContract({ address: clockShape.rollup, abi: ROLLUP_CLOCK_ABI, functionName: "getCurrentSlot" });
  return { slot, epochSlots: clockShape.epochSlots, slotSeconds: clockShape.slotSeconds };
}

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 10)}…` : s);

async function exitStep(ctx: ExitContext, b: ExitBatch, what: string, fn: () => Promise<void>) {
  if (!isDue(b, Date.now())) return;
  try {
    await fn();
  } catch (e) {
    const wait = recordFailure(b, Date.now(), oneLine(e));
    ctx.save();
    ctx.log(`${what} ${exitName(b)} failed: ${oneLine(e)}; retry in ${fmtDuration(wait)}`);
    ctx.debug(e);
  }
}

function done(ctx: ExitContext, b: ExitBatch) {
  recordSuccess(b);
  ctx.save();
}

const registered = new Set<string>();
async function claimContract(ctx: ExitContext, d: bigint) {
  const addr = ctx.claims[d.toString()];
  if (!addr) return undefined;
  const a = await ctx.aztec();
  if (a.register && !registered.has(addr)) {
    await a.register(addr, EclypsClaimContract.artifact);
    registered.add(addr);
  }
  return { a, claim: EclypsClaimContract.at(AztecAddressClass.fromStringUnsafe(addr), a.wallet) };
}

const minBatch = new Map<string, number>();

/**
 * The open exit epoch of a claim contract, read from its public storage (one packed slot:
 * id << 64 | count << 32 | ends_at), so no wallet is needed to look.
 */
export async function readOpenExitEpoch(node: AztecNode, claim: string): Promise<{ id: bigint; count: number; endsAt: number }> {
  const v = (await node.getPublicStorageAt("latest", AztecAddressClass.fromStringUnsafe(claim), EclypsClaimContract.storage.exit_epoch.slot)).toBigInt();
  return { id: v >> 64n, count: Number((v >> 32n) & 0xffffffffn), endsAt: Number(v & 0xffffffffn) };
}

/** Aztec: close due exit epochs, then read every closed one this finisher has not carried yet. */
export async function aztecExitLeg(ctx: ExitContext) {
  const s = ctx.state;
  for (const [index, d] of ctx.denominations.entries()) {
    if (ctx.stopping()) return;
    if (d === 0n || !ctx.claims[d.toString()]) continue;
    const denom = d.toString();
    const pending = s.closing?.[denom];
    if (pending) {
      const receipt = await ctx.node.getTxReceipt(TxHash.fromString(pending.tx));
      if (receipt.isPending()) {
        ctx.waiting(`close:${denom}`, `close_exit_epoch ${sizeName(d)}: waiting for Aztec tx ${short(pending.tx)}`);
        continue;
      }
      if (!(receipt.isMined() && receipt.hasExecutionSucceeded())) ctx.log(`close_exit_epoch ${sizeName(d)}: Aztec tx ${short(pending.tx)} did not land; checking again`);
      delete s.closing![denom];
      ctx.save();
    }
    // The open exit epoch from public storage: no wallet is started while nobody exits.
    let open = await readOpenExitEpoch(ctx.node, ctx.claims[denom]!);
    const toRead = exitEpochsToCarry(s, denom, open.id).filter((id) => s.exits[exitKey(denom, id)]?.root === undefined);
    if (open.count === 0 && toRead.length === 0) continue;
    const c = await claimContract(ctx, d);
    if (!c) continue;
    const { a, claim } = c;
    if (!minBatch.has(denom)) {
      const { result: cfg } = await claim.methods.get_config().simulate({ from: a.from });
      minBatch.set(denom, Number(cfg.min_exit_batch));
    }
    const block = Number(await ctx.node.getBlockNumber());
    const min = minBatch.get(denom)!;
    const due = exitCloseDue(open, block, min);
    let timing: CloseTiming = { action: "close" };
    if (due && ctx.aztecClock) {
      const clock = await ctx.aztecClock();
      timing = exitCloseTiming(clock, s.closeHeld?.[denom]);
      if (timing.action === "hold") {
        if (s.closeHeld?.[denom] !== timing.heldIn) {
          (s.closeHeld ??= {})[denom] = timing.heldIn;
          ctx.save();
        }
        const why = timing.why === "epoch-ending"
          ? `the Aztec epoch ends in ${timing.slotsLeft} slot${timing.slotsLeft === 1 ? "" : "s"}; closing in the next one, at least ${CLOSE_MARGIN_SLOTS} slots before its end`
          : `closing ${timing.slotsLeft - CLOSE_MARGIN_SLOTS - CLOSE_WINDOW_SLOTS} slots from now, before this Aztec epoch ends (proven together, ${fmtDuration(msToEpochEnd(clock))} left)`;
        ctx.waiting(`close:${denom}`, `close_exit_epoch ${sizeName(d)} #${open.id}: ${open.count} exits; ${why}`);
      }
    }
    if (due && timing.action === "close") {
      if (s.closeHeld?.[denom] !== undefined) {
        delete s.closeHeld[denom];
        ctx.save();
      }
      const call = claim.methods.close_exit_epoch();
      if (ctx.waitForClose) {
        const { receipt } = await call.send({ from: a.from, fee: a.fee as never });
        ctx.log(`close_exit_epoch ${sizeName(d)} #${open.id}: ${open.count} exits (Aztec block ${receipt.blockNumber})`);
        open = await readOpenExitEpoch(ctx.node, ctx.claims[denom]!);
      } else {
        const { txHash } = await call.send({ from: a.from, fee: a.fee as never, wait: NO_WAIT });
        (s.closing ??= {})[denom] = { tx: txHash.toString(), at: Date.now() };
        ctx.save();
        ctx.log(`close_exit_epoch ${sizeName(d)} #${open.id}: ${open.count} exits, Aztec tx ${short(txHash.toString())} sent`);
      }
    } else if (!due && open.count >= min) {
      ctx.waiting(`close:${denom}`, `close_exit_epoch ${sizeName(d)} #${open.id}: ${open.count} exits; the epoch ends in ${exitBlocksLeft(open, block)} blocks`);
      await ctx.nudge?.();
    }
    for (const id of exitEpochsToCarry(s, denom, open.id)) {
      const key = exitKey(denom, id);
      const b = (s.exits[key] ??= { denomination: denom, index, exitEpochId: id.toString() });
      if (b.root !== undefined) continue;
      const { result } = await claim.methods.get_closed_exit_epoch(id).simulate({ from: a.from });
      if (Number(result.count) === 0) continue; // not closed (never happens below the open id)
      Object.assign(b, { root: toHex(BigInt(result.root), { size: 32 }), count: Number(result.count), content: toHex(BigInt(result.content), { size: 32 }), closedAt: Number(result.closed_at) });
      ctx.save();
      ctx.log(`${exitName(b)}: closed on Aztec with ${b.count} exits (block ${b.closedAt})`);
    }
  }
}

let nodeInfo: Awaited<ReturnType<AztecNode["getNodeInfo"]>> | undefined;

/** Ethereum: exitBatch for every closed exit epoch whose L2->L1 root is in the Outbox. */
export async function ethereumExitLeg(ctx: ExitContext) {
  for (const b of Object.values(ctx.state.exits)) {
    if (ctx.stopping()) return;
    if (exitStageOf(b) !== "prove" || b.root === undefined) continue;
    await exitStep(ctx, b, "exitBatch", () => exitOne(ctx, b));
  }
}

async function exitOne(ctx: ExitContext, b: ExitBatch) {
  const key = exitKey(b.denomination, b.exitEpochId);
  const d = BigInt(b.denomination);
  const id = BigInt(b.exitEpochId);

  // 1. This finisher's exitBatch, if sent: its receipt.
  if (b.l1Tx) {
    const receipt = await ctx.l1.getTransactionReceipt({ hash: b.l1Tx as Hex }).catch(() => undefined);
    if (receipt?.status === "success") {
      Object.assign(b, { exited: true, exitedByUs: true });
      done(ctx, b);
      ctx.log(`exitBatch ${exitName(b)}: burned to Solana (${short(b.l1Tx)})`);
      return;
    }
    if (!receipt && !exitL1Stuck(b, Date.now())) return ctx.waiting(key, `exitBatch ${exitName(b)}: waiting for L1 tx ${short(b.l1Tx)}`);
    ctx.log(`exitBatch ${exitName(b)}: L1 tx ${short(b.l1Tx)} ${receipt ? "reverted" : "not mined after 10 min"}; checking the portal`);
    delete b.l1Tx;
    delete b.l1SubmittedAt;
    ctx.save();
  }

  // 2. Exited already (another finisher, or a lost record).
  if (await ctx.l1.readContract({ address: ctx.portal, abi: PORTAL_EXIT_ABI, functionName: "exited", args: [d, id] })) {
    b.exited = true;
    done(ctx, b);
    ctx.log(`exitBatch ${exitName(b)}: already burned on Ethereum`);
    return;
  }

  // 3. The witness: the close's L2->L1 message in a proven Outbox root.
  nodeInfo ??= await ctx.node.getNodeInfo();
  const msg = computeL2ToL1MessageHash({
    l2Sender: AztecAddressClass.fromStringUnsafe(ctx.claims[b.denomination]!),
    l1Recipient: EthAddress.fromString(ctx.portal),
    content: Fr.fromHexString(b.content!),
    rollupVersion: new Fr(BigInt(nodeInfo.rollupVersion)),
    chainId: new Fr(BigInt(nodeInfo.l1ChainId)),
  });
  if (!b.closeTx) {
    b.closeTx = await findL2ToL1Tx(ctx.node, b.closedAt!, msg);
    if (!b.closeTx) throw new Error(`no transaction in Aztec block ${b.closedAt} sent this exit epoch's message`);
    ctx.save();
  }
  const outbox = nodeInfo.l1ContractAddresses.outboxAddress.toString() as Hex;
  const proof = await l2ToL1Proof(ctx.node, ctx.l1, outbox, msg, b.closeTx);
  if (!proof) {
    ctx.waiting(key, `exitBatch ${exitName(b)}: waiting for Aztec to prove the epoch of block ${b.closedAt}`);
    await ctx.nudge?.();
    return;
  }
  const consumed = await ctx.l1.readContract({ address: outbox, abi: OUTBOX_ABI, functionName: "hasMessageBeenConsumedAtEpoch", args: [proof.epoch, outboxLeafId(proof.path.length, proof.leafIndex)] });
  if (consumed) throw new Error("the Outbox message is consumed but the portal has not exited this epoch");

  // 4. exitBatch: the portal consumes the message and burns count × denomination to Solana.
  const wei = await ctx.l1.getBalance({ address: ctx.l1w.account.address });
  if (wei === 0n) return ctx.waiting(key, `exitBatch ${exitName(b)}: needs ETH at ${ctx.l1w.account.address}`);
  const gas = await ctx.gasWait?.();
  if (gas) return ctx.waiting(key, `exitBatch ${exitName(b)}: ${gas}`);
  const hash = await ctx.l1w.writeContract({
    address: ctx.portal, abi: PORTAL_EXIT_ABI, functionName: "exitBatch",
    args: [b.root as Hex, b.count!, id, d, proof],
  });
  Object.assign(b, { l1Tx: hash, l1SubmittedAt: Date.now() });
  ctx.save();
  ctx.log(`exitBatch ${exitName(b)}: L1 tx ${short(hash)} sent (Outbox epoch ${proof.epoch}, path of ${proof.path.length})`);
  const receipt = await ctx.l1.waitForTransactionReceipt({ hash, timeout: 180_000 }).catch(() => undefined);
  if (!receipt) return ctx.waiting(key, `exitBatch ${exitName(b)}: waiting for L1 tx ${short(hash)}`);
  if (receipt.status !== "success") {
    delete b.l1Tx;
    delete b.l1SubmittedAt;
    ctx.save();
    throw new Error(`exitBatch tx ${hash} reverted`);
  }
  Object.assign(b, { exited: true, exitedByUs: true });
  done(ctx, b);
  ctx.log(`exitBatch ${exitName(b)}: burned ${sizeName(d * BigInt(b.count!))} to Solana (gas ${receipt.gasUsed})`);
}

/** The exitBatch transaction of an exit epoch another finisher burned (Iris finds messages by it). */
export async function findExitBatchTx(l1: PublicClient, portal: Hex, d: bigint, id: bigint, fromBlock: bigint): Promise<Hex | undefined> {
  const latest = await l1.getBlockNumber();
  const CHUNK = 10_000n;
  for (let to = latest; to >= fromBlock; to -= CHUNK) {
    const from = to - CHUNK + 1n > fromBlock ? to - CHUNK + 1n : fromBlock;
    const logs = await l1.getLogs({ address: portal, event: EXIT_BATCH_SENT, args: { denomination: d, exitEpochId: id }, fromBlock: from, toBlock: to });
    if (logs[0]) return logs[0].transactionHash;
    if (from === fromBlock) break;
  }
  return undefined;
}

let table: { address: Address; addresses: Address[] } | undefined;
let feeRecipient: Address | undefined;

/** The receive_exit lookup table: the deployment's, this finisher's, or a new one (once). */
async function lookupTable(ctx: ExitContext): Promise<{ address: Address; addresses: Address[] }> {
  if (table) return table;
  const s = ctx.state;
  const want = await receiveExitLookupTableAddresses({
    usdcMint: ctx.usdcMint,
    burnToken: evmAddressToBytes32(await ctx.l1.readContract({ address: ctx.portal, abi: PORTAL_EXIT_ABI, functionName: "usdc" })),
    cctpFeeRecipient: await cctpFeeRecipient(ctx),
  });
  const existing = (ctx.lookupTable ?? s.exitLookupTable) as Address | undefined;
  if (existing) {
    const raw = await ctx.sol.accountData(existing);
    const have = raw ? decodeLookupTable(raw) : [];
    if (want.every((x) => have.includes(x))) return (table = { address: existing, addresses: have });
    if (ctx.lookupTable) throw new Error(`the deployment's lookup table ${existing} does not hold receive_exit's accounts`);
  }
  // Create it once: ≈ 0.0053 SOL, recoverable by closing it later.
  const recentSlot = await ctx.sol.rpc.getSlot({ commitment: "finalized" }).send();
  const { ix, table: address } = await createLookupTableIx({ authority: ctx.payer.address, payer: ctx.payer.address, recentSlot });
  await ctx.sol.send([ix, extendLookupTableIx({ table: address, authority: ctx.payer.address, payer: ctx.payer.address, addresses: want })], [ctx.payer.keyPair], ctx.payer.address);
  // A table is usable from the slot after its last extension.
  const after = await ctx.sol.rpc.getSlot({ commitment: "confirmed" }).send();
  for (let i = 0; i < 40 && (await ctx.sol.rpc.getSlot({ commitment: "confirmed" }).send()) <= after; i++) await new Promise((r) => setTimeout(r, 400));
  s.exitLookupTable = address;
  ctx.save();
  ctx.log(`created the receive_exit lookup table ${address} (record it in the deployment as solana.exitLookupTable)`);
  return (table = { address, addresses: want });
}

async function cctpFeeRecipient(ctx: ExitContext): Promise<Address> {
  if (feeRecipient) return feeRecipient;
  const tm = (await cctpReceiveAccounts({ usdcMint: ctx.usdcMint, burnToken: new Uint8Array(32), feeRecipient: ctx.payer.address })).tokenMessenger;
  const raw = await ctx.sol.accountData(tm);
  if (!raw) throw new Error(`CCTP's TokenMessenger state ${tm} not found on Solana`);
  return (feeRecipient = decodeTokenMessengerFeeRecipient(raw));
}

/** Solana: Circle's attestation, then receive_exit, for every exit batch burned on Ethereum. */
export async function solanaExitLeg(ctx: ExitContext) {
  for (const b of Object.values(ctx.state.exits)) {
    if (ctx.stopping()) return;
    if (exitStageOf(b) !== "attest") continue;
    await exitStep(ctx, b, "receive_exit", () => receiveOne(ctx, b));
    if (b.received) {
      advanceExitsDone(ctx.state, b.denomination);
      ctx.save();
    }
  }
}

async function receiveOne(ctx: ExitContext, b: ExitBatch) {
  const key = exitKey(b.denomination, b.exitEpochId);
  const pda = await exitBatchPda(b.index, BigInt(b.exitEpochId));
  if (await ctx.sol.accountData(pda)) {
    b.received = true;
    done(ctx, b);
    ctx.log(`receive_exit ${exitName(b)}: on Solana; its ${b.count} exits can be claimed`);
    return;
  }
  if (!b.message || !b.attestation) {
    const r = await ctx.attest(b);
    if ("pending" in r) return ctx.waiting(key, `iris ${exitName(b)}: ${r.pending}`);
    const why = exitMessageMismatch(decodeExitMessage(hexToBytes(r.message)), b);
    if (why) throw new Error(`Circle's message does not carry this exit batch: ${why}`);
    Object.assign(b, { message: r.message, attestation: r.attestation });
    ctx.save();
    ctx.log(`iris ${exitName(b)}: attested`);
  }
  const lamports = (await ctx.sol.rpc.getBalance(ctx.payer.address, { commitment: "confirmed" }).send()).value;
  if (lamports < 5_000_000n) return ctx.waiting(key, `receive_exit ${exitName(b)}: needs about 0.005 SOL at ${ctx.payer.address}`);
  const t = await lookupTable(ctx);
  const ix = await receiveExitIx({
    payer: ctx.payer.address, usdcMint: ctx.usdcMint, message: hexToBytes(b.message as Hex), attestation: hexToBytes(b.attestation as Hex),
    denominations: ctx.denominations, cctpFeeRecipient: await cctpFeeRecipient(ctx),
  });
  let sig: string;
  try {
    sig = await ctx.sol.send([computeUnitLimitIx(RECEIVE_EXIT_COMPUTE_UNITS), ix], [ctx.payer.keyPair], ctx.payer.address, { [t.address]: t.addresses });
  } catch (e) {
    if (await ctx.sol.accountData(pda)) {
      b.received = true;
      done(ctx, b);
      ctx.log(`receive_exit ${exitName(b)}: received by another finisher`);
      return;
    }
    throw e;
  }
  Object.assign(b, { received: true, receivedByUs: true, receiveSig: sig });
  done(ctx, b);
  ctx.log(`receive_exit ${exitName(b)}: ${sizeName(BigInt(b.denomination) * BigInt(b.count ?? 0))} in exit custody (${short(sig)}); ${b.count} exits to claim`);
}
