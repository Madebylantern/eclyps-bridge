/**
 * Batch Merkle tree, identical to circuits/merkle-rs (Rust / Solana syscall) and
 * circuits/merkle-nr (Noir). Poseidon over BN254 with circom parameters; field
 * elements are bigint, serialised as 32-byte big-endian. See ADR 0004.
 */
import { poseidon1, poseidon2 } from "poseidon-lite";

export const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Per-batch tree depth (256 leaves). Must match BATCH_TREE_DEPTH in Rust and Noir. */
export const BATCH_TREE_DEPTH = 8;

export const ZERO_LEAF = 0n;

export function assertField(x: bigint): bigint {
  if (x < 0n || x >= BN254_R) throw new RangeError("not a canonical BN254 field element");
  return x;
}

/** Poseidon(a, b), circom parameters (poseidon-lite's `poseidon2` = 2 inputs, not Poseidon2). */
export function hashPair(a: bigint, b: bigint): bigint {
  return poseidon2([assertField(a), assertField(b)]);
}

/** Poseidon(x), 1 input. Exported for nullifier derivation experiments. */
export function hashOne(x: bigint): bigint {
  return poseidon1([assertField(x)]);
}

/** Leaf stored by the gateway: commitment = H(nullifierKey, secret). */
export function commitment(nullifierKey: bigint, secret: bigint): bigint {
  return hashPair(nullifierKey, secret);
}

export function zeroHashes(depth: number): bigint[] {
  const zeros = [ZERO_LEAF];
  for (let i = 0; i < depth; i++) zeros.push(hashPair(zeros[i]!, zeros[i]!));
  return zeros;
}

function levels(leaves: bigint[], depth: number): bigint[][] {
  if (leaves.length > 2 ** depth) throw new RangeError("too many leaves");
  const zeros = zeroHashes(depth);
  const out = [leaves.map(assertField)];
  for (let d = 0; d < depth; d++) {
    const cur = out[d]!;
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(hashPair(cur[i]!, cur[i + 1] ?? zeros[d]!));
    out.push(next);
  }
  return out;
}

export function root(leaves: bigint[], depth = BATCH_TREE_DEPTH): bigint {
  const ls = levels(leaves, depth);
  return ls[depth]![0] ?? zeroHashes(depth)[depth]!;
}

/** Sibling path for `index`, bottom-up; computed locally from public leaves. */
export function path(leaves: bigint[], index: number, depth = BATCH_TREE_DEPTH): bigint[] {
  if (index < 0 || index >= 2 ** depth) throw new RangeError("index out of range");
  const zeros = zeroHashes(depth);
  const ls = levels(leaves, depth);
  return Array.from({ length: depth }, (_, d) => ls[d]![(index >> d) ^ 1] ?? zeros[d]!);
}

export function rootFromPath(leaf: bigint, index: number, siblings: bigint[]): bigint {
  return siblings.reduce(
    (node, sib, d) => (((index >> d) & 1) === 0 ? hashPair(node, sib) : hashPair(sib, node)),
    leaf,
  );
}

export function toBytes32(x: bigint): Uint8Array {
  assertField(x);
  const out = new Uint8Array(32);
  for (let i = 31, v = x; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

export function fromBytes32(b: Uint8Array): bigint {
  if (b.length !== 32) throw new RangeError("expected 32 bytes");
  return assertField(b.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n));
}

export const toHex = (x: bigint): string => `0x${x.toString(16).padStart(64, "0")}`;
