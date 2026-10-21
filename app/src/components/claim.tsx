"use client";
import { type Advice, adviseClaim } from "@eclyps/sdk";
import { useMemo } from "react";
import type { ClaimStage } from "@/lib/aztec";
import { type ClaimProgress, useApp } from "@/lib/app";
import { usd } from "@/lib/deployment";
import { oneIn, stopwatch } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { claimOdds, type NoteView } from "@/lib/portfolio";
import { CrowdDisk, NoteDots } from "./crowd";
import { Act, DocsLink, Glyph, Label, StatusLine } from "./ui";

export const CLAIM_STEPS: { key: ClaimStage; label: string; hint: string }[] = [
  { key: "preparing", label: "Preparing", hint: "From public chain data." },
  { key: "proving", label: "Proving", hint: "Up to a minute. Keep this tab open." },
  { key: "sending", label: "Sending", hint: "To the Aztec network." },
  { key: "waiting", label: "Waiting for inclusion", hint: "Until a block includes it." },
];

export const claimRunning = (p?: ClaimProgress) => !!p && p.stage !== "done" && p.stage !== "failed";

/** Staged claim progress in words, with an elapsed timer. Nothing spins or blinks. */
export function ClaimProgressView({ p, testId }: { p: ClaimProgress; testId?: string }) {
  const now = useNow(1000, claimRunning(p));
  const at = CLAIM_STEPS.findIndex((s) => s.key === p.stage);
  return (
    <div className="flex flex-col gap-4" data-testid={testId} data-claim-stage={p.stage} role="status" aria-live="polite">
      <ol className="steps">
        {CLAIM_STEPS.map((s, i) => {
          const state = p.stage === "done" || i < at ? "done" : i === at ? "now" : "next";
          return (
            <li key={s.key} className={state === "next" ? "future" : undefined}>
              <Glyph state={state} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="t">{s.label}</span>
                {state === "now" && <span className="w">{s.hint}</span>}
              </span>
              <time>{state === "now" ? stopwatch(now - p.stageAt) : ""}</time>
            </li>
          );
        })}
      </ol>
      <p className="mono text-grey">
        {p.stage === "done" ? `Claimed in ${stopwatch(p.stageAt - p.startedAt)}` : `Elapsed ${stopwatch(now - p.startedAt)}`}
      </p>
    </div>
  );
}

/** One side of the comparison: a caption, the crowd as points, and "1 in N". */
function Side({ label, filled, hollow = 0, value, more, testId }: { label: string; filled: number; hollow?: number; value: string; more?: boolean; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <Label>{label}</Label>
      <div className="tabular font-display text-[clamp(1.8rem,1.4rem+1.2vw,2.5rem)] font-extralight leading-none text-white">
        {value}
        {more && <span className="text-sm font-light text-grey"> or more</span>}
      </div>
      {filled + hollow <= 64 ? <NoteDots filled={filled} hollow={hollow} /> : <div className="w-24"><CrowdDisk n={filled} waiting={hollow} /></div>}
    </div>
  );
}

/**
 * The crowd a claim hides in now, against after the next batch: "Now · 1 in 4" and "After the next
 * batch · 1 in 8 or more", each with its notes as points (hollow: the next batch, not yet crossed).
 */
export function ClaimOdds({ n, testId }: { n: NoteView; testId?: string }) {
  const { snap } = useApp();
  const pool = snap?.pools.find((p) => p.index === n.denominationIndex);
  const odds = claimOdds(n, pool);
  const crossed = pool?.crossed ?? 0;
  return (
    <div className="grid grid-cols-2 gap-x-[clamp(24px,5vw,64px)] gap-y-4" data-testid={testId}>
      <Side label="Now" filled={odds.now} value={oneIn(odds.now)} />
      <Side label="After the next batch" filled={crossed} hollow={Math.max(0, odds.later - crossed)} value={oneIn(odds.later)} more />
    </div>
  );
}

/** The one line that matters before claiming, if any: the advisor's most serious item, said short. */
export function claimRisk(advice: Advice[], v: string): Advice | undefined {
  const worst = advice.find((a) => a.severity === "risk") ?? advice.find((a) => a.severity === "caution");
  if (!worst) return undefined;
  if (worst.id.startsWith("thin-")) return { ...worst, title: worst.severity === "risk" ? `Small ${v} crowd: easy to link by timing` : `${v} crowd still growing` };
  if (worst.id === "newest-batch") return { ...worst, title: "Your batch just landed: waiting hides you better" };
  return worst;
}

/** The comparison, one risk line, and the claim; then staged progress. */
export function ClaimPanel({ n, onWait, prefix = "" }: { n: NoteView; onWait?: () => void; prefix?: string }) {
  const { snap, aztec, setModal, claim, claims } = useApp();
  const pool = snap?.pools.find((p) => p.index === n.denominationIndex);
  const advice = useMemo(
    () => (n.epochId ? adviseClaim({ denomination: BigInt(n.denomination), epochId: BigInt(n.epochId), latestSentEpoch: pool?.latestSentEpoch, pool }) : []),
    [n.denomination, n.epochId, pool],
  );
  const p = claims[n.index];
  const idle = !p || p.stage === "failed";
  const risk = claimRisk(advice, usd(n.denomination));

  return (
    <div className="flex flex-col gap-8" data-testid={`${prefix}claim-panel-${n.index}`}>
      {idle && (
        <div className="flex flex-col gap-3" data-testid={`${prefix}claim-advice-${n.index}`}>
          {/* One crowd line: the most serious risk, else how many it hides among now. */}
          <p className="flex flex-wrap items-baseline gap-x-4 text-sm text-grey" data-testid={`${prefix}claim-odds-${n.index}`}>
            {risk ? (
              <span className={risk.severity === "risk" ? "text-white" : ""} data-testid={`${prefix}claim-risk-${n.index}`} data-severity={risk.severity} title={risk.detail}>{risk.title}</span>
            ) : (
              <span>Hides {oneIn(claimOdds(n, pool).now)} now</span>
            )}
            <DocsLink to="crowd" />
          </p>
        </div>
      )}
      {!idle ? (
        <ClaimProgressView p={p!} testId={`${prefix}claim-progress-${n.index}`} />
      ) : (
        <div className="acts">
          <Act big arrow testId={`${prefix}claim-confirm-${n.index}`} disabled={aztec.state === "warming"}
            onClick={() => (aztec.session ? claim(n).catch(() => undefined) : setModal("aztec"))}>
            {aztec.session ? (risk ? "Claim anyway" : "Claim privately") : aztec.state === "warming" ? "Aztec wallet starting" : "Open Aztec to claim"}
          </Act>
          {onWait && <Act quiet onClick={onWait}>Wait</Act>}
        </div>
      )}
      {p?.stage === "failed" && <StatusLine error={p.error} testId={`${prefix}claim-error-${n.index}`} />}
      {idle && <p className="text-sm text-dim sm:hidden">Proving is faster on a laptop.</p>}
    </div>
  );
}
