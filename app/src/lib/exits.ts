/**
 * Move out (ADR 0009 to Solana, ADR 0014 §4 to Ethereum): reading where each exit is from public
 * chain state, and the user's own last step. To Solana the finishers carry the batch; the user
 * claims it with `claim_exit` (any Solana wallet can send it; the USDC only goes to the address in
 * the commitment). To Ethereum the user claims with `claimToEthereum` from an Ethereum wallet in
 * this browser (or anyone else sends it for them; the USDC only goes to the committed recipient).
 */
import {
  CLAIM_EXIT_COMPUTE_UNITS,
  claimExitIx,
  computeUnitLimitIx,
  decodeExitBatch,
  decodeFront,
  frontPda,
  deriveEthereumExitSecret,
  deriveExitSecret,
  ethereumExitContent,
  exitBatchPda,
  exitClaimed,
  exitClaimInputs,
  MIN_EXIT_BATCH,
} from "@eclyps/sdk";
import { type Address, address } from "@solana/kit";
import { createPublicClient, createWalletClient, custom, type EIP1193Provider, type Hex, http, parseAbi, toHex } from "viem";
import type { ExitReads } from "./aztec";
import type { Deployment } from "./deployment";
import type { AztecClock } from "./eta";
import { type ExitFacts, outboxMayHold } from "./exit-status";
import { inChunks } from "./poller";
import { accountBytes, sendWith, type SolanaSigner } from "./solana";
import type { StoredExit } from "./vault";

const PORTAL_ABI = parseAbi([
  "struct OutboxProof { uint256 epoch; uint256 numCheckpointsInEpoch; uint256 leafIndex; bytes32[] path; }",
  "function exited(uint64 denomination, uint64 exitEpochId) view returns (bool)",
  "function claimToEthereum(uint64 denomination, address recipient, bytes32 exitSecret, OutboxProof proof)",
]);
const OUTBOX_ABI = parseAbi([
  "function getRootData(uint256 epoch, uint256 numCheckpointsInEpoch) view returns (bytes32)",
  "function hasMessageBeenConsumedAtEpoch(uint256 epoch, uint256 leafId) view returns (bool)",
]);

interface OutboxProof {
  epoch: bigint;
  numCheckpointsInEpoch: bigint;
  leafIndex: bigint;
  path: Hex[];
}

const l1Of = (dep: Deployment) => createPublicClient({ transport: http(dep.l1.rpc) });

/** What is known about one Solana exit, plus where its leaf sits once found. */
export interface SolanaExitView extends ExitFacts {
  exitEpochId?: bigint;
  leaves?: bigint[];
}

/**
 * A Solana exit's facts: its exit epoch (searched from the hint in the public leaves), whether that
 * epoch is closed, burned to Solana by the portal, received there, and whether this leaf is paid.
 */
export async function solanaExitFacts(dep: Deployment, x: StoredExit, reads: ExitReads): Promise<SolanaExitView> {
  if (!x.tx) return { mined: false };
  const d = x.denomination;
  const open = await reads.openExitEpoch(d);
  let id = x.exitEpochId !== undefined ? BigInt(x.exitEpochId) : undefined;
  let leaves: bigint[] | undefined;
  if (id === undefined) {
    for (let k = BigInt(x.epochHint ?? "0"); k <= open.id; k++) {
      const ls = await reads.exitLeaves(d, k);
      if (ls.includes(BigInt(x.commitment))) {
        id = k;
        leaves = ls;
        break;
      }
    }
    if (id === undefined) return { mined: true, minBatch: MIN_EXIT_BATCH };
  }
  leaves ??= await reads.exitLeaves(d, id);
  const closed = id < open.id;
  const base: SolanaExitView = { mined: true, exitEpochId: id, leaves, closed, inEpoch: leaves.length, minBatch: MIN_EXIT_BATCH };
  // Fast (ADR 0017): fronted from the liquidity pool, the destination is paid already. The record
  // closes when the slow path repays the pool, so a fast exit shows paid from then on as well.
  if (dep.features?.fastExit === true && x.fast?.sig) {
    const raw = await accountBytes(dep, await frontPda(BigInt(x.commitment)));
    if (raw) return { ...base, paid: true, frontedAdvanced: decodeFront(raw).advanced };
  }
  const fronted = x.fast?.sig && x.fast.advanced ? { frontedAdvanced: BigInt(x.fast.advanced) } : {};
  if (!closed) return base;
  const exited = await l1Of(dep).readContract({ address: dep.l1.portal as Hex, abi: PORTAL_ABI, functionName: "exited", args: [BigInt(d), id] });
  if (!exited) return base;
  const idx = dep.denominations.indexOf(d);
  const raw = await accountBytes(dep, await exitBatchPda(idx, id));
  if (!raw) return { ...base, exited };
  const batch = decodeExitBatch(raw);
  const leafIndex = leaves.indexOf(BigInt(x.commitment));
  const paid = !!x.claimTx || exitClaimed(batch, leafIndex);
  return { ...base, exited, arrived: true, paid, ...(paid ? fronted : {}) };
}

