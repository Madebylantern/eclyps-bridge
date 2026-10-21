/**
 * Express batches in the finisher's record (ADR 0015): found from the Lanes counter, named apart
 * from normal batches, carried by the same relay and register stages, watermarked separately.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceDone,
  advanceExpressDone,
  batchKey,
  batchName,
  emptyState,
  epochsToCarry,
  EXPRESS_BIT,
  expressReward,
  expressToCarry,
  isExpress,
  stageOf,
} from "../src/plan.js";

describe("express batches", () => {
  it("are told apart by the top bit of the id", () => {
    assert.equal(isExpress(EXPRESS_BIT), true);
    assert.equal(isExpress((EXPRESS_BIT | 7n).toString()), true);
    assert.equal(isExpress(7n), false);
    assert.equal(batchName({ denomination: "1000000000", epochId: (EXPRESS_BIT | 3n).toString() }), "$1,000 express #3");
    assert.equal(batchName({ denomination: "1000000000", epochId: "3" }), "$1,000 #3");
  });

  it("are found from the watermark up to the Lanes counter", () => {
    const s = emptyState("Cfg", "0xabc");
    assert.deepEqual(expressToCarry(s, "100", 0n), []);
    assert.deepEqual(expressToCarry(s, "100", 2n), [EXPRESS_BIT, EXPRESS_BIT | 1n]);
    s.expressDoneBelow = { "100": "1" };
    assert.deepEqual(expressToCarry(s, "100", 3n), [EXPRESS_BIT | 1n, EXPRESS_BIT | 2n]);
  });

  it("move through the same stages and their own watermark, leaving the normal one alone", () => {
    const s = emptyState("Cfg", "0xabc");
    const id0 = EXPRESS_BIT, id1 = EXPRESS_BIT | 1n;
    s.batches[batchKey("100", id0)] = { denomination: "100", index: 0, epochId: id0.toString(), sent: true, l1ToL2Hash: "0x1", registered: true };
    s.batches[batchKey("100", id1)] = { denomination: "100", index: 0, epochId: id1.toString(), sent: true };
    assert.equal(stageOf(s.batches[batchKey("100", id0)]!), "done");
    assert.equal(stageOf(s.batches[batchKey("100", id1)]!), "relay");
    assert.equal(advanceExpressDone(s, "100"), 1n);
    assert.deepEqual(s.expressDoneBelow, { "100": "1" });
    assert.equal(advanceDone(s, "100"), 0n, "normal epochs are not moved by express ones");
    assert.deepEqual(epochsToCarry(s, "100", 2n), [0n, 1n]);
  });

  it("pay the finisher its share of the note's fee plus the express fee", () => {
    assert.equal(expressReward({ finisherFee: 3_000_000n, expressFee: 1_200_000n }), 4_200_000n);
  });
});
