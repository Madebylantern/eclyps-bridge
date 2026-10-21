"use client";
import { type Advice, ANONYMITY_THRESHOLDS, adviseShield, bpsOf, planSchedule, type ScheduledNote, splitAmount } from "@eclyps/sdk";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { depositBlock, isCancelled, useApp } from "@/lib/app";
import { type Destination, destinations, parseEthAddress } from "@/lib/bridge";
import { bridgeLine, epochMs, parseUsd, pct, usd, usdExact } from "@/lib/deployment";
import { clock, plural } from "@/lib/format";
import { solBalanceOf } from "@/lib/solana";
import { explainSwapError, fetchQuote, QUOTE_DEBOUNCE_MS, solNeeded, solText, type SwapConfig, swapFor, type SwapQuote } from "@/lib/swap";
import { type Totality, totalityPlan, utcClock } from "@/lib/totality";
import { PLAN_HOURS } from "@/lib/transfers";
import type { PlanKind } from "@/lib/vault";
import { CrowdDisk } from "./crowd";
import { useTotality } from "./totality";
import { Tunnel } from "./tunnel";
import { Act, AdviceList, Glyph, Label, Modal, StatusLine } from "./ui";

const PLANS: { kind: PlanKind; title: string; blurb: string }[] = [
  { kind: "fast", title: "Fast", blurb: "Now · easy to link" },
  { kind: "balanced", title: "Balanced", blurb: "Over 6 hours · recommended" },
  { kind: "private", title: "Private", blurb: "Over 3 days · hardest to link" },
];

/** "14:20–19:50", or "Sun 20:03–20:58" when both fall on the same later day. */
function clockRange(a: number, b: number): string {
  const sameDay = new Date(a).toDateString() === new Date(b).toDateString();
  return `${clock(a)}–${sameDay ? new Date(b).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : clock(b)}`;
}

/**
 * The advisor's items as one short line each. The crowd row already shows each size's count, so a
 * thin pool says what it means (severity, id and remedy stay the SDK's); the explanation is on
 * Docs. Under Totality, "window too short" says what the fixed window does.
 */
function present(a: Advice, o: { totality: boolean }): Advice {
  if (a.id === "window-short" && o.totality) return { ...a, title: "Some notes less than an epoch apart", detail: "The eclipse is too short for one note per epoch, so yours are planned closer together. Balanced and Private keep them an epoch apart." };
  if (a.id === "same-epoch") return { ...a, title: "Deposited together: linked by timing" };
  if (a.id === "amount-pattern") return { ...a, title: "A recognisable amount pattern" };
  if (!a.id.startsWith("thin-")) return a;
  const many = a.id.startsWith("thin-pools-");
  return {
    ...a,
    title: a.severity === "risk" ? `Small ${many ? "crowds" : "crowd"}: easy to link by timing` : `${many ? "Crowds" : "Crowd"} still growing: wait before claiming`,
    detail: `A claim hides only among the notes of its size that have crossed. Until ${ANONYMITY_THRESHOLDS.weak} have, timing alone can link it to its deposit.`,
  };
}

/**
 * Pay with SOL: what exactly `usdc` costs in SOL, asked again once the amount stops changing
 * (keyless Jupiter takes one request every two seconds). Nothing is asked while paying in USDC.
 */
function useSolPrice(cfg: SwapConfig | undefined, usdcMint: string, usdc: bigint) {
  const [got, setGot] = useState<{ usdc: bigint; quote?: SwapQuote; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!cfg || usdc <= 0n) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetchQuote(cfg, usdcMint, usdc, (url, init) => fetch(url, { ...init, signal: ctl.signal })).then(
        (quote) => setGot({ usdc, quote }),
        (e) => !ctl.signal.aborted && setGot({ usdc, error: explainSwapError(e) }),
      );
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [cfg, usdcMint, usdc, attempt]);
  const now = got?.usdc === usdc ? got : undefined;
  return {
    quote: now?.quote,
    error: now?.error,
    retry: () => {
      setGot(undefined);
      setAttempt((a) => a + 1);
    },
  };
}

