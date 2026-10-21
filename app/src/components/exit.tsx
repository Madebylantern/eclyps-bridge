"use client";
import { adviseExit, deriveEthereumExit, deriveExit, toHex } from "@eclyps/sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseAddress, useApp, useVault } from "@/lib/app";
import { parseEthAddress } from "@/lib/bridge";
import { usd } from "@/lib/deployment";
import { exitAction, type ExitFacts, exitJourney, exitStage } from "@/lib/exit-status";
import { ethereumExitFacts, injectedEthereum, type SolanaExitView, solanaExitFacts } from "@/lib/exits";
import { startPoller } from "@/lib/poller";
import { type Failure, failure } from "@/lib/tunnel";
import type { StoredExit } from "@/lib/vault";
import { JourneyView } from "./route";
import { Act, AdviceList, DocsLink, Glyph, Heading, Input, Label, Mono, Ref, Section, short, StatusLine, Title } from "./ui";

type To = "solana" | "ethereum";
export type Facts = ExitFacts & { view?: SolanaExitView; proof?: Awaited<ReturnType<typeof ethereumExitFacts>>["proof"] };

const known = (x: StoredExit): Facts => (x.claimTx ? { mined: true, paid: true, proven: true, arrived: true } : { mined: !!x.tx, paid: false });

/**
 * Where each exit is, read from the chains (src/lib/exits.ts) and read again a few seconds after
 * each look ends (4 s on the local stack, 15 s elsewhere; longer while the chains fail to answer).
 * One look at a time: on slow public nodes, overlapping looks piled up requests until the browser
 * refused more (net::ERR_INSUFFICIENT_RESOURCES). A Solana exit needs the open Aztec wallet to
 * read its exit epoch. `mark` records what this page just did (a claim that went through).
 */
export function useExitFacts(exits: StoredExit[]): { facts: Record<string, Facts>; mark(id: string, patch: Partial<Facts>): void } {
  const { dep, aztec, requestFastExit } = useApp();
  const reads = aztec.session?.reads;
  const [facts, setFacts] = useState<Record<string, Facts>>({});
  const paidRef = useRef<Record<string, boolean>>({});
  const key = exits.map((x) => `${x.id}:${x.tx ?? ""}:${x.claimTx ?? ""}:${x.fast?.sig ?? x.fast?.refused ?? ""}`).join("|");
  useEffect(() => {
    const open = exits.filter((x) => !x.claimTx && x.tx);
    // Nothing on its way (not sent yet, or paid): nothing to poll.
    if (!open.length) return;
    const poller = startPoller(
      async (live) => {
        let failed: unknown;
        for (const x of open) {
          if (!live()) return;
          if (paidRef.current[x.id] || (x.to === "solana" && !reads)) continue;
          try {
            const f: Facts = x.to === "solana" ? await solanaExitFacts(dep, x, reads!).then((view) => ({ ...view, view })) : await ethereumExitFacts(dep, x);
            // Fast (ADR 0017): ask the keeper until it fronts or refuses; the exit stays on the normal path meanwhile.
            if (dep.features?.fastExit === true && x.fast && !x.fast.sig && !x.fast.refused && f.view && !f.arrived && !f.paid) {
              await requestFastExit(x, f.view).catch(() => undefined);
            }
            if (!live()) return;
            if (f.paid) paidRef.current[x.id] = true;
            setFacts((all) => ({ ...all, [x.id]: { ...f, paid: f.paid || all[x.id]?.paid } }));
          } catch (e) {
            failed = e;
          }
        }
        // A failed read slows the next look down (the poller backs off).
        if (failed) throw failed;
      },
      { intervalMs: dep.network === "local" ? 4_000 : 15_000, maxMs: 120_000 },
    );
    return () => poller.stop();
  }, [dep, key, reads]); // eslint-disable-line react-hooks/exhaustive-deps
  const out: Record<string, Facts> = {};
  for (const x of exits) out[x.id] = x.claimTx ? known(x) : (facts[x.id] ?? known(x));
  return {
    facts: out,
    mark: (id, patch) => {
      if (patch.paid) paidRef.current[id] = true;
      setFacts((all) => ({ ...all, [id]: { ...(all[id] ?? { mined: true }), ...patch } }));
    },
  };
}

/**
 * Move out: burn notes on Aztec and receive USDC at a fresh Solana address (ADR 0009) or at an
 * Ethereum address (ADR 0014 §4). Below the form, each exit on its way, with the same journey view
 * as a crossing, and the user's one step at the end: the claim.
 */
