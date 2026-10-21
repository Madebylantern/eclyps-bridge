import { describe, expect, it } from "vitest";
import {
  backupChallenge,
  checkBackupWords,
  isValidMnemonic,
  mnemonicToSeed,
  parseSeedInput,
  seedToMnemonic,
} from "../src/mnemonic.js";
import { seedToHex } from "../src/notes.js";

describe("recovery phrase", () => {
  it("encodes the seed itself as BIP-39 entropy (standard vector)", () => {
    const zero = new Uint8Array(32);
    expect(seedToMnemonic(zero)).toBe(`${"abandon ".repeat(23)}art`);
    expect(mnemonicToSeed(`${"abandon ".repeat(23)}art`)).toEqual(zero);
  });

  it("round-trips and tolerates spacing and case", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const words = seedToMnemonic(seed);
    expect(words.split(" ")).toHaveLength(24);
    expect(mnemonicToSeed(`  ${words.toUpperCase().replaceAll(" ", "   ")}\n`)).toEqual(seed);
    expect(isValidMnemonic(words)).toBe(true);
  });

  it("rejects typos and wrong lengths with a readable error", () => {
    const words = seedToMnemonic(new Uint8Array(32).fill(3)).split(" ");
    const swapped = [...words];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(isValidMnemonic(swapped.join(" "))).toBe(words[0] === words[1]);
    expect(() => mnemonicToSeed(words.slice(0, 12).join(" "))).toThrow(/24 words/);
    expect(() => mnemonicToSeed([...words.slice(0, 23), "notaword"].join(" "))).toThrow(/typo/);
  });

  it("accepts older 64-hex backups", () => {
    const seed = new Uint8Array(32).fill(0xab);
    expect(parseSeedInput(seedToHex(seed))).toEqual(seed);
    expect(parseSeedInput(seedToMnemonic(seed))).toEqual(seed);
  });

  it("asks for distinct positions and checks the answers", () => {
    let i = 0;
    const seq = [0.0, 0.0, 0.5, 0.99];
    const pos = backupChallenge(3, () => seq[i++ % seq.length]!);
    expect(pos).toEqual([1, 13, 24]);
    const seed = Uint8Array.from({ length: 32 }, (_, k) => k);
    const words = seedToMnemonic(seed).split(" ");
    expect(checkBackupWords(seed, pos.map((p) => ({ position: p, word: ` ${words[p - 1]!.toUpperCase()} ` })))).toBe(true);
    expect(checkBackupWords(seed, [{ position: 1, word: words[1]! }])).toBe(words[0] === words[1]);
    expect(checkBackupWords(seed, [])).toBe(false);
  });
});
