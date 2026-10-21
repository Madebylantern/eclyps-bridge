/**
 * The finisher's exit rules (src/plan.ts, ADR 0009) and the local stack's Iris (src/local-iris.ts).
 * Run with `pnpm --filter @eclyps/finisher test`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeExitMessage } from "@eclyps/sdk";
import { hexToBytes, keccak256, recoverAddress, toHex } from "viem";
import { attest, testAttesters } from "../src/local-iris.js";
import {
  advanceExitsDone,
  type ExitBatch,
  exitBlocksLeft,
  exitCloseDue,
  exitEpochsToCarry,
  exitKey,
  exitL1Stuck,
  exitMessageMismatch,
  exitName,
  exitsBusy,
  exitStageOf,
  type ExitState,
  exitSummary,
  outboxLeafId,
  RELAY_STUCK_MS,
} from "../src/plan.js";

const $100 = 100_000_000n;
const fresh = (): ExitState => ({ exits: {}, exitsDoneBelow: {} });

describe("exitCloseDue", () => {
  const min = 4;
  it("waits for the minimum: below it a close would only roll the epoch over", () => {
    assert.equal(exitCloseDue({ count: 0, endsAt: 10 }, 50, min), false);
    assert.equal(exitCloseDue({ count: 3, endsAt: 10 }, 50, min), false);
  });
  it("closes once the minimum is reached and the epoch has ended", () => {
    assert.equal(exitCloseDue({ count: 4, endsAt: 10 }, 9, min), false);
    assert.equal(exitCloseDue({ count: 4, endsAt: 10 }, 10, min), true);
    assert.equal(exitCloseDue({ count: 9, endsAt: 10 }, 11, min), true);
  });
  it("closes a full tree at once, ended or not", () => {
    assert.equal(exitCloseDue({ count: 256, endsAt: 1_000 }, 5, min), true);
    assert.equal(exitCloseDue({ count: 255, endsAt: 1_000 }, 5, min), false);
  });
  it("treats a minimum above the tree size as the tree size", () => {
    assert.equal(exitCloseDue({ count: 256, endsAt: 1_000 }, 5, 300), true);
  });
  it("counts the blocks left", () => {
    assert.equal(exitBlocksLeft({ endsAt: 20 }, 13), 7);
    assert.equal(exitBlocksLeft({ endsAt: 20 }, 25), 0);
  });
});

describe("exit stages", () => {
  const b = (x: Partial<ExitBatch> = {}): ExitBatch => ({ denomination: $100.toString(), index: 1, exitEpochId: "3", ...x });
  it("moves prove -> attest -> done", () => {
    assert.equal(exitStageOf(b()), "prove");
    assert.equal(exitStageOf(b({ root: "0x01", l1Tx: "0xab" })), "prove");
    assert.equal(exitStageOf(b({ exited: true })), "attest");
    assert.equal(exitStageOf(b({ exited: true, message: "0x", attestation: "0x" })), "attest");
    assert.equal(exitStageOf(b({ exited: true, received: true })), "done");
  });
  it("names a batch as the logs do", () => {
    assert.equal(exitName(b()), "$100 exit #3");
  });
  it("considers an exitBatch without a receipt after 10 minutes dropped", () => {
    assert.equal(exitL1Stuck(b({ l1Tx: "0xab", l1SubmittedAt: 0 }), RELAY_STUCK_MS - 1), false);
    assert.equal(exitL1Stuck(b({ l1Tx: "0xab", l1SubmittedAt: 0 }), RELAY_STUCK_MS), true);
    assert.equal(exitL1Stuck(b({ l1Tx: "0xab", l1SubmittedAt: 0, exited: true }), RELAY_STUCK_MS), false);
    assert.equal(exitL1Stuck(b(), RELAY_STUCK_MS), false);
  });
});

describe("exit watermark", () => {
  it("carries every closed exit epoch from the watermark to the open one", () => {
    const s = fresh();
    assert.deepEqual(exitEpochsToCarry(s, "100", 0n), []);
    assert.deepEqual(exitEpochsToCarry(s, "100", 3n), [0n, 1n, 2n]);
    s.exitsDoneBelow["100"] = "2";
    assert.deepEqual(exitEpochsToCarry(s, "100", 3n), [2n]);
  });
  it("advances only past epochs received on Solana, in order", () => {
    const s = fresh();
    s.exits[exitKey("100", 0n)] = { denomination: "100", index: 0, exitEpochId: "0", received: true };
    s.exits[exitKey("100", 1n)] = { denomination: "100", index: 0, exitEpochId: "1", exited: true };
    s.exits[exitKey("100", 2n)] = { denomination: "100", index: 0, exitEpochId: "2", received: true };
    assert.equal(advanceExitsDone(s, "100"), 1n);
    s.exits[exitKey("100", 1n)]!.received = true;
    assert.equal(advanceExitsDone(s, "100"), 3n);
    assert.equal(s.exitsDoneBelow["100"], "3");
    assert.deepEqual(exitSummary(s), { carried: 3, inFlight: 0 });
    assert.equal(exitsBusy(s), false);
    s.exits[exitKey("10", 0n)] = { denomination: "10", index: 0, exitEpochId: "0", root: "0x1" };
    assert.deepEqual(exitSummary(s), { carried: 3, inFlight: 1 });
    assert.equal(exitsBusy(s), true);
  });
  it("keeps exit keys apart from batch keys", () => {
    assert.equal(exitKey($100, 7n), "exit:100000000:7");
  });
});

describe("outboxLeafId", () => {
  it("is 2^depth + index, as the Outbox tracks consumed leaves", () => {
    assert.equal(outboxLeafId(5, 3n), 35n);
    assert.equal(outboxLeafId(0, 0n), 1n);
  });
});

// The receive_exit that landed in LiteSVM, attested by the gateway tests' two keys
// (programs/gateway/tests/exit.rs, written by `exit_fixture_for_the_sdk`).
const fx = JSON.parse(readFileSync(new URL("../../sdk/test/fixtures/exit-claim.json", import.meta.url), "utf8"));
const message = hexToBytes(`0x${fx.receive.message}`);

describe("exitMessageMismatch", () => {
  const m = decodeExitMessage(message);
  const batch = { denomination: fx.exitBatch.denomination ?? "1000000000", exitEpochId: fx.exitEpochId, count: 3, root: fx.root };
  it("accepts the message Solana received for that exit batch", () => {
    assert.equal(exitMessageMismatch(m, batch), undefined);
  });
  it("names what does not match", () => {
    assert.match(exitMessageMismatch(m, { ...batch, exitEpochId: "8" })!, /another exit batch/);
    assert.match(exitMessageMismatch(m, { ...batch, denomination: $100.toString() })!, /another exit batch/);
    assert.match(exitMessageMismatch(m, { ...batch, count: 4 })!, /count/);
    assert.match(exitMessageMismatch(m, { ...batch, root: "0x01" })!, /root/);
    assert.match(exitMessageMismatch({ ...m, finalityExecuted: 1000 }, batch)!, /finality/);
    assert.match(exitMessageMismatch({ ...m, sourceDomain: 5 }, batch)!, /Ethereum to Solana/);
    assert.match(exitMessageMismatch({ ...m, amount: m.amount + 1n }, batch)!, /amount/);
  });
});

describe("the local Iris", () => {
  it("signs as the gateway tests' attesters, byte for byte (what Circle's MessageTransmitterV2 accepted)", async () => {
    assert.equal(await attest(message), `0x${fx.receive.attestation}`);
  });
  it("orders signatures by attester address, each recovering to its attester", async () => {
    const att = hexToBytes(await attest(message));
    assert.equal(att.length, 130);
    const hash = keccak256(message);
    const signers = [];
    for (let i = 0; i < 2; i++) signers.push(await recoverAddress({ hash, signature: toHex(att.slice(65 * i, 65 * i + 65)) }));
    assert.deepEqual(signers, testAttesters());
    assert.ok(BigInt(signers[0]!) < BigInt(signers[1]!));
  });
});
