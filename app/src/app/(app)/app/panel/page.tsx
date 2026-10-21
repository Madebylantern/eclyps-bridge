"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/brand";
import { Act, Label, Mono, short, StatusLine, Title } from "@/components/ui";
import { loadDeployment, usd } from "@/lib/deployment";
import { clock } from "@/lib/format";
import { amount, type Chain, explorerOf, level, type PanelDeployment } from "@/lib/panel";
import { type PanelState, type Read, readPanel } from "@/lib/panel-read";

/**
 * The owner's control panel: each wallet Eclyps runs on, with a gauge and "Top up" when it runs
 * low, and where the bridge's money is (src/lib/panel.ts). Not linked from the app; read-only.
 */
const CHAINS: { chain: Chain; label: string }[] = [
  { chain: "solana", label: "Solana" },
  { chain: "ethereum", label: "Ethereum" },
  { chain: "aztec", label: "Aztec" },
];
const EVERY_MS = 60_000;

export default function Panel() {
  const [dep, setDep] = useState<PanelDeployment>();
  const [state, setState] = useState<PanelState>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    loadDeployment().then((d) => setDep(d as PanelDeployment), (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  const refresh = useCallback(async () => {
    if (!dep) return;
    setBusy(true);
    try {
      setState(await readPanel(dep));
      setErr(undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [dep]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), EVERY_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const lows = state?.wallets.filter((w) => "value" in w.balance && level(w.balance.value, w).low).length ?? 0;
  return (
    <div className="flex min-h-svh flex-col px-[clamp(20px,5vw,64px)]">
      <div className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col">
        <Header right={<Act quiet small onClick={refresh} disabled={busy || !dep} testId="panel-refresh">{busy ? "Reading" : "Refresh"}</Act>} />
        <main className="flex flex-col gap-14 pb-24 pt-4" data-testid="panel">
          <div className="space-y-2">
            <Title as="h1">Wallets</Title>
            <Mono testId="panel-status">
              {dep ? `${dep.network}${state ? ` · ${clock(state.at)}` : ""}` : ""}
              {state && (lows ? ` · ${lows} to top up` : " · all funded")}
            </Mono>
          </div>
          {!state && !err && <Mono>Reading the chains…</Mono>}
          <StatusLine error={err} />
          {state && dep && CHAINS.map(({ chain, label }) => {
            const rows = state.wallets.filter((w) => w.chain === chain);
            if (rows.length === 0) return null;
            return (
              <section key={chain} className="space-y-3" aria-label={label}>
                <Label>{label}</Label>
                <ul className="rows">
                  {rows.map((w) => {
                    const lv = "value" in w.balance ? level(w.balance.value, w) : undefined;
                    return (
                      <li key={w.key} className="panel-row" data-testid={`wallet-${w.key}`} data-low={lv?.low ? "true" : undefined}>
                        <div className="flex items-baseline justify-between gap-4">
                          <span className="text-white">{w.name}</span>
                          <Value read={w.balance} unit={w.unit} />
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <AddressLink href={explorerOf(dep, chain, w.address)} address={w.address} />
                          <span className="flex items-center gap-4">
                            {lv?.low && <span className="text-sm text-white">Top up</span>}
                            {lv?.fill !== undefined && <Gauge fill={lv.fill} low={lv.low} />}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
          {state && <Bridge state={state} />}
        </main>
      </div>
    </div>
  );
}

function Bridge({ state }: { state: PanelState }) {
  const b = state.bridge;
  const rows: { key: string; name: string; read?: Read }[] = [
    { key: "escrow", name: "Waiting on Solana", read: b.escrow },
    { key: "fee-vault", name: "Fees waiting", read: b.feeVault },
    { key: "treasury", name: "Treasury", read: b.treasury },
    { key: "exit-custody", name: "Going back to Solana", read: b.exitCustody },
    { key: "portal", name: "Held on Ethereum", read: b.portal },
    { key: "aztec-supply", name: "On Aztec", read: b.aztecSupply },
  ];
  const held = b.portal && "value" in b.portal ? b.portal.value : undefined;
  const supply = b.aztecSupply && "value" in b.aztecSupply ? b.aztecSupply.value : undefined;
  const capFill = b.netDeposits !== undefined && b.depositCap ? Math.min(1, Number((b.netDeposits * 1000n) / b.depositCap) / 1000) : undefined;
  return (
    <section className="space-y-3" aria-label="In the bridge" data-testid="panel-bridge">
      <Label>In the bridge</Label>
      <ul className="rows">
        {rows.filter((r) => r.read).map((r) => (
          <li key={r.key} className="panel-row" data-testid={`bridge-${r.key}`}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-grey">{r.name}</span>
              <Value read={r.read!} unit="USDC" />
            </div>
          </li>
        ))}
        {capFill !== undefined && (
          <li className="panel-row" data-testid="bridge-cap">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-grey">Deposits</span>
              <span className="mono text-text">{usd(b.netDeposits!)} of {usd(b.depositCap!)}</span>
            </div>
            <div className="flex justify-end"><Gauge fill={capFill} /></div>
          </li>
        )}
      </ul>
      {held !== undefined && supply !== undefined && (
        <p className={`text-sm ${held >= supply ? "text-grey" : "text-white"}`} data-testid="bridge-backing" role="status">
          {held >= supply ? "Every Aztec dollar is held on Ethereum." : `Short by ${amount(supply - held, "USDC")} on Ethereum.`}
        </p>
      )}
      {b.paused && <p className="text-sm text-white" data-testid="bridge-paused">Deposits paused.</p>}
    </section>
  );
}

function Value({ read, unit }: { read: Read; unit: Parameters<typeof amount>[1] }) {
  if ("error" in read) return <span className="mono text-dim" title={read.error}>—</span>;
  return <span className="mono text-text">{amount(read.value, unit)}</span>;
}

function AddressLink({ href, address }: { href?: string; address: string }) {
  const text = <span className="mono text-[0.75rem] text-grey">{short(address, 4)}</span>;
  return href ? <a href={href} target="_blank" rel="noreferrer" className="act quiet" title={address}>{text}</a> : <span title={address}>{text}</span>;
}

/** A hairline that fills toward a comfortable balance; dim when the wallet needs topping up. */
function Gauge({ fill, low }: { fill: number; low?: boolean }) {
  return (
    <span className={`gauge${low ? " low" : ""}`} aria-hidden>
      <i style={{ width: `${Math.max(fill * 100, fill > 0 ? 2 : 0)}%` }} />
    </span>
  );
}
