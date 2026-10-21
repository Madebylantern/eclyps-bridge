/**
 * Reminders for scheduled deposits. There is no Eclyps server, and a scheduled deposit only happens
 * while this page is open and the user signs, so the app offers three local nudges:
 *   - an .ics calendar file generated in the browser (the calendar provider will see the times);
 *   - a browser notification when a note falls due while the tab is open (opt-in);
 *   - a "(1)" prefix in the tab title.
 * Event titles and notifications carry no amounts. Totality (totality.ts) gets one weekly event.
 */
import { useEffect, useRef } from "react";
import { APP_TITLE } from "./deployment";
import { type Totality, totalityStatus } from "./totality";
import { download } from "./vault";

const pad = (n: number) => String(n).padStart(2, "0");
const icsTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

/** RFC 5545 folds lines longer than 75 octets (the text here is ASCII). */
const fold = (line: string) => line.match(/.{1,74}/g)!.join("\r\n ");

export const REMINDER_TITLE = "Eclyps: deposit due";

/** One VEVENT per planned deposit time. */
export function depositCalendar(times: number[], now = Date.now()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Eclyps//Deposit reminders//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const t of [...times].sort((a, b) => a - b)) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${crypto.randomUUID()}@eclyps.invalid`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(t)}`,
      `DTEND:${icsTime(t + 15 * 60_000)}`,
      `SUMMARY:${icsText(REMINDER_TITLE)}`,
      `DESCRIPTION:${icsText("Open Eclyps in the browser that holds your vault and sign the deposit. It only happens while the page is open.")}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsText(REMINDER_TITLE)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function downloadCalendar(times: number[]) {
  download("eclyps-deposits.ics", depositCalendar(times), "text/calendar");
}

export const TOTALITY_TITLE = "Eclyps: Totality";

/**
 * One weekly event for Totality, starting with the window that is on or the next one. The rule
 * repeats in UTC, as Totality does, so the local time shifts with daylight saving. The UID is
 * derived from Totality #1, so importing the file again updates the same event.
 */
export function totalityCalendar(t: Totality, now = Date.now()): string {
  const { on, next } = totalityStatus(t, now);
  const w = on ?? next;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Eclyps//Totality//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:totality-${icsTime(t.firstMs)}@eclyps.invalid`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(w.start)}`,
    `DTEND:${icsTime(w.end)}`,
    "RRULE:FREQ=WEEKLY",
    `SUMMARY:${icsText(TOTALITY_TITLE)}`,
    `DESCRIPTION:${icsText("The weekly hour when people move in to Eclyps together. Open Eclyps in the browser that holds your vault; a deposit happens only while the page is open and you sign it.")}`,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(TOTALITY_TITLE)}`,
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function downloadTotalityCalendar(t: Totality) {
  download("eclyps-totality.ics", totalityCalendar(t), "text/calendar");
}

export type NotifySupport = "unsupported" | "default" | "granted" | "denied";

export function notifySupport(): NotifySupport {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function askNotifyPermission(): Promise<NotifySupport> {
  if (notifySupport() === "unsupported") return "unsupported";
  return Notification.requestPermission();
}

/**
 * Keeps the tab title prefixed with the number of due deposits, and (when enabled and allowed)
 * shows one notification for each note that becomes due while the page is open. Notes already due
 * when the page loads are on screen, so they do not notify.
 */
export function useDueAlerts(due: number[], ready: boolean, notify: boolean) {
  const seen = useRef<Set<number> | undefined>(undefined);
  const key = due.join(",");

  useEffect(() => {
    document.title = due.length ? `(${due.length}) ${APP_TITLE}` : APP_TITLE;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => void (document.title = APP_TITLE), []);

  useEffect(() => {
    if (!ready) return;
    if (!seen.current) {
      seen.current = new Set(due);
      return;
    }
    const fresh = due.filter((i) => !seen.current!.has(i));
    fresh.forEach((i) => seen.current!.add(i));
    if (fresh.length === 0 || !notify || notifySupport() !== "granted") return;
    try {
      new Notification(REMINDER_TITLE, {
        body: "A scheduled deposit is ready for your signature. Open the Eclyps tab to sign it.",
        tag: "eclyps-deposit-due",
      });
    } catch {
      // Some browsers only allow notifications from a service worker; the title prefix still shows.
    }
  }, [key, ready, notify]); // eslint-disable-line react-hooks/exhaustive-deps
}
