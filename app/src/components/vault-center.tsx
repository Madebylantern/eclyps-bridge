"use client";
import { useEffect, useState } from "react";
import { useApp, useVault } from "@/lib/app";
import { hostOf } from "@/lib/deployment";
import { clock, plural } from "@/lib/format";
import { walletMessage } from "@/lib/keys";
import { createPasskey, getPasskey, passkeyAvailable } from "@/lib/passkey";
import { download, Vault } from "@/lib/vault";
import { NotifyToggle } from "./reminders";
import { PhraseGrid, WordCheck } from "./phrase";
import { Act, Confirm, Disclosure, DocsLink, FieldLabel, Input, Label, Mono, Section, short, StatusLine, Switch } from "./ui";

/** A row of the keys list: what it is and a line about it on the left, its state or action on the right. */
function Row({ k, d, children, testId }: { k: React.ReactNode; d?: React.ReactNode; children?: React.ReactNode; testId?: string }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-5" data-testid={testId}>
      <div className="min-w-0 max-w-[52ch] flex-1 space-y-1">
        <p className="text-text">{k}</p>
        {d && <div className="text-sm text-grey">{d}</div>}
      </div>
      {children && <div className="flex min-w-0 max-w-full flex-col items-start gap-2 max-sm:basis-full">{children}</div>}
    </li>
  );
}

