/**
 * When the finisher sends close_exit_epoch (ADR 0017 item 1): at least two Aztec slots before an
 * Aztec epoch ends, so that an exit epoch's exits and its close are proven together, and never
 * just after a boundary. Pure rules from src/plan.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aztecEpochOf,
  CLOSE_MARGIN_SLOTS,
  CLOSE_WINDOW_SLOTS,
  type CloseTiming,
  exitCloseTiming,
  msToEpochEnd,
  slotsLeftInEpoch,
} from "../src/plan.js";

/** Mainnet and testnet shape: 32 slots of 72 s (read from the rollup, 2026-10-16). */
const E = 32;
const at = (epoch: number, slotInEpoch: number) => ({ slot: BigInt(epoch * E + slotInEpoch), epochSlots: E, slotSeconds: 72 });

/**
 * Plays the finisher's passes over a run of slots, keeping the held epoch as the record does, and
 * returns the slot at which it closes (or undefined).
 */
function closesAt(fromEpoch: number, fromSlot: number, passes: number): { epoch: number; slot: number } | undefined {
  let held: string | undefined;
  for (let k = 0; k < passes; k++) {
    const abs = fromEpoch * E + fromSlot + k;
    const c = { slot: BigInt(abs), epochSlots: E };
    const t: CloseTiming = exitCloseTiming(c, held);
    if (t.action === "close") return { epoch: Math.floor(abs / E), slot: abs % E };
    held = t.heldIn;
  }
  return undefined;
}

describe("Aztec clock", () => {
  it("counts epochs and the slots left in one", () => {
    assert.equal(aztecEpochOf(at(5, 0)), 5n);
    assert.equal(aztecEpochOf(at(5, 31)), 5n);
    assert.equal(aztecEpochOf(at(6, 0)), 6n);
    assert.equal(slotsLeftInEpoch(at(5, 0)), 32);
    assert.equal(slotsLeftInEpoch(at(5, 30)), 2);
    assert.equal(slotsLeftInEpoch(at(5, 31)), 1);
    assert.equal(msToEpochEnd(at(5, 30)), 2 * 72_000);
  });
});

describe("exitCloseTiming", () => {
  it("closes at once while at least two slots are left in the Aztec epoch", () => {
    assert.deepEqual(exitCloseTiming(at(7, 0)), { action: "close" });
    assert.deepEqual(exitCloseTiming(at(7, 17)), { action: "close" });
    assert.deepEqual(exitCloseTiming(at(7, E - CLOSE_MARGIN_SLOTS)), { action: "close" });
  });

  it("holds a close that could land just after the boundary", () => {
    const t = exitCloseTiming(at(7, E - 1));
    assert.equal(t.action, "hold");
    assert.equal(t.action === "hold" && t.heldIn, "7");
    assert.equal(t.action === "hold" && t.why, "epoch-ending");
    assert.equal(t.action === "hold" && t.slotsLeft, 1);
  });

  it("keeps holding until the boundary has passed", () => {
    assert.equal(exitCloseTiming(at(7, E - 1), "7").action, "hold");
  });

  it("after the boundary, waits for the end of the next epoch instead of closing just after it", () => {
    // First slots of the next epoch: no gain from closing now (proven at the epoch's end anyway).
    for (const s of [0, 1, 10, E - CLOSE_MARGIN_SLOTS - CLOSE_WINDOW_SLOTS - 1]) {
      const t = exitCloseTiming(at(8, s), "7");
      assert.equal(t.action, "hold", `slot ${s}`);
      assert.equal(t.action === "hold" && t.why, "window");
      assert.equal(t.action === "hold" && t.heldIn, "7");
    }
    // Its window: from margin + window slots left down to the margin.
    for (let s = E - CLOSE_MARGIN_SLOTS - CLOSE_WINDOW_SLOTS; s <= E - CLOSE_MARGIN_SLOTS; s++) {
      assert.deepEqual(exitCloseTiming(at(8, s), "7"), { action: "close" }, `slot ${s}`);
    }
  });

  it("a missed window holds again for the following epoch, never closing inside the margin", () => {
    const t = exitCloseTiming(at(8, E - 1), "7");
    assert.equal(t.action, "hold");
    assert.equal(t.action === "hold" && t.heldIn, "8");
    assert.equal(exitCloseTiming(at(9, 0), "8").action, "hold");
    assert.deepEqual(exitCloseTiming(at(9, E - CLOSE_MARGIN_SLOTS), "8"), { action: "close" });
  });

  it("a record held long ago closes in the current epoch's window", () => {
    assert.equal(exitCloseTiming(at(40, 3), "7").action, "hold");
    assert.deepEqual(exitCloseTiming(at(40, E - 3), "7"), { action: "close" });
  });

  it("over every possible starting slot, the close is sent with at least two slots left", () => {
    for (let s = 0; s < E; s++) {
      const r = closesAt(100, s, 3 * E);
      assert.ok(r, `due at slot ${s}: never closed`);
      assert.ok(E - r.slot >= CLOSE_MARGIN_SLOTS, `due at slot ${s}: closed at slot ${r.slot}`);
      if (E - s >= CLOSE_MARGIN_SLOTS) assert.deepEqual(r, { epoch: 100, slot: s }, "closes at once when it can make the epoch");
      else assert.equal(r.epoch, 101, "held exactly one epoch, closed before its end");
    }
  });

  it("honours other margins and epoch lengths (a local network's shape)", () => {
    const c = { slot: 46n, epochSlots: 16 }; // epoch 2, slot 14: 2 left
    assert.deepEqual(exitCloseTiming(c, undefined, 2), { action: "close" });
    assert.equal(exitCloseTiming(c, undefined, 3).action, "hold");
  });
});