/**
 * The bridge's form, shared by the tunnel (amount, To, Send, then the eclipse or the next batch)
 * and the More options sheet (the spread plans): the amount as fixed notes, the fee on top, what
 * blocks a deposit, and `submit`, which deposits now or saves a plan. Wallet signatures and checks
 * are the app's own (src/lib/app.tsx `addNotes` and `deposit`).
 */
export function useBridgeForm() {
  const { dep, data, snap, solana, setModal, addNotes, deposit, swapToUsdc, ensureVault } = useApp();
  const denoms = dep.denominations.map(BigInt);
  const [amountText, setAmountText] = useState("");
  // The sheet's plan; the tunnel sends Fast now or Totality.
  const [plan, setPlan] = useState<PlanKind>("fast");
  const routes = destinations(dep);
  const [to, setTo] = useState<Destination>("aztec");
  const [ethText, setEthText] = useState("");
  const eth = parseEthAddress(ethText);
  const toEth = to === "ethereum" && routes.includes("ethereum");
  const [shuffle, setShuffle] = useState(0);
  const z = useTotality();
  // Pay with SOL (ADR 0011): offered only on Solana mainnet with a swap configured.
  const swapCfg = useMemo(() => swapFor(dep), [dep]);
  const [pay, setPay] = useState<"usdc" | "sol">("usdc");
  const [swapStep, setSwapStep] = useState<"swapping" | "swapped">();
  const paySol = !!swapCfg && pay === "sol";

  const mode = plan === "fast" ? "now" : "spread";
  const windowH = PLAN_HOURS[plan] ?? 0;
  const amount = parseUsd(amountText);
  const split = useMemo(() => (amount === undefined ? { notes: [], remainder: 0n } : splitAmount(amount, denoms)), [amount, dep.denominations]); // eslint-disable-line react-hooks/exhaustive-deps
  const eMs = epochMs(dep);
  // Totality plans fill the window that is on (while enough of it remains) or the next one.
  const tWindow = z ? totalityPlan(z.t, z.now).window : undefined;
  const totality = plan === "totality" && z ? z.t : undefined;
  const planTotality = (t: Totality) => {
    const p = totalityPlan(t, Date.now());
    return { ...planSchedule(split.notes, { now: p.from, windowMs: p.windowMs, epochMs: eMs, withinWindow: true }), base: p.from, window: p.window, windowMs: p.windowMs };
  };
  const schedule = useMemo(() => {
    if (totality) return planTotality(totality);
    const base = Date.now() + 60_000;
    return { ...planSchedule(split.notes, { now: base, windowMs: windowH * 3_600_000, epochMs: eMs }), base, window: undefined, windowMs: windowH * 3_600_000 };
  }, [split.notes, windowH, eMs, shuffle, totality, tWindow?.number]); // eslint-disable-line react-hooks/exhaustive-deps
  const pools = snap?.pools ?? [];
  // Risks and cautions only, one line each. Notes (info) are explained on the Docs page; the one
  // that matters here, that the user signs each deposit when it is due, is in the plan line.
  const advice = adviseShield({ notes: split.notes, mode, pools, scheduleFits: schedule.fits, minWindowMs: schedule.minWindowMs })
    .filter((a) => a.severity !== "info")
    .map((a) => present(a, { totality: !!schedule.window }));
  const total = split.notes.reduce((a, b) => a + b, 0n);
  const count = split.notes.length;
  // The fee on top of each note (ADR 0012): now, the open epoch's rate; later, the config's.
  const gw = snap?.gateway;
  const rate = (d: bigint) => (mode === "now" ? (pools.find((p) => p.denomination === d)?.nextFeeBps ?? gw?.feeBps) : gw?.feeBps);
  const fees = gw ? split.notes.reduce((a, d) => a + bpsOf(d, rate(d) ?? 0), 0n) : undefined;
  // The tunnel always shows what a deposit now costs (the open epochs' rates).
  const feesNow = gw ? split.notes.reduce((a, d) => a + bpsOf(d, pools.find((p) => p.denomination === d)?.nextFeeBps ?? gw.feeBps), 0n) : undefined;
  const cost = total + (fees ?? 0n);
  const costNow = total + (feesNow ?? 0n);
  const enoughNow = solana.usdc ? solana.usdc.amount >= costNow : false;
  const overCap = !!gw && !gw.capReached && total > gw.room;
  const blocked = depositBlock(gw, data, solana.screened) ?? (overCap ? `Over the deposit cap: ${usd(gw.room)} can still enter.` : undefined);
  const enough = solana.usdc ? solana.usdc.amount >= cost : false;
  const smallest = denoms.reduce((a, b) => (a < b ? a : b));
  const price = useSolPrice(paySol ? swapCfg : undefined, dep.solana.usdcMint, cost);
  const [sol, setSol] = useState<bigint>();
  useEffect(() => {
    if (!paySol || !solana.signer) return setSol(undefined);
    let live = true;
    solBalanceOf(dep, solana.signer.address).then((b) => live && setSol(b), () => live && setSol(undefined));
    return () => {
      live = false;
    };
  }, [paySol, solana.signer, dep, price.quote]);
  // Cross now (ADR 0015), when on: the express fee for these notes, and whether the crossing pool
  // pays for all of them ("on us"). Undefined while the gateway has no V2 lanes.
  const lanes = dep.features?.crossNow === true ? snap?.lanes : undefined;
  const crossNow = lanes
    ? {
        expressFee: lanes.lanes.params.expressFee,
        total: lanes.lanes.params.expressFee * BigInt(count),
        onUs: lanes.lanes.params.expressFee > 0n && lanes.crossingPool >= lanes.lanes.params.expressFee * BigInt(Math.max(count, 1)),
      }
    : undefined;
  const solNeed = price.quote && solNeeded({ maxIn: price.quote.maxInLamports, hasUsdcAccount: !!solana.usdc, deposits: count });
  const solShort = sol !== undefined && solNeed !== undefined && sol < solNeed;

  const plans = z
    ? [
        ...PLANS,
        {
          kind: "totality" as const,
          title: "Totality",
          blurb: z.on && tWindow?.number === z.on.number ? "Now, during the eclipse" : "During the next eclipse",
        },
      ]
    : PLANS;

  /**
   * Deposits now (`fast`: one transaction per note, each signed) or saves a plan (the deposits
   * happen when due, each signed then). Returns the transfer's id. `progress` hears one short line
   * per step.
   */
  const submit = async (kind: PlanKind, progress?: (line: string) => void, opts?: { express?: boolean }): Promise<string> => {
    if (split.notes.length === 0 || (toEth && !eth)) throw new Error("Nothing to send.");
    if (paySol && !solana.signer) {
      setModal("solana");
      throw new Error("Connect a Solana wallet first.");
    }
    const transfer = { id: crypto.randomUUID(), kind, ...(toEth && eth ? { to: eth } : {}) };
    // The vault step comes here, before anything is swapped or signed (wallet first, ADR 0016).
    const vault = await ensureVault();
    try {
      if (paySol) {
        // One swap for the plan's whole USDC, final before anything else happens.
        setSwapStep("swapping");
        progress?.("Confirm the swap in your wallet.");
        await swapToUsdc(kind === "fast" ? costNow : total + (gw ? split.notes.reduce((a, d) => a + bpsOf(d, gw.feeBps), 0n) : 0n), count);
        setSwapStep("swapped");
        // The USDC is in the wallet now: whatever happens next, trying again must not swap again.
        setPay("usdc");
      }
      if (kind !== "fast") {
        progress?.("Saving the plan to your vault…");
        if (kind === "balanced" || kind === "private") {
          await vault.update((d) => {
            d.settings.windowHours = PLAN_HOURS[kind] ?? 6;
          });
        }
        let times: { denomination: bigint; at: number }[];
        if (kind === "totality") {
          if (!z) throw new Error("No eclipse on this network.");
          times = planTotality(z.t).schedule;
        } else {
          // The plan was drawn when the form computed it; keep its shape but start it from now. A
          // Totality plan drawn while its window was already on is drawn again over what remains.
          const shift = Math.max(0, Date.now() + 60_000 - schedule.base);
          times = schedule.schedule.map((s: ScheduledNote) => ({ denomination: s.denomination, at: s.at + shift }));
        }
        await addNotes(times, transfer);
      } else {
        if (!solana.signer) {
          setModal("solana");
          throw new Error("Connect a Solana wallet first.");
        }
        progress?.("Creating notes…");
        const ids = await addNotes(split.notes.map((d) => ({ denomination: d })), transfer);
        for (const [k, id] of ids.entries()) {
          progress?.(ids.length === 1 ? "Confirm in your wallet." : `Confirm in your wallet · ${k + 1} of ${ids.length}`);
          await deposit(
            [id],
            (m) => {
              // Passed on only when a note moved to a fresh index (found already on chain).
              if (/already deposited/.test(m)) progress?.(m);
            },
            // Cross now (ADR 0015): "on us" means no express fee from the wallet; otherwise the
            // price shown, and never more.
            opts?.express && crossNow ? { express: { maxExpressFee: crossNow.onUs ? 0n : crossNow.expressFee } } : undefined,
          );
        }
      }
      return transfer.id;
    } catch (e) {
      setSwapStep((st) => (st === "swapping" ? undefined : st));
      throw e;
    }
  };

  return {
    dep, amountText, setAmountText, amount, split, count, total, fees, feesNow, cost, costNow, enoughNow, smallest, routes, to, setTo, ethText, setEthText, eth, toEth,
    plan, setPlan, plans, mode, schedule, shuffle, setShuffle, windowH, advice, pools, gw, blocked, enough, z, tWindow,
    swapCfg, pay, setPay, paySol, price, sol, solShort, swapStep, submit, crossNow,
  };
}

