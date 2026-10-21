/**
 * The poller behind Move out's exit reads (src/lib/poller.ts): one look at a time, backoff on
 * failure, nothing after stop. Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backoffDelay, inChunks, startPoller } from "../src/lib/poller.ts";

/** A hand-driven clock: timers run only when the test says so. */
function fakeTimers() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    pending: () => [...timers.values()].map((t) => t.ms),
    /** Runs every timer due now. */
    fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
    },
  };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/** A look that stays in flight until released. */
function gate() {
  let release!: (fail?: boolean) => void;
  const p = new Promise<void>((res, rej) => (release = (fail) => (fail ? rej(new Error("node down")) : res())));
  return { p, release };
}

describe("startPoller", () => {
  it("looks at once, then only after the last look ends", async () => {
    const t = fakeTimers();
    let looks = 0;
    let inFlight = 0;
    let most = 0;
    const gates: ReturnType<typeof gate>[] = [];
    const poller = startPoller(
      async () => {
        looks++;
        inFlight++;
        most = Math.max(most, inFlight);
        const g = gate();
        gates.push(g);
        await g.p;
        inFlight--;
      },
      { intervalMs: 15_000, setTimer: t.setTimer, clearTimer: t.clearTimer },
    );
    assert.equal(looks, 1);
    // A slow look: no timer is set while it runs, however long it takes.
    assert.deepEqual(t.pending(), []);
    t.fire();
    await flush();
    assert.equal(looks, 1);
    gates[0]!.release();
    await flush();
    assert.deepEqual(t.pending(), [15_000]);
    t.fire();
    await flush();
    assert.equal(looks, 2);
    assert.equal(most, 1);
    poller.stop();
    gates[1]!.release();
  });

  it("backs off while looks fail, and returns to the interval after a success", async () => {
    const t = fakeTimers();
    let fail = true;
    const errors: unknown[] = [];
    const poller = startPoller(
      async () => {
        if (fail) throw new Error("ERR_INSUFFICIENT_RESOURCES");
      },
      { intervalMs: 1_000, maxMs: 5_000, setTimer: t.setTimer, clearTimer: t.clearTimer, onError: (e) => errors.push(e) },
    );
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await flush();
      delays.push(...t.pending());
      if (i < 3) t.fire();
    }
    assert.deepEqual(delays, [2_000, 4_000, 5_000, 5_000]);
    assert.equal(errors.length, 4);
    fail = false;
    t.fire();
    await flush();
    assert.deepEqual(t.pending(), [1_000]);
    poller.stop();
  });

  it("stops: no timer left, and a look in flight schedules nothing", async () => {
    const t = fakeTimers();
    const g = gate();
    let looks = 0;
    let liveAfter: boolean | undefined;
    const poller = startPoller(
      async (live) => {
        looks++;
        await g.p;
        liveAfter = live();
      },
      { intervalMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer },
    );
    poller.stop();
    g.release();
    await flush();
    assert.equal(liveAfter, false);
    assert.deepEqual(t.pending(), []);
    t.fire();
    await flush();
    assert.equal(looks, 1);
  });

  it("stop() clears a scheduled look", async () => {
    const t = fakeTimers();
    let looks = 0;
    const poller = startPoller(async () => void looks++, { intervalMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    await flush();
    assert.deepEqual(t.pending(), [1_000]);
    poller.stop();
    assert.deepEqual(t.pending(), []);
    assert.equal(looks, 1);
  });
});

describe("backoffDelay", () => {
  it("doubles from the interval up to the ceiling", () => {
    assert.equal(backoffDelay(15_000, 0), 15_000);
    assert.equal(backoffDelay(15_000, 1), 30_000);
    assert.equal(backoffDelay(15_000, 2), 60_000);
    assert.equal(backoffDelay(15_000, 10), 120_000);
    assert.equal(backoffDelay(15_000, 10, 60_000), 60_000);
  });
});

describe("inChunks", () => {
  it("reads in order, never more than `width` at once", async () => {
    let now = 0;
    let most = 0;
    const out = await inChunks(10, 4, async (i) => {
      now++;
      most = Math.max(most, now);
      await flush();
      now--;
      return i * i;
    });
    assert.deepEqual(out, [0, 1, 4, 9, 16, 25, 36, 49, 64, 81]);
    assert.equal(most, 4);
  });
});
