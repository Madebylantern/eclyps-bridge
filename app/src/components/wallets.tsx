"use client";
import { useEffect, useMemo, useState } from "react";
import { type ExtensionCandidate, discoverExtensions } from "@/lib/aztec";
import { useApp } from "@/lib/app";
import { hostOf, solanaChain, usd } from "@/lib/deployment";
import { connectStandardWallet, devKeypairSigner, standardWallets } from "@/lib/solana";
import { Act, FieldLabel, Input, Label, Modal, Mono, Ref, StatusLine } from "./ui";

export function WalletModals() {
  const { modal, setModal } = useApp();
  return (
    <>
      {/* Above the vault step (src/components/vault-sheet.tsx), which can ask for the wallet. */}
      <Modal open={modal === "solana"} onClose={() => setModal(null)} title="Solana wallet" testId="solana-modal" layer="z-[70]"><SolanaPanel /></Modal>
      <Modal open={modal === "aztec"} onClose={() => setModal(null)} title="Aztec wallet" testId="aztec-modal" layer="z-[70]"><AztecPanel /></Modal>
    </>
  );
}

function SolanaPanel() {
  const { dep, solana } = useApp();
  const [devKey, setDevKey] = useState("");
  const [err, setErr] = useState<string>();
  const wallets = useMemo(() => (typeof window === "undefined" ? [] : standardWallets()), []);
  const chain = solanaChain(dep);
  const connect = (f: Parameters<typeof solana.connect>[0]) => {
    setErr(undefined);
    return solana.connect(f).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  if (solana.signer) {
    return (
      <div className="flex flex-col gap-10">
        <div className="space-y-2">
          <Label>Connected</Label>
          <p className="text-lg text-white">{solana.signer.label}</p>
          <Ref value={solana.signer.address} display={solana.signer.address} prefix="Address" />
        </div>
        <dl className="facts">
          <div>
            <dt>USDC</dt>
            <dd data-testid="usdc-balance">{solana.usdc ? usd(solana.usdc.amount) : "No USDC account on this network"}</dd>
          </div>
        </dl>
        <p className="text-sm text-grey">Public as a depositor. Never move out to it.</p>
        <div><Act quiet onClick={solana.disconnect}>Disconnect</Act></div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      <div className="space-y-4">
        <Label>Browser wallets</Label>
        <div className="acts">
          {wallets.length === 0 && <span className="text-sm text-dim" title="Phantom, Solflare, Backpack and other Wallet Standard wallets">No wallet found in this browser.</span>}
          {wallets.map((w) => (
            <Act key={w.name} arrow onClick={() => connect(() => connectStandardWallet(w, chain))}>
              {w.icon && <img src={w.icon} alt="" className="h-4 w-4 self-center grayscale" />}
              {w.name}
            </Act>
          ))}
        </div>
      </div>
      {/* Never on mainnet: pasting a secret key is for throwaway test keys only. */}
      {dep.network !== "mainnet" && <div className="space-y-4">
        <Label>Test networks: a dev keypair</Label>
        <p className="text-sm text-grey">Throwaway keys only, never one with real funds.</p>
        <label className="block space-y-1">
          <FieldLabel>Keypair</FieldLabel>
          <Input testId="dev-key" placeholder="[12, 34, …]" title="Local stack: scripts/e2e/.local/user.json" value={devKey} onChange={(e) => setDevKey(e.target.value)} className="font-mono !text-sm" autoComplete="off" spellCheck={false} />
        </label>
        <Act testId="use-dev-key" arrow disabled={!devKey} onClick={() => connect(() => devKeypairSigner(devKey))}>Use dev keypair</Act>
      </div>}
      <StatusLine error={err} />
    </div>
  );
}

function AztecPanel() {
  const { dep, aztec, data } = useApp();
  const [found, setFound] = useState<ExtensionCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<{ name: string; emojis: string; confirm(): Promise<unknown>; cancel(): void }>();
  const [err, setErr] = useState<string>();

  const scan = async () => {
    setScanning(true);
    setFound([]);
    try {
      await discoverExtensions(dep, (c) => setFound((f) => [...f.filter((x) => x.id !== c.id), c]));
    } catch (e) {
      setErr(`Looking for wallet extensions failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    if (!aztec.session) void scan();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (aztec.session) {
    const s = aztec.session;
    return (
      <div className="flex flex-col gap-10">
        <div className="space-y-2">
          <Label>Connected</Label>
          <p className="text-lg text-white">{s.label}</p>
        </div>
        <div className="space-y-2">
          <Label>Recipient</Label>
          <Ref value={s.recipient} display={s.recipient} />
          <p className="text-sm text-grey">Never seen on Solana or Ethereum.</p>
        </div>
        <dl className="facts">
          <div>
            <dt>Fees</dt>
            <dd>{s.feePayer}</dd>
          </div>
        </dl>
        <div><Act quiet onClick={aztec.disconnect}>Disconnect</Act></div>
      </div>
    );
  }
  const warming = aztec.state === "warming";
  return (
    <div className="flex flex-col gap-12">
      <div className="space-y-3">
        <Label>In this page</Label>
        <Act big arrow testId="open-aztec" onClick={aztec.openEmbedded} disabled={warming}>
          {warming ? "Opening the wallet in this page" : aztec.state === "failed" ? "Try again: wallet in this page" : "Open the wallet in this page"}
        </Act>
        <p className="text-sm text-grey" title={`${dep.network === "local" ? "Local stack: proofs are off." : dep.fees?.user === "eclypsFpc" ? "Real proofs; Eclyps pays the Aztec fees." : dep.fees?.user === "feeJuice" ? "Real proofs; your account pays the fees in Fee Juice." : "Real proofs; the network's SponsoredFPC pays fees."} Aztec node: ${hostOf(dep.aztec.node)}.`}>
          Proves claims in this tab, from your phrase.
        </p>
        {aztec.status && <Mono testId="aztec-status" className="block">{aztec.status}</Mono>}
        {!data.settings.warmAztec && !warming && <p className="text-sm text-dim">Start on unlock is off (Keys).</p>}
        {aztec.state === "failed" && aztec.error && <StatusLine error={`Opening the wallet failed: ${aztec.error}`} testId="aztec-error" />}
        <p className="text-sm text-dim sm:hidden">Proving is faster on a laptop.</p>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <Label>Aztec wallet extension</Label>
          <Act quiet small onClick={scan} disabled={scanning}>{scanning ? "Looking" : "Look again"}</Act>
        </div>
        <p className="text-sm text-grey">Keys stay in the extension.</p>
        {found.length === 0 && <Mono testId="aztec-extensions" className="block">{scanning ? "Looking for extensions…" : "No Aztec wallet extension found."}</Mono>}
        <div className="acts">
          {found.map((c) => (
            <Act key={c.id} arrow onClick={async () => {
              try {
                const p = await c.connect();
                setPending({ name: c.name, ...p });
              } catch (e) {
                setErr(String(e));
              }
            }}>
              {c.icon && <img src={c.icon} alt="" className="h-4 w-4 self-center grayscale" />}
              {c.name}
            </Act>
          ))}
        </div>
        {pending && (
          <div className="space-y-3 pt-2">
            <p className="text-white">Check that {pending.name} shows exactly these emojis:</p>
            <div className="text-2xl tracking-widest">{pending.emojis}</div>
            <div className="acts">
              <Act onClick={async () => {
                try {
                  await aztec.setSession((await pending.confirm()) as never);
                } catch (e) {
                  setErr(String(e));
                }
              }}>They match</Act>
              <Act quiet onClick={() => { pending.cancel(); setPending(undefined); }}>They don&apos;t</Act>
            </div>
          </div>
        )}
      </div>
      <StatusLine error={err} />
    </div>
  );
}
