/**
 * Restoring notes from a seed (ADR 0010). Every note derives from (seed, index), and every
 * deposited commitment sits in a public epoch account, so a restored seed finds its notes by
 * deriving index after index and looking each commitment up in the epochs' leaves.
 *
 * This also guards against reusing a note index. The gateway rejects a commitment already in the
 * same epoch, but it cannot see other epochs; a second deposit of an old commitment would be
 * unclaimable (the claim nullifier depends only on the note's keys) and would publicly link both
 * deposits. Clients check `findCommitment` before every deposit.
 */
import type { EpochAccount } from "./gateway.js";
import { deriveNote } from "./notes.js";

export type EpochLeaves = Pick<EpochAccount, "denominationIndex" | "epochId" | "leaves">;

export interface LeafLocation {
  denominationIndex: number;
  epochId: bigint;
  leafIndex: number;
}

export interface RecoveredNote extends LeafLocation {
  index: number;
  commitment: bigint;
}

function indexLeaves(epochs: EpochLeaves[]): Map<bigint, LeafLocation> {
  const at = new Map<bigint, LeafLocation>();
  for (const e of epochs) {
    e.leaves.forEach((leaf, leafIndex) => {
      if (!at.has(leaf)) at.set(leaf, { denominationIndex: e.denominationIndex, epochId: e.epochId, leafIndex });
    });
  }
  return at;
}

/** Where a commitment was deposited, if anywhere in `epochs`. */
export function findCommitment(epochs: EpochLeaves[], commitment: bigint): LeafLocation | undefined {
  for (const e of epochs) {
    const leafIndex = e.leaves.indexOf(commitment);
    if (leafIndex >= 0) return { denominationIndex: e.denominationIndex, epochId: e.epochId, leafIndex };
  }
  return undefined;
}

/**
 * Notes deposited from `seed`, found in public epoch leaves. Scanning stops after `gapLimit`
 * consecutive indices with no deposit; a plan can reserve up to 32 notes that are never
 * deposited, so the default leaves room for two such plans in a row. `nextIndex` is the first
 * index after the last one found: new notes start there.
 */
export async function recoverNotes(
  seed: Uint8Array,
  epochs: EpochLeaves[],
  opts: { gapLimit?: number; maxIndex?: number } = {},
): Promise<{ found: RecoveredNote[]; nextIndex: number }> {
  const gapLimit = opts.gapLimit ?? 64;
  const maxIndex = opts.maxIndex ?? 100_000;
  const at = indexLeaves(epochs);
  const found: RecoveredNote[] = [];
  let gap = 0;
  for (let index = 0; index < maxIndex && gap < gapLimit; index++) {
    const { commitment } = await deriveNote(seed, index);
    const loc = at.get(commitment);
    if (loc) {
      found.push({ index, commitment, ...loc });
      gap = 0;
    } else {
      gap++;
    }
  }
  const last = found.at(-1);
  return { found, nextIndex: last ? last.index + 1 : 0 };
}
