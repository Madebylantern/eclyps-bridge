/**
 * Seed-derived notes (SPEC §4.5: keys come from a seed, never from a signed message).
 * Every note's (nullifier_key, secret) is derived from one 32-byte seed and a note index, so a
 * backed-up seed restores all notes: rescan public epoch leaves for the derived commitments.
 * Phase 0 derivation (to be reviewed before Phase 1):
 *   s0           = sha256(seed) mod r
 *   nullifierKey = Poseidon(s0, 1, index)
 *   secret       = Poseidon(s0, 2, index)
 *   commitment   = Poseidon(nullifierKey, secret)          (ADR 0004)
 */
import { poseidon3 } from "poseidon-lite";
import { BN254_R, commitment, toBytes32 } from "./merkle.js";

export interface Note {
  index: number;
  nullifierKey: bigint;
  secret: bigint;
  commitment: bigint;
}

export function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** s0 = sha256(seed) mod r: the root scalar every seed-derived secret starts from. */
export async function seedField(seed: Uint8Array): Promise<bigint> {
  if (seed.length !== 32) throw new RangeError("seed must be 32 bytes");
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(seed)));
  return h.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n) % BN254_R;
}

export async function deriveNote(seed: Uint8Array, index: number): Promise<Note> {
  if (!Number.isInteger(index) || index < 0) throw new RangeError("index");
  const s0 = await seedField(seed);
  const nullifierKey = poseidon3([s0, 1n, BigInt(index)]);
  const secret = poseidon3([s0, 2n, BigInt(index)]);
  return { index, nullifierKey, secret, commitment: commitment(nullifierKey, secret) };
}

export const commitmentBytes = (n: Note) => toBytes32(n.commitment);

export const seedToHex = (seed: Uint8Array) =>
  Array.from(seed, (b) => b.toString(16).padStart(2, "0")).join("");

export function seedFromHex(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("seed must be 64 hex characters");
  return Uint8Array.from({ length: 32 }, (_, i) => parseInt(h.slice(2 * i, 2 * i + 2), 16));
}