/** claim_exit: pays the exit's committed Solana address from exit custody. Any wallet may send it. */
export async function claimExitOnSolana(dep: Deployment, signer: SolanaSigner, seed: Uint8Array, x: StoredExit, view: SolanaExitView): Promise<string> {
  if (view.exitEpochId === undefined || !view.leaves) throw new Error("This exit's batch isn't readable yet. Try again in a moment.");
  const secret = await deriveExitSecret(seed, x.index);
  const destination = address(x.destination);
  const inputs = exitClaimInputs(view.leaves, destination, secret);
  // A fronted exit (ADR 0017) is claimed for the fronter: the program requires its record's accounts.
  const frontRaw = await accountBytes(dep, await frontPda(inputs.leaf));
  const front = frontRaw ? decodeFront(frontRaw) : undefined;
  const ix = await claimExitIx({
    payer: signer.address, usdcMint: dep.solana.usdcMint as Address, denominationIndex: dep.denominations.indexOf(x.denomination),
    exitEpochId: view.exitEpochId, leafIndex: inputs.leafIndex, path: inputs.path, destination, secret,
    front: front && { payee: front.payee, rentPayer: front.rentPayer },
  });
  return sendWith(dep, signer, [computeUnitLimitIx(CLAIM_EXIT_COMPUTE_UNITS), ix]);
}

/**
 * The exit to Ethereum's Outbox proof, once the Aztec epoch holding its burn is proven, and
 * whether it is already paid (consumed by anyone).
 */
export async function ethereumExitFacts(dep: Deployment, x: StoredExit): Promise<ExitFacts & { proof?: OutboxProof }> {
  if (!x.tx) return { mined: false };
  if (x.claimTx) return { mined: true, proven: true, paid: true };
  const l1 = l1Of(dep);
  // Found once, the proof does not change: later looks only ask whether it was consumed.
  const known = proofs.get(x.commitment);
  if (known) {
    const paid = await l1.readContract({ address: known.outbox, abi: OUTBOX_ABI, functionName: "hasMessageBeenConsumedAtEpoch", args: [known.proof.epoch, leafIdOf(known.proof)] });
    return { mined: true, proven: true, paid, proof: known.proof };
  }
  const [{ AztecAddress, EthAddress }, { Fr }, { TxHash }, { computeL2ToL1MessageHash }, { computeL2ToL1MembershipWitness }] = await Promise.all([
    import("@aztec-labs/aztec.js/addresses"),
    import("@aztec-labs/aztec.js/fields"),
    import("@aztec-labs/aztec.js/tx"),
    import("@aztec-labs/stdlib/hash"),
    import("@aztec-labs/stdlib/messaging"),
  ]);
  const { node, info } = await aztecNodeOf(dep);
  // Until the epoch holding the burn is proven (about 40 to 75 minutes on testnet), the Outbox has
  // no root for it: one receipt read per look, instead of the epoch's blocks and 32 Outbox reads.
  const receipt = await node.getTxReceipt(TxHash.fromString(x.tx));
  if (!outboxMayHold(receipt.status)) return { mined: true };
  const outbox = info.l1ContractAddresses.outboxAddress.toString() as Hex;
  const msg = computeL2ToL1MessageHash({
    l2Sender: AztecAddress.fromStringUnsafe(dep.aztec.claims[x.denomination]!),
    l1Recipient: EthAddress.fromString(dep.l1.portal),
    content: new Fr(await ethereumExitContent(BigInt(x.commitment), BigInt(x.denomination))),
    rollupVersion: new Fr(BigInt(info.rollupVersion)),
    chainId: new Fr(BigInt(info.l1ChainId)),
  });
  // The epoch's 32 partial roots, a few reads at a time (never 32 requests at once).
  const roots = {
    getRoots: (epoch: bigint | number) =>
      inChunks(32, 4, async (i) => Fr.fromHexString(await l1.readContract({ address: outbox, abi: OUTBOX_ABI, functionName: "getRootData", args: [BigInt(epoch), BigInt(i + 1)] }))),
  };
  const w = await computeL2ToL1MembershipWitness(node, roots, msg, receipt);
  if (!w) return { mined: true };
  const proof: OutboxProof = {
    epoch: BigInt(w.epochNumber), numCheckpointsInEpoch: BigInt(w.numCheckpointsInEpoch), leafIndex: w.leafIndex,
    path: w.siblingPath.toBufferArray().map((b) => toHex(b)),
  };
  proofs.set(x.commitment, { proof, outbox });
  const paid = await l1.readContract({ address: outbox, abi: OUTBOX_ABI, functionName: "hasMessageBeenConsumedAtEpoch", args: [proof.epoch, leafIdOf(proof)] });
  return { mined: true, proven: true, paid, proof };
}

