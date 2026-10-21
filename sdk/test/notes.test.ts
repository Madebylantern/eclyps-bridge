import { describe, expect, it } from "vitest";
import { deriveNote, seedFromHex, seedToHex } from "../src/notes.js";
import { BN254_R, commitment } from "../src/merkle.js";

describe("seed-derived notes", () => {
  const seed = seedFromHex("11".repeat(32));

  it("is deterministic and index-separated", async () => {
    const a = await deriveNote(seed, 0);
    const b = await deriveNote(seed, 0);
    const c = await deriveNote(seed, 1);
    expect(a).toEqual(b);
    expect(c.commitment).not.toBe(a.commitment);
    expect(a.nullifierKey).not.toBe(a.secret);
    for (const x of [a.nullifierKey, a.secret, a.commitment]) expect(x < BN254_R).toBe(true);
    expect(a.commitment).toBe(commitment(a.nullifierKey, a.secret));
  });

  it("different seeds give unrelated notes", async () => {
    const other = await deriveNote(seedFromHex("12".repeat(32)), 0);
    expect(other.commitment).not.toBe((await deriveNote(seed, 0)).commitment);
  });

  it("hex round-trip", () => {
    expect(seedToHex(seedFromHex("ab".repeat(32)))).toBe("ab".repeat(32));
    expect(() => seedFromHex("zz")).toThrow();
  });

  // Known answers for seed 00 01 .. 1f. If these change, every note already deposited from an
  // existing seed becomes unrecoverable: a derivation change needs a new vault version (ADR 0010).
  it("matches the known-answer vectors", async () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const kat: [number, string, string, string][] = [
      [0, "0x17b8b2daabc266a2017fe7cceeea57768b46717a6baca7d7a464d01e0d7cbcc9", "0x2870bb3c264a4753a1c6c1cd714519d673bc2ad5d5315742fb03f4b1d9621a4f", "0x1dc08c4bbde8edf897594904d764c6f15d1be398a366734d0783386f8f436c8b"],
      [1, "0x21d3f35db8ad12718d1c607591aae7628537ccc5843528776b9768e4d5efd27c", "0x67e820d0f37a0ef67fa50174777a9761b5c707e92a6fbf366643a199ab6b02a", "0x2b3cf7bd1f728a30d97a073f14271ee864992488a11101e52335d9ce93f0f121"],
      [7, "0x2f86d29dcc12980ed3c4ce46cd6c186c59a7f6c83453ce3c2a9d79ba3d52166b", "0x8b9361f8b810978d1737394099b64affa4b862b65a641a576b00268614cda9a", "0x4a3a0e8f914ff1cfe1831bc28f845c44b458d40835a29c92f3d91250837d8f5"],
    ];
    for (const [index, nk, s, c] of kat) {
      const n = await deriveNote(seed, index);
      expect([n.nullifierKey, n.secret, n.commitment]).toEqual([BigInt(nk), BigInt(s), BigInt(c)]);
    }
  });
});
