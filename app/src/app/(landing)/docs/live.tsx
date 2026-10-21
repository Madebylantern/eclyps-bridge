"use client";

import { useEffect, useRef, useState } from "react";
import { EclipseWeek } from "./figures";

// The parts of Docs that read the page or the network: the top bar (which section you are in),
// facts from /deployment.json (note sizes, batch size, the weekly eclipse) and the addresses to
// verify. The deployment is read once, in the browser, like the app does; nothing is invented when
// it is missing, the static text stays.

/** The few fields Docs reads from deployment.json. Everything is optional: it is checked at use. */
interface DocsDeployment {
  network?: unknown;
  solana?: { gateway?: unknown; treasury?: unknown };
  l1?: { portal?: unknown };
  aztec?: { claims?: unknown };
  denominations?: unknown;
  params?: { minBatchSize?: unknown };
  totality?: { weekday?: unknown; hourUtc?: unknown; minutes?: unknown; first?: unknown };
}

let pending: Promise<DocsDeployment | null> | undefined;
function readDeployment(): Promise<DocsDeployment | null> {
  pending ??= fetch("/deployment.json", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<DocsDeployment>) : null))
    .then((d) => (d && typeof d === "object" ? d : null))
    .catch(() => null);
  return pending;
}

/** undefined while reading, null when the site has no deployment.json. */
function useDeployment(): DocsDeployment | null | undefined {
  const [dep, setDep] = useState<DocsDeployment | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readDeployment().then((d) => live && setDep(d));
    return () => {
      live = false;
    };
  }, []);
  return dep;
}

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

function usd(baseUnits: string): string | undefined {
  try {
    const v = Number(BigInt(baseUnits)) / 1e6;
    return v > 0 ? `$${v.toLocaleString("en-US")}` : undefined;
  } catch {
    return undefined;
  }
}

const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// ---------------------------------------------------------------- top bar

const SECTIONS: [id: string, word: string][] = [
  ["what", "What"],
  ["how", "How"],
  ["crowd", "Crowd"],
  ["totality", "Eclipse"],
  ["public", "Public"],
  ["limits", "Limits"],
  ["keys", "Keys"],
  ["fees", "Fees"],
  ["status", "Status"],
  ["verify", "Verify"],
];

