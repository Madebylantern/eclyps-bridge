import { gauss, GOLDEN, mulberry32, TAU } from "./rng";

// The still drawings: inline SVG in white points and hairlines on black. Point positions come from
// a seeded generator, so the server and the browser draw exactly the same picture.

const f1 = (n: number) => Math.round(n * 10) / 10;

/** Points on a sunflower disk: even spacing, no centre, no edge, no "first" point. */
function sunflower(count: number, spacing: number) {
  return Array.from({ length: count }, (_, i) => {
    const r = spacing * Math.sqrt(i + 0.5);
    const th = i * GOLDEN;
    return { x: f1(r * Math.cos(th)), y: f1(r * Math.sin(th)) };
  });
}

// ---------------------------------------------------------------- the crowd

/**
 * Many identical notes of one size, and the faint ring a claim proves membership of. No note is
 * marked: a claim says "one of these", never which. Three groups breathe slowly out of step.
 */
export function CrowdFigure() {
  const pts = sunflower(170, 9.2);
  const groups = [0, 1, 2].map((g) => pts.filter((_, i) => (i * 7 + (i >> 3)) % 3 === g));
  return (
    <svg className="c-disk" viewBox="-150 -150 300 300" role="img" aria-label="A disk of many identical points, inside one faint ring">
      <circle r="136" fill="none" stroke="#555" strokeWidth="0.8" strokeDasharray="1 5" />
      {groups.map((g, k) => (
        <g key={k} className={`breathe b${k}`} fill="#fff">
          {g.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="2.3" />
          ))}
        </g>
      ))}
    </svg>
  );
}

const SPOTS = [
  [22, 30], [60, 20], [100, 34], [138, 22], [38, 64], [80, 62], [124, 66],
] as const;
const ANY = [2.2, 6.6, 3.4, 8.6, 1.6, 4.9, 2.8];

/** Why fixed sizes: different amounts each stand out; notes of one size look alike. */
export function SizesPair() {
  return (
    <div className="pair">
      <figure>
        <svg viewBox="0 0 160 90" aria-hidden="true">
          {SPOTS.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={ANY[i]} fill="#fff" fillOpacity="0.9" />
          ))}
        </svg>
        <figcaption>
          <b>Any amount</b>
          Each one stands out.
        </figcaption>
      </figure>
      <figure>
        <svg viewBox="0 0 160 90" aria-hidden="true">
          {SPOTS.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="3.6" fill="#fff" fillOpacity="0.9" />
          ))}
        </svg>
        <figcaption>
          <b>Fixed sizes</b>
          They look alike.
        </figcaption>
      </figure>
    </div>
  );
}

/** Why waiting helps: right after your batch lands, timing points at it; later the crowd is wider. */
export function WaitPair() {
  const few = sunflower(4, 8.5);
  const many = sunflower(30, 8.5);
  return (
    <div className="pair">
      <figure>
        <svg viewBox="-60 -60 120 120" aria-hidden="true">
          <circle r="54" fill="none" stroke="#1d1d1d" strokeWidth="1" strokeDasharray="1 4" />
          {few.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="2.6" fill="#fff" />
          ))}
        </svg>
        <figcaption>
          <b>Claim right away</b>
          Timing points at your batch.
        </figcaption>
      </figure>
      <figure>
        <svg viewBox="-60 -60 120 120" aria-hidden="true">
          <circle r="54" fill="none" stroke="#1d1d1d" strokeWidth="1" strokeDasharray="1 4" />
          {many.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="2.6" fill="#fff" />
          ))}
        </svg>
        <figcaption>
          <b>Claim after later batches</b>
          More notes could be yours.
        </figcaption>
      </figure>
    </div>
  );
}

// ---------------------------------------------------------------- the weekly eclipse

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const R = 30;
/** How far the moon sits from the disk's centre each day: clear the day after the eclipse, total on its day. */
const OFFSETS = [64, 50, 40, 30, 20, 10, 0];

const corona = (() => {
  const rnd = mulberry32(1018);
  const limb = Array.from({ length: 70 }, () => {
    const th = rnd() * TAU;
    const r = R + 1.2 + Math.abs(gauss(rnd)) * 0.5;
    return { x: f1(Math.cos(th) * r), y: f1(Math.sin(th) * r), r: 0.55, o: f1(0.6 + 0.4 * rnd()) };
  });
  const rays = Array.from({ length: 150 }, () => {
    const th = rnd() * TAU;
    const down = Math.max(0, Math.sin(th));
    const reach = 4 + 11 * down + 6 * Math.abs(Math.sin(th * 3 + 0.6));
    const u = Math.pow(rnd(), 1.6);
    const r = R + 1.8 + u * reach;
    return { x: f1(Math.cos(th) * r), y: f1(Math.sin(th) * r), r: f1(0.4 + 0.45 * rnd()), o: f1((1 - u) * (0.35 + 0.6 * rnd())) };
  });
  return [...limb, ...rays];
})();

/**
 * The week as an eclipse: a stippled white disk, whole the day after the eclipse, covered a little
 * more each day, total on the eclipse day (a ring of light), then whole again. Days end on `weekday`.
 */
export function EclipseWeek({ weekday, hour }: { weekday: number; hour: string }) {
  const days = Array.from({ length: 8 }, (_, i) => (weekday + 1 + i) % 7);
  return (
    <figure className="e-week">
      <svg viewBox="0 0 800 128" role="img" aria-label={`A white disk covered a little more each day, fully covered on ${DAY[weekday]} at ${hour} UTC, then whole again`}>
        <defs>
          <pattern id="dx-stipple" width="3.4" height="3.4" patternUnits="userSpaceOnUse">
            <circle cx="0.9" cy="0.9" r="0.72" fill="#fff" />
            <circle cx="2.6" cy="2.4" r="0.6" fill="#fff" fillOpacity="0.85" />
          </pattern>
          <clipPath id="dx-disk">
            <circle r={R} />
          </clipPath>
          <radialGradient id="dx-halo">
            <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.66" stopColor="#fff" stopOpacity="0.22" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        {days.map((_, i) => {
          const cx = 50 + i * 100;
          const cy = 60;
          const total = i === 6;
          const reset = i === 7;
          return (
            <g key={i} transform={`translate(${cx} ${cy})`} opacity={reset ? 0.45 : 1}>
              {!total && <circle r={R} fill="url(#dx-stipple)" />}
              {total && (
                <>
                  <circle r={R * 1.5} fill="url(#dx-halo)" />
                  {corona.map((p, k) => (
                    <circle key={k} cx={p.x} cy={p.y} r={p.r} fill="#fff" fillOpacity={p.o} />
                  ))}
                </>
              )}
              {/* the moon, seen only where it covers the disk */}
              {i > 0 && !reset && !total && <circle cx={OFFSETS[i]} r={R + 0.6} fill="#000" clipPath="url(#dx-disk)" />}
              {total && <circle r={R + 0.6} fill="#000" />}
            </g>
          );
        })}
      </svg>
      <div className="e-days" aria-hidden="true">
        {days.map((d, i) => (
          <span key={i} className={i === 6 ? "on" : i === 7 ? "again" : undefined}>
            {DAY[d]}
          </span>
        ))}
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------- the recovery phrase

/** 24 numbered slots, the words veiled: what the recovery phrase looks like, without a phrase. */
export function PhraseSlots() {
  return (
    <ol className="k-phrase" aria-label="A recovery phrase: 24 words">
      {Array.from({ length: 24 }, (_, i) => (
        <li key={i}>
          <span className="mono">{String(i + 1).padStart(2, "0")}</span>
          <i />
        </li>
      ))}
    </ol>
  );
}