const leafIdOf = (p: OutboxProof) => (1n << BigInt(p.path.length)) + p.leafIndex;

/** Proofs found this session, by exit commitment. */
const proofs = new Map<string, { proof: OutboxProof; outbox: Hex }>();

/** One Aztec node client per node URL for these reads, and its info (read once). */
const nodes = new Map<string, Promise<{ node: import("@aztec-labs/aztec.js/node").AztecNode; info: Awaited<ReturnType<import("@aztec-labs/aztec.js/node").AztecNode["getNodeInfo"]>> }>>();
function aztecNodeOf(dep: Deployment) {
  let p = nodes.get(dep.aztec.node);
  if (!p) {
    p = (async () => {
      const { createAztecNodeClient } = await import("@aztec-labs/aztec.js/node");
      const node = createAztecNodeClient(dep.aztec.node, { maxBatchSize: 3 }); // public testnet nodes refuse larger batches
      return { node, info: await node.getNodeInfo() };
    })();
    p.catch(() => nodes.delete(dep.aztec.node));
    nodes.set(dep.aztec.node, p);
  }
  return p;
}

const ROLLUP_CLOCK_ABI = parseAbi([
  "function getCurrentSlot() view returns (uint256)",
  "function getEpochDuration() view returns (uint256)",
  "function getSlotDuration() view returns (uint256)",
]);
const clockShapes = new Map<string, Promise<{ rollup: Hex; epochSlots: number; slotSeconds: number }>>();

/**
 * Where Aztec is in its epoch, read from the rollup on L1, as the finisher reads it
 * (finisher/src/exits.ts `readAztecClock`, ADR 0017 item 1): for the bridge's time estimates
 * (src/lib/eta.ts). The epoch's shape is read once; each call reads the current slot.
 */
export async function readAztecClock(dep: Deployment): Promise<AztecClock> {
  const l1 = l1Of(dep);
  let shape = clockShapes.get(dep.aztec.node);
  if (!shape) {
    shape = (async () => {
      const { info } = await aztecNodeOf(dep);
      const rollup = info.l1ContractAddresses.rollupAddress.toString() as Hex;
      const [e, s] = await Promise.all([
        l1.readContract({ address: rollup, abi: ROLLUP_CLOCK_ABI, functionName: "getEpochDuration" }),
        l1.readContract({ address: rollup, abi: ROLLUP_CLOCK_ABI, functionName: "getSlotDuration" }),
      ]);
      return { rollup, epochSlots: Number(e), slotSeconds: Number(s) };
    })();
    shape.catch(() => clockShapes.delete(dep.aztec.node));
    clockShapes.set(dep.aztec.node, shape);
  }
  const { rollup, epochSlots, slotSeconds } = await shape;
  const slot = await l1.readContract({ address: rollup, abi: ROLLUP_CLOCK_ABI, functionName: "getCurrentSlot" });
  return { slot, epochSlots, slotSeconds, at: Date.now() };
}

/** The Ethereum wallet in this browser (EIP-1193), if there is one. */
export function injectedEthereum(): EIP1193Provider | undefined {
  return typeof window !== "undefined" ? (window as unknown as { ethereum?: EIP1193Provider }).ethereum : undefined;
}

/** claimToEthereum from the browser's Ethereum wallet: it pays the gas; the USDC goes to the committed recipient. */
export async function claimOnEthereum(dep: Deployment, seed: Uint8Array, x: StoredExit, proof: OutboxProof): Promise<string> {
  const provider = injectedEthereum();
  if (!provider) throw new Error("No Ethereum wallet in this browser.");
  const wallet = createWalletClient({ transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("The Ethereum wallet shared no account.");
  const chainId = await wallet.getChainId();
  if (chainId !== dep.l1.chainId) {
    try {
      await wallet.switchChain({ id: dep.l1.chainId });
    } catch {
      throw new Error(`Switch your Ethereum wallet to chain ${dep.l1.chainId}, then try again.`);
    }
  }
  const secret = await deriveEthereumExitSecret(seed, x.index);
  const hash = await wallet.writeContract({
    account, chain: null, address: dep.l1.portal as Hex, abi: PORTAL_ABI, functionName: "claimToEthereum",
    args: [BigInt(x.denomination), x.destination as Hex, toHex(secret, { size: 32 }), proof],
  });
  const receipt = await l1Of(dep).waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The claim reverted on Ethereum. Nothing was paid.");
  return hash;
}
