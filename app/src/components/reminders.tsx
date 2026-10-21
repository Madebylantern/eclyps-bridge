"use client";
import { useEffect, useState } from "react";
import { useApp } from "@/lib/app";
import { askNotifyPermission, downloadCalendar, type NotifySupport, notifySupport, REMINDER_TITLE } from "@/lib/reminders";
import { Act } from "./ui";

/** Downloads an .ics with one event per planned deposit, made in the browser. What it shares is in the tooltip. */
export function CalendarButton({ times, testId = "add-calendar" }: { times: number[]; testId?: string }) {
  const [done, setDone] = useState(false);
  if (times.length === 0) return null;
  return (
    <Act quiet small testId={testId} title={`Each event is called “${REMINDER_TITLE}”, with no amount. Your calendar provider will see these times.`}
      onClick={() => { downloadCalendar(times); setDone(true); }}>
      {done ? "Calendar file downloaded" : `Add ${times.length === 1 ? "the deposit" : `${times.length} deposits`} to calendar`}
    </Act>
  );
}

/** One-click opt-in shown next to reminders; hidden once on, or when the browser can't or won't. */
export function NotifyPrompt() {
  const { data, updateSettings } = useApp();
  const [support, setSupport] = useState<NotifySupport>("unsupported");
  useEffect(() => setSupport(notifySupport()), []);
  const on = data.settings.notify && support === "granted";
  if (on || support === "unsupported" || support === "denied") return null;
  return (
    <Act quiet small testId="notify-prompt" title="Only while an Eclyps tab is open. The notification shows no amount."
      onClick={async () => {
        const p = await askNotifyPermission();
        setSupport(p);
        if (p === "granted") await updateSettings({ notify: true });
      }}>
      Notify me when due
    </Act>
  );
}

/** Opt-in browser notification when a scheduled deposit falls due (while a tab is open). */
export function NotifyToggle() {
  const { data, updateSettings } = useApp();
  const [support, setSupport] = useState<NotifySupport>("unsupported");
  useEffect(() => setSupport(notifySupport()), []);
  const on = data.settings.notify && support === "granted";

  const body =
    support === "unsupported"
      ? "Not in this browser. The tab title shows (1) instead."
      : support === "denied"
        ? "Blocked in browser settings. The tab title shows (1)."
        : "While an Eclyps tab is open. No amount shown.";

  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2" data-testid="notify-setting">
      <div className="min-w-0 max-w-[52ch] flex-1 space-y-1">
        <p className="text-text">Notify me when a deposit is due</p>
        <p className="text-sm text-grey">{body}</p>
      </div>
      {support !== "unsupported" && support !== "denied" && (
        <Act small quiet={on} testId="notify-toggle" onClick={async () => {
          if (on) return updateSettings({ notify: false });
          const p = await askNotifyPermission();
          setSupport(p);
          if (p === "granted") await updateSettings({ notify: true });
        }}>
          {on ? "Turn off" : "Turn on"}
        </Act>
      )}
    </div>
  );
}
