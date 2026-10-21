/**
 * The bridge screen's journey (src/lib/tunnel.ts, src/lib/tunnel-scene.ts): which crossing the
 * tunnel follows and where it is, read from real states only (the vault's notes and exits joined
 * with chain state), the crowd it shows, the words it says, and where the disk sits. Run with
 * `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExitStage } from "../src/lib/exit-status.ts";
import {
  crowdLine,
  destNote,
  failure,
  farLight,
  fastPlan,
  holdOf,
  inText,
  type JourneyExit,
  type JourneyNote,
  journeyStage,
  lastActivity,
  leavingLine,
  newestJourney,
  othersInOpen,
  outLine,
  pickJourney,
  slowestBatch,
  slowestExit,
  STALE_MS,
  thenLine,
  transitLine,
  waitLines,
} from "../src/lib/tunnel.ts";
import { edgeAt, flightPath, NEAR, NEAR_WORDS, tunnelLayout, WORDS } from "../src/lib/tunnel-scene.ts";

const D100 = "100000000";
const D10 = "10000000";
let next = 0;
const note = (stage: JourneyNote["stage"], o: Partial<JourneyNote> = {}): JourneyNote => ({
  index: next++,
  stage,
  due: false,
  denomination: D100,
  denominationIndex: 1,
  ...o,
});
const exit = (stage: ExitStage, o: Partial<JourneyExit> = {}): JourneyExit => ({
  id: `solana:${next}`,
  note: next++,
  to: "solana",
  destination: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  denomination: D100,
  stage,
  facts: { mined: stage !== "burning" },
  ...o,
});

describe("journeyStage: real states to the journey", () => {
  it("opens on the amount when nothing is in flight, or everything was taken back", () => {
    assert.equal(journeyStage([]), "amount");
    assert.equal(journeyStage([note("refunded"), note("refunded")]), "amount");
  });
  it("asks for a signature when a deposit is due (a Fast crossing not yet signed, or a planned note whose time came)", () => {
    assert.equal(journeyStage([note("scheduled", { due: true })]), "sign");
    assert.equal(journeyStage([note("queued"), note("scheduled", { due: true })]), "sign");
  });
  it("waits for planned deposits (the eclipse, a spread plan) before anything else", () => {
    assert.equal(journeyStage([note("scheduled", { scheduledAt: 1 })]), "scheduled");
    assert.equal(journeyStage([note("queued"), note("scheduled", { heldBy: 3 })]), "scheduled");
  });
  it("holds at the batch while any note is in the open batch, even if another already arrived", () => {
    assert.equal(journeyStage([note("queued")]), "wait");
    assert.equal(journeyStage([note("queued"), note("claimable")]), "wait");
  });
  it("crosses once the batch closed or was sent through CCTP", () => {
    assert.equal(journeyStage([note("batched")]), "transit");
    assert.equal(journeyStage([note("sent"), note("claimable")]), "transit");
  });
  it("has arrived when Aztec registered every batch still crossing", () => {
    assert.equal(journeyStage([note("claimable")]), "arrived");
    assert.equal(journeyStage([note("claimable"), note("claimed")]), "arrived");
  });
  it("shows the claim while one runs", () => {
    assert.equal(journeyStage([note("claimable")], [], { claiming: true }), "claim");
  });
  it("rests in the private balance once claimed", () => {
    assert.equal(journeyStage([note("claimed"), note("refunded")]), "claimed");
  });
  it("follows the way out: burning, leaving, the claim at the destination, then out", () => {
    const n = note("exited");
    assert.equal(journeyStage([n], [exit("burning")]), "burning");
    for (const s of ["burned", "batched", "sent"] as const) assert.equal(journeyStage([n], [exit(s)]), "leaving");
    assert.equal(journeyStage([n], [exit("arrived")]), "exit-claim");
    assert.equal(journeyStage([n], [exit("proven", { to: "ethereum" })]), "exit-claim");
    assert.equal(journeyStage([n], [exit("paid")]), "out");
    // the slowest exit leads
    assert.equal(journeyStage([n, note("exited")], [exit("arrived"), exit("burned")]), "leaving");
  });
  it("keeps the balance when only part of it moved out and arrived", () => {
    assert.equal(journeyStage([note("claimed"), note("exited")], [exit("paid")]), "claimed");
  });
});

describe("pickJourney: the crossing the screen follows", () => {
  const t = (id: string, kind: string, createdAt: number, notes: JourneyNote[]) => ({ id, kind, createdAt, notes });
  it("is the newest crossing made from the bridge", () => {
    const a = t("a", "fast", 1, [note("queued")]);
    const b = t("b", "totality", 2, [note("scheduled")]);
    assert.equal(pickJourney([a, b], () => [], 10)?.id, "b");
    assert.equal(newestJourney([b, a])?.id, "b");
  });
  it("leaves notes found from the phrase and earlier notes to Balance", () => {
    const r = t("recovered", "recovered", 9, [note("claimable")]);
    const e = t("earlier", "earlier", 8, [note("queued")]);
    assert.equal(pickJourney([r, e], () => [], 10), undefined);
  });
  it("skips a crossing that was taken back entirely", () => {
    const a = t("a", "fast", 1, [note("queued")]);
    const b = t("b", "fast", 2, [note("refunded")]);
    assert.equal(pickJourney([a, b], () => [], 10)?.id, "a");
  });
  it("follows a finished crossing for a while, then opens on a new amount", () => {
    const done = t("d", "fast", 1_000, [note("claimed", { claimedAt: 5_000 })]);
    assert.equal(pickJourney([done], () => [], 5_000 + STALE_MS - 1)?.id, "d");
    assert.equal(pickJourney([done], () => [], 5_000 + STALE_MS + 1), undefined);
    // an unfinished one is followed however old it is
    const old = t("o", "fast", 1, [note("queued", { depositedAt: 2 })]);
    assert.equal(pickJourney([old], () => [], 1e12)?.id, "o");
  });
  it("counts the last step of a crossing, the way out included", () => {
    assert.equal(lastActivity(1, [note("claimed", { claimedAt: 50 })], [exit("paid", { sentAt: 70, claimedAt: 90 })]), 90);
  });
});

describe("the crowd, from the chain", () => {
  const pools = [
    { index: 0, denomination: 10_000_000n, openEpochId: 3n, openEpochLeaves: 2 },
    { index: 1, denomination: 100_000_000n, openEpochId: 7n, openEpochLeaves: 3 },
  ];
  it("counts others in the open batch: its leaves minus your own notes there", () => {
    const own = [note("queued", { epochId: "7" }), note("queued", { epochId: "6" }), note("claimed", { epochId: "7" })];
    assert.deepEqual(othersInOpen(pools, own, [1]).map((o) => [o.index, o.count]), [[1, 2]]);
    assert.deepEqual(othersInOpen(pools, [], [0, 1]).map((o) => o.count), [2, 3]);
  });
  it("says it in notes, never in people", () => {
    assert.equal(crowdLine(0), "You’re the only one crossing right now.");
    assert.equal(crowdLine(1), "1 other note crossing right now.");
    assert.equal(crowdLine(3), "3 other notes crossing right now.");
  });
  it("waits for the batch with the fewest deposits", () => {
    const a = note("queued", { epochLeaves: 3 });
    const b = note("queued", { epochLeaves: 1, denomination: D10, denominationIndex: 0 });
    assert.equal(slowestBatch([a, b, note("claimable")]), b);
    assert.equal(slowestBatch([note("claimable")]), undefined);
  });
});

describe("farLight: the far side as points", () => {
  it("lights the batch you crossed with and the crowd that crossed before it", () => {
    const n = note("claimable", { epochId: "4", epochLeaves: 4 });
    const pools = [{ index: 1, crossed: 12 }];
    const f = farLight([n], pools);
    assert.equal(f.batch.length, 4);
    assert.equal(f.crowd.length, 8); // the pool's 12 already include this batch
  });
  it("does not take a closed batch out of the crowd before it is sent", () => {
    const f = farLight([note("batched", { epochId: "5", epochLeaves: 4 })], [{ index: 1, crossed: 12 }]);
    assert.equal(f.crowd.length, 12);
    assert.equal(f.batch.length, 4);
  });
  it("caps what it draws without adding a point", () => {
    const f = farLight([note("claimed", { epochId: "1", epochLeaves: 4 })], [{ index: 1, crossed: 5000 }], { crowd: 50, batch: 64 });
    assert.equal(f.crowd.length, 50);
    assert.ok(farLight([], [{ index: 1, crossed: 3 }]).crowd.length === 0, "only the journey's sizes");
  });
});

describe("the words", () => {
  const now = 1_000_000;
  it("says how full the batch is and what makes it cross", () => {
    assert.deepEqual(waitLines(note("queued", { epochLeaves: 1 }), { minBatch: 4, multi: false, now }), { l1: "Your batch: 1 of 4 deposits.", l2: "It crosses when 3 more arrive." });
    assert.equal(waitLines(note("queued", { epochLeaves: 3 }), { minBatch: 4, multi: false, now }).l2, "It crosses when 1 more arrives.");
    assert.equal(waitLines(note("queued", { epochLeaves: 2 }), { minBatch: 4, multi: true, now }).l1, "Your $100 batch: 2 of 4 deposits.");
    assert.equal(waitLines(note("queued", { epochLeaves: 4 }), { minBatch: 4, multi: false, now, endsAt: now + 60_000, at: () => "14:20" }).l2, "It can cross from 14:20.");
    assert.equal(waitLines(note("queued", { epochLeaves: 5 }), { minBatch: 4, multi: false, now }).l2, "It crosses as soon as anyone sends it.");
  });
  it("offers the way back when a batch could not fill", () => {
    const n = note("queued", { epochLeaves: 1, fee: 500_000n, refund: { refundable: true, fromSlot: 0n, atMs: 0 } as JourneyNote["refund"] });
    assert.deepEqual(waitLines(n, { minBatch: 4, multi: false, now }), { l1: "Your batch did not fill in a day.", l2: "You can take back $100.50." });
  });
  it("says what the crossing waits for", () => {
    assert.equal(transitLine([note("batched")], true), "Waiting for anyone to send the batch.");
    assert.equal(transitLine([note("sent")], true), "It lands on Aztec within minutes.");
    assert.equal(transitLine([note("sent")], false), "Open Aztec to see it land.");
  });
  it("says in one line what each destination means, and when its time starts", () => {
    assert.equal(destNote("aztec", false), "Ends in your private balance.");
    assert.equal(destNote("ethereum", false), "Most of the wait is Aztec’s proof.");
    assert.equal(destNote("aztec", true), "Ends in your private balance. Times start once your batch crosses.");
    assert.equal(destNote("solana", false), "Times start once 4 exits fill the batch.");
    for (const to of ["aztec", "ethereum", "solana"] as const) assert.ok(destNote(to, true).length <= 72, "two short lines at most");
  });
  it("says what follows a wait for others on the same line", () => {
    assert.equal(thenLine("It crosses when 3 more arrive.", "then about 2–4 min"), "It crosses when 3 more arrive · then about 2–4 min");
    assert.equal(thenLine("It crosses when 3 more arrive.", undefined), "It crosses when 3 more arrive.");
  });
  it("says honestly how long Aztec takes to prove on testnet", () => {
    const eth = exit("burned", { to: "ethereum" });
    assert.equal(leavingLine(eth, { testnet: true, canRead: true }), "Aztec is proving it: about 40–75 min on testnet.");
    assert.equal(leavingLine(eth, { testnet: false, canRead: true }), "Aztec is proving it.");
    assert.equal(leavingLine(exit("batched"), { testnet: true, canRead: true }), "Aztec is proving the batch: about 40–75 min on testnet.");
    assert.equal(leavingLine(exit("burned", { facts: { mined: true, inEpoch: 1, minBatch: 4 } }), { testnet: false, canRead: true }), "Waiting for 3 more exits to fill the batch.");
    assert.equal(leavingLine(exit("burned"), { testnet: false, canRead: false }), "Open Aztec to follow it.");
    assert.equal(leavingLine(exit("sent"), { testnet: false, canRead: true }), "Crossing to Solana.");
  });
  it("names the slowest exit and where the money went", () => {
    const a = exit("arrived"), b = exit("burned");
    assert.equal(slowestExit([a, b, exit("paid")]), b);
    assert.equal(outLine([exit("paid")]), "$100 at 7xKXtg…gAsU");
    assert.equal(outLine([exit("paid", { to: "ethereum", destination: "0x52908400098527886E0F7030069857D2E4169EE7", denomination: D10 })]), "$10 sent to 0x5290…9EE7");
    // A fast exit paid the note minus the front fee, and says so exactly.
    assert.equal(outLine([exit("paid", { facts: { mined: true, paid: true, frontedAdvanced: 99_900_000n } })]), "$99.90 at 7xKXtg…gAsU");
  });
  it("offers Fast only for the notes the pool can front now, largest first", () => {
    const n = (index: number, d: bigint) => ({ index, denomination: d.toString() });
    const notes = [n(1, 100_000_000n), n(2, 1_000_000_000n), n(3, 100_000_000n)];
    // 10 bps: $1,000 advances $999, $100 advances $99.90.
    const all = fastPlan(notes, 2_000_000_000n, 10);
    assert.deepEqual(all.fast.map((x) => x.index), [2, 1, 3]);
    assert.deepEqual(all.wait, []);
    assert.equal(all.fee, 1_000_000n + 2n * 100_000n);
    const some = fastPlan(notes, 1_050_000_000n, 10);
    assert.deepEqual(some.fast.map((x) => x.index), [2]);
    assert.deepEqual(some.wait.map((x) => x.index), [1, 3]);
    assert.equal(some.fee, 1_000_000n);
    const small = fastPlan(notes, 200_000_000n, 10);
    assert.deepEqual(small.fast.map((x) => x.index), [1, 3]);
    assert.deepEqual(fastPlan(notes, 0n, 10).fast, []);
  });
  it("counts down to the eclipse in its own words", () => {
    assert.equal(inText(((2 * 24 + 4) * 60 + 12) * 60_000), "2d 04h");
    assert.equal(inText((4 * 60 + 5) * 60_000), "4h 05m");
    assert.equal(inText(12 * 60_000 + 30_000), "12m");
    assert.equal(inText(20_000), "under a minute");
  });
});

describe("the picture", () => {
  it("holds the camera where the journey is", () => {
    assert.equal(holdOf("amount"), "amount");
    assert.equal(holdOf("decide"), "decide");
    assert.equal(holdOf("depositing"), "decide");
    for (const s of ["sign", "scheduled", "wait"] as const) assert.equal(holdOf(s), "wait");
    assert.equal(holdOf("transit"), "transit");
    assert.equal(holdOf("arrived"), "arrived");
    assert.equal(holdOf("claim"), "claim");
    for (const s of ["claimed", "move", "burning"] as const) assert.equal(holdOf(s), "claimed");
    for (const s of ["leaving", "exit-claim"] as const) assert.equal(holdOf(s), "outwait");
    assert.equal(holdOf("out"), "out");
  });
  it("flies only forwards, through every stage in between", () => {
    assert.deepEqual(flightPath("amount", "decide"), ["send"]);
    assert.deepEqual(flightPath("wait", "transit"), ["cross"]);
    assert.deepEqual(flightPath("wait", "arrived"), ["cross", "ring", "arrive"]);
    assert.deepEqual(flightPath("transit", "arrived"), ["ring", "arrive"]);
    assert.deepEqual(flightPath("claimed", "outwait"), ["moveout"]);
    assert.deepEqual(flightPath("claimed", "amount"), ["back"]);
    assert.deepEqual(flightPath("decide", "wait"), []);
    assert.deepEqual(flightPath("arrived", "claim"), []);
    assert.deepEqual(flightPath("claimed", "wait"), [], "a new crossing jumps, it never flies backwards");
  });
  it("never places the disk higher than the approved prototype while there is room, and keeps the words above the footer", () => {
    const cases: [number, number, number, number][] = [[390, 844, 150, 747], [1440, 900, 92, 803], [390, 844, 300, 747], [360, 640, 130, 543], [1366, 657, 90, 560], [1920, 1080, 92, 983]];
    for (const [W, H, top, bottom] of cases) {
      const g = tunnelLayout(W, H, top, bottom);
      const approved = g.wide ? H * 0.46 : H * 0.38;
      const R0 = g.wide ? Math.min(H * 0.24, W * 0.15) : Math.min(W * 0.32, H * 0.165);
      assert.ok(g.cy >= approved - 1e-6 || g.R <= 0.72 * R0 + 1e-6 || g.cy <= top + 1.18 * g.R + 1e-6, `${W}x${H}: centred at ${g.cy.toFixed(1)}, R ${g.R.toFixed(1)}`);
      assert.ok(g.cy - g.R >= top, `${W}x${H}: the disk clears what is above it`);
      assert.ok(g.lineY >= g.cy + 1.12 * g.R - 1e-6, `${W}x${H}: the words start under the disk`);
      assert.ok(g.lineY + WORDS(g.wide) <= bottom + 1e-6, `${W}x${H}: room for the words above the footer`);
    }
    // the reference screens keep the approved centre and (nearly) the approved size
    const phone = tunnelLayout(390, 844, 150, 747);
    assert.equal(phone.wide, false);
    assert.equal(phone.cy, 844 * 0.38);
    assert.equal(phone.R, 390 * 0.32);
    const desk = tunnelLayout(1440, 900, 92, 803);
    assert.equal(desk.wide, true);
    assert.equal(desk.cy, 900 * 0.46);
    assert.ok(desk.R > 0.97 * 216);
  });

  it("before the crossing, puts the choice under the ring's edge however near the camera comes", () => {
    // Phones and desktops, with and without notices above the tunnel (the testnet run: 390×844).
    const cases: [number, number, number, number][] = [
      [390, 844, 150, 747], [390, 844, 430, 747], [360, 640, 130, 543], [360, 640, 250, 543], [414, 896, 150, 800],
      [1440, 900, 92, 803], [1440, 900, 230, 803], [1366, 657, 90, 560], [1920, 1080, 92, 983],
    ];
    for (const [W, H, top, bottom] of cases) {
      const g = tunnelLayout(W, H, top, bottom);
      const name = `${W}x${H} (top ${top})`;
      assert.ok(g.nearY >= g.lineY, `${name}: never above the usual words`);
      assert.ok(g.nearY + NEAR_WORDS(g.wide) <= bottom + 1e-6, `${name}: the choice stays above the footer`);
      // The nearest the camera comes: the choice's drift, and a full batch.
      for (const cam of [Math.min(g.camNear, NEAR.cam + NEAR.drift), Math.min(g.camNear, NEAR.cam + NEAR.fill)]) {
        assert.ok(g.cy + edgeAt(g, cam) <= g.nearY + 1e-6, `${name}: the ring's edge (${(g.cy + edgeAt(g, cam)).toFixed(0)}) stays above the words (${g.nearY.toFixed(0)}) at cam ${cam.toFixed(2)}`);
      }
    }
    // Where there is room, the camera comes as near as before.
    const phone = tunnelLayout(390, 844, 150, 747);
    assert.ok(phone.camNear >= NEAR.cam + NEAR.drift, `camNear ${phone.camNear}`);
  });
});

describe("failure", () => {
  it("says a technical failure in one short line, the reason kept for Details", () => {
    const f = failure(new Error("Invalid tx: Block header not found"), "Claim failed. Try again.");
    assert.deepEqual(f, { line: "Claim failed. Try again.", why: "Invalid tx: Block header not found" });
    const sql = failure(new Error("SQLITE_ERROR: sqlite3 result code 1: no such table: data"), "Claim failed. Try again.");
    assert.equal(sql.line, "Claim failed. Try again.");
    const long = failure(new Error(`Couldn't reach the Aztec node: ${"x".repeat(120)}. Check your connection and try again.`), "Not moved out. Try again.");
    assert.equal(long.line, "Not moved out. Try again.");
    assert.ok(long.why);
  });

  it("keeps a short reason written for people as the line", () => {
    const f = failure(new Error("Already claimed, maybe from another device. It is in your balance."), "Claim failed. Try again.");
    assert.deepEqual(f, { line: "Already claimed, maybe from another device. It is in your balance." });
  });

  it("without a short line, shows the reason as it is", () => {
    assert.deepEqual(failure(new Error("Connect the wallet that made this deposit.")), { line: "Connect the wallet that made this deposit." });
  });
});
