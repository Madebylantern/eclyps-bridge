/**
 * How long a crossing still takes (src/lib/eta.ts): measured ranges per network, the real Aztec
 * clock when it is known, never a time for a wait that depends on other people, and the words.
 * Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aboutText,
  type AztecClock,
  batchWait,
  epochEnd,
  etaLine,
  exitTimes,
  journeyEta,
  PROFILES,
  profileOf,
  provenAt,
  routeTimes,
  sendWait,
  walk,
} from "../src/lib/eta.ts";

const p = PROFILES.testnet;
const MIN = 60_000;
const NOW = 1_800_000_000_000;
const EPOCH = 32 * 72_000;
/** The Aztec clock `k` slots into an epoch, read now. */
const clockAt = (k: number): AztecClock => ({ slot: BigInt(32 * 500 + k), epochSlots: 32, slotSeconds: 72, at: NOW });
const r = (lo: number, hi: number) => ({ lo: lo * MIN, hi: hi * MIN });

describe("the profile: measured numbers", () => {
  it("uses testnet's measured legs, and the local stack's own", () => {
    assert.equal(profileOf("testnet"), PROFILES.testnet);
    assert.equal(profileOf("local"), PROFILES.local);
    // An Aztec epoch is 32 slots of 72 s; the finisher carried a batch in 57–93 s over five runs.
    assert.equal(p.epochMs, 38.4 * MIN);
    assert.ok(p.carry.lo <= 57_000 + 14_000 && p.carry.hi >= 93_000 + 14_000);
    // Run 5: the browser claim took 102 s, the burn 142 s, the Ethereum claim 33 s; Iris 14 min.
    for (const [leg, t] of [["claim", 102_000], ["burn", 142_000], ["ethClaim", 33_000], ["iris", 14 * MIN]] as const) {
      assert.ok(p[leg].lo <= t && t <= p[leg].hi, `${leg} covers ${t} ms`);
    }
  });
});

describe("the Aztec clock", () => {
  it("ends the epoch holding a moment at its last slot", () => {
    assert.equal(epochEnd(NOW, clockAt(0)), NOW + EPOCH);
    assert.equal(epochEnd(NOW, clockAt(31)), NOW + 72_000);
    assert.equal(epochEnd(NOW + 2 * 72_000, clockAt(31)), NOW + 72_000 + EPOCH);
    assert.equal(epochEnd(NOW - 60_000, clockAt(0)), NOW);
  });
  it("proves at the end of the epoch plus the proof; without the clock, anywhere within one epoch", () => {
    const at = { lo: NOW, hi: NOW };
    assert.deepEqual(provenAt(at, p, clockAt(16)), { lo: NOW + 16 * 72_000 + p.proof.lo, hi: NOW + 16 * 72_000 + 72_000 + p.proof.hi });
    assert.deepEqual(provenAt(at, p), { lo: NOW + p.proof.lo, hi: NOW + EPOCH + p.proof.hi });
    // The local network proves within seconds.
    assert.ok(provenAt(at, PROFILES.local).hi - NOW <= MIN);
  });
  it("walks legs in order, the proof placed by the clock", () => {
    const end = walk({ lo: NOW, hi: NOW }, ["burn", "proof", "ethClaim"], p, { clock: clockAt(0) });
    assert.equal(end.lo, NOW + EPOCH + p.proof.lo + p.ethClaim.lo);
  });
});

