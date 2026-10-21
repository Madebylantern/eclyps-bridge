/**
 * Recovery phrase for the vault seed (ADR 0010). The 32-byte seed *is* the BIP-39 entropy, so the
 * 24 words encode exactly the seed that notes, exit secrets and the Aztec account derive from
 * (notes.ts). This is not BIP-39's `mnemonicToSeed` (PBKDF2): no passphrase, no stretching, and
 * a seed backed up as 64 hex characters restores to the same notes as its 24 words.
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { seedFromHex } from "./notes.js";

export const MNEMONIC_WORDS = 24;

export function seedToMnemonic(seed: Uint8Array): string {
  if (seed.length !== 32) throw new RangeError("seed must be 32 bytes");
  return entropyToMnemonic(seed, wordlist);
}

const normalize = (phrase: string) => phrase.trim().toLowerCase().split(/\s+/).join(" ");

export function isValidMnemonic(phrase: string): boolean {
  const p = normalize(phrase);
  return p.split(" ").length === MNEMONIC_WORDS && validateMnemonic(p, wordlist);
}

export function mnemonicToSeed(phrase: string): Uint8Array {
  const p = normalize(phrase);
  if (p.split(" ").length !== MNEMONIC_WORDS) throw new Error(`a recovery phrase has ${MNEMONIC_WORDS} words`);
  if (!validateMnemonic(p, wordlist)) throw new Error("this recovery phrase has a typo: a word is misspelled or out of order");
  return mnemonicToEntropy(p, wordlist);
}

/** Accepts either a 24-word recovery phrase or the 64-hex-character seed (older backups). */
export function parseSeedInput(input: string): Uint8Array {
  const t = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return seedFromHex(t);
  return mnemonicToSeed(t);
}

/** `count` distinct 1-based word positions to ask for when checking a written backup. */
export function backupChallenge(count = 3, random: () => number = Math.random): number[] {
  const picks = new Set<number>();
  while (picks.size < Math.min(count, MNEMONIC_WORDS)) picks.add(1 + Math.floor(random() * MNEMONIC_WORDS));
  return [...picks].sort((a, b) => a - b);
}

/** True when every answered word matches the seed's phrase at its 1-based position. */
export function checkBackupWords(seed: Uint8Array, answers: { position: number; word: string }[]): boolean {
  const words = seedToMnemonic(seed).split(" ");
  return answers.length > 0 && answers.every((a) => words[a.position - 1] === a.word.trim().toLowerCase());
}
