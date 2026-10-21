"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { depositBlock, useApp } from "@/lib/app";
import { usd, usdExact } from "@/lib/deployment";
import { clock, plural, shortAddr } from "@/lib/format";
import { journeyOf, whereShort } from "@/lib/journey";
import type { NoteView, Stage } from "@/lib/portfolio";
import { PLAN_LABEL, type TransferView, transferStatus, transferTitle } from "@/lib/transfers";
import { ClaimPanel, claimRunning } from "./claim";
import { CalendarButton, NotifyPrompt } from "./reminders";
import { JourneyView, RouteFigure } from "./route";
import { Act, Confirm, Disclosure, Glyph, Heading, StatusLine, short } from "./ui";

/** The note a transfer opens on: the one closest to needing you, else the furthest along. */
const PICK_ORDER: Stage[] = ["claimable", "sent", "batched", "queued", "scheduled", "claimed", "exited", "refunded"];
function defaultPick(notes: NoteView[]): NoteView | undefined {
  const due = notes.find((n) => n.stage === "scheduled" && n.due);
  for (const s of PICK_ORDER) {
    if (s === "scheduled" && due) return due;
    const n = notes.find((x) => x.stage === s);
    if (n) return n;
  }
  return notes[0];
}

const glyphOf = (n: NoteView) => (n.stage === "claimed" || n.stage === "exited" ? "done" : n.stage === "scheduled" || n.stage === "refunded" ? "next" : "now");

/**
 * One transfer (the notes one Move in created): "Moving in $1,310", where its notes are on the
 * route, the notes list and, for the selected note, where its money is at every stage.
 */