export function VaultCenter({ verifyNow }: { verifyNow?: boolean }) {
  const { dep, aztec, solana, lock, setModal, rev, rescan, confirmBackup, updateSettings } = useApp();
  const vault = useVault();
  const backedUp = vault.data.backup.confirmedAt !== undefined;
  const [reveal, setReveal] = useState<"closed" | "ask" | "shown">("closed");
  const [verify, setVerify] = useState(!!verifyNow && !backedUp);
  const [pass, setPass] = useState("");
  const [msg, setMsg] = useState<{ text?: string; error?: string }>({});
  const [scan, setScan] = useState<{ busy?: boolean; text?: string; error?: string }>({});
  const [forget, setForget] = useState(false);
  const [prf, setPrf] = useState(false);
  const [pk, setPk] = useState<{ busy?: boolean; text?: string; error?: string }>({});
  useEffect(() => {
    passkeyAvailable().then(setPrf);
  }, []);
  const passkeys = vault.passkeys;
  /** A passkey vault: the phrase is an optional backup, revealed with a passkey (ADR 0016). */
  const byPasskey = passkeys.length > 0;
  /** A wallet vault ("Use my wallet instead"): revealed with the wallet's signature. */
  const byWallet = !byPasskey && !vault.hasPassphrase && !!vault.wallet;
  /** What brings the seed back without the phrase, which is then an optional backup. */
  const optional = vault.seedFrom;

  const revealWithWallet = async () => {
    setMsg({});
    try {
      const s = solana.signer;
      if (!s?.signMessage || s.address !== vault.wallet) {
        setModal("solana");
        throw new Error(`Connect ${short(vault.wallet!, 4)}, the wallet that opens this vault.`);
      }
      const signature = await s.signMessage(new TextEncoder().encode(walletMessage(dep.network)));
      if (await vault.check({ wallet: { address: s.address, signature } })) setReveal("shown");
      else setMsg({ error: "This wallet doesn't open this vault." });
    } catch (e) {
      setMsg({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  const revealWithPasskey = async () => {
    setMsg({});
    try {
      const got = await getPasskey(passkeys);
      if (await vault.check({ passkey: got })) setReveal("shown");
      else setMsg({ error: "This passkey doesn't open this vault." });
    } catch (e) {
      setMsg({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  const addPasskey = async () => {
    setPk({ busy: true });
    try {
      await vault.addPasskey(await createPasskey("added", passkeys));
      setPk({ text: "Added. It unlocks this vault with one tap." });
    } catch (e) {
      setPk({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  const exportViewOnly = () => {
    const view = {
      app: "eclyps",
      kind: "view-only",
      warning: "Lets the holder see these notes and, with the Aztec key, incoming private notes. It cannot spend. Treat it as private.",
      network: dep.network,
      exportedAt: new Date().toISOString(),
      aztec: aztec.session ? { recipient: aztec.session.recipient, incomingViewingSecretKey: aztec.session.incomingViewingKey ?? null } : null,
      notes: vault.data.notes.map((n) => ({
        index: n.index, denomination: n.denomination, commitment: n.commitment, epochId: n.epochId ?? null,
        depositSig: n.depositSig ?? null, scheduledAt: n.scheduledAt ?? null, claimTx: n.claimTx ?? null, refundSig: n.refundSig ?? null,
      })),
    };
    download(`eclyps-view-only-${dep.network}.json`, JSON.stringify(view, null, 2));
  };

  const runRescan = async () => {
    setScan({ busy: true });
    try {
      const r = await rescan();
      setScan({ text: r.found === 0 ? "No notes from this phrase on chain yet." : `Found ${plural(r.found, "note")}${r.added ? `, ${r.added} new under Recovered notes` : ", all already here"}.` });
    } catch (e) {
      setScan({ error: `The scan didn't finish: ${e instanceof Error ? e.message : e}` });
    }
  };

  return (
    <div className="flex max-w-[46rem] flex-col gap-[clamp(48px,8vh,80px)]" data-rev={rev}>
      <Section testId="phrase-card" label={optional ? "Back up" : "Recovery phrase"} className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Label>{optional ? "Back up" : "Recovery phrase"}</Label>
          <p className="text-grey">{optional ? `Optional. 24 words on paper bring your notes back without the ${optional}.` : "24 words: the only way back to your notes."}</p>
        </div>
        {verify ? (
          <WordCheck seed={vault.seed} laterLabel="Cancel" onLater={() => setVerify(false)} onDone={async () => {
            await confirmBackup();
            setVerify(false);
            setMsg({ text: "Your written phrase matches." });
          }} />
        ) : reveal === "shown" ? (
          <div className="flex flex-col gap-6">
            <PhraseGrid phrase={vault.phrase} revealed testId="phrase-revealed" />
            <Disclosure summary="Advanced: the same seed as 64 hex characters" testId="phrase-hex">
              <p className="mb-2 text-sm text-grey">Older backups used this form. Same notes.</p>
              <Mono className="block break-all text-text">{vault.data.seedHex}</Mono>
            </Disclosure>
            <div><Act quiet onClick={() => setReveal("closed")}>Hide</Act></div>
          </div>
        ) : reveal === "ask" ? (
          <form className="flex flex-col gap-5" onSubmit={async (e) => {
            e.preventDefault();
            if (await vault.checkPassphrase(pass)) {
              setReveal("shown");
              setPass("");
              setMsg({});
            } else setMsg({ error: "Wrong passphrase. Check caps lock." });
          }}>
            <PhraseGrid phrase={vault.phrase} revealed={false} testId="phrase-veiled" />
            <label className="flex max-w-[24rem] flex-col gap-1">
              <FieldLabel>Passphrase</FieldLabel>
              <Input type="password" autoComplete="current-password" autoFocus placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} testId="reveal-passphrase" />
            </label>
            <div className="acts">
              <Act type="submit" arrow testId="reveal-confirm" disabled={!pass}>Show the phrase</Act>
              <Act quiet onClick={() => setReveal("closed")}>Cancel</Act>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-6">
            <PhraseGrid phrase={vault.phrase} revealed={false} testId="phrase-veiled" />
            <div className="acts">
              <Act testId="reveal-phrase" quiet onClick={() => (byPasskey ? revealWithPasskey() : byWallet ? revealWithWallet() : setReveal("ask"))}>Reveal</Act>
              <Act testId="verify-backup" quiet={backedUp || !!optional} arrow={!backedUp && !optional} onClick={() => { setVerify(true); setMsg({}); }}>Check my written copy</Act>
            </div>
          </div>
        )}
        <StatusLine text={msg.text} error={msg.error} />
      </Section>

      <Section label="Vault and settings">
        <ul className="rows">
          <Row k="Backup" d={backedUp ? undefined : optional ? <span className="flex flex-wrap items-baseline gap-x-4">Eclyps can&apos;t recover your {optional}.<DocsLink to="keys">How keys work</DocsLink></span> : "Check your written copy."}>
            <span className={backedUp || optional ? "text-text" : "text-white"} data-testid="backup-status">
              {backedUp ? `Checked ${clock(vault.data.backup.confirmedAt!)}` : optional ? "Not backed up" : "Not checked yet"}
            </span>
          </Row>
          {(byPasskey || prf) && (
            <Row k="Passkeys" d={byPasskey ? "Each one unlocks this vault." : "Unlock with one tap instead."} testId="passkeys">
              <span className="text-text" data-testid="passkey-count">{byPasskey ? plural(passkeys.length, "passkey") : "None"}</span>
              {prf && <Act small arrow testId="passkey-add" disabled={pk.busy} onClick={addPasskey}>{pk.busy ? "Waiting for the passkey" : "Add a passkey"}</Act>}
            </Row>
          )}
          {(pk.text || pk.error) && <li className="py-4"><StatusLine text={pk.text} error={pk.error} testId="passkey-result" /></li>}
          <Row k="Encryption" d={<>In this browser · {plural(vault.data.notes.length, "note")}</>}>
            <span className="mono text-[0.75rem] text-grey [overflow-wrap:anywhere]" data-testid="vault-status" title={vault.cryptoLine}>
              Encrypted · unlocked
            </span>
            <Act small quiet testId="vault-lock" onClick={lock}>Lock now</Act>
          </Row>
          <Row k="Start the Aztec wallet on unlock" d={<span title={`Connects to ${hostOf(dep.aztec.node)} when you unlock.`}>Claims are faster.</span>}>
            <Switch on={vault.data.settings.warmAztec} onChange={(v) => updateSettings({ warmAztec: v })} label="Start the Aztec wallet on unlock" testId="setting-warm-aztec" />
          </Row>
          <li className="py-5"><NotifyToggle /></li>
          <Row k="Find notes on chain" d="After a restore or import.">
            <Act small arrow testId="rescan" disabled={scan.busy} onClick={runRescan}>{scan.busy ? "Scanning" : "Scan the chain"}</Act>
          </Row>
          {(scan.text || scan.error) && <li className="py-4"><StatusLine text={scan.text} error={scan.error} testId="rescan-result" /></li>}
          <Row k="Vault file" d={vault.hasPassphrase ? "Encrypted. Needs your passphrase." : byWallet ? "Encrypted. Needs your wallet." : "Encrypted. Needs your passkey."}>
            <Act small arrow testId="export-vault" onClick={() => download(`eclyps-vault-${dep.network}.json`, vault.exportFile())}>Download encrypted</Act>
          </Row>
          <Row k="View-only key" d={<span title={aztec.session?.incomingViewingKey ? "Note history and your Aztec incoming viewing key." : "Note history; the Aztec viewing key once the Aztec wallet is open."}>Sees your history. Cannot spend.</span>}>
            <Act small arrow testId="export-viewing-key" onClick={exportViewOnly}>Export view-only</Act>
            {!aztec.session && <Act small quiet onClick={() => setModal("aztec")}>Open Aztec</Act>}
          </Row>
          <Row k="This browser" d={optional ? `Your ${optional} or phrase brings your notes back.` : "Your phrase still restores your notes."}>
            {!forget && <Act small quiet onClick={() => setForget(true)}>Forget vault</Act>}
          </Row>
          {forget && (
            <li className="py-5">
              <Confirm title="Forget the vault in this browser?" testId="forget-vault" confirmLabel="Forget it"
                body={optional ? `Your ${optional === "passkey" ? "first passkey" : "wallet"} or your phrase brings your notes back.` : backedUp ? "You will need your phrase or a backup file." : "Your phrase isn't checked yet. Without it or a backup, these notes are lost."}
                onCancel={() => setForget(false)} onConfirm={() => { Vault.forget(); lock(); }} />
            </li>
          )}
        </ul>
      </Section>
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
        <Mono className="text-xs !text-dim">Vault created {new Date(vault.data.createdAt).toLocaleString()}</Mono>
        <DocsLink to="keys" arrow>How keys work</DocsLink>
      </div>
    </div>
  );
}