export function Exit() {
  const { dep, snap, aztec, rev } = useApp();
  const vault = useVault();
  const claimed = (snap?.notes ?? []).filter((n) => n.stage === "claimed");
  const [selected, setSelected] = useState<number[]>([]);
  const ethOn = dep.features?.exitEthereum === true;
  const [to, setTo] = useState<To>("solana");
  const [destText, setDestText] = useState("");
  const [commitments, setCommitments] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<Failure>();
  const { moveOut } = useApp();
  const toEth = to === "ethereum" && ethOn;
  const solDest = toEth ? undefined : parseAddress(destText);
  const ethDest = toEth ? parseEthAddress(destText) : undefined;
  const dest = solDest ?? ethDest;
  const enabled = dep.features?.exit === true;
  const notes = claimed.filter((n) => selected.includes(n.index));
  const depositWallets = [...new Set(vault.data.notes.map((n) => n.depositWallet).filter((w): w is string => !!w))];
  const lastClaimAt = Math.max(0, ...vault.data.notes.map((n) => n.claimedAt ?? 0)) || undefined;
  const advice = useMemo(
    () => adviseExit({ destination: solDest, depositWallets, now: Date.now(), lastClaimAt, notes: notes.map((n) => BigInt(n.denomination)) }),
    [solDest, depositWallets.join(), lastClaimAt, notes.length], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // An Ethereum address chosen on the bridge screen comes back here with its notes.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !ethOn) return;
    const target = notes.map((n) => vault.data.transfers[n.planId]?.to).find((t): t is string => !!t);
    if (target) {
      prefilled.current = true;
      setTo("ethereum");
      setDestText(target);
    }
  }, [notes.length, ethOn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    if (!dest || notes.length === 0) return setCommitments([]);
    const derive = (k: number) =>
      solDest ? deriveExit(vault.seed, vault.data.nextExit + k, solDest) : deriveEthereumExit(vault.seed, vault.data.nextEthExit + k, ethDest!);
    Promise.all(notes.map((_, k) => derive(k))).then((xs) => {
      if (live) setCommitments(xs.map((x) => toHex(x.commitment)));
    });
    return () => {
      live = false;
    };
  }, [dest, notes.length, vault, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (i: number) => setSelected((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]));
  const total = notes.reduce((a, n) => a + BigInt(n.denomination), 0n);

  const submit = async () => {
    if (!dest || notes.length === 0) return;
    setErr(undefined);
    try {
      await moveOut(notes, toEth ? "ethereum" : "solana", dest, setBusy);
      setSelected([]);
      setDestText("");
      setBusy(undefined);
    } catch (e) {
      setBusy(undefined);
      setErr(failure(e, "Not moved out. Try again."));
    }
  };

  const exits = [...vault.data.exits].reverse();

  return (
    <Section className="flex max-w-[46rem] flex-col gap-10" testId={enabled ? "exit" : "exit-gated"} label="Move out">
      <div className="flex flex-col gap-3">
        <Label>Move out</Label>
        {enabled ? (
          <Title>Burn notes on Aztec. Receive USDC at a fresh address.</Title>
        ) : (
          <>
            <Title>Not open yet.</Title>
            <p className="text-grey">You can prepare one. Nothing is sent.</p>
          </>
        )}
        <div><DocsLink to="how" arrow>How it works</DocsLink></div>
      </div>

      <div className="flex flex-col gap-3">
        <Label>Notes</Label>
        {claimed.length === 0 ? (
          <p className="text-grey">{vault.data.exits.length ? "No notes left on Aztec." : "No notes on Aztec yet."}</p>
        ) : (
          <div className="flex flex-wrap gap-x-8 gap-y-3" data-testid="exit-notes">
            {claimed.map((n) => {
              const on = selected.includes(n.index);
              return (
                <Act key={n.index} big quiet={!on} pressed={on} testId={`exit-note-${n.index}`} onClick={() => toggle(n.index)}>
                  <Glyph state={on ? "now" : "next"} className="self-center" />
                  <span className="tabular">{usd(n.denomination)}</span>
                  <span className="mono text-[0.75rem] text-dim">#{n.index}</span>
                </Act>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>To</Label>
        {ethOn && (
          <div role="radiogroup" aria-label="To" className="flex flex-col items-start gap-1.5">
            <button type="button" role="radio" aria-checked={!toEth} data-testid="exit-to-solana" onClick={() => setTo("solana")} className={`dest ${!toEth ? "on" : ""}`}>
              A fresh Solana address
            </button>
            <button type="button" role="radio" aria-checked={toEth} data-testid="exit-to-ethereum" onClick={() => setTo("ethereum")} className={`dest ${toEth ? "on" : ""}`}>
              An Ethereum address
            </button>
          </div>
        )}
        <Input testId="exit-destination" aria-label={toEth ? "Ethereum address" : "Solana address"} placeholder={toEth ? "0x…" : "A new account in your wallet"} value={destText} onChange={(e) => setDestText(e.target.value)}
          className="font-mono !text-base" autoComplete="off" spellCheck={false} />
        {destText && !dest && <StatusLine error={toEth ? "Not an Ethereum address." : "Not a valid Solana address."} />}
      </div>

      {commitments.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="exit-commitments">
          <Label>What Aztec sees</Label>
          {commitments.map((c, i) => <Mono key={i} className="block break-all">{short(c, 14)}</Mono>)}
        </div>
      )}

      {!toEth && notes.length > 0 && <AdviceList items={advice} testId="exit-advice" why="crowd" />}

      <div className="flex flex-col gap-3">
        <div className="acts">
          <Act big arrow testId="exit-submit" onClick={submit}
            disabled={!enabled || !dest || notes.length === 0 || !!busy || !aztec.session}
            title={enabled ? (aztec.session ? undefined : "Open your Aztec wallet first") : "The exit leg is not deployed on this network yet (ADR 0009)"}>
            {notes.length === 0 ? "Move out" : `Move out ${usd(total)}`}
          </Act>
        </div>
        <StatusLine text={busy} error={err?.line} why={err?.why} testId="exit-log" />
      </div>

      {enabled && exits.length > 0 && (
        <div className="flex flex-col gap-12" data-testid="exit-list">
          {exits.map((x) => <ExitRow key={x.id} x={x} depositWallets={depositWallets} />)}
        </div>
      )}
    </Section>
  );
}

/** One exit on its way: the journey, and the claim once it can be made. */
function ExitRow({ x, depositWallets }: { x: StoredExit; depositWallets: string[] }) {
  const { solana, setModal, claimExit, claimToEthereum } = useApp();
  const list = useMemo(() => [x], [x, x.tx, x.claimTx]); // eslint-disable-line react-hooks/exhaustive-deps
  const { facts: all, mark } = useExitFacts(list);
  const facts = all[x.id]!;
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();

  const stage = exitStage(x.to, facts);
  const j = exitJourney(x, stage, facts);
  const action = exitAction(stage);
  const hasEth = !!injectedEthereum();
  const linked = x.to === "solana" && !!solana.signer && depositWallets.includes(solana.signer.address);

  const claim = async () => {
    setErr(undefined);
    try {
      if (x.to === "solana") {
        if (!solana.signer) return setModal("solana");
        setBusy("Confirm the claim in your wallet…");
        await claimExit(x, facts.view!);
      } else {
        setBusy("Confirm the claim in your Ethereum wallet…");
        await claimToEthereum(x, facts.proof!);
      }
      setBusy(undefined);
      mark(x.id, { paid: true });
    } catch (e) {
      setBusy(undefined);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // A paid exit is history: one line, and the claim to look up.
  if (stage === "paid") {
    return (
      <div data-testid={`exit-row-${x.id}`} data-stage={stage} data-to={x.to} className="flex flex-col gap-1">
        <Heading as="h3">{j.headline}</Heading>
        <p className="text-grey">{j.now}</p>
        {x.claimTx && <Ref value={x.claimTx} prefix="tx" />}
      </div>
    );
  }

  return (
    <div data-testid={`exit-row-${x.id}`} data-stage={stage} data-to={x.to}>
      <JourneyView j={j} testId={`exit-journey-${x.id}`}>
        {action === "claim" && (
          <div className="flex flex-col gap-2">
            {x.to === "ethereum" && !hasEth ? (
              <p className="text-sm text-grey" data-testid={`exit-eth-missing-${x.id}`}>
                Claiming needs an Ethereum wallet in this browser.
                <DocsLink to="how" className="ml-4">Docs</DocsLink>
              </p>
            ) : (
              <div className="acts">
                <Act big arrow testId={`exit-claim-${x.id}`} onClick={claim} disabled={!!busy}>
                  {x.to === "solana" ? (solana.signer ? "Claim" : "Connect a Solana wallet to claim") : "Claim on Ethereum"}
                </Act>
              </div>
            )}
            {linked && (
              <p className="text-sm text-grey" data-testid={`exit-linked-${x.id}`}>
                Your deposit wallet sends this claim: that links the two.
                <DocsLink to="public" className="ml-4" />
              </p>
            )}
          </div>
        )}
        <StatusLine text={busy} error={err} testId={`exit-status-${x.id}`} />
      </JourneyView>
    </div>
  );
}
