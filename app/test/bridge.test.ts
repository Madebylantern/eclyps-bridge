/**
 * The bridge screen (ADR 0014): the line under the amount (fixed notes and the fee on top, ADR
 * 0012), the amount parser and the destinations. Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitAmount } from "../../sdk/src/advisor.ts";
import { destinations, parseEthAddress } from "../src/lib/bridge.ts";
import { bridgeLine, parseUsd, splitLine } from "../src/lib/deployment.ts";

const $ = (n: number) => BigInt(Math.round(n * 1e6));
const DENOMS = [$(10), $(100), $(1000)];
const feeOf = (notes: bigint[], bps = 50) => notes.reduce((a, d) => a + (d * BigInt(bps)) / 10_000n, 0n);

describe("parseUsd", () => {
  it("reads plain, dollar and grouped amounts to the base unit", () => {
    assert.equal(parseUsd("100"), $(100));
    assert.equal(parseUsd("$1,310.5"), 1_310_500_000n);
    assert.equal(parseUsd(" 0.000001 "), 1n);
  });
  it("refuses what is not an amount", () => {
    assert.equal(parseUsd(""), undefined);
    assert.equal(parseUsd("abc"), undefined);
    assert.equal(parseUsd("1.0000001"), undefined);
    assert.equal(parseUsd("-5"), undefined);
  });
});

describe("bridgeLine", () => {
  it("shows one note and its fee: 1 × $100 · fee $0.50", () => {
    const split = splitAmount($(100), DENOMS);
    assert.deepEqual(bridgeLine(split, feeOf(split.notes), $(10)), { text: "1 × $100 · fee $0.50" });
  });
  it("counts each size, largest first, with the summed fee", () => {
    const split = splitAmount($(1310), DENOMS);
    assert.equal(splitLine(split.notes), "1 × $1,000 · 3 × $100 · 1 × $10");
    assert.deepEqual(bridgeLine(split, feeOf(split.notes), $(10)), { text: "1 × $1,000 · 3 × $100 · 1 × $10 · fee $6.55" });
  });
  it("says plainly what does not fit a note", () => {
    const split = splitAmount($(125.5), DENOMS);
    assert.deepEqual(bridgeLine(split, feeOf(split.notes), $(10)), { text: "1 × $100 · 2 × $10 · fee $0.60", rest: "$5.50 stays in your wallet" });
  });
  it("asks for the smallest note when nothing fits", () => {
    assert.deepEqual(bridgeLine(splitAmount($(7), DENOMS), 0n, $(10)), { text: "Enter at least $10." });
  });
  it("leaves the fee out while it is unknown or zero", () => {
    const split = splitAmount($(100), DENOMS);
    assert.equal(bridgeLine(split, undefined, $(10)).text, "1 × $100");
    assert.equal(bridgeLine(split, 0n, $(10)).text, "1 × $100");
  });
});

describe("destinations", () => {
  it("offers only the private balance unless the exit to Ethereum is on", () => {
    assert.deepEqual(destinations({}), ["aztec"]);
    assert.deepEqual(destinations({ features: { exit: true } }), ["aztec"]);
    assert.deepEqual(destinations({ features: { exitEthereum: false } }), ["aztec"]);
    assert.deepEqual(destinations({ features: { exitEthereum: true } }), ["aztec", "ethereum"]);
  });
});

describe("parseEthAddress", () => {
  it("takes 20 bytes of hex after 0x", () => {
    assert.equal(parseEthAddress(" 0x52908400098527886E0F7030069857D2E4169EE7 "), "0x52908400098527886E0F7030069857D2E4169EE7");
  });
  it("refuses other shapes and the zero address", () => {
    assert.equal(parseEthAddress("52908400098527886E0F7030069857D2E4169EE7"), undefined);
    assert.equal(parseEthAddress("0x1234"), undefined);
    assert.equal(parseEthAddress(`0x${"0".repeat(40)}`), undefined);
    assert.equal(parseEthAddress("4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf"), undefined);
  });
});