export type BridgeForm = ReturnType<typeof useBridgeForm>;

/**
 * The bridge (the app's front door) is the tunnel: an amount, a destination, Send, then the
 * journey itself. More options opens the spread plans in a sheet; a plan made there goes to
 * Balance, as before.
 */
export function Shield({ done, menuOpen = false }: { done: () => void; menuOpen?: boolean }) {
  // `menuOpen` also covers the vault step: the tunnel pauses under any sheet.
  const form = useBridgeForm();
  const [more, setMore] = useState(false);
  return (
    <>
      <Tunnel form={form} sheetOpen={more || menuOpen} onMore={() => setMore(true)} />
      <Modal open={more} onClose={() => setMore(false)} title="More options" testId="bridge-sheet">
        <PlanOptions form={form} done={() => { setMore(false); done(); }} />
      </Modal>
    </>
  );
}

/** The plans: Fast, Balanced, Private and Totality, their timeline, facts, crowds and advice. */
function PlanOptions({ form, done }: { form: BridgeForm; done: () => void }) {
  const { solana, setModal } = useApp();
  const f = form;
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const denoms = f.dep.denominations.map(BigInt);
  const first = f.schedule.schedule[0]?.at;
  const last = f.schedule.schedule.at(-1)?.at;
  // The timeline runs across the Totality window, or from now across the plan's window.
  const origin = f.schedule.window ? f.schedule.window.start : Date.now();
  const span = f.schedule.window ? f.schedule.window.end - f.schedule.window.start : Math.max(f.windowH * 3_600_000, (last ?? 0) - Date.now(), 1);
  const ends = f.schedule.window ? [utcClock(f.schedule.window.start), utcClock(f.schedule.window.end)] : [clock(origin), clock(origin + span)];
  // Bigger notes are bigger points.
  const rank = (d: bigint) => [...denoms].sort((a, b) => (a < b ? -1 : 1)).indexOf(d);
  const count = f.count;
  const planNote =
    count === 0
      ? `Enter at least ${usd(f.smallest)}.`
      : f.mode === "now"
        ? count === 1
          ? "One deposit now. You sign it."
          : `${count} deposits now, together. You sign each one.`
        : count === 1
          ? `One deposit at ${clock(first ?? Date.now())}${f.schedule.window ? ", during the eclipse" : ""}. You sign it when it is due.`
          : `${count} deposits, ${clockRange(first ?? Date.now(), last ?? Date.now())}${f.schedule.window ? ", during the eclipse" : ""}. You sign each one when it is due.`;
  // The eclipse is an option, never a gate: outside it, one quiet line says what that means.
  const outside = !!f.z && !f.z.on && f.plan !== "totality";
  const involved = [...new Set(f.split.notes)];
  const line = bridgeLine(f.split, f.fees, f.smallest);
  const sendLabel = f.paySol
    ? f.mode === "spread" ? `Swap, then plan ${plural(count, "deposit")}` : "Swap, then send"
    : f.mode === "spread" ? `Plan ${plural(count, "deposit")}` : "Send";

  const submit = async () => {
    setErr(undefined);
    try {
      await f.submit(f.plan, setBusy);
      setBusy(undefined);
      done();
    } catch (e) {
      setBusy(undefined);
      if (!isCancelled(e)) setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-12" data-testid="bridge-options">
      <p className="text-grey" data-testid="bridge-options-amount">
        {count ? <><span className="text-text">{usd(f.total)}</span> · {line.text}</> : line.text}
      </p>
      <div className="flex flex-col gap-[18px]">
        <Label>Privacy plan</Label>
        <div className="max-w-[36rem]">
          <div className="flex flex-col gap-5">
            <div role="group" aria-label="Privacy plan" data-testid="shield-plan" className="grid grid-cols-2 gap-x-7 gap-y-6 max-[479px]:grid-cols-1 max-[479px]:gap-y-[18px]">
              {f.plans.map((p) => (
                <button key={p.kind} type="button" className="plan" aria-pressed={f.plan === p.kind} data-testid={`shield-plan-${p.kind}`} onClick={() => f.setPlan(p.kind)}>
                  <b><Glyph state="now" />{p.title}</b>
                  <span>{p.blurb}</span>
                </button>
              ))}
            </div>
            {outside && <p className="text-sm text-dim" data-testid="shield-outside">Fewer people cross outside the eclipse: less private.</p>}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        <p className="max-w-[52ch] text-text" data-testid="shield-plan-note">{planNote}</p>
        {f.mode === "spread" && count > 0 && (
          <div className="flex flex-col gap-2" data-testid="shield-timeline">
            <div className="relative mx-1.5 h-7" aria-hidden>
              <div className="absolute inset-x-0 top-1/2 h-px bg-hair" />
              {f.schedule.schedule.map((x, i) => {
                const px = 5 + 2 * rank(x.denomination);
                return (
                  <motion.i key={`${f.shuffle}-${i}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04, duration: 0.3 }}
                    className="absolute top-1/2 block rounded-full bg-white" style={{ left: `${Math.min(100, Math.max(0, ((x.at - origin) / span) * 100))}%`, width: px, height: px, transform: "translate(-50%,-50%)" }}
                    title={`${usd(x.denomination)} · ${clock(x.at)}`} />
                );
              })}
            </div>
            <div className="flex items-baseline justify-between gap-6">
              <span className="mono !text-[0.6875rem] text-dim">{ends[0]}</span>
              <Act quiet small testId="shield-reshuffle" onClick={() => f.setShuffle((x) => x + 1)}>Reshuffle</Act>
              <span className="mono !text-[0.6875rem] text-dim">{ends[1]}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-8">
        <dl className="facts">
          <div>
            <dt>Notes</dt>
            <dd className="tabular">{count} · {usd(f.total)}</dd>
          </div>
          <div>
            <dt>Fees</dt>
            {/* The Eclyps fee is paid on top of each note and charged only if its batch crosses
                (ADR 0012); no CCTP fee (standard transfer, max_fee 0). Each deposit also pays
                Solana's fee and the rent for the 64 bytes it adds to its epoch (ADR 0010): about
                0.00045 SOL. */}
            <dd className="tabular" data-testid="shield-fee"
              title={f.gw ? `Paid only if the batch crosses: ${pct(f.gw.finisherBps)} to whoever carries it, ${pct(f.gw.feeBps - f.gw.finisherBps)} to the treasury. Plus Solana fees and rent.` : undefined}>
              {count === 0 ? "None" : `${f.gw && f.gw.feeBps > 0 ? `${pct(f.gw.feeBps)} · ${usdExact(f.fees ?? 0n)} · ` : ""}≈ ${(count * 0.00045).toFixed(4)} SOL`}
            </dd>
          </div>
          <div>
            <dt>{f.mode === "spread" ? "Last deposit" : "Deposits"}</dt>
            <dd className="tabular">{count === 0 ? "None" : f.mode === "spread" ? clock(last ?? Date.now()) : "Now"}</dd>
          </div>
        </dl>
        {involved.length > 0 && (
          <ul className="flex flex-wrap gap-x-10 gap-y-4" data-testid="shield-crowds" aria-label="The crowds you join">
            {involved.map((d) => {
              const p = f.pools.find((x) => x.denomination === d);
              return (
                <li key={String(d)} className="flex items-center gap-3" data-testid={p ? `shield-meter-${p.index}` : undefined} data-crossed={p?.crossed}
                  title={p ? `${plural(p.crossed, `${usd(d)} note`)} crossed${p.openEpochLeaves ? ` · ${p.openEpochLeaves} waiting` : ""}` : undefined}>
                  <CrowdDisk n={p?.crossed ?? 0} waiting={p?.openEpochLeaves ?? 0} className="w-11" />
                  <span className="tabular text-text">{usd(d)}</span>
                  <span className="text-grey">· {!p ? "…" : p.crossed > 0 ? p.crossed.toLocaleString("en-US") : "first batch"}</span>
                </li>
              );
            })}
          </ul>
        )}
        <AdviceList items={f.advice} testId="shield-advice" why="crowd" empty="No concerns for this plan." />
      </div>

      <div className="flex flex-col gap-3">
        <div className="acts">
          {(f.mode === "now" || f.paySol) && !solana.signer ? (
            <Act big arrow onClick={() => setModal("solana")} testId="shield-connect">Connect a Solana wallet</Act>
          ) : (
            <Act big arrow testId="shield-submit" onClick={submit}
              disabled={count === 0 || !!busy || !!f.blocked || (f.toEth && !f.eth) || (f.paySol ? !f.price.quote || f.solShort || f.fees === undefined : f.mode === "now" && !f.enough)}>
              {sendLabel}
            </Act>
          )}
        </div>
        {!f.paySol && f.mode === "now" && solana.usdc && !f.enough && count > 0 && <p className="text-sm text-white">More than your {usdExact(solana.usdc.amount)} USDC, with fees.</p>}
        {f.swapStep && (
          <p className="flex items-center gap-3 text-sm" data-testid="pay-sol-step" data-step={f.swapStep}>
            <Glyph state={f.swapStep === "swapped" ? "done" : "now"} />
            <span className={f.swapStep === "swapped" ? "text-text" : "text-grey"}>{f.swapStep === "swapped" ? "Swapped" : "Swapping…"}</span>
          </p>
        )}
        <StatusLine text={busy} error={err ?? f.blocked} testId="shield-log" />
      </div>
    </div>
  );
}
