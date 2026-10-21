"use client";
import { useMemo, useState } from "react";
import { useApp } from "@/lib/app";
import { useNow } from "@/lib/hooks";
import { downloadTotalityCalendar, TOTALITY_TITLE } from "@/lib/reminders";
import { parseTotality, type Totality, type TotalityWindow, totalityStatus } from "@/lib/totality";
import { Act } from "./ui";

export interface TotalityNow {
  t: Totality;
  now: number;
  on?: TotalityWindow;
  next: TotalityWindow;
}

/** The deployment's Totality, validated and re-read every 30 s; undefined when it has none. */
export function useTotality(): TotalityNow | undefined {
  const { dep } = useApp();
  const t = useMemo(() => parseTotality(dep.totality), [dep.totality]);
  const now = useNow(30_000, !!t);
  return t ? { t, now, ...totalityStatus(t, now) } : undefined;
}

/** Downloads a weekly .ics event for Totality, made in the browser. What it shares is in the tooltip. */
export function TotalityCalendar({ t, testId = "totality-calendar" }: { t: Totality; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Act quiet small testId={testId} title={`A weekly event called “${TOTALITY_TITLE}”. Your calendar provider will see it.`}
      onClick={() => { downloadTotalityCalendar(t); setDone(true); }}>
      {done ? "Calendar file downloaded" : "Add to calendar"}
    </Act>
  );
}
