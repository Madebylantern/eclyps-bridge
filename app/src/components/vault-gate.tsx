"use client";
import { parseSeedInput } from "@eclyps/sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/lib/app";
import type { Deployment } from "@/lib/deployment";
import { hostOf } from "@/lib/deployment";
import { plural } from "@/lib/format";
import { sameBytes, verifyWalletSignature, walletMessage } from "@/lib/keys";
import { ChainCache } from "@/lib/portfolio";
import { scanForNotes } from "@/lib/recovery";
import { addressBytes, describeChainError } from "@/lib/solana";
import { createPasskey, getPasskey, NoPrfError, passkeyAvailable } from "@/lib/passkey";
import { type StoredVault, Vault } from "@/lib/vault";
import { PhraseGrid, WordCheck } from "./phrase";
import { Act, Confirm, FieldLabel, HelpLine, Input, Section, short, StatusLine, Title } from "./ui";

type Mode = "open" | "restore" | "import";
type Step = "form" | "phrase" | "check" | "scan";
/** Which way in shows: the passkey (or the passphrase where none can be offered), the wallet, or a form under Other options. */
type View = "auto" | "wallet" | "form";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The one line under each way in, and what its "?" says (≤ 2 short lines; the rest is on Docs). */
const LINE = { start: "Keeps your private receipts on this device.", open: "Opens your private receipts on this device." };
const HELP = {
  passkey: "A passkey is your face or fingerprint. It locks receipts that prove the money is yours, without showing which deposit. Nothing leaves this device.",
  passphrase: "Your passphrase locks receipts that prove the money is yours, without showing which deposit. Nothing leaves this device.",
  unlock: "Your receipts stay locked here until an action needs them: a deposit, a claim, or seeing where your money is.",
  wallet: "The same wallet makes the same keys on any device. A copy of this site could ask for the same signature, so check the address first.",
};

/** What the restore field holds so far, in words. */
function readRestore(text: string): { ok: boolean; hint?: string; error?: string } {
  const t = text.trim();
  if (!t) return { ok: false };
  if (/^(0x)?[0-9a-fA-F]+$/.test(t) && !/\s/.test(t)) {
    const n = t.replace(/^0x/, "").length;
    return n === 64 ? { ok: true, hint: "Old-style 64-hex backup: the same notes." } : { ok: false, hint: `${n} of 64 hex characters` };
  }
  const words = t.split(/\s+/).length;
  if (words < 24) return { ok: false, hint: `${words} of 24 words` };
  try {
    parseSeedInput(t);
    return { ok: true, hint: "24 words, checksum OK." };
  } catch (e) {
    return { ok: false, error: `${cap(e instanceof Error ? e.message : String(e))}.` };
  }
}

/**
 * One calm column on black, centred: an optional thin title and line, then the step. The vault
 * sheet (src/components/vault-sheet.tsx) centres it in the screen.
 */
function Gate({ title, children, lead, testId }: { title?: string; lead?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <Section testId={testId} className="mx-auto flex w-full max-w-[46rem] flex-col items-center gap-10 text-center">
      {(title || lead) && (
        <div className="flex flex-col items-center gap-4">
          {title && <Title as="h1">{title}</Title>}
          {lead && <p className="max-w-[44ch] text-grey">{lead}</p>}
        </div>
      )}
      {children}
    </Section>
  );
}

/** A generic face-scan glyph: four corner brackets and a minimal face, thin white lines. */
function FaceScan() {
  return (
    <svg className="face" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 10V5.5A2.5 2.5 0 0 1 5.5 3H10M22 3h4.5A2.5 2.5 0 0 1 29 5.5V10M29 22v4.5a2.5 2.5 0 0 1-2.5 2.5H22M10 29H5.5A2.5 2.5 0 0 1 3 26.5V22" />
      <path d="M11.5 12v2.5M20.5 12v2.5M16 12.5v5h-1.5M12 21.5c2.3 1.9 5.7 1.9 8 0" />
    </svg>
  );
}

