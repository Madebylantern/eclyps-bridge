/**
 * Exits. To Solana (ADR 0009) below; to Ethereum (ADR 0014 §4) at the end of the file.
 *
 * Exit (Aztec → Solana) destination commitments, ADR 0009.
 *
 * An exit burns one private note on Aztec and publishes only a commitment to where the USDC should
 * go on Solana. The destination is revealed when `claim_exit` pays it on Solana, never on Aztec.
 * A Solana address is 32 bytes, wider than a BN254 field element, so it enters as two 128-bit halves:
 *   exitSecret = Poseidon(s0, 3, index)                  (seed-derived, like notes; s0 = seedField)
 *   leaf       = Poseidon(dest_hi, dest_lo, exitSecret)  (circom Poseidon, 3 inputs)
 * Exit trees use the batch tree's node hash and depth (hashPair, depth 8), so Solana verifies them
 * with the same `sol_poseidon` syscall code as deposit batches.
 */
import { type Address, getAddressEncoder } from "@solana/kit";
import { poseidon3 } from "poseidon-lite";
import { assertField, BATCH_TREE_DEPTH, path, root } from "./merkle.js";
import { seedField } from "./notes.js";

const LOW_128 = (1n << 128n) - 1n;

/**
 * Exit epochs of every `EclypsClaim` the deploy scripts create (constructor arguments, fixed for
 * the contract's life). 13 blocks is about 15 minutes on the Aztec testnet (72 s blocks, read
 * 2026-10-13), like the gateway's 2,250-slot epochs; fewer than 4 exits roll over, like its minimum
 * batch.
 */
export const EXIT_EPOCH_BLOCKS = 13;
export const MIN_EXIT_BATCH = 4;

/** The two 128-bit halves (big-endian) of a 32-byte Solana address. */
export function destinationFields(destination: Address): [bigint, bigint] {
  const bytes = new Uint8Array(getAddressEncoder().encode(destination));
  const n = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return [n >> 128n, n & LOW_128];
}

export async function deriveExitSecret(seed: Uint8Array, index: number): Promise<bigint> {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("index");
  return poseidon3([await seedField(seed), 3n, BigInt(index)]);
}

export function exitCommitment(destination: Address, secret: bigint): bigint {
  const [hi, lo] = destinationFields(destination);
  return poseidon3([hi, lo, assertField(secret)]);
}

export interface ExitIntent {
  index: number;
  destination: Address;
  secret: bigint;
  commitment: bigint;
}

export async function deriveExit(seed: Uint8Array, index: number, destination: Address): Promise<ExitIntent> {
  const secret = await deriveExitSecret(seed, index);
  return { index, destination, secret, commitment: exitCommitment(destination, secret) };
}

export interface ExitClaimInputs {
  leafIndex: number;
  leaf: bigint;
  /** Sibling path, bottom-up (depth 8), for `claimExitIx`. */
  path: bigint[];
  /** The root it proves; must equal the ExitBatch's root. */
  root: bigint;
}

/**
 * Where an exit sits in its batch and its proof. `leaves` are the batch's exit commitments in
 * order, as the Aztec exit epoch appended them (public). Throws if the exit is not in the batch.
 */
export function exitClaimInputs(leaves: bigint[], destination: Address, secret: bigint): ExitClaimInputs {
  const leaf = exitCommitment(destination, secret);
  const leafIndex = leaves.indexOf(leaf);
  if (leafIndex < 0) throw new Error("this exit is not in the batch");
  return { leafIndex, leaf, path: path(leaves, leafIndex, BATCH_TREE_DEPTH), root: root(leaves, BATCH_TREE_DEPTH) };
}

/** sha256ToField over 32-byte big-endian words, as Aztec contents are made: 0x00 then the first 31
 * bytes of sha256. Solidity `AztecHash.sha256ToField(abi.encode(...))`, Noir `sha256_to_field`. */
async function sha256ToFieldOfWords(words: bigint[]): Promise<bigint> {
  const bytes = new Uint8Array(32 * words.length);
  words.forEach((w, i) => {
    if (w < 0n || w >= 1n << 256n) throw new RangeError("word");
    for (let j = 31; j >= 0; j--, w >>= 8n) bytes[32 * i + j] = Number(w & 0xffn);
  });
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return h.subarray(0, 31).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/**
 * The L2→L1 content a closed exit epoch sends to the portal (ADR 0009):
 * sha256ToField(abi.encode(root, count, exitEpochId, denomination)), = `EclypsPortal.exitContent`
 * and `exit_content` in aztec/claim.
 */
export async function exitBatchContent(root: bigint, count: number, exitEpochId: bigint, denomination: bigint): Promise<bigint> {
  if (!Number.isInteger(count) || count < 1 || count > 256) throw new RangeError("count");
  return sha256ToFieldOfWords([assertField(root), BigInt(count), exitEpochId, denomination]);
}

// ---------- leave to Ethereum (ADR 0014 §4) ----------

/** "eclyps:exit-to-ethereum" as a big-endian integer: the first word of an Ethereum exit's content,
 * so it is never another message kind's content (`EclypsPortal.ETHEREUM_EXIT_TAG`). */
export const ETHEREUM_EXIT_TAG = BigInt(
  "0x" + Array.from(new TextEncoder().encode("eclyps:exit-to-ethereum"), (b) => b.toString(16).padStart(2, "0")).join(""),
);

/**
 * Seed-derived secret of the index-th exit to Ethereum: Poseidon(s0, 4, index). Domain 4 is its own
 * index space, apart from notes (1, 2) and Solana exits (3): the same index never gives the same
 * secret on both routes, so a secret revealed on one never links to the other. With the seed and
 * the recipient, a restored wallet finds its pending exits again.
 */
export async function deriveEthereumExitSecret(seed: Uint8Array, index: number): Promise<bigint> {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("index");
  return poseidon3([await seedField(seed), 4n, BigInt(index)]);
}

function addressWord(recipient: string): bigint {
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) throw new Error("recipient must be a 20-byte hex address");
  const n = BigInt(recipient);
  if (n === 0n) throw new Error("recipient must not be the zero address");
  return n;
}

/**
 * What `exit_to_ethereum` burns with on Aztec: sha256ToField(abi.encode(recipient, exitSecret)), =
 * `EclypsPortal.ethereumExitCommitment`. Truncated to 31 bytes so it fits an Aztec field.
 */
export async function ethereumExitCommitment(recipient: string, exitSecret: bigint): Promise<bigint> {
  return sha256ToFieldOfWords([addressWord(recipient), assertField(exitSecret)]);
}

/** The L2→L1 content of one exit to Ethereum: sha256ToField(abi.encode(ETHEREUM_EXIT_TAG,
 * commitment, denomination)), = `EclypsPortal.ethereumExitContent` and `ethereum_exit_content`. */
export async function ethereumExitContent(commitment: bigint, denomination: bigint): Promise<bigint> {
  return sha256ToFieldOfWords([ETHEREUM_EXIT_TAG, assertField(commitment), denomination]);
}

export interface EthereumExitIntent {
  index: number;
  recipient: string;
  secret: bigint;
  commitment: bigint;
}

/** Everything an exit to Ethereum needs: `commitment` goes to `exit_to_ethereum`, and
 * `(recipient, secret)` to `claimToEthereum` once the Aztec epoch is proven. */
export async function deriveEthereumExit(seed: Uint8Array, index: number, recipient: string): Promise<EthereumExitIntent> {
  const secret = await deriveEthereumExitSecret(seed, index);
  return { index, recipient, secret, commitment: await ethereumExitCommitment(recipient, secret) };
}
