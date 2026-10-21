/**
 * Amounts with fees (ADR 0012): a $100 note costs $100.50, and $1 notes on testnet pay $0.005.
 * Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pct, usdExact } from "../src/lib/deployment.ts";

describe("usdExact", () => {
  it("shows whole dollars plainly and cents when there are any", () => {
    assert.equal(usdExact(100_000_000n), "$100");
    assert.equal(usdExact(100_500_000n), "$100.50");
    assert.equal(usdExact(6_550_000n), "$6.55");
    assert.equal(usdExact("1310000000"), "$1,310");
  });
  it("keeps every base unit, never rounding a fee away", () => {
    assert.equal(usdExact(5_000n), "$0.005");
    assert.equal(usdExact(6_172n), "$0.006172");
    assert.equal(usdExact(0n), "$0");
  });
});

describe("pct", () => {
  it("turns basis points into a percentage", () => {
    assert.equal(pct(50), "0.5%");
    assert.equal(pct(30), "0.3%");
    assert.equal(pct(20), "0.2%");
  });
});