/** One quiet word, "Other options", that reveals the other ways in, one per line. */
function Others({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <Act quiet small testId="gate-other" pressed={open} onClick={onToggle}>Other options</Act>
      {open && <div className="flex flex-col items-center gap-3" data-testid="gate-options">{children}</div>}
    </div>
  );
}

/**
 * The vault step (ADR 0016, amended 2026-10-19). It comes only when an action needs the vault:
 * the face and "Start" (a passkey), with one line and its "?"; returning, "Unlock". Everything else
 * is under Other options: a passkey from another device, "Use my wallet instead" (keys from one
 * wallet signature), a passphrase, restore, import. Without a passkey (headless browsers, IP
 * addresses) the passphrase comes first, the path the UI demos drive. `onCancel` closes it.
 */
export function VaultGate({ dep, onReady, onCancel }: { dep: Deployment; onReady: (v: Vault) => void; onCancel: () => void }) {
  const { solana, setModal, modal } = useApp();
  const [stored, setStored] = useState<StoredVault>();
  const exists = stored !== undefined;
  /** Passkeys with PRF can be offered here (ADR 0016); undefined while checking. */
  const [prf, setPrf] = useState<boolean>();
  const [view, setView] = useState<View>("auto");
  /** "Other options" opened. */
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState<Mode>("open");
  const [pass, setPass] = useState("");
  const [restore, setRestore] = useState("");
  const [fileText, setFileText] = useState<string>();
  const [vault, setVault] = useState<Vault>();
  const [step, setStep] = useState<Step>("form");
  const [revealed, setRevealed] = useState(false);
  const [scan, setScan] = useState<{ state: "running" | "done" | "failed"; found?: number; error?: string }>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [note, setNote] = useState<string>();
  const [forget, setForget] = useState(false);
  useEffect(() => {
    const s = Vault.stored();
    setStored(s);
    // A vault without passkeys opens on its own way in (the passphrase, or the wallet).
    if (s && s.passkeys.length === 0) setPrf(false);
    // A vault that holds passkeys already proved PRF works here (perhaps with a security key, which
    // the detection below does not count), so its passkeys are always offered.
    else if (s) setPrf(typeof window.PublicKeyCredential === "function");
    else passkeyAvailable().then(setPrf);
  }, []);
  useEffect(() => {
    if (stored && !stored.passphrase && mode === "open") setMode("restore");
  }, [stored, mode]);
  const restoreState = useMemo(() => readRestore(restore), [restore]);

  const run = (f: () => Promise<void>) => async () => {
    setBusy(true);
    setMsg(undefined);
    setNote(undefined);
    try {
      await f();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setNote(undefined);
    }
  };

  /** Go to another way in, its options closed. */
  const go = (to: View, m?: Mode) => () => {
    setView(to);
    if (m) setMode(m);
    setMore(false);
    setForget(false);
    setMsg(undefined);
  };

  const runScan = async (v: Vault) => {
    setScan({ state: "running" });
    try {
      const r = await scanForNotes(dep, v, new ChainCache());
      setScan({ state: "done", found: r.found });
    } catch (e) {
      const d = describeChainError(e, dep);
      setScan({ state: "failed", error: d.kind === "unreachable" ? `Couldn't reach the Solana RPC at ${hostOf(dep.solana.rpc)}.` : d.message });
    }
  };

  /**
   * Close (or Escape): before a vault exists, the action that asked is cancelled. Once one was made
   * (the phrase and its check, the scan) it opens as it is, the phrase left for later under Keys.
   */
  const close = async () => {
    if (vault && (step === "phrase" || step === "check")) {
      await vault.update((d) => {
        d.backup.deferredAt ??= Date.now();
      });
      onReady(vault);
    } else if (vault && step === "scan") onReady(vault);
    else onCancel();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    // A wallet sheet over this step takes Escape first.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && modal === null && !busy && void closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, busy]);

  const frame = (content: React.ReactNode) => (
    <div className="grid min-h-svh grid-rows-[auto_1fr_auto]">
      <div className="flex justify-end py-7">
        <button type="button" className="nav-word" data-testid="vault-close" onClick={() => void close()}>Close</button>
      </div>
      <div className="flex flex-col justify-center py-6">{content}</div>
      <div className="h-[clamp(32px,9vh,96px)]" aria-hidden />
    </div>
  );

  const forgetting = (body: string, after?: () => void) =>
    forget ? (
      <Confirm title="Forget the vault in this browser?" testId="forget-vault" body={body}
        confirmLabel="Forget it" onCancel={() => setForget(false)}
        onConfirm={() => { Vault.forget(); setStored(undefined); setForget(false); setMore(false); setView("auto"); after?.(); }} />
    ) : (
      <Act quiet small testId="gate-forget" onClick={() => setForget(true)}>Forget the vault in this browser</Act>
    );
  const forgetBody = stored?.seedPasskey || stored?.wallet
    ? `Your ${stored.seedPasskey ? "passkey" : "wallet"} or your phrase still brings your notes back.`
    : "Your phrase or a backup file still restores your notes.";

  if (vault && step === "phrase") {
    return frame(
      <Gate key="phrase" title="Write down your recovery phrase."
        lead="24 words, on paper, in order. Anyone with them can take your notes.">
        <PhraseGrid phrase={vault.phrase} revealed={revealed} onReveal={() => setRevealed(true)} />
        <div className="acts justify-center">
          <Act big arrow testId="seed-saved" disabled={!revealed} onClick={() => setStep("check")}>I wrote it down</Act>
          <Act quiet testId="seed-later" onClick={async () => { await vault.update((d) => { d.backup.deferredAt = Date.now(); }); onReady(vault); }}>Later, under Keys</Act>
        </div>
      </Gate>,
    );
  }

  if (vault && step === "check") {
    const finish = async (f: "confirmedAt" | "deferredAt") => {
      await vault.update((d) => {
        d.backup[f] = Date.now();
      });
      onReady(vault);
    };
    return frame(
      <Gate key="check" title="Check your copy."
        lead="Type these three words from your paper.">
        <div className="text-left"><WordCheck seed={vault.seed} onDone={() => finish("confirmedAt")} onLater={() => finish("deferredAt")} /></div>
        <div><Act quiet small onClick={() => setStep("phrase")}>Show the phrase again</Act></div>
      </Gate>,
    );
  }

  if (vault && step === "scan") {
    return frame(
      <Gate key="scan" testId="restore-scan" title="Looking for your notes."
        lead={`Reading Solana for notes made from this ${vault.passkeys.length ? "passkey" : vault.wallet ? "wallet" : "phrase"}.`}>
        {scan?.state === "running" && <p className="text-grey" role="status">Reading epochs from {hostOf(dep.solana.rpc)}…</p>}
        {scan?.state === "done" && (
          <p className="text-white" data-testid="restore-found" role="status">
            {scan.found ? `Found ${plural(scan.found, "note")}.` : "No notes yet. New notes start from the beginning."}
          </p>
        )}
        {scan?.state === "failed" && (
          <StatusLine testId="restore-scan-error"
            error={`${scan.error} Deposits stay off until the scan ends.`} />
        )}
        <div className="acts justify-center">
          <Act big arrow testId="restore-continue" disabled={scan?.state === "running"} onClick={() => onReady(vault)}>Continue</Act>
          {scan?.state === "failed" && <Act quiet onClick={() => runScan(vault)}>Try again</Act>}
        </div>
      </Gate>,
    );
  }

  if (prf === undefined && !exists) return frame(<Section className="min-h-[50vh]"><span /></Section>);
  const passkeyHere = !!prf && (exists ? stored.passkeys.length > 0 : true);
  /** The way in that comes first: a passkey where one can be, else the wallet that made the vault, else the passphrase. */
  const auto = passkeyHere ? "passkey" : exists && stored.wallet && !stored.passphrase ? "wallet" : "form";
  const shown = view === "auto" ? auto : view;
  /** Other options: the ways in this view does not show. */
  const walletOption = !exists
    ? <Act quiet small testId="gate-wallet" onClick={go("wallet")}>Use my wallet instead</Act>
    : stored.wallet ? <Act quiet small testId="gate-wallet" onClick={go("wallet")}>Unlock with my wallet</Act> : null;

  if (shown === "passkey") {
    const createWithPasskey = run(async () => {
      try {
        onReady(await Vault.fromPasskey(await createPasskey("seed")));
      } catch (e) {
        if (e instanceof NoPrfError) {
          setPrf(false);
          setView("form");
          setMode("open");
        }
        throw e;
      }
    });
    const signIn = run(async () => {
      const pk = await getPasskey();
      if (pk.role === "added") throw new Error("This passkey opens the vault only where it was added. Use your first passkey or your phrase.");
      if (pk.role !== "seed") throw new Error("This isn't an Eclyps vault passkey.");
      const v = await Vault.fromPasskey(pk, true);
      setVault(v);
      setStep("scan");
      runScan(v);
    });
    const unlock = run(async () => {
      const pk = await getPasskey(stored!.passkeys);
      onReady(await Vault.unlock({ passkey: pk }));
    });
    return frame(
      <Gate testId="passkey-gate">
        <div className="flex flex-col items-center gap-4">
          {/* The face above the word, both on the column's axis (globals.css .act.stack). */}
          {exists ? (
            <Act big className="stack" testId="passkey-unlock" disabled={busy} onClick={unlock}><FaceScan /><span>{busy ? "Waiting" : "Unlock"}</span></Act>
          ) : (
            <Act big className="stack" testId="passkey-create" disabled={busy} onClick={createWithPasskey}><FaceScan /><span>{busy ? "Waiting" : "Start"}</span></Act>
          )}
          <StatusLine error={msg} testId="gate-error" />
        </div>
        <HelpLine center className="text-text" testId="gate-line" help={exists ? HELP.unlock : HELP.passkey} docs="keys">{exists ? LINE.open : LINE.start}</HelpLine>
        <Others open={more} onToggle={() => { setMore((m) => !m); setForget(false); }}>
          {exists ? (
            <>
              {stored.passphrase
                ? <Act quiet small testId="gate-passphrase" onClick={go("form", "open")}>Use the passphrase</Act>
                : <Act quiet small testId="gate-restore" onClick={go("form", "restore")}>Restore from my phrase</Act>}
              {walletOption}
              {forgetting(forgetBody, () => setMode("open"))}
            </>
          ) : (
            <>
              <Act quiet small testId="passkey-signin" disabled={busy} onClick={signIn}>I already have a passkey</Act>
              {walletOption}
              <Act quiet small testId="gate-passphrase" onClick={go("form", "open")}>Use a passphrase</Act>
              <Act quiet small testId="gate-restore" onClick={go("form", "restore")}>Restore from my phrase</Act>
              <Act quiet small testId="gate-import" onClick={go("form", "import")}>Import a vault file</Act>
            </>
          )}
        </Others>
      </Gate>,
    );
  }

  if (shown === "wallet") {
    const signer = solana.signer;
    const unlocking = exists && !!stored.wallet;
    const wrongWallet = unlocking && !!signer && signer.address !== stored.wallet;
    // "Use my wallet instead" (ADR 0016, amended): one signature over a fixed message makes the keys.
    const sign = run(async () => {
      if (!signer) return setModal("solana");
      if (!signer.signMessage) throw new Error("This wallet can't sign messages here. Use a passkey or a passphrase.");
      const message = new TextEncoder().encode(walletMessage(dep.network));
      const signature = await signer.signMessage(message);
      if (!(await verifyWalletSignature(addressBytes(signer.address), signature, message))) {
        throw new Error("This wallet signed a different message, so it can't make keys here. Use a passkey or a passphrase.");
      }
      if (unlocking) {
        onReady(await Vault.unlock({ wallet: { address: signer.address, signature } }));
        return;
      }
      // The same bytes twice, or another device would get other keys from this wallet.
      setNote("Sign once more to check.");
      const again = await signer.signMessage(message);
      if (!sameBytes(signature, again)) throw new Error("This wallet signs differently each time, so it can't hold keys. Use a passkey or a passphrase.");
      onReady(await Vault.fromWallet({ address: signer.address, signature }));
    });
    return frame(
      <Gate testId="wallet-gate">
        <div className="flex flex-col items-center gap-4">
          {!signer ? (
            <Act big testId="wallet-connect" onClick={() => setModal("solana")}>Connect wallet</Act>
          ) : (
            <Act big testId="wallet-sign" disabled={busy || wrongWallet} onClick={sign}>{busy ? "Waiting for your wallet" : unlocking ? "Unlock" : "Sign"}</Act>
          )}
          <StatusLine text={note} error={msg ?? (wrongWallet ? `This vault opens with ${short(stored.wallet!, 4)}. Switch to it in your wallet.` : undefined)} testId="gate-error" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <HelpLine center className="text-text" testId="gate-line" help={HELP.wallet} docs="keys">{unlocking ? "Your wallet opens your private receipts." : "Your wallet signs one message that makes your keys."}</HelpLine>
          <p className="text-sm text-white" data-testid="wallet-warning">Only sign this on eclyps.xyz.</p>
        </div>
        <Others open={more} onToggle={() => { setMore((m) => !m); setForget(false); }}>
          {exists ? (
            <>
              {stored.passkeys.length > 0 && <Act quiet small testId="gate-passkey" onClick={go("auto")}>Unlock with a passkey</Act>}
              {stored.passphrase
                ? <Act quiet small testId="gate-passphrase" onClick={go("form", "open")}>Use the passphrase</Act>
                : <Act quiet small testId="gate-restore" onClick={go("form", "restore")}>Restore from my phrase</Act>}
              {forgetting(forgetBody, () => setMode("open"))}
            </>
          ) : (
            <>
              {prf && <Act quiet small testId="gate-passkey" onClick={go("auto")}>Use a passkey</Act>}
              <Act quiet small testId="gate-passphrase" onClick={go("form", "open")}>Use a passphrase</Act>
              <Act quiet small testId="gate-restore" onClick={go("form", "restore")}>Restore from my phrase</Act>
              <Act quiet small testId="gate-import" onClick={go("form", "import")}>Import a vault file</Act>
            </>
          )}
        </Others>
      </Gate>,
    );
  }

  const title = mode === "restore" ? "Restore your notes." : mode === "import" ? "Import a vault file." : undefined;
  const lead = mode === "restore" ? "Type your 24 words." : undefined;
  const canOpen = !exists || !!stored.passphrase;
  const fileWallet = fileText ? (() => { try { return Vault.readFile(fileText).wallet; } catch { return undefined; } })() : undefined;
  return frame(
    <Gate title={title} lead={lead}>
      {mode === "open" && (
        <HelpLine center className="text-text" testId="gate-line" help={exists ? HELP.unlock : HELP.passphrase} docs="keys">{exists ? LINE.open : LINE.start}</HelpLine>
      )}
      <form className="flex w-full max-w-[26rem] flex-col items-center gap-8" onSubmit={(e) => e.preventDefault()}>
        {/* Lets password managers file the passphrase under a stable name. */}
        <input type="text" name="username" autoComplete="username" value="Eclyps vault" readOnly hidden />
        {mode === "restore" && (
          <div className="flex w-full flex-col gap-2">
            <label className="flex flex-col gap-1">
              <FieldLabel>Recovery phrase</FieldLabel>
              <textarea data-testid="restore-seed" rows={4} value={restore} onChange={(e) => setRestore(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false}
                placeholder="24 words, or an older 64-hex seed"
                className="field resize-y text-center font-mono !text-sm leading-relaxed placeholder:font-sans" />
            </label>
            <StatusLine text={restoreState.hint} error={restoreState.error} testId="restore-hint" />
          </div>
        )}
        {mode === "import" && (
          <label className="act quiet cursor-pointer has-[:focus-visible]:text-white has-[:focus-visible]:[text-shadow:var(--glow)]">
            {fileText ? "File loaded. Choose another" : "Choose a vault file"}
            <span className="arr" aria-hidden>→</span>
            <input type="file" accept="application/json" className="sr-only" onChange={async (e) => setFileText(await e.target.files?.[0]?.text())} />
          </label>
        )}
        <label className="flex w-full flex-col gap-1">
          <FieldLabel>{mode === "open" && exists ? "Passphrase" : mode === "import" ? "The file's passphrase" : "Choose a passphrase"}</FieldLabel>
          <Input testId="passphrase" type="password" className="text-center" placeholder={mode === "open" && exists ? "Passphrase" : mode === "import" ? "Passphrase" : "8 or more characters"}
            autoComplete={mode === "open" && exists ? "current-password" : "new-password"} value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <div className="flex flex-col items-center gap-4">
          {mode === "open" && (
            exists ? (
              <Act big type="submit" testId="unlock" disabled={busy || !pass} onClick={run(async () => onReady(await Vault.unlock(pass)))}>{busy ? "Unlocking" : "Unlock"}</Act>
            ) : (
              <Act big type="submit" testId="create-vault" disabled={busy} onClick={run(async () => { setVault(await Vault.create(pass)); setStep("phrase"); })}>{busy ? "Starting" : "Start"}</Act>
            )
          )}
          {mode === "restore" && (
            <>
              {exists && <p className="text-sm text-white">This replaces the vault in this browser.</p>}
              <Act big arrow type="submit" testId="restore-submit" disabled={busy || !restoreState.ok} onClick={run(async () => {
                const v = await Vault.create(pass, parseSeedInput(restore));
                setVault(v);
                setStep("scan");
                runScan(v);
              })}>
                {busy ? "Restoring" : "Restore"}
              </Act>
            </>
          )}
          {mode === "import" && (
            <div className="acts justify-center">
              <Act big arrow type="submit" disabled={busy || !fileText} onClick={run(async () => onReady(await Vault.importFile(fileText!, pass)))}>{busy ? "Importing" : "Import"}</Act>
              {prf && fileText && (
                <Act quiet disabled={busy} onClick={run(async () => {
                  const pk = await getPasskey(Vault.readFile(fileText).passkeys);
                  onReady(await Vault.importFile(fileText, { passkey: pk }));
                })}>Import with passkey</Act>
              )}
              {fileWallet && solana.signer?.signMessage && solana.signer.address === fileWallet && (
                <Act quiet disabled={busy} onClick={run(async () => {
                  const message = new TextEncoder().encode(walletMessage(dep.network));
                  const signature = await solana.signer!.signMessage!(message);
                  onReady(await Vault.importFile(fileText!, { wallet: { address: fileWallet, signature } }));
                })}>Import with my wallet</Act>
              )}
            </div>
          )}
          <StatusLine error={msg} testId="gate-error" />
        </div>
      </form>
      <Others open={more} onToggle={() => { setMore((m) => !m); setForget(false); }}>
        {passkeyHere && <Act quiet small testId="gate-passkey" onClick={go("auto")}>{exists ? "Unlock with a passkey" : "Use a passkey"}</Act>}
        {walletOption}
        {mode !== "open" && canOpen && <Act quiet small testId="gate-passphrase" onClick={go("form", "open")}>{exists ? "Unlock with the passphrase" : "Use a passphrase"}</Act>}
        {mode !== "restore" && <Act quiet small testId="gate-restore" onClick={go("form", "restore")}>Restore from my phrase</Act>}
        {mode !== "import" && <Act quiet small testId="gate-import" onClick={go("form", "import")}>Import a vault file</Act>}
        {exists && forgetting(forgetBody, () => { setMode("open"); passkeyAvailable().then(setPrf); })}
      </Others>
    </Gate>,
  );
}
