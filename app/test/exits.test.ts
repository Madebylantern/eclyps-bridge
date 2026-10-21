/**
 * Move out (ADR 0009, 0014 §4): where an exit is, in words and steps. Run with
 * `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exitAction, exitJourney, exitStage, outboxMayHold } from "../src/lib/exit-status.ts";

const sol = { to: "solana" as const, denomination: "100000000", destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" };
const eth = { to: "ethereum" as const, denomination: "10000000", destination: "0x52908400098527886E0F7030069857D2E4169EE7" };

describe("exitStage", () => {
  it("follows a Solana exit from the burn to the payment", () => {
    assert.equal(exitStage("solana", { mined: false }), "burning");
    assert.equal(exitStage("solana", { mined: true, inEpoch: 2, minBatch: 4 }), "burned");
    assert.equal(exitStage("solana", { mined: true, closed: true }), "batched");
    assert.equal(exitStage("solana", { mined: true, closed: true, exited: true }), "sent");
    assert.equal(exitStage("solana", { mined: true, closed: true, exited: true, arrived: true }), "arrived");
    assert.equal(exitStage("solana", { mined: true, closed: true, exited: true, arrived: true, paid: true }), "paid");
  });
  it("follows an Ethereum exit: burned, proven, paid", () => {
    assert.equal(exitStage("ethereum", { mined: true }), "burned");
    assert.equal(exitStage("ethereum", { mined: true, proven: true }), "proven");
    assert.equal(exitStage("ethereum", { mined: true, proven: true, paid: true }), "paid");
  });
  it("asks the user to act only when the claim can be made", () => {
    assert.equal(exitAction("arrived"), "claim");
    assert.equal(exitAction("proven"), "claim");
    for (const s of ["burning", "burned", "batched", "sent", "paid"] as const) assert.equal(exitAction(s), undefined);
  });
});

describe("exitJourney", () => {
  it("says how many exits the batch still needs, in one line", () => {
    const j = exitJourney(sol, "burned", { mined: true, inEpoch: 1, minBatch: 4 });
    assert.equal(j.headline, "$100 leaving for Solana");
    assert.equal(j.now, "Waiting for 3 more exits to fill the batch.");
    assert.deepEqual(j.steps.map((s) => s.state), ["now", "next", "next", "next", "next"]);
    assert.equal(exitJourney(sol, "burned", { mined: true, inEpoch: 3, minBatch: 4 }).now, "Waiting for 1 more exit to fill the batch.");
  });
  it("marks every step done once paid, with the references it has", () => {
    const j = exitJourney({ ...sol, tx: "0xaa", claimTx: "sig" }, "paid", { mined: true, paid: true });
    assert.equal(j.headline, "$100 moved out");
    assert.ok(j.steps.every((s) => s.state === "done"));
    assert.deepEqual(j.steps[0]!.ref, { prefix: "tx", value: "0xaa" });
    assert.deepEqual(j.steps.at(-1)!.ref, { prefix: "tx", value: "sig" });
    assert.equal(j.steps.at(-1)!.title, "Paid to 7xKX…gAsU");
  });
  it("invents no reference", () => {
    const j = exitJourney(eth, "proven", { mined: true, proven: true });
    assert.equal(j.steps.length, 3);
    assert.ok(j.steps.every((s) => s.ref === undefined));
    assert.equal(j.now, "Ready. Claim it to 0x52…9EE7.");
    assert.deepEqual(j.steps.map((s) => s.state), ["done", "now", "next"]);
  });
  it("a fast exit shows what the destination received", () => {
    const j = exitJourney(sol, "paid", { mined: true, paid: true, frontedAdvanced: 99_900_000n });
    assert.equal(j.headline, "$99.90 moved out");
  });
  it("keeps every line short (two short lines per item at most)", () => {
    for (const st of ["burning", "burned", "batched", "sent", "arrived", "paid"] as const) {
      const j = exitJourney(sol, st, { mined: st !== "burning", inEpoch: 1, minBatch: 4 });
      assert.ok(j.now.length <= 60, j.now);
      assert.ok(j.headline.length <= 40, j.headline);
    }
  });
});

describe("outboxMayHold", () => {
  it("reads the Outbox only once the burn's epoch is proven", () => {
    for (const s of ["pending", "dropped", "proposed", "checkpointed"]) assert.equal(outboxMayHold(s), false, s);
    for (const s of ["proven", "finalized"]) assert.equal(outboxMayHold(s), true, s);
  });
});
