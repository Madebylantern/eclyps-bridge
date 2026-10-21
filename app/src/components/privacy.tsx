"use client";
import { ANONYMITY_THRESHOLDS, auditNotes } from "@eclyps/sdk";
import { Fragment } from "react";
import { useApp } from "@/lib/app";
import { epochMs, usd } from "@/lib/deployment";
import { etaFromSlots } from "@/lib/format";
import type { PoolView } from "@/lib/portfolio";
import { CrowdDisk, NoteDots } from "./crowd";
import { Eclipse } from "./eclipse";
import { AdviceList, DocsLink, Heading, Label, Section } from "./ui";

/** One short line under a crowd's count. Small crowds are called small; the rest is on Docs. */
function crowdWord(n: number): string {
  if (n === 0) return "first batch forming";
  if (n < ANONYMITY_THRESHOLDS.weak) return "crossed · small crowd";
  if (n < ANONYMITY_THRESHOLDS.moderate) return "crossed · still growing";
  return "crossed";
}

/** Privacy at a glance: the eclipse and the batches forming now, then a disk per crowd. */
export function Privacy() {
  const { dep, data, snap } = useApp();
  const pools = snap?.pools ?? [];
  const audit = auditNotes(
    data.notes
      .filter((n) => !n.refundedAt)
      .map((n) => ({ index: n.index, denominationIndex: n.denominationIndex, denomination: BigInt(n.denomination), epochId: n.epochId !== undefined ? BigInt(n.epochId) : undefined, depositedAt: n.depositedAt })),
    epochMs(dep),
  );
  const endsOf = (p: PoolView) => {
    const left = p.openEpochEndSlot !== undefined && snap ? p.openEpochEndSlot - snap.slot : undefined;
    return left !== undefined && left > 0n ? ` · ends ${etaFromSlots(left)}` : "";
  };
  // Sizes with a crowd or a batch forming get a disk; the rest share one quiet line.
  const active = pools.filter((p) => p.crossed > 0 || p.openEpochLeaves > 0);
  const quiet = pools.filter((p) => p.crossed === 0 && p.openEpochLeaves === 0);
  const forming = pools.filter((p) => p.openEpochLeaves > 0);

  return (
    <div className="flex flex-col gap-[clamp(56px,9vh,96px)]">
      <Section label="Now" testId="privacy-now" className="flex flex-col gap-8">
        <Label>Now</Label>
        <div className="grid items-center gap-x-[clamp(40px,7vw,112px)] gap-y-10 min-[760px]:grid-cols-[auto_minmax(0,1fr)]">
          <Eclipse size={248} testId="privacy-eclipse" />
          {!snap ? (
            <p className="text-grey">Reading Solana…</p>
          ) : forming.length > 0 ? (
            <ul className="flex flex-col gap-8" data-testid="privacy-forming">
              {forming.map((p) => (
                <li key={p.index} data-testid={`forming-${p.index}`} className="flex flex-col gap-2.5">
                  <span className="text-[clamp(1.125rem,1rem+0.5vw,1.4rem)] font-light leading-tight text-white">
                    {p.crossed > 0 ? "Next" : "First"} {usd(p.denomination)} batch
                  </span>
                  <NoteDots filled={p.openEpochLeaves} hollow={p.minBatch - p.openEpochLeaves} />
                  <span className="mono text-grey">
                    {p.openEpochLeaves >= p.minBatch ? `${p.openEpochLeaves} deposits · ready to send` : `${p.openEpochLeaves} of ${p.minBatch} deposits`}{endsOf(p)}
                  </span>
                </li>
              ))}
            </ul>
          ) : pools.length > 0 ? (
            <p className="text-[clamp(1.125rem,1rem+0.5vw,1.4rem)] font-light text-white" data-testid="privacy-forming">
              No batch forming. <span className="text-grey">The next deposit starts one.</span>
            </p>
          ) : (
            <p className="text-grey">No pools on this network.</p>
          )}
        </div>
      </Section>

      <Section label="Crowds" className="flex flex-col gap-10">
        <Label>Crowds</Label>
        {active.length > 0 && (
          <div className="grid grid-cols-2 gap-x-[clamp(24px,5vw,72px)] gap-y-14 min-[860px]:grid-cols-3">
            {active.map((p) => (
              <div key={p.index} className="crowd flex flex-col items-start gap-2" data-testid={`pool-${p.index}`} data-active="true">
                <div data-testid={`pool-meter-${p.index}`} className="mb-2 w-full max-w-[240px]"><CrowdDisk n={p.crossed} waiting={p.openEpochLeaves} /></div>
                <Label>{usd(p.denomination)} notes</Label>
                <span className="tabular font-display text-[clamp(2.2rem,1.6rem+2vw,3.2rem)] font-extralight leading-none text-white">{p.crossed.toLocaleString("en-US")}</span>
                <span className="text-sm text-grey">{crowdWord(p.crossed)}</span>
              </div>
            ))}
          </div>
        )}
        {quiet.length > 0 && (
          <p className="text-grey" data-testid="pools-quiet">
            {quiet.map((p, i) => (
              <Fragment key={p.index}>
                {i > 0 && " · "}
                <span className="tabular text-text" data-testid={`pool-${p.index}`} data-active="false">{usd(p.denomination)}</span>
              </Fragment>
            ))}
            <span className="text-dim">{"  "}no deposits yet</span>
          </p>
        )}
        {pools.length === 0 && snap && <p className="text-grey">No pools on this network.</p>}
        <div><DocsLink to="crowd" arrow testId="privacy-docs">How privacy works</DocsLink></div>
      </Section>

      <Section label="Your own notes" className="flex max-w-[46rem] flex-col gap-4">
        <Heading>Your own notes</Heading>
        {audit.length === 0 ? (
          <p className="text-text" title="Checked in this browser. Nothing is sent anywhere.">No links between your notes.</p>
        ) : (
          <AdviceList items={audit} testId="privacy-audit" why="crowd" />
        )}
      </Section>
    </div>
  );
}
