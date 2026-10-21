/**
 * When the landing's horn calls come (conductor in src/app/(landing)/sound.ts): the first at once,
 * then one every 20-35 s whatever the scroll, never overlapping, and the crossing bringing the
 * answer forward without adding a call. Run with `pnpm --filter @eclyps/app test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conductor, TUNING, type Call } from "../src/app/(landing)/sound.ts";

const C = TUNING.calls;
type Heard = Call & { end: number };

/** Ticks a conductor every quarter second, as the page does; calls last `length(call)` s. */
function visit(seconds: number, rng: () => number, progressAt: (t: number) => number, length: (c: Call) => number) {
  const heard: Heard[] = [];
  const c = conductor(rng);
  for (let t = 0; t < seconds; t += 0.25) {
    c.tick(t, progressAt(t), (call) => { const end = call.at + length(call); heard.push({ ...call, end }); return end; });
  }
  return heard;
}
const typical = (c: Call) => (c.kind === "first" ? 17 : c.kind === "answer" ? 13 : 11);
const still = () => 0;
const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const character = (c: Call) => (c.kind === "distant" ? (c.distance! < 0.5 ? "near" : "far") : c.kind);

describe("calls", () => {
  it("come about five times in a two-minute visit, whatever the scroll", () => {
    const heard = visit(120, () => 0.5, still, typical);
    assert.deepEqual(heard.map(character), ["first", "answer", "near", "far", "near"]);
    assert.ok(heard[0]!.at <= C.entry[1]);
  });

  it("alternate near and far after the answer, never overlap, and keep the quiet between them", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = seeded(seed);
      const heard = visit(600, rng, still, (c) => (c.kind === "first" ? 14 + 6 * rng() : 9 + 6 * rng()));
      assert.deepEqual(heard.slice(0, 6).map(character), ["first", "answer", "near", "far", "near", "far"]);
      for (let i = 1; i < heard.length; i++) {
        const a = heard[i - 1]!, b = heard[i]!;
        assert.ok(b.at >= a.end + C.gap, `call ${i} waits for the quiet`);
        assert.ok(b.at - a.at >= C.every[0], `call ${i} is not early`);
        assert.ok(b.at <= Math.max(a.at + C.every[1], a.end + C.gap) + 0.3, `call ${i} is not late`);
        if (b.distance !== undefined) {
          const [lo, hi] = character(b) === "near" ? TUNING.distant.nearAt : TUNING.distant.farAt;
          assert.ok(b.distance >= lo && b.distance <= hi);
        }
      }
    }
  });

  it("the crossing brings the answer forward in place of the next timed call", () => {
    const late = () => 0.999; // the timed calls as late as they come
    const alone = visit(200, late, still, typical);
    const crossed = visit(200, late, (t) => (t >= 90 ? 1 : 0), typical);
    // the third call (near) ends at about 82 s; the answer then comes once the quiet allows
    assert.equal(character(crossed[2]!), "near");
    assert.equal(crossed[3]!.kind, "answer");
    assert.ok(crossed[3]!.at <= Math.max(90, crossed[2]!.end + C.gap) + 0.3);
    assert.ok(crossed[3]!.at < alone[3]!.at - 10);
    // it takes the next call's place rather than adding one: the timer runs on from it
    assert.equal(character(crossed[4]!), "near");
    assert.ok(crossed[4]!.at - crossed[3]!.at >= C.every[0]);
  });

  it("the crossing during the first call brings the answer right after the quiet", () => {
    const crossed = visit(60, () => 0.999, (t) => (t >= 5 ? 1 : 0), typical);
    assert.equal(crossed[1]!.kind, "answer");
    assert.ok(crossed[1]!.at <= crossed[0]!.end + C.gap + 0.3);
  });

  it("the crossing just after the answer changes nothing", () => {
    const alone = visit(200, () => 0.5, still, typical);
    const crossed = visit(200, () => 0.5, (t) => (t >= 45 ? 1 : 0), typical);
    assert.deepEqual(crossed, alone);
  });
});
