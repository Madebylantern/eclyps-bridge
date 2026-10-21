/**
 * The testnet finisher's pure rules (src/plan.ts). Run with `pnpm --filter @eclyps/finisher test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceDone,
  backoffMs,
  type Batch,
  batchKey,
  batchName,
  BUSY_INTERVAL_MS,
  closeAction,
  emptyState,
  epochsToCarry,
  finisherReward,
  fmtDuration,
  fmtUnits,
  IRIS_BLOCK_MS,
  isDue,
  lowBalances,
  nextDelayMs,
  oneLine,
  Quiet,
  RateGate,
  readIris,
  recordFailure,
  recordRollover,
  recordSuccess,
  RELAY_STUCK_MS,
  relayStuck,
  sizeName,
  stageOf,
  stateMatches,
  summarize,
  summaryLine,
  usd,
} from "../src/plan.js";

const batch = (over: Partial<Batch> = {}): Batch => ({ denomination: "1000000", index: 0, epochId: "3", ...over });

describe("stages", () => {
  it("moves send -> relay -> register -> done as the record fills", () => {
    const b = batch();
    assert.equal(stageOf(b), "send");
    b.sent = true;
    assert.equal(stageOf(b), "relay");
    b.burnSig = "sig";
    b.message = "0x01";
    assert.equal(stageOf(b), "relay");
    b.l1ToL2Hash = "0xabc";
    assert.equal(stageOf(b), "register");
    b.registerTx = "0xdef";
    assert.equal(stageOf(b), "register");
    b.registered = true;
    assert.equal(stageOf(b), "done");
  });

  it("a relay sent but not confirmed stays in the relay stage", () => {
    assert.equal(stageOf(batch({ relayTx: "0x1", relaySubmittedAt: 0 })), "relay");
  });

  it("a relay without a receipt for 10 minutes is considered dropped", () => {
    const b = batch({ relayTx: "0x1", relaySubmittedAt: 1_000 });
    assert.equal(relayStuck(b, 1_000 + RELAY_STUCK_MS - 1), false);
    assert.equal(relayStuck(b, 1_000 + RELAY_STUCK_MS), true);
    assert.equal(relayStuck(batch(), 10 * RELAY_STUCK_MS), false);
  });

  it("survives a restart: the saved record resumes at the same stage", () => {
    const s = emptyState("Cfg", "0xAbC");
    s.batches[batchKey(1_000_000n, 3n)] = batch({ sent: true, burnSig: "sig", message: "0x01", attestation: "0x02" });
    const again = JSON.parse(JSON.stringify(s));
    assert.equal(stageOf(again.batches["1000000:3"]), "relay");
    assert.ok(stateMatches(again, "Cfg", "0xabc"));
  });
});

describe("closeAction", () => {
  const params = { minBatchSize: 4, perEpochCap: 8 };
  const epoch = (n: number, endSlot = 100n, status = "Open") => ({ status, endSlot, leaves: Array(n).fill(0) });

  it("closes an ended epoch that reached the batch minimum", () => {
    assert.equal(closeAction(epoch(4), 100n, params), "close");
    assert.equal(closeAction(epoch(6), 150n, params), "close");
  });
  it("closes a full epoch before its end", () => {
    assert.equal(closeAction(epoch(8), 10n, params), "close");
    assert.equal(closeAction(epoch(256), 0n, { minBatchSize: 4, perEpochCap: 1_000 }), "close"); // 256 = 2^depth
  });
  it("waits for the end slot below the cap", () => {
    assert.equal(closeAction(epoch(5), 99n, params), "none");
    assert.equal(closeAction(epoch(1), 99n, params), "none");
  });
  it("rolls over an ended epoch below the minimum that holds a deposit", () => {
    assert.equal(closeAction(epoch(1), 100n, params), "rollover");
    assert.equal(closeAction(epoch(3), 1_000n, params), "rollover");
  });
  it("rolls over once per end: after a rollover the new end slot is ahead", () => {
    const e = epoch(1, 100n);
    assert.equal(closeAction(e, 100n, params), "rollover");
    e.endSlot = 100n + 2_250n; // what close_epoch sets on a rollover
    for (const slot of [101n, 1_000n, 2_349n]) assert.equal(closeAction(e, slot, params), "none");
    assert.equal(closeAction(e, 2_350n, params), "rollover");
  });
  it("never touches an empty epoch", () => {
    assert.equal(closeAction(epoch(0), 1_000n, params), "none");
    assert.equal(closeAction(epoch(0), 1_000n, { minBatchSize: 0, perEpochCap: 8 }), "none");
  });
  it("never closes an epoch that is not open", () => {
    assert.equal(closeAction(epoch(8, 0n, "Closed"), 1_000n, params), "none");
    assert.equal(closeAction(epoch(1, 0n, "Sent"), 1_000n, params), "none");
  });
});

describe("fees", () => {
  it("pays the finisher share per note, rounded down per note (ADR 0012)", () => {
    assert.equal(finisherReward(1_000_000n, 30, 4), 12_000n); // 4 x $1 at 0.3 %
    assert.equal(finisherReward(1_234_567n, 30, 1), 3_703n); // the ADR's rounding example
    assert.equal(finisherReward(100_000_000n, 30, 256), 76_800_000n);
    assert.equal(finisherReward(100_000_000n, 0, 4), 0n);
  });
  it("formats dollars", () => {
    assert.equal(usd(0n), "$0.00");
    assert.equal(usd(12_000n), "$0.012");
    assert.equal(usd(1_200_000n), "$1.20");
    assert.equal(usd(1_234_567_890n), "$1,234.56789");
    assert.equal(sizeName(1_000_000n), "$1");
    assert.equal(sizeName("1000000000"), "$1,000");
    assert.equal(batchName(batch()), "$1 #3");
  });
  it("sums what this finisher earned and where each batch is", () => {
    const s = emptyState("c", "0x0");
    s.batches.a = batch({ epochId: "0", sentByUs: true, reward: "12000", registered: true });
    s.batches.b = batch({ epochId: "1", sentByUs: true, reward: "12000", l1ToL2Hash: "0x1" });
    s.batches.c = batch({ epochId: "2", sent: true, burnSig: "x" }); // sent by another finisher
    s.batches.d = batch({ epochId: "3" }); // closed, not sent yet
    assert.deepEqual(summarize(s), { sentByUs: 2, earned: 24_000n, carried: 1, inFlight: 2, rollovers: 0, rolloverLamports: 0n });
    assert.equal(summaryLine(summarize(s)), "earned $0.024 from 2 batches sent · 1 carried across · 2 on the way");
  });
  it("counts the SOL spent on rollovers", () => {
    const s = emptyState("c", "0x0");
    recordRollover(s, 5_000n);
    recordRollover(s, 5_000n);
    const again = JSON.parse(JSON.stringify(s)); // survives a restart
    assert.deepEqual(again.rollovers, { count: 2, lamports: "10000" });
    const x = summarize(again);
    assert.equal(x.rollovers, 2);
    assert.equal(x.rolloverLamports, 10_000n);
    assert.equal(summaryLine(x), "earned $0.00 from 0 batches sent · 0 carried across · 0 on the way · 2 rollovers (0.00001 SOL)");
  });
});

describe("retries", () => {
  it("backs off exponentially, capped", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffMs(n)), [30_000, 60_000, 120_000, 240_000]);
    assert.equal(backoffMs(50), 30 * 60_000);
    assert.equal(backoffMs(10, 30_000, 10 * 60_000), 10 * 60_000);
  });
  it("records failures and clears them on success", () => {
    const b = batch();
    assert.equal(isDue(b, 0), true);
    const wait = recordFailure(b, 1_000, "boom\nstack");
    assert.equal(wait, 30_000);
    assert.equal(isDue(b, 30_999), false);
    assert.equal(isDue(b, 31_000), true);
    recordFailure(b, 31_000, "again");
    assert.equal(b.failures, 2);
    assert.equal(b.retryAt, 31_000 + 60_000);
    recordSuccess(b);
    assert.equal(b.failures, undefined);
    assert.equal(isDue(b, 0), true);
  });
  it("looks again sooner while a batch waits on Circle or Aztec", () => {
    const s = emptyState("c", "0x0");
    assert.equal(nextDelayMs(s, 60_000), 60_000);
    s.batches.x = batch({ registered: true });
    assert.equal(nextDelayMs(s, 60_000), 60_000);
    s.batches.y = batch({ sent: true });
    assert.equal(nextDelayMs(s, 60_000), BUSY_INTERVAL_MS);
    assert.equal(nextDelayMs(s, 5_000), 5_000);
  });
});

describe("watermark", () => {
  it("moves past carried batches and stops at the first one still on the way", () => {
    const s = emptyState("c", "0x0");
    for (const id of [0, 1, 3]) s.batches[batchKey("1000000", String(id))] = batch({ epochId: String(id), registered: true });
    s.batches[batchKey("1000000", "2")] = batch({ epochId: "2", l1ToL2Hash: "0x1" });
    assert.equal(advanceDone(s, "1000000"), 2n);
    assert.deepEqual(epochsToCarry(s, "1000000", 5n), [2n, 3n, 4n]);
    s.batches[batchKey("1000000", "2")]!.registered = true;
    assert.equal(advanceDone(s, "1000000"), 4n);
    assert.deepEqual(epochsToCarry(s, "1000000", 5n), [4n]);
    assert.deepEqual(epochsToCarry(s, "10000000", 2n), [0n, 1n]);
  });
  it("a record for another deployment does not match", () => {
    const s = emptyState("Cfg", "0xAA");
    assert.equal(stateMatches(s, "Other", "0xaa"), false);
    assert.equal(stateMatches(s, "Cfg", "0xbb"), false);
    assert.equal(stateMatches({ ...s, version: 0 }, "Cfg", "0xaa"), false);
  });
});

describe("Iris", () => {
  it("reads an attested message", () => {
    const r = readIris(200, { messages: [{ status: "complete", message: "0x0102", attestation: "0xabcd" }] });
    assert.deepEqual(r, { kind: "attested", message: "0x0102", attestation: "0xabcd" });
  });
  it("waits while the burn is not indexed or not attested", () => {
    assert.deepEqual(readIris(404, { error: "Message not found for provided parameters" }), { kind: "pending", status: "not indexed yet" });
    assert.deepEqual(readIris(200, { messages: [{ status: "pending_confirmations", message: "0x01", attestation: "PENDING" }] }), {
      kind: "pending", status: "pending_confirmations",
    });
    assert.deepEqual(readIris(200, { messages: [{ status: "complete", message: "0x01", attestation: "PENDING" }] }), { kind: "pending", status: "complete" });
    assert.deepEqual(readIris(200, { messages: [] }), { kind: "pending", status: "no message yet" });
  });
  it("respects Circle's rate limit", () => {
    assert.deepEqual(readIris(429, undefined, "120"), { kind: "rate-limited", retryAfterMs: 120_000 });
    assert.deepEqual(readIris(429, undefined, null), { kind: "rate-limited", retryAfterMs: IRIS_BLOCK_MS });
    assert.equal(readIris(503, "down").kind, "error");
  });
  it("spaces requests and pauses after a 429", () => {
    const g = new RateGate(1_000);
    assert.equal(g.waitMs(0), 0);
    g.hit(0);
    assert.equal(g.waitMs(400), 600);
    assert.equal(g.waitMs(1_000), 0);
    g.block(1_000, IRIS_BLOCK_MS);
    assert.equal(g.blocked(1_000 + IRIS_BLOCK_MS - 1), true);
    assert.equal(g.waitMs(2_000), IRIS_BLOCK_MS - 1_000);
    assert.equal(g.blocked(1_000 + IRIS_BLOCK_MS), false);
  });
});

describe("logs", () => {
  it("prints a waiting line once, again when it changes or after a while", () => {
    const q = new Quiet(60_000);
    assert.equal(q.shouldLog("k", "waiting", 0), true);
    assert.equal(q.shouldLog("k", "waiting", 30_000), false);
    assert.equal(q.shouldLog("k", "attested", 31_000), true);
    assert.equal(q.shouldLog("k", "attested", 91_000), true);
    q.forget("k");
    assert.equal(q.shouldLog("k", "attested", 92_000), true);
    assert.equal(q.shouldLog("other", "attested", 92_000), true);
  });
  it("keeps errors to one short line", () => {
    assert.equal(oneLine(new Error("first\n    at stack")), "first");
    assert.equal(oneLine("x".repeat(500), 20).length, 20);
    assert.equal(oneLine(Object.assign(new Error("long viem text"), { shortMessage: "short" })), "short");
  });
  it("formats amounts and durations", () => {
    assert.equal(fmtUnits(42_000_000n, 9), "0.042");
    assert.equal(fmtUnits(2_000_000_000n, 9), "2");
    assert.equal(fmtUnits(21_300_000_000_000_000n, 18), "0.0213");
    assert.equal(fmtUnits(5_000n, 9, 9), "0.000005");
    assert.equal(fmtDuration(45_000), "45s");
    assert.equal(fmtDuration(120_000), "2m");
    assert.equal(fmtDuration(65 * 60_000), "1h 5m");
  });
  it("warns when SOL or ETH run low", () => {
    assert.deepEqual(lowBalances({ lamports: 1_000_000_000n, wei: 10n ** 17n }), []);
    const w = lowBalances({ lamports: 10_000_000n, wei: 10n ** 15n });
    assert.equal(w.length, 2);
    assert.match(w[0]!, /low SOL: 0.01/);
    assert.match(w[1]!, /low Sepolia ETH: 0.001/);
  });
});
