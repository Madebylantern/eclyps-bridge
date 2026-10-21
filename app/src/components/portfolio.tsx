"use client";
import { useMemo, useState } from "react";
import { useApp } from "@/lib/app";
import { usd } from "@/lib/deployment";
import { clock, plural } from "@/lib/format";
import type { NoteView } from "@/lib/portfolio";
import { groupTransfers, nextAction } from "@/lib/transfers";
import { NextForYou } from "./next-action";
import { TransferCard } from "./transfer";
import { Act, DocsLink, Label, Mono, Notice, Section } from "./ui";

const sum = (ns: NoteView[]) => ns.reduce((a, n) => a + BigInt(n.denomination), 0n);

/**
 * Balance: one large number, the one thing to do (if any), the notes folded into one line, and
 * the two ways on: Move out and Bridge more. One crowd line says how small the crowd is.
 */
export function Portfolio({ go }: { go: (tab: "shield" | "exit") => void }) {
  const { snap, snapError, data, scanNotice, dismissScanNotice } = useApp();
  const notes = snap?.notes ?? [];
  const transfers = useMemo(() => groupTransfers(notes, data.transfers), [notes, data.transfers]);
  const claimed = notes.some((n) => n.stage === "claimed");
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<{ index: number; nonce: number }>();
  const see = (index: number) => {
    setOpen(true);
    setFocus((f) => ({ index, nonce: (f?.nonce ?? 0) + 1 }));
  };
  // When the next step is a deposit, it already offers the calendar for every upcoming deposit,
  // so the transfers below don't repeat it.
  const next = nextAction(snap, notes);
  const above = { calendar: next.kind === "deposit", notify: false };
  const empty = transfers.length === 0 && data.notes.length === 0;

  return (
    <div className="flex flex-col gap-[clamp(40px,7vh,72px)]">
      {scanNotice && (
        <Notice testId="scan-notice" label="Recovery" title={scanNotice.found ? `Found ${plural(scanNotice.found, "note")} made from your recovery phrase.` : "Found no notes made from your recovery phrase."}
          action={<Act quiet small onClick={dismissScanNotice}>Dismiss</Act>} />
      )}
      <Balance />
      <NextForYou go={go} see={see} />

      {!empty && (
        <section className="flex flex-col gap-[clamp(40px,7vh,72px)]" aria-label="Notes">
          {!snap ? (
            <p className="text-grey" data-testid="transfers-offline">
              {data.notes.length === 1 ? "Your note is" : `Your ${data.notes.length} notes are`} safe here. Waiting for Solana.
            </p>
          ) : (
            <button type="button" className="act quiet self-start" data-testid="notes-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <NotesSummary notes={notes} />
              <span className="arr" aria-hidden>{open ? "↑" : "↓"}</span>
            </button>
          )}
          {open && snap && transfers.map((t) => <TransferCard key={t.id} t={t} focus={focus} above={above} />)}
        </section>
      )}

      {!empty && (
        <div className="flex flex-col gap-5">
          <div className="acts">
            {(claimed || data.exits.length > 0) && <Act big arrow testId="tab-exit" onClick={() => go("exit")}>Move out</Act>}
            <Act big={!claimed} quiet={claimed} arrow testId="balance-bridge" onClick={() => go("shield")}>Bridge more</Act>
          </div>
          <CrowdLine notes={notes} />
        </div>
      )}
      <Mono testId="chain-updated" className="text-xs !text-dim">{snap ? `Solana ${clock(snap.updatedAt)} · slot ${snap.slot}` : snapError ? "Solana not reachable" : "Reading Solana…"}</Mono>
    </div>
  );
}

/** "3 notes · $1,000 crossing · $10 planned": the notes, folded into one line. */
function NotesSummary({ notes }: { notes: NoteView[] }) {
  const live = notes.filter((n) => n.stage !== "refunded" && n.stage !== "exited");
  const crossing = notes.filter((n) => ["queued", "batched", "sent", "claimable"].includes(n.stage));
  const scheduled = notes.filter((n) => n.stage === "scheduled");
  return (
    <span>
      {plural(live.length, "note")}
      {crossing.length > 0 && <><span className="text-dim"> · </span><span data-testid="in-transit">{usd(sum(crossing))}</span> crossing</>}
      {scheduled.length > 0 && <><span className="text-dim"> · </span><span data-testid="scheduled-total">{usd(sum(scheduled))}</span> planned</>}
    </span>
  );
}

/**
 * The one crowd line: the smallest crowd your notes are in (the notes of that size that crossed),
 * and Why, to Docs.
 */
function CrowdLine({ notes }: { notes: NoteView[] }) {
  const { snap } = useApp();
  const sizes = new Set(notes.filter((n) => n.stage !== "refunded" && n.stage !== "scheduled").map((n) => n.denominationIndex));
  const p = (snap?.pools ?? []).filter((x) => sizes.has(x.index)).sort((a, b) => a.crossed - b.crossed)[0];
  if (!p) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 text-sm text-grey" data-testid="balance-crowd">
      <span>{p.crossed > 0 ? `Smallest crowd: ${p.crossed.toLocaleString("en-US")} × ${usd(p.denomination)} crossed` : `No ${usd(p.denomination)} crowd yet`}</span>
      <DocsLink to="crowd" />
    </p>
  );
}

function Balance() {
  const { aztec, setModal, showBalance, setShowBalance } = useApp();
  return (
    <Section label="Private balance" className="flex flex-col gap-3.5">
      <Label>Private balance</Label>
      <div className="flex flex-wrap items-baseline gap-x-7 gap-y-3">
        <span className="amount tabular" data-testid="private-balance" data-hidden={!showBalance} aria-live="polite" title="Only this browser can read it.">
          {!aztec.session ? (
            <span className="text-dim">$<span className="mask !text-dim" aria-label="not readable yet">••••</span></span>
          ) : !showBalance ? (
            <>$<span className="mask" aria-label="hidden">••••</span></>
          ) : aztec.balance === undefined ? (
            <span className="text-dim">$…</span>
          ) : (
            usd(aztec.balance)
          )}
        </span>
        {aztec.session && <Act quiet testId="balance-toggle" pressed={showBalance} onClick={() => setShowBalance(!showBalance)}>{showBalance ? "Hide" : "Show"}</Act>}
      </div>
      {!aztec.session && (
        <div className="text-grey">
          {aztec.state === "warming" ? "Aztec wallet starting…" : <Act quiet arrow onClick={() => setModal("aztec")}>Open Aztec to read it</Act>}
        </div>
      )}
    </Section>
  );
}
