"use client";
import { useState } from "react";
import { depositBlock, useApp } from "@/lib/app";
import { usd, usdExact } from "@/lib/deployment";
import { clock, plural, shortAddr } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { type NextAction, nextAction } from "@/lib/transfers";
import { ClaimPanel } from "./claim";
import { CalendarButton } from "./reminders";
import { RefundButton } from "./transfer";
import { Act, Section, StatusLine } from "./ui";

/** The step as one short sentence: white for what, grey for a few words of why. */
function Sentence({ children, why }: { children: React.ReactNode; why?: React.ReactNode }) {
  return (
    <h2 className="max-w-[34rem] text-[clamp(1.25rem,1rem+1vw,1.75rem)] font-light leading-[1.35] text-white" data-testid="next-title">
      {children}
      {why && <em className="not-italic text-grey"> {why}</em>}
    </h2>
  );
}

/**
 * The single most important thing right now, when there is one: take back a stuck deposit,
 * deposit a due note, or claim. Nothing to do shows nothing (the tunnel says where things are).
 */
export function NextForYou({ go, see }: { go: (tab: "shield") => void; see: (index: number) => void }) {
  const { snap, data } = useApp();
  useNow(30_000);
  const a: NextAction = nextAction(snap, snap?.notes ?? []);
  const empty = a.kind === "empty" && (snap || data.notes.length === 0);
  if (a.kind === "idle" || (a.kind === "empty" && !empty)) return null;

  return (
    <Section testId="next-action" label="Next step" data-kind={a.kind} className="flex max-w-[46rem] flex-col gap-5">
      {empty && (
        <>
          <Sentence>Nothing has moved in yet.</Sentence>
          <div className="acts">
            <Act big arrow onClick={() => go("shield")} testId="empty-shield">Move in from Solana</Act>
          </div>
        </>
      )}
      {a.kind === "refund" && <RefundNext a={a} see={see} />}
      {a.kind === "deposit" && <DepositNext a={a} see={see} />}
      {a.kind === "claim" && (
        <>
          <Sentence>Your {usd(a.note.denomination)} note can be claimed.</Sentence>
          <ClaimPanel n={a.note} prefix="next-" />
        </>
      )}
    </Section>
  );
}

function RefundNext({ a, see }: { a: Extract<NextAction, { kind: "refund" }>; see: (index: number) => void }) {
  const n = a.note;
  return (
    <>
      <Sentence why={<>Its batch did not fill in a day.{n.depositWallet ? ` It goes back to ${shortAddr(n.depositWallet)}.` : ""}</>}>
        You can take back {usdExact(BigInt(n.denomination) + (n.fee ?? 0n))}.
      </Sentence>
      <div className="acts">
        <RefundButton n={n} testId="next-refund" />
        <Act quiet arrow onClick={() => see(n.index)}>See where it is</Act>
      </div>
    </>
  );
}

function DepositNext({ a, see }: { a: Extract<NextAction, { kind: "deposit" }>; see: (index: number) => void }) {
  const { snap, data, solana, setModal, deposit, reschedule } = useApp();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const n = a.note;
  const blocked = depositBlock(snap?.gateway, data, solana.screened);
  const later = (snap?.notes ?? []).filter((x) => x.stage === "scheduled" && (x.scheduledAt ?? 0) > Date.now()).map((x) => x.scheduledAt!);

  const go = async () => {
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

  return (
    <>
      <Sentence why={`Due since ${clock(n.scheduledAt ?? Date.now())}.`}>Your {usd(n.denomination)} deposit is due.</Sentence>
      <div className="acts">
        <Act big arrow testId="deposit-next" onClick={go} disabled={!!busy || !!blocked}>
          {busy ? "Depositing" : solana.signer ? `Deposit ${usd(n.denomination)} now` : "Connect Solana to deposit"}
        </Act>
        {a.overdue.length > 1 && (
          <Act quiet testId="respread" title="Depositing a backlog back to back would link the notes. This plans them again from now."
            onClick={() => reschedule(a.overdue.map((x) => x.index)).then(() => setBusy(`Planned ${plural(a.overdue.length, "overdue deposit")} again from now.`))}>
            Re-spread {a.overdue.length} overdue
          </Act>
        )}
        <Act quiet arrow onClick={() => see(n.index)}>See where it is</Act>
      </div>
      {a.overdue.length > 1 && <p className="text-sm text-grey">{a.overdue.length} overdue: back to back, they would be linked.</p>}
      <StatusLine text={busy} error={err ?? blocked} testId="portfolio-status" />
      {later.length > 0 && <CalendarButton times={later} testId="add-calendar-next" />}
    </>
  );
}
