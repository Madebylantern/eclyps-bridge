/** Time and count wording shared by the views. Everything is local time, in the user's locale. */

const DAY = 86_400_000;
const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "14:20", "tomorrow 09:05", "Sun 20:03" within a week, else "Oct 25 09:05". */
export function clock(ms: number, now = Date.now()): string {
  const t = new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days === 0) return t;
  if (days === 1) return `tomorrow ${t}`;
  if (days === -1) return `yesterday ${t}`;
  const day = Math.abs(days) < 7 ? { weekday: "short" as const } : { month: "short" as const, day: "numeric" as const };
  return `${new Date(ms).toLocaleDateString(undefined, day)} ${t}`;
}

export function relTime(ms: number, now = Date.now()): string {
  const d = ms - now;
  const a = Math.abs(d);
  const unit = a < 90_000 ? `${Math.round(a / 1000)} s` : a < 5_400_000 ? `${Math.round(a / 60_000)} min` : a < 172_800_000 ? `${(a / 3_600_000).toFixed(1)} h` : `${Math.round(a / DAY)} d`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Rough wall-clock time until a slot (Solana slots are ~400 ms). */
export function etaFromSlots(slots: bigint): string {
  const s = Number(slots) * 0.4;
  if (s <= 0) return "now";
  if (s < 90) return `~${Math.round(s)} s`;
  if (s < 5400) return `~${Math.round(s / 60)} min`;
  return `~${(s / 3600).toFixed(1)} h`;
}

/** "0:42", "12:05", "1:02:09". */
export function stopwatch(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How full the batch forming in an open epoch is: "3 of 4 deposits", or "4 deposits, enough to send". */
export const batchFill = (leaves: number, minBatch: number) =>
  leaves >= minBatch ? `${plural(leaves, "deposit")}, enough to send` : `${leaves} of ${minBatch} deposits`;

/** "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The anonymity set in plain words: "1 in 12". Zero means nobody has crossed yet. */
export const oneIn = (set: number) => (set > 0 ? `1 in ${set.toLocaleString("en-US")}` : "no crowd yet");

export const shortAddr = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
