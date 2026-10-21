import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildPoseidon } from "circomlibjs";
import {
  BATCH_TREE_DEPTH,
  BN254_R,
  commitment,
  fromBytes32,
  hashPair,
  path,
  root,
  rootFromPath,
  toBytes32,
  zeroHashes,
} from "../src/merkle.js";

const v = JSON.parse(
  readFileSync(new URL("../../circuits/vectors/merkle.json", import.meta.url), "utf8"),
);
const big = (s: string) => BigInt(s);

describe("shared vectors (circuits/vectors/merkle.json)", () => {
  it("pair hashes", () => {
    for (const p of v.pairs) expect(hashPair(big(p.a), big(p.b))).toBe(big(p.out));
  });

  it("commitments, roots, zero hashes and paths", () => {
    const leaves = v.notes.map((n: any) => {
      const c = commitment(big(n.nullifier_key), big(n.secret));
      expect(c).toBe(big(n.commitment));
      return c;
    });
    expect(leaves).toHaveLength(16);
    expect(root(leaves, 4)).toBe(big(v.root_depth4_16_leaves));
    expect(v.batch_depth).toBe(BATCH_TREE_DEPTH);
    expect(root(leaves)).toBe(big(v.root_batch_depth_16_leaves));
    expect(root(leaves.slice(0, 11))).toBe(big(v.root_batch_depth_first_11_leaves));
    expect(zeroHashes(BATCH_TREE_DEPTH)).toEqual(v.zero_hashes.map(big));
    for (const p of v.paths_batch_depth) {
      expect(path(leaves, p.index)).toEqual(p.siblings.map(big));
      expect(rootFromPath(leaves[p.index], p.index, p.siblings.map(big))).toBe(
        big(v.root_batch_depth_16_leaves),
      );
    }
  });
});

describe("independent implementation (circomlibjs)", () => {
  it("agrees with poseidon-lite on every vector pair and commitment", async () => {
    const poseidon = await buildPoseidon();
    const h = (a: bigint, b: bigint) => poseidon.F.toObject(poseidon([a, b])) as bigint;
    for (const p of v.pairs) expect(h(big(p.a), big(p.b))).toBe(big(p.out));
    for (const n of v.notes) expect(h(big(n.nullifier_key), big(n.secret))).toBe(big(n.commitment));
  });
});

describe("encoding", () => {
  it("round-trips 32-byte big-endian and rejects non-canonical values", () => {
    const x = big(v.root_batch_depth_16_leaves);
    expect(fromBytes32(toBytes32(x))).toBe(x);
    expect(() => hashPair(BN254_R, 1n)).toThrow(RangeError);
    expect(() => fromBytes32(new Uint8Array(32).fill(0xff))).toThrow(RangeError);
  });
});