/** `above`: what the next step at the top of Balance already offers for every upcoming deposit. */
export function TransferCard({ t, focus, above }: { t: TransferView; focus?: { index: number; nonce: number }; above?: { calendar: boolean; notify: boolean } }) {
  const { reschedule } = useApp();
  const [open, setOpen] = useState(!t.done);
  const [picked, setPicked] = useState<number>();
  const [note, setNote] = useState<string>();
  const journey = useRef<HTMLDivElement>(null);
  const scheduled = t.notes.filter((n) => n.stage === "scheduled");
  const overdue = scheduled.filter((n) => (n.scheduledAt ?? 0) <= Date.now());
  const upcoming = scheduled.map((n) => n.scheduledAt ?? 0).filter((at) => at > Date.now());
  const calendar = upcoming.length > 0 && !above?.calendar;
  const notify = scheduled.length > 0 && !above?.notify;
  const selected = t.notes.find((n) => n.index === picked) ?? defaultPick(t.notes);

  // "See where it is" from the next step: open this transfer on that note and bring it into view.
  useEffect(() => {
    if (!focus || !t.notes.some((n) => n.index === focus.index)) return;
    setOpen(true);
    setPicked(focus.index);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => journey.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" }), 80);
    return () => clearTimeout(timer);
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // On one column the journey sits under the list: bring it into view when a note is chosen there.
  const pick = (i: number, reveal = false) => {
    setPicked(i);
    setOpen(true);
    if (reveal && window.matchMedia("(max-width: 859px)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setTimeout(() => journey.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }), 60);
    }
  };

  return (
    <motion.article layout="position" className="flex flex-col gap-6" data-testid={`transfer-${t.id}`} data-done={t.done}>
      <div className="flex flex-col gap-1.5">
        <Heading>{transferTitle(t)}</Heading>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <span className="text-grey" data-testid={`transfer-status-${t.id}`} title={t.kind !== "earlier" && t.kind !== "recovered" ? `Started ${clock(t.createdAt)}` : undefined}>
            <span className="text-dim">{PLAN_LABEL[t.kind]} · </span>{transferStatus(t)}
          </span>
          <button type="button" className="act quiet small" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid={`transfer-toggle-${t.id}`}>
            {open ? "Hide notes" : `Show ${plural(t.notes.length, "note")}`}
          </button>
        </div>
      </div>

      <RouteFigure notes={t.notes} selected={open ? selected?.index : undefined} onPick={pick} testId={`transfer-bar-${t.id}`} />

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35 }} className="overflow-hidden">
            <div className="grid items-start gap-x-[clamp(32px,6vw,88px)] gap-y-14 pb-2 pt-2 min-[860px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <div className="flex min-w-0 flex-col gap-8">
                <ul className="rows" aria-label="Notes in this transfer">
                  {t.notes.map((n) => <NoteRow key={n.index} n={n} selected={n.index === selected?.index} onSelect={(reveal) => pick(n.index, reveal)} />)}
                </ul>
                {(calendar || notify || overdue.length > 1) && (
                  <div className="flex flex-col gap-4">
                    {calendar && <CalendarButton times={upcoming} testId={`add-calendar-${t.id}`} />}
                    {notify && <div><NotifyPrompt /></div>}
                    {overdue.length > 1 && (
                      <div className="space-y-1">
                        <Act small testId={`respread-${t.id}`} title="Depositing a backlog back to back would link the notes. This plans them again from now."
                          onClick={async () => { await reschedule(overdue.map((n) => n.index)); setNote(`Planned ${plural(overdue.length, "overdue deposit")} again from now.`); }}>
                          Re-spread {overdue.length} overdue
                        </Act>
                        <p className="text-xs text-dim">Back to back, they would be linked.</p>
                      </div>
                    )}
                  </div>
                )}
                <StatusLine text={note} />
              </div>
              <div ref={journey} className="min-w-0 scroll-mt-24">
                {selected && <NoteJourney key={selected.index} n={selected} />}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

function NoteRow({ n, selected, onSelect }: { n: NoteView; selected: boolean; onSelect: (reveal?: boolean) => void }) {
  const { snap, data, aztec, setModal, solana, deposit, claims } = useApp();
  const progress = claims[n.index];
  const [claimOpen, setClaimOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const held = n.heldBy !== undefined;
  const blocked = depositBlock(snap?.gateway, data, solana.screened);
  const pool = snap?.pools.find((p) => p.index === n.denominationIndex);

  const depositNow = async () => {
    if (!solana.signer) return setModal("solana");
    setBusy("Depositing…");
    setErr(undefined);
    try {
      await deposit([n.index], setBusy);
      setBusy(undefined);
    } catch (e) {
      setBusy(undefined);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const showClaim = n.stage === "claimable" && (claimOpen || claimRunning(progress) || progress?.stage === "failed");
  const canDeposit = n.stage === "scheduled" && !held;
  const canClaim = n.stage === "claimable" && !claimRunning(progress);
  const canRefund = n.stage === "queued" && !!n.refund?.refundable;

  return (
    <li data-testid={`note-${n.index}`} data-stage={n.stage} data-held={held ? "true" : undefined}>
      <div className="flex items-center gap-x-4 sm:gap-x-5">
        <button type="button" className="note min-w-0 flex-1" aria-current={selected} onClick={() => onSelect(true)}>
          <Glyph state={glyphOf(n)} />
          <span className="v tabular">{usd(n.denomination)}</span>
          <span className="s min-w-0" data-testid={`stage-${n.index}`}>{whereShort(n, pool?.minBatch, !!aztec.session)}</span>
        </button>
        {(canDeposit || canClaim || canRefund) && (
          <div className="shrink-0">
            {canDeposit && (
              <Act small quiet={!n.due} arrow={n.due} testId={`deposit-${n.index}`} disabled={!!busy || !!blocked} title={blocked} onClick={depositNow}>
                {busy ? "Depositing" : n.due ? "Deposit now" : "Deposit early"}
              </Act>
            )}
            {canClaim && (
              <Act small arrow={!claimOpen} quiet={claimOpen} testId={`claim-${n.index}`} onClick={() => { setClaimOpen((o) => !o); onSelect(false); }}>
                {claimOpen ? "Close" : "Claim"}
              </Act>
            )}
            {canRefund && <RefundButton n={n} testId={`refund-${n.index}`} compact />}
          </div>
        )}
      </div>
      {(busy || err) && <div className="pb-4"><StatusLine text={busy} error={err} testId={`note-status-${n.index}`} /></div>}
      {showClaim && (
        <div className="pb-8 pt-2">
          <ClaimPanel n={n} onWait={() => setClaimOpen(false)} />
        </div>
      )}
    </li>
  );
}

/** The selected note's journey, with its technical details (and the hold override) underneath. */
function NoteJourney({ n }: { n: NoteView }) {
  const { dep, snap, aztec, solana, setModal, deposit } = useApp();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const pool = snap?.pools.find((p) => p.index === n.denominationIndex);
  const j = journeyOf(n, dep, pool?.minBatch, !!aztec.session);

  const force = async () => {
    if (!solana.signer) return setModal("solana");
    setBusy("Depositing…");
    setErr(undefined);
    try {
      await deposit([n.index], setBusy, { force: true });
      setBusy(undefined);
    } catch (e) {
      setBusy(undefined);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <JourneyView j={j} testId={`journey-${n.index}`}>
      <StatusLine text={busy} error={err} testId={`journey-status-${n.index}`} />
      <Disclosure summary="Technical details" testId={`details-${n.index}`}>
        <TechnicalDetails n={n} onForce={force} busy={!!busy} />
      </Disclosure>
    </JourneyView>
  );
}

/** Take back a stuck deposit. Says which wallet is needed when another one is connected. */
export function RefundButton({ n, testId, compact }: { n: NoteView; testId: string; compact?: boolean }) {
  const { solana, setModal, refund } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<string>();
  const wrong = solana.signer && n.depositWallet && solana.signer.address !== n.depositWallet;
  return (
    <div className="space-y-1.5">
      <Act small arrow testId={testId} disabled={busy} onClick={async () => {
        if (!solana.signer) return setModal("solana");
        setBusy(true);
        setErr(undefined);
        try {
          setDone(await refund(n));
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}>
        {busy ? "Taking back" : `Take back ${usdExact(BigInt(n.denomination) + (n.fee ?? 0n))}`}
      </Act>
      {wrong && !err && !compact && <p className="text-sm text-white">Needs {shortAddr(n.depositWallet!)}, the wallet that deposited.</p>}
      {!solana.signer && n.depositWallet && !compact && <p className="text-sm text-grey">Connect {shortAddr(n.depositWallet)}, the wallet that deposited.</p>}
      <StatusLine text={done && `Taken back to ${shortAddr(n.depositWallet ?? "")}.`} error={err} testId={`${testId}-status`} />
    </div>
  );
}

function Field({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.625rem] uppercase tracking-[0.2em] text-dim">{label}</dt>
      <dd className="mono truncate text-[0.75rem] text-text" title={title}>{children}</dd>
    </div>
  );
}

/** Ids, roots, slots and signatures live here, out of the main path; so does the hold override. */
function TechnicalDetails({ n, onForce, busy }: { n: NoteView; onForce: () => void; busy: boolean }) {
  const { snap } = useApp();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-6" data-testid={`tech-${n.index}`}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Field label="Note">#{n.index}</Field>
        <Field label="Commitment" title={n.commitment}>{short(n.commitment, 8)}</Field>
        {n.scheduledAt !== undefined && n.stage === "scheduled" && <Field label="Planned">{new Date(n.scheduledAt).toLocaleString()}</Field>}
        {n.epochId !== undefined && <Field label="Epoch">{n.epochId}</Field>}
        {n.leafIndex !== undefined && <Field label="Leaf">{n.leafIndex}</Field>}
        {n.epochLeaves !== undefined && <Field label="Deposits in epoch">{n.epochLeaves}</Field>}
        {n.epochEndSlot !== undefined && <Field label="Epoch end slot">{String(n.epochEndSlot)}{snap ? ` (now ${snap.slot})` : ""}</Field>}
        {n.root !== undefined && <Field label="Batch root" title={`0x${n.root.toString(16)}`}>{short(`0x${n.root.toString(16).padStart(64, "0")}`, 8)}</Field>}
        {n.depositSig && <Field label="Deposit tx" title={n.depositSig}>{short(n.depositSig, 8)}</Field>}
        {n.depositWallet && <Field label="Deposited by" title={n.depositWallet}>{shortAddr(n.depositWallet, 6)}</Field>}
        {n.claimTx && <Field label="Claim tx" title={n.claimTx}>{short(n.claimTx, 8)}</Field>}
        {n.refundSig && <Field label="Refund tx" title={n.refundSig}>{short(n.refundSig, 8)}</Field>}
      </dl>

      {n.stage === "queued" && n.refund && (
        <p className="text-sm text-grey" data-testid={`refund-info-${n.index}`}>
          {n.refund.refundable ? "Can be taken back now, by the wallet that made it." : `Can be taken back from ${clock(n.refund.atMs)} if its batch has not sent.`}
        </p>
      )}
      {n.stage === "queued" && n.refund?.refundable && <RefundButton n={n} testId={`refund-details-${n.index}`} />}
      {n.recovered && (
        <p className="text-sm text-grey" title="If it was claimed before, claiming again fails without moving any funds.">Found on chain from your recovery phrase.</p>
      )}

      {n.stage === "scheduled" && n.heldBy !== undefined && (
        confirm ? (
          <Confirm testId={`force-confirm-${n.index}`} busy={busy} title={`Deposit into the same epoch as note #${n.heldBy}?`} confirmLabel="Deposit anyway"
            body={<>Two {usd(n.denomination)} deposits in one batch can be tied together. Waiting costs nothing.</>}
            onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); onForce(); }} />
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm text-grey">Held: your note #{n.heldBy} is in the open {usd(n.denomination)} epoch.</p>
            <Act small quiet testId={`force-deposit-${n.index}`} onClick={() => setConfirm(true)}>Deposit anyway…</Act>
          </div>
        )
      )}
    </div>
  );
}