describe("the batch: timed only once it is full", () => {
  it("never times a batch that still needs deposits", () => {
    assert.equal(batchWait({ leaves: 3, minBatch: 4, cap: 8, now: NOW }, p), undefined);
  });
  it("crosses at its end slot once full, or at the next pass at the cap", () => {
    assert.deepEqual(batchWait({ leaves: 4, minBatch: 4, cap: 8, endsAt: NOW + 10 * MIN, now: NOW }, p), { lo: 10 * MIN, hi: 10 * MIN + p.pass.hi });
    assert.deepEqual(batchWait({ leaves: 4, minBatch: 4, cap: 4, endsAt: NOW + 10 * MIN, now: NOW }, p), p.pass);
    assert.deepEqual(batchWait({ leaves: 5, minBatch: 4, cap: 8, endsAt: NOW - 1, now: NOW }, p), p.pass);
  });
  it("before Send: Cross now is timed; a batch only if the new note fills it; two notes of one size never", () => {
    const pools = [{ index: 0, leaves: 3, minBatch: 4 }, { index: 1, leaves: 1, minBatch: 4 }];
    assert.deepEqual(sendWait({ crossNow: true, notes: [1, 1], pools, cap: 4, now: NOW }, p), p.pass);
    assert.deepEqual(sendWait({ crossNow: false, notes: [0], pools, cap: 4, now: NOW }, p), p.pass);
    assert.equal(sendWait({ crossNow: false, notes: [1], pools, cap: 4, now: NOW }, p), undefined);
    assert.equal(sendWait({ crossNow: false, notes: [0, 0], pools, cap: 4, now: NOW }, p), undefined);
    assert.equal(sendWait({ crossNow: false, notes: [], pools, cap: 4, now: NOW }, p), undefined);
  });
});

describe("the Send choice", () => {
  it("Aztec takes minutes; Ethereum adds the burn and Aztec's proof", () => {
    const t = routeTimes({ now: NOW, wait: p.pass }, p);
    assert.equal(aboutText(t.aztec), "about 2–5 min");
    assert.ok(t.ethereum.hi >= EPOCH, "without the clock, the proof can take a whole epoch");
    assert.equal(t.afterBatch, false);
  });
  it("counts from when the batch crosses when nobody can time it, and then ignores the clock", () => {
    const t = routeTimes({ now: NOW, clock: clockAt(10) }, p);
    assert.equal(t.afterBatch, true);
    assert.ok(t.ethereum.hi - t.ethereum.lo > 30 * MIN);
  });
  it("narrows Ethereum with the real clock", () => {
    const t = routeTimes({ now: NOW, wait: p.pass, clock: clockAt(10) }, p);
    assert.equal(aboutText(t.ethereum), "about 25–35 min");
    // Near an epoch's end the burn may land either side of it: the range says so.
    assert.ok(routeTimes({ now: NOW, wait: p.pass, clock: clockAt(28) }, p).ethereum.hi > 40 * MIN);
  });
  it("Move out: Ethereum within an epoch and a proof, Solana adds the exit batch and Iris", () => {
    const t = exitTimes({ now: NOW }, p);
    assert.ok(t.ethereum.hi <= p.burn.hi + EPOCH + p.proof.hi + p.ethClaim.hi);
    assert.ok(t.solana.lo >= t.ethereum.lo + p.iris.lo - p.ethClaim.lo);
    assert.equal(aboutText(t.solana), "about 15 min–1.5 h");
  });
});