export function TopBar() {
  const [on, setOn] = useState<string>();
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setOn(e.target.id);
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
  // On narrow screens the words scroll sideways: keep the current one in view.
  useEffect(() => {
    const n = nav.current;
    const a = on ? n?.querySelector<HTMLElement>(`a[href="#${on}"]`) : null;
    if (!n || !a || n.scrollWidth <= n.clientWidth) return;
    const left = a.offsetLeft - n.offsetLeft;
    if (left < n.scrollLeft + 8 || left + a.offsetWidth > n.scrollLeft + n.clientWidth - 24) n.scrollLeft = Math.max(0, left - 24);
  }, [on]);
  return (
    <header className="d-bar">
      <div className="w d-bar-in">
        <a className="d-mark" href="/" aria-label="Eclyps home">ECLYPS</a>
        <nav className="d-nav" ref={nav} aria-label="Sections">
          {SECTIONS.map(([id, word]) => (
            <a key={id} href={`#${id}`} className={on === id ? "on" : undefined} aria-current={on === id ? "location" : undefined}>
              {word}
            </a>
          ))}
        </nav>
        <a className="d-open" href="/app/">Open app</a>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- facts from the network

/** The smallest batch that sends on this network (the program never allows fewer than 4). */
export function useMinBatch(): number {
  const dep = useDeployment();
  const m = dep?.params?.minBatchSize;
  return int(m, 4, 64) ? m : 4;
}

/** "Sizes on this network: $1 and $10." Nothing until the deployment is read. */
export function NoteSizes() {
  const dep = useDeployment();
  const ds = Array.isArray(dep?.denominations) ? dep.denominations.filter(str).map(usd).filter((s): s is string => !!s) : [];
  if (ds.length === 0) return null;
  return <p className="d-net">Sizes on this network: {and(ds)}.</p>;
}

// ---------------------------------------------------------------- the weekly eclipse

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = 7 * 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

interface Schedule {
  weekday: number;
  hourUtc: number;
  minutes: number;
  firstMs: number;
}

/** deployments/testnet.json `totality`, shown until (or unless) the site's own deployment says otherwise. */
const TESTNET: Schedule = { weekday: 0, hourUtc: 20, minutes: 60, firstMs: Date.UTC(2026, 9, 18, 20) };

function parseSchedule(t: DocsDeployment["totality"]): Schedule | undefined {
  if (!t || typeof t !== "object") return undefined;
  if (!int(t.weekday, 0, 6) || !int(t.hourUtc, 0, 23) || !int(t.minutes, 1, 1440) || !str(t.first)) return undefined;
  if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(t.first.trim())) return undefined;
  const firstMs = Date.parse(t.first);
  if (!Number.isFinite(firstMs)) return undefined;
  const f = new Date(firstMs);
  if (f.getUTCDay() !== t.weekday || f.getUTCHours() !== t.hourUtc || f.getUTCMinutes()) return undefined;
  return { weekday: t.weekday, hourUtc: t.hourUtc, minutes: t.minutes, firstMs };
}

const clockUtc = (ms: number) => `${pad(new Date(ms).getUTCHours())}:${pad(new Date(ms).getUTCMinutes())}`;
const dateUtc = (ms: number) => {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** The eclipse drawing with its schedule: the next one, and the hour of totality. */
export function EclipseSchedule() {
  const dep = useDeployment();
  const [now, setNow] = useState<number>();
  useEffect(() => setNow(Date.now()), []);
  const parsed = dep ? parseSchedule(dep.totality) : undefined;
  const none = dep !== undefined && dep !== null && !parsed;
  const s = parsed ?? TESTNET;
  const hour = `${pad(s.hourUtc)}:00`;
  const end = clockUtc(Date.UTC(2026, 0, 4, s.hourUtc) + s.minutes * 60_000);
  // the first eclipse that has not ended yet (window n starts n - 1 weeks after the first)
  let next = s.firstMs;
  if (now !== undefined && now > s.firstMs + s.minutes * 60_000) next = s.firstMs + Math.ceil((now - s.firstMs - s.minutes * 60_000) / WEEK) * WEEK;
  const isOn = now !== undefined && now >= next && now < next + s.minutes * 60_000;

  return (
    <div className="e-sched">
      <EclipseWeek weekday={s.weekday} hour={hour} />
      {none ? (
        <p className="e-when">No eclipse is scheduled on this network yet.</p>
      ) : (
        <div className="e-when">
          <p className="e-next">
            {isOn ? (
              <>The eclipse is on until {end} UTC.</>
            ) : (
              <>
                Next eclipse: <span className="hi">{dateUtc(next)}, {hour} UTC</span>
              </>
            )}
          </p>
          <p>
            Totality is {WEEKDAYS[s.weekday]}, {hour} to {end} UTC: the {s.minutes === 60 ? "hour" : "time"} people aim to move in together, every week.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- verify

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="d-copy"
      aria-label={`Copy the ${label} address`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          /* clipboard blocked: the address stays selectable */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** The contracts anyone can inspect, read from /deployment.json. Missing ones are left out. */
export function Addresses() {
  const dep = useDeployment();
  if (dep === undefined) return <p className="v-wait">Reading the deployment…</p>;
  if (dep === null) return <p className="v-wait">This site has no deployment attached yet. Its addresses will appear here.</p>;

  const rows: { chain: string; what: string; value: string }[] = [];
  if (str(dep.solana?.gateway)) rows.push({ chain: "Solana", what: "Eclyps gateway program", value: dep.solana.gateway.trim() });
  if (str(dep.solana?.treasury)) rows.push({ chain: "Solana", what: "Eclyps treasury (fees)", value: dep.solana.treasury.trim() });
  const portal = str(dep.l1?.portal) ? dep.l1.portal.trim() : undefined;
  if (portal) rows.push({ chain: "Ethereum", what: "Eclyps portal", value: portal });
  const claims = dep.aztec?.claims && typeof dep.aztec.claims === "object" ? Object.entries(dep.aztec.claims as Record<string, unknown>) : [];
  const claimRows = claims
    .filter((e): e is [string, string] => str(e[1]))
    .sort((a, b) => (BigInt(/^\d+$/.test(a[0]) ? a[0] : "0") < BigInt(/^\d+$/.test(b[0]) ? b[0] : "0") ? -1 : 1))
    .map(([d, v]) => ({ chain: "Aztec", what: `Eclyps claim contract${usd(d) ? `, ${usd(d)} notes` : ""}`, value: v.trim() }));
  rows.push(...claimRows);
  const missing = [!portal && "the Ethereum portal", claimRows.length === 0 && "the Aztec claim contracts"].filter((x): x is string => !!x);
  const net = str(dep.network) ? dep.network : undefined;

  return (
    <div className="v-list">
      {net && <span className="label">On {net}</span>}
      <ul>
        {rows.map((r) => (
          <li key={r.value}>
            <span className="v-what">
              {r.chain} <span className="v-dot">·</span> {r.what}
            </span>
            <span className="v-addr">
              <span className="mono">{r.value}</span>
              <Copy value={r.value} label={`${r.chain} ${r.what}`} />
            </span>
          </li>
        ))}
      </ul>
      {missing.length > 0 && <p className="v-wait">{and(missing).replace(/^t/, "T")} will appear here once deployed.</p>}
    </div>
  );
}
