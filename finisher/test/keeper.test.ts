/**
 * The reference keeper's rules (src/keeper-plan.ts, ADR 0017 amended): what it accepts, when it
 * fronts from the pool, and what it still has to be repaid for.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BN254_R,
  decideFront,
  emptyKeeperState,
  type FrontFacts,
  frontsToRepay,
  keeperStateMatches,
  keeperSummary,
  parseFrontRequest,
  quoteLines,
} from "../src/keeper-plan.js";

const DENOMS = ["1000000", "10000000"];
const good = {
  denomination: "10000000",
  exitEpochId: "4",
  leafIndex: 2,
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  secret: "0x1234",
  aztecTx: `0x${"ab".repeat(32)}`,
};

describe("parseFrontRequest", () => {
  it("reads a well-formed request", () => {
    const r = parseFrontRequest(good, DENOMS);
    assert.ok("ok" in r);
    assert.deepEqual(r.ok, { ...good, denominationIndex: 1, exitEpochId: 4n, secret: 0x1234n });
  });
  it("refuses anything else, with the reason", () => {
    const bad: [Record<string, unknown> | unknown, RegExp][] = [
      [null, /JSON object/],
      [{ ...good, denomination: "5" }, /denomination/],
      [{ ...good, exitEpochId: "-1" }, /exitEpochId/],
      [{ ...good, leafIndex: 256 }, /leafIndex/],
      [{ ...good, leafIndex: 1.5 }, /leafIndex/],
      [{ ...good, destination: "0xabc" }, /destination/],
      [{ ...good, secret: "1234" }, /secret/],
      [{ ...good, secret: "0x0" }, /field element/],
      [{ ...good, secret: `0x${BN254_R.toString(16)}` }, /field element/],
      [{ ...good, aztecTx: "0x12" }, /aztecTx/],
    ];
    for (const [body, why] of bad) {
      const r = parseFrontRequest(body, DENOMS);
      assert.ok("error" in r, JSON.stringify(body));
      assert.match(r.error, why);
    }
  });
});

describe("decideFront", () => {
  const facts: FrontFacts = {
    txOk: true, txBlock: 100, checkpointed: 100, leafOnAztec: 77n, leaf: 77n,
    arrived: false, fronted: false, capacity: 10_000_000n, advanced: 9_990_000n,
  };
  it("fronts a checkpointed exit whose leaf matches, when the pool covers it", () => {
    assert.deepEqual(decideFront(facts), { action: "front" });
  });
  it("waits for the exit to be mined, readable and checkpointed", () => {
    assert.equal(decideFront({ ...facts, txOk: false }).action, "wait");
    assert.equal(decideFront({ ...facts, leafOnAztec: undefined }).action, "wait");
    assert.equal(decideFront({ ...facts, leafOnAztec: 0n }).action, "wait");
    const w = decideFront({ ...facts, checkpointed: 99 });
    assert.equal(w.action, "wait");
    assert.match(w.action === "wait" ? w.reason : "", /checkpointed/);
  });
  it("refuses another exit's leaf, a fronted or arrived leaf, and what the pool cannot cover", () => {
    assert.equal(decideFront({ ...facts, leafOnAztec: 78n }).action, "refuse");
    assert.equal(decideFront({ ...facts, fronted: true }).action, "refuse");
    assert.equal(decideFront({ ...facts, arrived: true }).action, "refuse");
    assert.equal(decideFront({ ...facts, capacity: 9_989_999n }).action, "refuse");
  });
});

describe("the keeper's record", () => {
  it("lists fronts still to be repaid and sums what is out", () => {
    const s = emptyKeeperState("Cfg");
    assert.ok(keeperStateMatches(JSON.parse(JSON.stringify(s)), "Cfg"));
    assert.ok(!keeperStateMatches(s, "Other"));
    const base = { denomination: "10000000", index: 1, exitEpochId: "4", leafIndex: 0, destination: good.destination, secret: "0x1", aztecTx: good.aztecTx };
    s.fronts.a = { ...base, leaf: "0xa", frontSig: "s1", advanced: "9990000" };
    s.fronts.b = { ...base, leaf: "0xb", frontSig: "s2", advanced: "9990000", repaid: true };
    s.fronts.c = { ...base, leaf: "0xc" }; // never fronted
    assert.deepEqual(frontsToRepay(s).map((f) => f.leaf), ["0xa"]);
    assert.deepEqual(keeperSummary(s), { fronted: 2, repaid: 1, outstanding: 9_990_000n });
  });
  it("quotes each note size against the pool's capacity", () => {
    const q = quoteLines(["1000000", "10000000", "0"], (d) => (d * 10n) / 10_000n, 5_000_000n);
    assert.deepEqual(q, [
      { denomination: "1000000", fee: "1000", advanced: "999000", fits: true },
      { denomination: "10000000", fee: "10000", advanced: "9990000", fits: false },
    ]);
  });
});