describe("the journey", () => {
  const line = (i: Parameters<typeof journeyEta>[0]) => etaLine(i.stage, journeyEta(i, p));
  it("while the batch needs deposits, says only what follows it", () => {
    assert.equal(line({ stage: "wait", to: "aztec", now: NOW }), "then about 2–4 min");
    assert.match(line({ stage: "wait", to: "ethereum", now: NOW })!, /^then about \d+–\d+ min$/);
  });
  it("a full batch: the total and when it crosses", () => {
    assert.equal(line({ stage: "wait", to: "aztec", now: NOW, fill: r(10, 11) }), "About 15 min left · it crosses in about 10 min");
  });
  it("crossing: lands on Aztec within a couple of minutes", () => {
    assert.equal(line({ stage: "transit", to: "aztec", now: NOW }), "About 2–4 min left · on Aztec in about 1–2 min");
    assert.equal(line({ stage: "transit", to: "ethereum", now: NOW, clock: clockAt(10) }), "About 25–35 min left · on Aztec in about 1–2 min");
  });
  it("the claim: the last step to Aztec, a part of the way to Ethereum", () => {
    assert.equal(line({ stage: "arrived", to: "aztec", now: NOW }), "About 2 min left · the claim is the last step");
    assert.match(line({ stage: "arrived", to: "ethereum", now: NOW })!, /left · the claim takes about 2 min$/);
    assert.equal(line({ stage: "claim", to: "aztec", now: NOW, startedAt: NOW - 30_000 }), "About 1 min left · keep this tab open");
    assert.match(line({ stage: "claim", to: "ethereum", now: NOW, startedAt: NOW - 30_000 })!, /left · about 1 min in this tab$/);
  });
  it("counts down while the page proves, and says when it runs late", () => {
    const a = journeyEta({ stage: "claim", to: "aztec", now: NOW, startedAt: NOW - 60_000 }, p).stage!;
    assert.equal(a.hi, p.claim.hi - 60_000);
    assert.equal(line({ stage: "claim", to: "aztec", now: NOW, startedAt: NOW - 10 * MIN }), "Taking longer than usual · keep this tab open");
  });
  it("send on: most of the wait is Aztec's proof", () => {
    assert.match(line({ stage: "send-on", to: "ethereum", now: NOW })!, /left · most of it is Aztec’s proof$/);
  });
  it("moving out to Ethereum: Aztec's proof from the real clock", () => {
    const x = { to: "ethereum" as const, stage: "burned", sentAt: NOW - MIN };
    assert.equal(line({ stage: "leaving", to: "ethereum", now: NOW, exit: x, clock: clockAt(10) }), "About 25–35 min left · Aztec is proving it");
    // The burn's epoch ended a minute ago: only the proof is left.
    assert.equal(line({ stage: "leaving", to: "ethereum", now: NOW, exit: x, clock: clockAt(0) }), "About 3–9 min left · Aztec proves it in about 3–8 min");
    // Long past the proof's range: late, never a made-up time.
    const old = { ...x, sentAt: NOW - 2 * EPOCH };
    assert.equal(line({ stage: "leaving", to: "ethereum", now: NOW, exit: old, clock: clockAt(10) }), "Aztec’s proof is taking longer than usual");
  });
  it("moving out to Solana: the exit batch, Aztec's proof, then Iris", () => {
    assert.match(line({ stage: "leaving", to: "aztec", now: NOW, exit: { to: "solana", stage: "burned" } })!, /^then about /);
    assert.match(line({ stage: "leaving", to: "aztec", now: NOW, exit: { to: "solana", stage: "burned", full: true } })!, /the exit batch closes in about/);
    assert.equal(line({ stage: "leaving", to: "aztec", now: NOW, exit: { to: "solana", stage: "batched" }, clock: clockAt(10) }), "About 40–55 min left · Aztec proves it in about 25–35 min");
    assert.equal(line({ stage: "leaving", to: "aztec", now: NOW, exit: { to: "solana", stage: "sent" } }), "About 10–25 min left · on Solana in about 10–20 min");
  });
  it("burning to Solana times only the burn: the exit batch then needs others", () => {
    assert.equal(line({ stage: "burning", to: "aztec", now: NOW, startedAt: NOW, exit: { to: "solana", stage: "burning" } }), "About 2–3 min left · keep this tab open");
  });
  it("the claim at the destination is the last step", () => {
    assert.equal(line({ stage: "exit-claim", to: "aztec", now: NOW, exit: { to: "ethereum", stage: "proven" } }), "About 1 min left · the claim is the last step");
  });
  it("keeps every line short", () => {
    const stages = ["wait", "transit", "arrived", "claim", "send-on", "burning", "exit-claim"] as const;
    for (const stage of stages) for (const to of ["aztec", "ethereum"] as const) {
      const l = line({ stage, to, now: NOW, startedAt: NOW, exit: { to: "ethereum", stage: "burning" } }) ?? "";
      assert.ok(l.length <= 52, `${stage} → ${to}: "${l}" (${l.length})`);
    }
  });
});

describe("aboutText: never more precise than the range", () => {
  it("rounds outwards, by the minute, 5 minutes, then half hours", () => {
    assert.equal(aboutText(r(0, 0.5)), "under a minute");
    assert.equal(aboutText(r(2.5, 3)), "about 3 min");
    assert.equal(aboutText(r(2.5, 4.8)), "about 2–5 min");
    assert.equal(aboutText(r(13, 20)), "about 10–20 min");
    assert.equal(aboutText(r(22, 23)), "about 25 min");
    assert.equal(aboutText(r(15, 84)), "about 15 min–1.5 h");
    assert.equal(aboutText(r(70, 130)), "about 1–2.5 h");
  });
  it("never says zero", () => {
    assert.equal(aboutText(r(0, 3)), "about 1–3 min");
  });
});
