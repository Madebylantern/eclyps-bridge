import { describe, expect, it } from "vitest";
import {
  adviseClaim,
  adviseExit,
  adviseShield,
  anonymityLevel,
  planSchedule,
  type PoolStats,
  splitAmount,
} from "../src/advisor.js";

const $ = (n: number) => BigInt(n) * 1_000_000n;
const D = [$(10), $(100), $(1_000), $(10_000)];
const pool = (d: bigint, crossed: number, openEpochLeaves = 1): PoolStats => ({ denomination: d, crossed, batches: 1, openEpochLeaves, minBatch: 4, cap: 4 });

/** Deterministic PRNG for reproducible schedules. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("splitAmount", () => {
  it("splits largest first", () => {
    expect(splitAmount($(1_300), D)).toEqual({ notes: [$(1_000), $(100), $(100), $(100)], remainder: 0n });
    expect(splitAmount($(12_345), D).notes.map(String)).toEqual(
      [$(10_000), $(1_000), $(1_000), $(100), $(100), $(100), $(10), $(10), $(10), $(10)].map(String),
    );
    expect(splitAmount($(12_345), D).remainder).toBe($(5));
  });
  it("keeps what notes cannot express", () => {
    expect(splitAmount($(7), D)).toEqual({ notes: [], remainder: $(7) });
  });
  it("caps the number of notes", () => {
    expect(splitAmount($(1_000), [$(10)], 5)).toEqual({ notes: Array(5).fill($(10)), remainder: $(950) });
  });
});

describe("planSchedule", () => {
  const epochMs = 3_600_000;
  const now = 1_700_000_000_000;

  it("keeps every pair of deposits at least one epoch apart, inside the window", () => {
    for (let s = 1; s < 50; s++) {
      const notes = splitAmount($(1_300), D).notes;
      const { schedule, fits } = planSchedule(notes, { now, windowMs: 24 * epochMs, epochMs, random: mulberry32(s) });
      expect(fits).toBe(true);
      expect(schedule).toHaveLength(4);
      const times = schedule.map((x) => x.at);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(epochMs);
      expect(Math.min(...times)).toBeGreaterThanOrEqual(now);
      expect(Math.max(...times)).toBeLessThanOrEqual(now + 24 * epochMs);
      expect(schedule.map((x) => x.denomination).sort().map(String)).toEqual(notes.slice().sort().map(String));
    }
  });

  it("reports a window that is too short and the minimum that works", () => {
    const r = planSchedule([$(100), $(100), $(100)], { now, windowMs: epochMs, epochMs, random: mulberry32(7) });
    expect(r.fits).toBe(false);
    expect(r.minWindowMs).toBe(2 * epochMs);
    const t = r.schedule.map((x) => x.at);
    expect(t[1]! - t[0]!).toBeGreaterThanOrEqual(epochMs);
  });

  it("handles one note and no notes", () => {
    expect(planSchedule([], { now, windowMs: 0, epochMs }).schedule).toEqual([]);
    expect(planSchedule([$(10)], { now, windowMs: 0, epochMs }).fits).toBe(true);
  });

  it("keeps notes inside a fixed window when asked, even if it is too short", () => {
    const notes = [$(1_000), $(100), $(100), $(100), $(10), $(10)];
    const windowMs = 2 * epochMs;
    for (let s = 1; s < 30; s++) {
      const r = planSchedule(notes, { now, windowMs, epochMs, random: mulberry32(s), withinWindow: true });
      expect(r.fits).toBe(false);
      expect(r.minWindowMs).toBe(5 * epochMs);
      const t = r.schedule.map((x) => x.at);
      expect(t).toHaveLength(6);
      expect(Math.min(...t)).toBeGreaterThanOrEqual(now);
      expect(Math.max(...t)).toBeLessThanOrEqual(now + windowMs);
      for (let i = 1; i < t.length; i++) expect(t[i]! - t[i - 1]!).toBeGreaterThanOrEqual(Math.floor(windowMs / 6) - 1);
      expect(r.schedule.map((x) => x.denomination).sort().map(String)).toEqual(notes.slice().sort().map(String));
    }
    // A window that fits behaves exactly as without the flag.
    const a = planSchedule(notes.slice(0, 2), { now, windowMs, epochMs, random: mulberry32(3), withinWindow: true });
    const b = planSchedule(notes.slice(0, 2), { now, windowMs, epochMs, random: mulberry32(3) });
    expect(a).toEqual(b);
  });
});

describe("advisor", () => {
  it("levels", () => {
    expect([0, 15, 16, 63, 64].map(anonymityLevel)).toEqual(["very weak", "very weak", "weak", "weak", "moderate"]);
  });

  it("flags deposits made together and mixed amounts", () => {
    const ids = adviseShield({ notes: [$(1_000), $(100), $(100), $(100)], mode: "now", pools: [pool($(1_000), 100), pool($(100), 100)] }).map((a) => a.id);
    expect(ids).toContain("same-epoch");
    expect(ids).toContain("amount-pattern");
    const spread = adviseShield({ notes: [$(100)], mode: "spread", pools: [pool($(100), 100)], scheduleFits: true }).map((a) => a.id);
    expect(spread).not.toContain("same-epoch");
    expect(spread).toContain("scheduled-needs-you");
  });

  it("warns about thin pools and empty epochs", () => {
    const a = adviseShield({ notes: [$(10_000)], mode: "now", pools: [pool($(10_000), 3, 0)] });
    expect(a.find((x) => x.id === `thin-${$(10_000)}`)?.severity).toBe("risk");
    expect(a.map((x) => x.id)).toContain("first-in-epoch");
    const many = adviseShield({ notes: [$(1_000), $(100), $(10)], mode: "spread", pools: [pool($(1_000), 0, 0), pool($(100), 2, 0), pool($(10), 30, 0)], scheduleFits: true });
    expect(many.filter((x) => x.id.startsWith("thin")).map((x) => x.id)).toEqual(["thin-pools-risk", `thin-${$(10)}`]);
    expect(many.filter((x) => x.id === "first-in-epoch")).toHaveLength(1);
    expect(adviseShield({ notes: [$(100)], mode: "now", pools: [pool($(100), 20)] }).find((x) => x.id.startsWith("thin"))?.severity).toBe("caution");
  });

  it("warns when claiming from the newest batch", () => {
    const ids = adviseClaim({ denomination: $(100), epochId: 5n, latestSentEpoch: 5n, pool: pool($(100), 200) }).map((a) => a.id);
    expect(ids).toEqual(["newest-batch"]);
    expect(adviseClaim({ denomination: $(100), epochId: 4n, latestSentEpoch: 5n, pool: pool($(100), 200) }).map((a) => a.id)).toEqual(["claim-ok"]);
  });

  it("warns about exiting to a depositing wallet, soon after a claim, or as a mix", () => {
    const now = Date.now();
    const ids = adviseExit({ destination: "W1", depositWallets: ["W1"], now, lastClaimAt: now - 60_000, notes: [$(100), $(10)] }).map((a) => a.id);
    expect(ids).toEqual(["same-wallet", "exit-soon", "exit-pattern"]);
    expect(adviseExit({ destination: "W2", depositWallets: ["W1"], now, lastClaimAt: now - 7 * 3_600_000, notes: [$(100)] })).toEqual([]);
  });
});

describe("auditNotes", () => {
  it("finds shared epochs and mixed deposits close in time", async () => {
    const { auditNotes } = await import("../src/advisor.js");
    const t = 1_700_000_000_000;
    const a = auditNotes(
      [
        { index: 0, denominationIndex: 1, denomination: $(100), epochId: 3n, depositedAt: t },
        { index: 1, denominationIndex: 1, denomination: $(100), epochId: 3n, depositedAt: t + 10_000 },
        { index: 2, denominationIndex: 2, denomination: $(1_000), epochId: 7n, depositedAt: t + 20_000 },
        { index: 3, denominationIndex: 1, denomination: $(100) },
      ],
      3_600_000,
    );
    expect(a.map((x) => x.id)).toEqual(["shared-epoch-1:3", "mixed-1-2"]);
    expect(auditNotes([{ index: 0, denominationIndex: 0, denomination: $(10), epochId: 1n, depositedAt: t }], 1)).toEqual([]);
  });
});

describe("openEpochBlocker", () => {
  it("holds a note while one of the same denomination is in the open epoch", async () => {
    const { openEpochBlocker } = await import("../src/advisor.js");
    const own = [
      { index: 0, denominationIndex: 1, epochId: 4n },
      { index: 1, denominationIndex: 2, epochId: 4n },
      { index: 2, denominationIndex: 1 },
    ];
    expect(openEpochBlocker({ index: 2, denominationIndex: 1 }, own, 4n)).toBe(0);
    expect(openEpochBlocker({ index: 2, denominationIndex: 1 }, own, 5n)).toBeUndefined();
    expect(openEpochBlocker({ index: 3, denominationIndex: 0 }, own, 4n)).toBeUndefined();
    expect(openEpochBlocker({ index: 0, denominationIndex: 1 }, own, 4n)).toBeUndefined();
  });

  it("is announced when a spread plan repeats a denomination", () => {
    const ids = adviseShield({ notes: [$(100), $(100)], mode: "spread", pools: [pool($(100), 100)], scheduleFits: true }).map((a) => a.id);
    expect(ids).toContain("rollover-hold");
    expect(adviseShield({ notes: [$(100), $(10)], mode: "spread", pools: [pool($(100), 100), pool($(10), 100)], scheduleFits: true }).map((a) => a.id)).not.toContain("rollover-hold");
  });
});
