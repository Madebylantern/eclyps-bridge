import { describe, expect, it } from "vitest";
import { deriveNote, seedFromHex } from "../src/notes.js";
import { findCommitment, recoverNotes } from "../src/recovery.js";

const seed = seedFromHex("42".repeat(32));
const other = seedFromHex("43".repeat(32));

async function commitments(s: Uint8Array, indices: number[]) {
  return Promise.all(indices.map(async (i) => (await deriveNote(s, i)).commitment));
}

describe("note recovery", () => {
  it("finds deposited notes across epochs, skipping undeposited indices", async () => {
    const [c0, c2, c5] = await commitments(seed, [0, 2, 5]);
    const [x0, x1] = await commitments(other, [0, 1]);
    const epochs = [
      { denominationIndex: 0, epochId: 0n, leaves: [x0!, c0!] },
      { denominationIndex: 1, epochId: 4n, leaves: [c2!, x1!] },
      { denominationIndex: 0, epochId: 1n, leaves: [c5!] },
    ];
    const { found, nextIndex } = await recoverNotes(seed, epochs);
    expect(found.map((f) => [f.index, f.denominationIndex, f.epochId, f.leafIndex])).toEqual([
      [0, 0, 0n, 1],
      [2, 1, 4n, 0],
      [5, 0, 1n, 0],
    ]);
    expect(nextIndex).toBe(6);
  });

  it("starts at 0 for a seed that never deposited, and honours the gap limit", async () => {
    expect((await recoverNotes(seed, [])).nextIndex).toBe(0);
    const [c10] = await commitments(seed, [10]);
    const epochs = [{ denominationIndex: 0, epochId: 0n, leaves: [c10!] }];
    expect((await recoverNotes(seed, epochs, { gapLimit: 5 })).found).toEqual([]);
    expect((await recoverNotes(seed, epochs, { gapLimit: 11 })).nextIndex).toBe(11);
  });

  it("locates a commitment for the duplicate-deposit guard", async () => {
    const [c3] = await commitments(seed, [3]);
    const epochs = [{ denominationIndex: 2, epochId: 9n, leaves: [1n, 2n, c3!] }];
    expect(findCommitment(epochs, c3!)).toEqual({ denominationIndex: 2, epochId: 9n, leafIndex: 2 });
    expect(findCommitment(epochs, 99n)).toBeUndefined();
  });
});
