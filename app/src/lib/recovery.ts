/**
 * Finding this seed's notes on chain (SDK recovery.ts, ADR 0010).
 *
 * - After a restore from the phrase, the vault has no note book. `scanForNotes` reads every epoch,
 *   derives note after note and rebuilds the book from the commitments it finds, then moves the
 *   next note index past them. Without this, the next deposit would reuse an index whose
 *   commitment is already on chain: unclaimable, and publicly linked to the first deposit.
 * - Before every deposit, `claimFreshIndex` checks the note's commitment against every known
 *   epoch. If it is already there, that deposit is recorded as a recovered note and the planned
 *   note moves to the next unused index. An index is never deposited twice.
 */
import { deriveNote, type EpochAccount, findCommitment, type LeafLocation, recoverNotes, toHex } from "@eclyps/sdk";
import type { Deployment } from "./deployment";
import { type ChainCache, knownEpochs, syncChain } from "./portfolio";
import { RECOVERED, type StoredNote, type Vault, type VaultData } from "./vault";

function foundNote(dep: Deployment, epochs: EpochAccount[], index: number, commitment: bigint, loc: LeafLocation): StoredNote {
  const epoch = epochs.find((e) => e.denominationIndex === loc.denominationIndex && e.epochId === loc.epochId);
  return {
    index,
    denominationIndex: loc.denominationIndex,
    denomination: dep.denominations[loc.denominationIndex] ?? String(epoch?.denomination ?? 0n),
    commitment: toHex(commitment),
    planId: RECOVERED,
    recovered: true,
    epochId: loc.epochId.toString(),
    leafIndex: loc.leafIndex,
    depositWallet: epoch?.depositors[loc.leafIndex],
  };
}

const nextFree = (d: VaultData) => Math.max(d.nextNote, ...d.notes.map((n) => n.index + 1));

function addRecovered(d: VaultData, notes: StoredNote[]): number {
  let added = 0;
  for (const r of notes) {
    const existing = d.notes.find((n) => n.index === r.index);
    if (existing) {
      // Known index: fill in what the chain says, without overwriting what this vault recorded.
      if (existing.epochId === undefined) {
        Object.assign(existing, { ...r, planId: existing.planId, scheduledAt: undefined });
      } else if (existing.leafIndex === undefined) {
        existing.leafIndex = r.leafIndex;
      }
      continue;
    }
    d.notes.push(r);
    added++;
  }
  if (added) d.transfers[RECOVERED] ??= { kind: "recovered", createdAt: Date.now() };
  return added;
}

/** Rescans public epoch leaves for this seed's commitments and rebuilds the note book from them. */
export async function scanForNotes(dep: Deployment, vault: Vault, cache: ChainCache): Promise<{ found: number; added: number }> {
  await syncChain(dep, cache);
  const epochs = knownEpochs(cache);
  const { found, nextIndex } = await recoverNotes(vault.seed, epochs);
  let added = 0;
  await vault.update((d) => {
    added = addRecovered(d, found.map((f) => foundNote(dep, epochs, f.index, f.commitment, f)));
    d.nextNote = Math.max(nextFree(d), nextIndex);
    d.rescan = { pending: false, at: Date.now(), found: found.length };
  });
  return { found: found.length, added };
}

/**
 * Makes sure stored note `index` has never been deposited (checked against `cache`, which the
 * caller has just synced). Returns the index to deposit: the same one, or a fresh one the planned
 * note was moved to.
 */
export async function claimFreshIndex(dep: Deployment, vault: Vault, cache: ChainCache, index: number): Promise<{ index: number; movedFrom?: number }> {
  const epochs = knownEpochs(cache);
  const stored = vault.data.notes.find((n) => n.index === index);
  if (!stored) throw new Error(`Note #${index} is not in this vault.`);
  const first = findCommitment(epochs, BigInt(stored.commitment));
  if (!first) return { index };

  const seen = [foundNote(dep, epochs, index, BigInt(stored.commitment), first)];
  let fresh = nextFree(vault.data);
  let commitment: bigint | undefined;
  for (let tries = 0; tries < 256; tries++, fresh++) {
    const n = await deriveNote(vault.seed, fresh);
    const loc = findCommitment(epochs, n.commitment);
    if (!loc) {
      commitment = n.commitment;
      break;
    }
    seen.push(foundNote(dep, epochs, fresh, n.commitment, loc));
  }
  if (commitment === undefined) throw new Error("Couldn't find an unused note index. Scan the chain for your notes in Vault & keys, then try again.");

  await vault.update((d) => {
    const s = d.notes.find((n) => n.index === index)!;
    s.index = fresh;
    s.commitment = toHex(commitment);
    addRecovered(d, seen);
    d.nextNote = Math.max(nextFree(d), fresh + 1);
  });
  return { index: fresh, movedFrom: index };
}
