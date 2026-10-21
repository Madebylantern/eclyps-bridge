"use client";
import { useEffect, useRef, useState } from "react";
import { type AztecState, useApp } from "@/lib/app";
import { usd } from "@/lib/deployment";
import { soundAvailable } from "@/lib/sound";
import { Mark, SoundWord } from "./brand";
import { Act, short } from "./ui";
import { Wordmark } from "./wordmark";

/**
 * The header's one word on the right: "Connect" until a Solana wallet is connected, then the
 * private balance (hidden as on Balance until shown there). It opens the wallet, or Balance.
 */
export function BalanceWord({ onBalance }: { onBalance: () => void }) {
  const { solana, aztec, showBalance, setModal } = useApp();
  if (!solana.signer) {
    return <button type="button" className="nav-word" data-testid="header-connect" onClick={() => setModal("solana")}>Connect</button>;
  }
  const amount = !aztec.session || !showBalance ? "$••••" : aztec.balance === undefined ? "$…" : usd(aztec.balance);
  return (
    <button type="button" className="nav-word tabular" data-testid="header-balance" title="Private balance" aria-label={`Private balance ${showBalance ? amount : "hidden"}`} onClick={onBalance}>
      {amount}
    </button>
  );
}

const AZTEC: Record<AztecState, string> = { ready: "Ready", warming: "Starting", failed: "Failed · retry", idle: "Open" };

/**
 * The Menu: a full black sheet over the app. Big words for the places (Privacy, Keys, Docs) and
 * Lock; under them, the wallets, the sound and the network, each one quiet line. Escape or Close
 * dismisses it; a wallet sheet opens over it and returns to it.
 */
export function Menu({ open, onClose, go }: { open: boolean; onClose: () => void; go: (tab: "privacy" | "vault") => void }) {
  const { dep, solana, aztec, modal, setModal, lock, vault } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const shut = useRef(onClose);
  const sheet = useRef(modal);
  useEffect(() => {
    shut.current = onClose;
    sheet.current = modal;
  });
  useEffect(() => {
    if (!open) return;
    // Escape closes a wallet sheet first, then the Menu.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && sheet.current === null && shut.current();
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  if (!open) return null;

  const aztecWord = aztec.state === "ready" && aztec.session?.kind === "extension" ? aztec.session.label : AZTEC[aztec.state];
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Menu" data-testid="menu" className="menu-sheet fixed inset-0 z-40 overflow-y-auto bg-black outline-none">
      <div className="mx-auto flex min-h-full w-full max-w-[72rem] flex-col px-[clamp(20px,5vw,64px)]">
        <div className="flex items-center py-7">
          <a href="/?landing" className="brand-word flex items-center gap-3 text-white" aria-label="Eclyps home">
            <Mark />
            <Wordmark className="h-[13px] w-auto max-[459px]:hidden" hairline={1} />
          </a>
          <button type="button" className="nav-word ml-auto" data-testid="menu-close" onClick={onClose}>Close</button>
        </div>

        <nav aria-label="Menu" className="flex flex-col items-start gap-y-[clamp(10px,2vh,22px)] pt-[clamp(28px,8vh,88px)]">
          <button type="button" className="menu-word" data-testid="tab-privacy" onClick={() => go("privacy")}>Privacy</button>
          <button type="button" className="menu-word" data-testid="tab-vault" onClick={() => go("vault")}>Keys</button>
          <a href="/docs/" className="menu-word" data-testid="nav-docs">Docs</a>
          {vault && <button type="button" className="menu-word" data-testid="lock" title="Lock the vault" onClick={() => { lock(); onClose(); }}>Lock</button>}
        </nav>

        <dl className="menu-facts pt-[clamp(40px,9vh,96px)]">
          <div>
            <dt>Wallet</dt>
            <dd>
              <button type="button" className="who" data-testid="chip-solana" data-lit={solana.signer ? "true" : undefined} title="Solana wallet" onClick={() => setModal("solana")}>
                {solana.signer ? (
                  <><span className="font-mono">{short(solana.signer.address, 4)}</span> · {solana.usdc ? usd(solana.usdc.amount) : "no USDC"}</>
                ) : (
                  "Connect Solana"
                )}
              </button>
              {solana.signer && <Act quiet small onClick={solana.disconnect}>Disconnect</Act>}
            </dd>
          </div>
          <div>
            <dt>Aztec</dt>
            <dd>
              <button type="button" className="who" data-testid="chip-aztec" data-state={aztec.state} data-lit={aztec.state === "failed" ? "alert" : aztec.state === "ready" ? "true" : undefined}
                title={aztec.state === "failed" && aztec.error ? `Aztec wallet failed: ${aztec.error}. Click to try again.` : "Aztec wallet"}
                onClick={() => { if (aztec.state === "failed") aztec.openEmbedded(); setModal("aztec"); }}>
                {aztecWord}
              </button>
            </dd>
          </div>
          <SoundRow />
        </dl>

        <p className="mt-auto pb-10 pt-16 text-[0.6875rem] tracking-[0.04em] text-dim" data-testid="warning">
          <span className="capitalize" data-testid="network">{dep.network}</span> · Unaudited · No Eclyps server
        </p>
      </div>
    </div>
  );
}

function SoundRow() {
  const [can, setCan] = useState(false);
  useEffect(() => setCan(soundAvailable()), []);
  if (!can) return null;
  return (
    <div>
      <dt>Sound</dt>
      <dd><SoundWord className="who" /></dd>
    </div>
  );
}
