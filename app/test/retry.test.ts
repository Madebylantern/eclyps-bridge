/**
 * Reorgs and lagging nodes (src/lib/retry.ts): which errors the wallet retries after a resync, and
 * how. Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isBrokenStoreError, isTransientChainError, withRetry } from "../src/lib/retry.ts";

describe("isTransientChainError", () => {
  it("matches what public testnet nodes said in a reorg or while lagging", () => {
    for (const m of [
      "Invalid tx: Block header not found",
      "Error: Invalid tx: Block header not found",
      "Block 41823 not found",
      "Block header for block number 12 and hash 0xabc not found during chain prune.",
      "Pruning data after block 41820 due to reorg",
      "Invalid tx: Incorrect archive root",
    ]) {
      assert.equal(isTransientChainError(new Error(m)), true, m);
    }
  });

  it("looks into causes", () => {
    assert.equal(isTransientChainError(new Error("Claim failed", { cause: new Error("Invalid tx: Block header not found") })), true);
  });

  it("leaves real failures alone", () => {
    for (const m of [
      "Already claimed, maybe from another device. It is in your balance.",
      "Invalid tx: Existing nullifier",
      "contract 0x1234 not found on the Aztec node",
      "Assertion failed: Balance too low",
      "Failed to fetch",
      "Transaction 0xabc was dropped",
    ]) {
      assert.equal(isTransientChainError(new Error(m)), false, m);
    }
  });
});

describe("isBrokenStoreError", () => {
  it("recognises a broken in-page store", () => {
    assert.equal(isBrokenStoreError(new Error("SQLITE_ERROR: sqlite3 result code 1: no such table: data")), true);
    assert.equal(isBrokenStoreError(new Error("SQLite store closed")), true);
    assert.equal(isBrokenStoreError(new Error("SQLite worker has crashed")), true);
    assert.equal(isBrokenStoreError(new Error("Invalid tx: Block header not found")), false);
  });
});

describe("withRetry", () => {
  it("retries a reorg after a resync, with waits that double", async () => {
    const waits: number[] = [];
    const resyncs: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("Invalid tx: Block header not found");
        return "0xtx";
      },
      { sleep: async (ms) => void waits.push(ms), onRetry: (n) => void resyncs.push(n) },
    );
    assert.equal(out, "0xtx");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2_000, 4_000]);
    assert.deepEqual(resyncs, [2, 3]);
  });

  it("gives up after the last try with the node's error", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("Invalid tx: Block header not found");
        },
        { attempts: 4, sleep: async () => undefined },
      ),
      /Block header not found/,
    );
    assert.equal(calls, 4);
  });

  it("does not retry other errors (a burn or claim is never sent twice)", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("Invalid tx: Existing nullifier");
        },
        { sleep: async () => undefined },
      ),
      /Existing nullifier/,
    );
    assert.equal(calls, 1);
  });
});
