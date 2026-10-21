"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
import { DocsWord, Footer, Header, useMuteKey } from "@/components/brand";
import { ChainStatus } from "@/components/chain-status";
import { Exit } from "@/components/exit";
import { BalanceWord, Menu } from "@/components/menu";
import { Portfolio } from "@/components/portfolio";
import { Privacy } from "@/components/privacy";
import { Shield } from "@/components/shield";
import { Act, Line, Notice } from "@/components/ui";
import { VaultCenter } from "@/components/vault-center";
import { VaultSheet } from "@/components/vault-sheet";
import { WalletModals } from "@/components/wallets";
import { AppProvider, useApp } from "@/lib/app";
import { type Deployment, loadDeployment } from "@/lib/deployment";
import { useDueAlerts } from "@/lib/reminders";

type Tab = "portfolio" | "shield" | "exit" | "privacy" | "vault";

/**
 * The two section words in the header. The test ids keep the earlier tab names. The bridge
 * ("shield") is the front door: the app opens on it. Move out opens from Balance (and from the
 * tunnel); Privacy and Keys from the Menu.
 */
const SECTIONS: { value: Tab; label: string }[] = [
  { value: "shield", label: "Bridge" },
  { value: "portfolio", label: "Balance" },
];

export default function Home() {
  const [dep, setDep] = useState<Deployment>();
  const [err, setErr] = useState<string>();
  // Remembered so the next visit to / opens the app directly (the landing's head script).
  useEffect(() => {
    try { localStorage.setItem("eclyps.app", "1"); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    loadDeployment().then(setDep, (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      {/* Above the bridge's tunnel, which is drawn behind everything (src/components/tunnel.tsx). */}
      <div className="relative z-[1] flex min-h-svh flex-col px-[clamp(20px,5vw,64px)]">
        <div className="mx-auto flex w-full max-w-[72rem] flex-1 flex-col">
          {dep ? (
            // Wallet first (ADR 0016, amended): the app opens on the bridge with no vault open; the
            // vault step comes only when an action needs it (src/components/vault-sheet.tsx).
            <AppProvider dep={dep}>
              <Shell />
            </AppProvider>
          ) : (
            <div className="grid flex-1 grid-rows-[1fr_auto_1fr]">
              <div className="self-start">
                <Header right={<><span className="who-word capitalize" data-testid="network">…</span><DocsWord /></>} />
              </div>
              <main className="flex flex-col gap-16 py-10">
                {err && (
                  <Notice testId="deployment-error" alert label="Network" title="This app has no network to talk to.">
                    {err}
                  </Notice>
                )}
              </main>
              <div className="self-end">
                <Footer />
              </div>
            </div>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}

function Nav({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav aria-label="Sections" className="flex gap-x-[clamp(18px,2.6vw,36px)]">
      {SECTIONS.map((s) => (
        <button key={s.value} type="button" data-testid={`tab-${s.value}`} aria-current={value === s.value ? "page" : undefined} onClick={() => onChange(s.value)} className="nav-word">
          {s.label}
        </button>
      ))}
    </nav>
  );
}

function Shell() {
  const { snap, vault, stored, ensureVault, gate, rev } = useApp();
  const [tab, setTab] = useState<Tab>("shield");
  const [menu, setMenu] = useState(false);
  const [verifyNow, setVerifyNow] = useState(0);
  const notes = snap?.notes ?? [];
  const due = notes.filter((n) => n.stage === "scheduled" && n.due).map((n) => n.index);
  useDueAlerts(due, !!snap, vault?.data.settings.notify ?? false);
  useMuteKey();
  const unchecked = !!vault && vault.data.backup.confirmedAt === undefined;
  /** Keys and Move out need the vault open; Balance and Privacy too once there is one to unlock. */
  const needsVault = (t: Tab) => t === "vault" || t === "exit" || (!!stored && (t === "portfolio" || t === "privacy"));
  const go = (t: Tab) => {
    setMenu(false);
    if (!vault && needsVault(t)) {
      ensureVault().then(() => setTab(t), () => undefined);
      return;
    }
    setTab(t);
  };
  // Locked (Menu, Keys): back to the bridge, where nothing needs the vault.
  useEffect(() => {
    if (!vault && (tab === "vault" || tab === "exit" || (stored && tab !== "shield"))) setTab("shield");
  }, [vault]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Header nav={<Nav value={tab} onChange={go} />}
        right={<><BalanceWord onBalance={() => go("portfolio")} /><button type="button" className="nav-word" data-testid="menu-open" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu(true)}>Menu</button></>} />
      <main className={`flex flex-col ${tab === "shield" ? "flex-1 gap-3 pb-2" : "gap-[clamp(48px,8vh,88px)] pb-24 pt-[clamp(16px,4vh,40px)]"}`}>
        <ChainStatus />
        {unchecked && tab !== "vault" && !vault.seedFrom && (
          <Line testId="backup-reminder" data-rev={rev}
            action={<Act small quiet arrow testId="backup-reminder-check" onClick={() => { setVerifyNow((v) => v + 1); go("vault"); }}>Check now</Act>}>
            Your recovery phrase isn’t checked yet
          </Line>
        )}
        {/* ADR 0016: a passkey (or wallet) vault gets one quiet reminder, once money is in it. */}
        {unchecked && tab !== "vault" && !!vault.seedFrom && vault.data.notes.length > 0 && (
          <Line testId="backup-reminder" data-rev={rev} title={vault.seedFrom === "wallet" ? "Eclyps can’t recover your wallet." : "Eclyps can’t recover your passkey."}
            action={<Act small quiet arrow testId="backup-reminder-check" onClick={() => go("vault")}>Keys</Act>}>
            Back up your keys
          </Line>
        )}
        {tab === "shield" ? (
          // The bridge fades in without moving: its tunnel is positioned on the viewport, which a
          // transform on this wrapper would break. It leaves at once, in the same frame as the
          // menu, so its tunnel never shows through on the way to another place.
          <motion.div key={tab} className="flex flex-1 flex-col" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }}>
            <Shield done={() => setTab("portfolio")} menuOpen={menu || gate} />
          </motion.div>
        ) : (
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22 }}>
              {tab === "portfolio" && <Portfolio go={go} />}
              {tab === "exit" && vault && <Exit />}
              {tab === "privacy" && <Privacy />}
              {tab === "vault" && vault && <VaultCenter key={verifyNow} verifyNow={verifyNow > 0} />}
            </motion.div>
          </AnimatePresence>
        )}
      </main>
      <Menu open={menu} onClose={() => setMenu(false)} go={go} />
      <VaultSheet />
      <WalletModals />
    </>
  );
}
