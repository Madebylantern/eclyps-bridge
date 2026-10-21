"use client";
/**
 * App state: the vault, both wallets (Solana via Wallet Standard, Aztec via the embedded PXE or an
 * extension), and a polled snapshot of public chain state. Every action that changes the note book
 * writes the encrypted vault first, then refreshes.
 *
 * Wallet first (ADR 0016, amended 2026-10-19): the app opens on the bridge with no vault open. The
 * vault is created or unlocked only when an action needs it (Send, a claim, Move out, Keys, or
 * Balance once a vault exists): `ensureVault` shows the vault step and resolves once it is open.
 * Until then the views read an empty note book (`data`).
 */
import { crossNowQuote, depositCost, depositFeeBps, depositRoom, deriveEthereumExit, deriveExit, deriveExitSecret, deriveNote, path as merklePath, openEpochBlocker, planSchedule, refundStatus, toHex } from "@eclyps/sdk";
import { type Address, address } from "@solana/kit";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type AztecSession, type ClaimStage, openEmbedded, type SponsorNote } from "./aztec";
import { claimExitOnSolana, claimOnEthereum, type ethereumExitFacts, type SolanaExitView } from "./exits";
import { type Deployment, epochMs, usd, usdExact } from "./deployment";
import { clock, shortAddr } from "./format";
import { ChainCache, type GatewayStatus, gatewayStatus, isDeposited, type NoteView, type Snapshot, syncChain, takeSnapshot } from "./portfolio";
import { claimFreshIndex, scanForNotes } from "./recovery";
import { parseTotality, totalityPlan } from "./totality";
import { depositExpressNote, depositNote, refundNote, SCREENED, signAndSend, solBalanceOf, type SolanaSigner, usdcAccountOf, walletScreened } from "./solana";
import { checkSwapTransaction, explainSwapError, fetchQuote, fetchSwapTransaction, solNeeded, solText, SwapError, swapFor } from "./swap";
import { PLAN_HOURS } from "./transfers";
import { emptyData, type PlanKind, type StoredExit, type StoredVault, Vault, type VaultData } from "./vault";

/** The vault step was closed without opening a vault: the action that asked for it does nothing. */
export class VaultCancelled extends Error {
  constructor() {
    super("Not started.");
    this.name = "VaultCancelled";
  }
}
export const isCancelled = (e: unknown) => e instanceof VaultCancelled;

export type WalletModal = "solana" | "aztec" | null;

/** Embedded Aztec wallet: opening it loads the prover, so the app starts it early (a setting). */
export type AztecState = "idle" | "warming" | "ready" | "failed";

export interface ClaimProgress {
  stage: ClaimStage | "done" | "failed";
  startedAt: number;
  stageAt: number;
  error?: string;
  tx?: string;
}

/**
 * Why deposits cannot happen right now, in words; undefined when they can (or it is not known yet).
 * `screened`: the connected wallet is on the gateway's screening list (ADR 0019).
 */
export function depositBlock(gw: GatewayStatus | undefined, vault: VaultData, screened?: boolean): string | undefined {
  if (screened) return SCREENED;
  if (vault.rescan?.pending) return "Still scanning for your notes. Deposits wait until it ends.";
  if (!gw) return undefined;
  if (gw.portal === "missing") return "No Ethereum portal on this network yet. Deposits are off.";
  if (gw.portal === "mismatch") return `Deposits blocked: the gateway sends to portal ${shortAddr(gw.onChainPortal, 6)}, not this app's.`;
  if (gw.pausedUntil) return `Deposits paused until ${clock(gw.pausedUntil)}.`;
  if (gw.capReached) return "Deposit cap reached: nothing more can enter for now.";
  return undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function explainClaimError(e: unknown): string {
  const m = message(e);
  if (/nullifier/i.test(m) && /exist|duplicate|already|spent/i.test(m)) {
    return "Already claimed, maybe from another device. It is in your balance.";
  }
  if (/fetch|network|ECONNREFUSED|timed? ?out/i.test(m)) return `Couldn't reach the Aztec node: ${m}. Check your connection and try again.`;
  return m;
}

interface Ctx {
  dep: Deployment;
  /** The open vault; undefined until an action has opened it (and again after Lock). */
  vault?: Vault;
  /** The open vault's note book, or an empty one while no vault is open. */
  data: VaultData;
  /** What this browser holds, read without opening it: a vault to unlock, or none yet. */
  stored?: StoredVault;
  /** The open vault; when none is open, shows the vault step (create or unlock) and waits for it. Rejects with VaultCancelled if it is closed. */
  ensureVault(): Promise<Vault>;
  /** The vault step is showing (src/components/vault-sheet.tsx). */
  gate: boolean;
  /** The vault step opened this vault. */
  openVault(v: Vault): void;
  /** The vault step was closed without a vault. */
  cancelGate(): void;
  lock(): void;
  /** Bumped whenever the vault changes, so views re-read it. */
  rev: number;
  snap?: Snapshot;
  snapError?: unknown;
  refresh(): void;
  modal: WalletModal;
  setModal(m: WalletModal): void;
  /** Private balance stays hidden until the user asks, for this session only. */
  showBalance: boolean;
  setShowBalance(v: boolean): void;
  solana: {
    signer?: SolanaSigner;
    usdc?: { address: Address; amount: bigint };
    /** The connected wallet is on the gateway's screening list (ADR 0019): it cannot deposit. */
    screened?: boolean;
    connect(f: () => Promise<SolanaSigner>): Promise<void>;
    disconnect(): void;
  };
  aztec: {
    session?: AztecSession;
    state: AztecState;
    status?: string;
    error?: string;
    balance?: bigint;
    /** Opens (or retries) the embedded wallet. */
    openEmbedded(): Promise<void>;
    setSession(s: AztecSession): Promise<void>;
    disconnect(): void;
  };
  /** Creates one transfer's notes in the vault; `at` = planned deposit time, undefined = deposit now. */
  addNotes(plan: { denomination: bigint; at?: number }[], transfer: { id: string; kind: PlanKind; to?: string }): Promise<number[]>;
  /**
   * Deposits stored notes now, one transaction each. Before each: the gateway must be the expected
   * one, the note's commitment must not be on chain already (else it moves to a fresh index), and a
   * scheduled note is refused while another of yours of the same denomination is in the open epoch,
   * unless `force` (the user accepted the risk). `express` crosses each note alone now (ADR 0015),
   * paying at most `maxExpressFee` of express fee (0: only while the crossing pool pays it).
   */
  deposit(indices: number[], onProgress?: (msg: string) => void, opts?: { force?: boolean; express?: { maxExpressFee: bigint } }): Promise<void>;
  /** Re-plans scheduled notes from now, instead of depositing a backlog. */
  reschedule(indices: number[]): Promise<void>;
  /**
   * Pay with SOL (ADR 0011): swaps SOL for exactly `usdc` through Jupiter, in one transaction the
   * connected wallet signs, waits until it is final and checks the USDC arrived. `deposits` is how
   * many deposits follow, so the wallet keeps SOL for their fees.
   */
  /** Swaps SOL for exactly `usdc` (ADR 0011). The signature, or "" when the wallet already held enough USDC. */
  swapToUsdc(usdc: bigint, deposits: number): Promise<string>;
  claims: Record<number, ClaimProgress>;
  claim(n: NoteView): Promise<string>;
  /** Takes back a deposit that could not cross, to the wallet that made it. */
  refund(n: NoteView): Promise<string>;
  /**
   * Move out: burns each note on Aztec, one exit each, committed to `destination` (a Solana address,
   * ADR 0009, or an Ethereum one, ADR 0014 §4). Each exit is saved before its burn is sent.
   */
  moveOut(notes: NoteView[], to: "solana" | "ethereum", destination: string, onProgress?: (msg: string) => void, opts?: { fast?: number[] }): Promise<void>;
  /** Fast (ADR 0017): asks the keeper to front a burned Solana exit; records its answer. */
  requestFastExit(x: StoredExit, view: SolanaExitView): Promise<void>;
  /** claim_exit, sent by the connected Solana wallet: pays the exit's committed address. */
  claimExit(x: StoredExit, view: SolanaExitView): Promise<string>;
  /** claimToEthereum from the browser's Ethereum wallet. */
  claimToEthereum(x: StoredExit, proof: NonNullable<Awaited<ReturnType<typeof ethereumExitFacts>>["proof"]>): Promise<string>;
  /** Scans public epochs for notes from this vault's phrase. */
  rescan(): Promise<{ found: number; added: number }>;
  scanNotice?: { found: number; added: number };
  dismissScanNotice(): void;
  updateSettings(patch: Partial<VaultData["settings"]>): Promise<void>;
  confirmBackup(): Promise<void>;
}

const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

/** The open vault, for views shown only while one is open (Keys, Move out). */
export function useVault(): Vault {
  const { vault } = useApp();
  if (!vault) throw new Error("The vault is locked.");
  return vault;
}

export function AppProvider({ dep, children }: { dep: Deployment; children: ReactNode }) {
  const [rev, setRev] = useState(0);
  const [vault, setVault] = useState<Vault>();
  const vaultRef = useRef<Vault | undefined>(undefined);
  const [stored, setStored] = useState<StoredVault | undefined>(() => Vault.stored());
  const [gate, setGate] = useState(false);
  const waiting = useRef<{ resolve: (v: Vault) => void; reject: (e: unknown) => void }[]>([]);
  const empty = useMemo(() => emptyData(), []);
  const data = vault?.data ?? empty;
  /** Bumped when a vault opens or locks: work started for the previous one is dropped. */
  const genRef = useRef(0);
  const [gen, setGen] = useState(0);
  // A snapshot belongs to the note book it was taken with: after an unlock the bridge waits for
  // one taken with the vault's notes instead of showing an empty journey first.
  const [snapState, setSnapState] = useState<{ s: Snapshot; gen: number; mine: number }>();
  const snap = snapState?.gen === gen ? snapState.s : undefined;
  const [snapError, setSnapError] = useState<unknown>();
  const [modal, setModal] = useState<WalletModal>(null);
  const [showBalance, setShowBalance] = useState(false);
  const [signer, setSigner] = useState<SolanaSigner>();
  const [usdc, setUsdc] = useState<{ address: Address; amount: bigint }>();
  const [screened, setScreened] = useState<boolean>();
  const [session, setSessionState] = useState<AztecSession>();
  const [warm, setWarm] = useState<Exclude<AztecState, "ready">>("idle");
  const [aztecError, setAztecError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [claims, setClaims] = useState<Record<number, ClaimProgress>>({});
  const [scanNotice, setScanNotice] = useState<{ found: number; added: number }>();
  const cache = useRef(new ChainCache());
  const sessionRef = useRef<AztecSession | undefined>(undefined);
  const busy = useRef(false);
  const again = useRef(false);
  const scanning = useRef(false);
  const opening = useRef(false);
  const bump = () => setRev((r) => r + 1);

  const ensureVault = useCallback((): Promise<Vault> => {
    if (vaultRef.current) return Promise.resolve(vaultRef.current);
    return new Promise<Vault>((resolve, reject) => {
      waiting.current.push({ resolve, reject });
      setGate(true);
    });
  }, []);

  const openVault = useCallback((v: Vault) => {
    vaultRef.current = v;
    const g = ++genRef.current;
    setGen(g);
    // A snapshot read with no notes still holds for a vault that has none (a new one).
    if (v.data.notes.length === 0) setSnapState((st) => (st && st.mine === 0 ? { ...st, gen: g } : st));
    setVault(v);
    setGate(false);
    setStored(Vault.stored());
    const r = v.data.rescan;
    setScanNotice(r && !r.pending && r.at && Date.now() - r.at < 120_000 ? { found: r.found ?? 0, added: r.found ?? 0 } : undefined);
    for (const w of waiting.current.splice(0)) w.resolve(v);
    setRev((x) => x + 1);
  }, []);

  const cancelGate = useCallback(() => {
    setGate(false);
    setStored(Vault.stored());
    for (const w of waiting.current.splice(0)) w.reject(new VaultCancelled());
  }, []);

  const runScan = useCallback(async (v: Vault) => {
    if (scanning.current) throw new Error("A scan is already running.");
    scanning.current = true;
    try {
      const r = await scanForNotes(dep, v, cache.current);
      if (vaultRef.current === v) {
        setScanNotice(r);
        setRev((x) => x + 1);
      }
      return r;
    } finally {
      scanning.current = false;
    }
  }, [dep]);

  const tick = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    const g = genRef.current;
    const v = vaultRef.current;
    try {
      // A restore (or a wallet's first open) whose scan could not reach the chain retries here.
      if (v?.data.rescan?.pending && !scanning.current) await runScan(v).catch(() => undefined);
      const notes = v?.data.notes ?? [];
      const s = await takeSnapshot(dep, notes, cache.current, sessionRef.current);
      if (genRef.current === g) {
        setSnapState({ s, gen: g, mine: notes.length });
        setSnapError(undefined);
      }
    } catch (e) {
      if (genRef.current === g) setSnapError(e);
    } finally {
      busy.current = false;
      // Something changed while this one ran (the vault opened, a deposit): read again now.
      if (again.current) {
        again.current = false;
        void tickRef.current();
      }
    }
  }, [dep, runScan]);
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    tick();
    const t = setInterval(tick, dep.network === "local" ? 4_000 : 12_000);
    return () => clearInterval(t);
  }, [tick, dep.network, rev]);

  const refreshUsdc = useCallback(async (s: SolanaSigner) => setUsdc(await usdcAccountOf(dep, s.address)), [dep]);
  // Read once per connected wallet, from the same RPC as everything else: nothing leaves the app.
  const refreshScreened = useCallback(async (s: SolanaSigner) => setScreened(await walletScreened(dep, s.address).catch(() => undefined)), [dep]);
  const refreshBalance = useCallback(async () => {
    if (sessionRef.current) setBalance(await sessionRef.current.privateBalance());
  }, []);

  const adopt = useCallback(async (s: AztecSession) => {
    sessionRef.current = s;
    setSessionState(s);
    setAztecError(undefined);
    setBalance(await s.privateBalance().catch(() => undefined));
    setRev((r) => r + 1);
  }, []);

  const openEmbeddedWallet = useCallback(async () => {
    if (opening.current || sessionRef.current) return;
    // The embedded wallet's account comes from the vault's seed: open the vault first (the wallet
    // sheet steps aside for the vault step).
    let v: Vault;
    if (!vaultRef.current) setModal(null);
    try {
      v = await ensureVault();
    } catch {
      return;
    }
    if (opening.current || sessionRef.current) return;
    opening.current = true;
    const g = genRef.current;
    setWarm("warming");
    setAztecError(undefined);
    try {
      const s = await openEmbedded(dep, v.seed, setStatus);
      if (genRef.current !== g || sessionRef.current) {
        // Locked meanwhile, or the user picked an extension wallet: don't keep a second PXE.
        await s.disconnect?.().catch(() => undefined);
      } else {
        await adopt(s);
      }
      setWarm("idle");
    } catch (e) {
      if (genRef.current === g) {
        setWarm("failed");
        setAztecError(message(e));
      } else setWarm("idle");
    } finally {
      opening.current = false;
      setStatus(undefined);
    }
  }, [dep, adopt, ensureVault]);

  // Warm the prover in the background as soon as a vault opens (default on; Keys can turn it off).
  useEffect(() => {
    if (vault?.data.settings.warmAztec) void openEmbeddedWallet();
  }, [vault]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Lock: the vault closes and the in-page PXE (it holds the recipient's keys) is dropped. The Solana wallet stays connected. */
  const lock = useCallback(() => {
    const s = sessionRef.current;
    sessionRef.current = undefined;
    void s?.disconnect?.().catch(() => undefined);
    vaultRef.current = undefined;
    genRef.current++;
    setGen(genRef.current);
    setVault(undefined);
    setSessionState(undefined);
    setBalance(undefined);
    setStatus(undefined);
    setAztecError(undefined);
    setWarm("idle");
    setClaims({});
    setScanNotice(undefined);
    setShowBalance(false);
    setStored(Vault.stored());
    setRev((x) => x + 1);
  }, []);

  // Leaving the app drops the in-page PXE too.
  useEffect(() => () => {
    genRef.current++;
    void sessionRef.current?.disconnect?.().catch(() => undefined);
  }, []);

  const value = useMemo<Ctx>(() => ({
    dep,
    vault,
    data,
    stored,
    ensureVault,
    gate,
    openVault,
    cancelGate,
    lock,
    rev,
    snap,
    snapError,
    refresh: bump,
    modal,
    setModal,
    showBalance,
    setShowBalance,
    solana: {
      signer,
      usdc,
      screened,
      async connect(f) {
        const s = await f();
        setSigner(s);
        setScreened(undefined);
        await Promise.all([refreshUsdc(s), refreshScreened(s)]);
        setModal(null);
      },
      disconnect() {
        setSigner(undefined);
        setUsdc(undefined);
        setScreened(undefined);
      },
    },
    aztec: {
      session,
      state: session ? "ready" : warm,
      status,
      error: aztecError,
      balance,
      openEmbedded: openEmbeddedWallet,
      async setSession(s) {
        await adopt(s);
        setModal(null);
      },
      disconnect() {
        sessionRef.current?.disconnect?.().catch(() => undefined);
        sessionRef.current = undefined;
        setSessionState(undefined);
        setBalance(undefined);
        setStatus(undefined);
        setWarm("idle");
      },
    },
    async addNotes(plan, transfer) {
      const vault = await ensureVault();
      const derived: { index: number; denominationIndex: number; commitment: string; at?: number }[] = [];
      let index = Math.max(vault.data.nextNote, ...vault.data.notes.map((n) => n.index + 1));
      for (const p of plan) {
        const idx = dep.denominations.findIndex((d) => BigInt(d) === p.denomination);
        if (idx < 0) throw new Error(`${usd(p.denomination)} is not a denomination on this network.`);
        const note = await deriveNote(vault.seed, index);
        derived.push({ index, denominationIndex: idx, commitment: toHex(note.commitment), at: p.at });
        index++;
      }
      await vault.update((d) => {
        d.transfers[transfer.id] = { kind: transfer.kind, createdAt: Date.now(), ...(transfer.to ? { to: transfer.to } : {}) };
        for (const n of derived) {
          d.notes.push({ index: n.index, denominationIndex: n.denominationIndex, denomination: dep.denominations[n.denominationIndex]!, commitment: n.commitment, scheduledAt: n.at, planId: transfer.id });
        }
        d.nextNote = index;
      });
      bump();
      return derived.map((n) => n.index);
    },
    async deposit(indices, onProgress, opts) {
      if (!signer) throw new Error("Connect a Solana wallet first.");
      const vault = await ensureVault();
      // Read again when the state has none yet: a swap just before may have created the account.
      const source = usdc ?? (await usdcAccountOf(dep, signer.address));
      if (!source) throw new Error("The connected wallet has no USDC account on this network. Get test USDC into it, then try again.");
      // A vault just opened from a passkey or a wallet used elsewhere looks for its notes first,
      // so no index is deposited twice (a short wait, then the line below if it still runs).
      for (let i = 0; i < 30 && vault.data.rescan?.pending; i++) {
        if (!scanning.current) await runScan(vault).catch(() => undefined);
        else await new Promise((r) => setTimeout(r, 1000));
      }
      const pending = depositBlock(undefined, vault.data);
      if (pending) throw new Error(pending);
      // The gateway would refuse it (ADR 0019): say so before the wallet asks for a signature.
      if (await walletScreened(dep, signer.address)) {
        setScreened(true);
        throw new Error(SCREENED);
      }
      for (const requested of indices) {
        const first = vault.data.notes.find((n) => n.index === requested);
        if (!first || isDeposited(first) || first.refundedAt) continue;

        const { cfg, lanes } = await syncChain(dep, cache.current);
        const blocked = depositBlock(gatewayStatus(dep, cfg), vault.data);
        if (blocked) throw new Error(blocked);

        // Never deposit a commitment that is already on chain (a restored phrase, another device).
        const { index: i, movedFrom } = await claimFreshIndex(dep, vault, cache.current, requested);
        if (movedFrom !== undefined) {
          onProgress?.(`Note #${movedFrom} was already deposited earlier from your phrase; it now shows under Recovered notes. This deposit uses note #${i} instead.`);
          bump();
        }
        const stored = vault.data.notes.find((n) => n.index === i)!;

        if (stored.scheduledAt !== undefined && !opts?.force) {
          const own = vault.data.notes
            .filter((n) => !n.refundedAt)
            .map((n) => ({ index: n.index, denominationIndex: n.denominationIndex, epochId: n.epochId !== undefined ? BigInt(n.epochId) : undefined }));
          const blocker = openEpochBlocker(stored, own, cfg.currentEpoch[stored.denominationIndex]!);
          if (blocker !== undefined) {
            throw new Error(`This ${usd(stored.denomination)} note waits for a new epoch: your note #${blocker} is still in the open one, and sharing an epoch would link them.`);
          }
        }
        const note = await deriveNote(vault.seed, i);
        if (toHex(note.commitment) !== stored.commitment) throw new Error(`Note #${i} doesn't match this vault's phrase. Nothing was deposited.`);
        // The note plus its fee (ADR 0012), and room under the deposit cap.
        const d = BigInt(stored.denomination);
        if (depositRoom(cfg) < d) throw new Error(`Deposit cap reached: this ${usd(d)} note can't enter now. Nothing was deposited.`);
        const open = cache.current.epochs.get(`${stored.denominationIndex}:${cfg.currentEpoch[stored.denominationIndex]}`);
        // Cross now (ADR 0015): the note's fee at the config's rate, plus the express fee unless
        // the crossing pool pays it; never more than the user saw (`maxExpressFee`).
        const express = opts?.express;
        if (express && !lanes) throw new Error("Cross now is not on this gateway yet. Nothing was deposited.");
        const q = express && lanes ? crossNowQuote({ expressFee: lanes.lanes.params.expressFee, poolBalance: lanes.crossingPool, denomination: d, feeBps: cfg.params.feeBps }) : undefined;
        if (q && !q.onUs && q.expressFee > express!.maxExpressFee) throw new Error(`Crossing now costs ${usdExact(q.expressFee)} now. Nothing was deposited.`);
        const cost = q ? q.userPays : depositCost(d, depositFeeBps(cfg, open));
        const held = (await usdcAccountOf(dep, signer.address))?.amount ?? 0n;
        if (held < cost) throw new Error(`This ${usd(d)} note needs ${usdExact(cost)} USDC with its fee; the wallet has ${usdExact(held)}.`);
        onProgress?.(`Depositing ${usd(stored.denomination)} (note #${i}). Confirm in your wallet…`);
        const { sig, epochId } = express
          ? await depositExpressNote(dep, signer, source.address, stored.denominationIndex, note.commitment, express.maxExpressFee).then((r) => ({ sig: r.sig, epochId: r.expressId }))
          : await depositNote(dep, signer, source.address, stored.denominationIndex, note.commitment);
        await vault.update((d) => {
          const n = d.notes.find((x) => x.index === i)!;
          Object.assign(n, { depositSig: sig, epochId: epochId.toString(), depositedAt: Date.now(), depositWallet: signer.address });
        });
        onProgress?.(`${usd(stored.denomination)} deposited (note #${i}, epoch ${epochId}).`);
        bump();
      }
      await refreshUsdc(signer);
    },
    async reschedule(indices) {
      const vault = await ensureVault();
      const notes = vault.data.notes.filter((n) => indices.includes(n.index) && !isDeposited(n));
      if (notes.length === 0) return;
      const kind = vault.data.transfers[notes[0]!.planId]?.kind;
      const hours = (kind && PLAN_HOURS[kind]) ?? vault.data.settings.windowHours ?? 6;
      // A Totality plan re-spreads into the window that is on, or the next one.
      const totality = kind === "totality" ? parseTotality(dep.totality) : undefined;
      const tw = totality && totalityPlan(totality, Date.now());
      const { schedule } = planSchedule(notes.map((n) => BigInt(n.denomination)), tw
        ? { now: tw.from, windowMs: tw.windowMs, epochMs: epochMs(dep), withinWindow: true }
        : { now: Date.now() + 60_000, windowMs: hours * 3_600_000, epochMs: epochMs(dep) });
      const pool = [...schedule];
      await vault.update((d) => {
        for (const n of notes) {
          const k = pool.findIndex((s) => s.denomination === BigInt(n.denomination));
          d.notes.find((x) => x.index === n.index)!.scheduledAt = pool.splice(k, 1)[0]!.at;
        }
      });
      bump();
    },
    async swapToUsdc(amount, deposits) {
      const cfg = swapFor(dep);
      if (!cfg) throw new Error("Paying with SOL is not available on this network.");
      if (!signer) throw new Error("Connect a Solana wallet first.");
      // Already enough USDC (an earlier swap that landed after its wait, or USDC held anyway):
      // never swap twice. The plan goes on from the USDC that is there.
      const held = await usdcAccountOf(dep, signer.address);
      if (held && held.amount >= amount) {
        setUsdc(held);
        return "";
      }
      // A fresh price, never the one on screen: the transaction is built from this quote.
      const quote = await fetchQuote(cfg, dep.solana.usdcMint, amount);
      const [before, sol] = await Promise.all([usdcAccountOf(dep, signer.address), solBalanceOf(dep, signer.address)]);
      const need = solNeeded({ maxIn: quote.maxInLamports, hasUsdcAccount: !!before, deposits });
      if (sol < need) throw new SwapError(`Not enough SOL: this needs up to ${solText(need, true)} SOL with fees; the wallet has ${solText(sol)}.`);
      const wire = await fetchSwapTransaction(cfg, quote, signer.address);
      await checkSwapTransaction(wire, { user: signer.address, maxInLamports: quote.maxInLamports });
      // Final before the plan goes on, so the deposits that follow see the USDC.
      const sig = await signAndSend(dep, signer, wire, { explain: explainSwapError, finality: "finalized", preflight: "confirmed" });
      const after = await usdcAccountOf(dep, signer.address);
      setUsdc(after);
      if (!after || after.amount - (before?.amount ?? 0n) < amount) throw new SwapError("The swap landed, but less USDC arrived than planned. Nothing was deposited.");
      return sig;
    },
    claims,
    async claim(n) {
      const vault = await ensureVault();
      const s = sessionRef.current;
      if (!s) throw new Error("Open your Aztec wallet first.");
      const startedAt = Date.now();
      const set = (p: Partial<ClaimProgress>) => setClaims((c) => ({ ...c, [n.index]: { ...c[n.index]!, ...p } }));
      setClaims((c) => ({ ...c, [n.index]: { stage: "preparing", startedAt, stageAt: startedAt } }));
      try {
        if (n.root === undefined || !n.leaves) throw new Error("This note's batch isn't readable yet. Wait for the next refresh and try again.");
        const note = await deriveNote(vault.seed, n.index);
        const leafIndex = n.leaves.indexOf(note.commitment);
        if (leafIndex < 0) throw new Error("This note isn't among its epoch's deposits. Scan the chain for your notes in Vault & keys.");
        const path = merklePath(n.leaves, leafIndex);
        const tx = await s.claim(
          { denomination: n.denomination, root: n.root, nullifierKey: note.nullifierKey, secret: note.secret, leafIndex, path },
          (stage) => set({ stage, stageAt: Date.now() }),
        );
        await vault.update((d) => {
          Object.assign(d.notes.find((x) => x.index === n.index)!, { claimTx: tx, claimedAt: Date.now() });
        });
        set({ stage: "done", stageAt: Date.now(), tx });
        bump();
        await refreshBalance().catch(() => undefined);
        return tx;
      } catch (e) {
        const error = explainClaimError(e);
        set({ stage: "failed", stageAt: Date.now(), error });
        throw new Error(error, { cause: e });
      }
    },
    async refund(n) {
      const vault = await ensureVault();
      const who = n.depositWallet;
      if (!signer) throw new Error(who ? `Connect the wallet that made this deposit (${shortAddr(who)}). Only it can take the deposit back.` : "Connect the wallet that made this deposit.");
      if (who && signer.address !== who) {
        throw new Error(`This deposit was made by ${shortAddr(who)}, but ${shortAddr(signer.address)} is connected. Switch to ${shortAddr(who)} in your wallet: only it can take the deposit back.`);
      }
      if (n.epochId === undefined) throw new Error("This note was never deposited, so there is nothing to take back.");
      const { cfg, slot } = await syncChain(dep, cache.current);
      const e = cache.current.epochs.get(`${n.denominationIndex}:${n.epochId}`);
      if (!e || BigInt(n.epochId) !== cfg.currentEpoch[n.denominationIndex]) throw new Error("This deposit's epoch has moved on: it is crossing and can't be taken back.");
      const st = refundStatus(e, slot);
      if (!st.refundable) {
        throw new Error(st.reason === "crossing" ? "This deposit's epoch has closed: it is crossing and can't be taken back." : "This deposit can't be taken back yet: its epoch has to stay open for about 24 hours and roll over at least once.");
      }
      const dest = await usdcAccountOf(dep, signer.address);
      if (!dest) throw new Error("This wallet has no USDC account to receive the refund. Receiving any USDC creates one; then try again.");
      const sig = await refundNote(dep, signer, dest.address, n.denominationIndex, BigInt(n.epochId), BigInt(n.commitment));
      await vault.update((d) => {
        Object.assign(d.notes.find((x) => x.index === n.index)!, { refundSig: sig, refundedAt: Date.now() });
      });
      bump();
      await refreshUsdc(signer);
      return sig;
    },
    async requestFastExit(x, view) {
      // ADR 0017: the keeper checks the exit on Aztec, then fronts it from the liquidity pool.
      const url = dep.keeper?.url;
      if (!url || !x.tx || !x.fast || x.fast.sig || x.fast.refused || view.exitEpochId === undefined || !view.leaves) return;
      const vault = vaultRef.current;
      if (!vault) return;
      const leafIndex = view.leaves.indexOf(BigInt(x.commitment));
      if (leafIndex < 0) return;
      const secret = await deriveExitSecret(vault.seed, x.index);
      const r = await fetch(`${url.replace(/\/$/, "")}/front`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ denomination: x.denomination, exitEpochId: view.exitEpochId.toString(), leafIndex, destination: x.destination, secret: toHex(secret), aztecTx: x.tx }),
      });
      const j = (await r.json().catch(() => ({}))) as { status?: string; sig?: string; advanced?: string; reason?: string };
      if (j.status === "fronted" && j.sig) {
        await vault.update((d) => {
          Object.assign(d.exits.find((e) => e.id === x.id)!, { fast: { sig: j.sig, at: Date.now(), advanced: j.advanced } });
        });
        bump();
      } else if (j.status === "refused") {
        await vault.update((d) => {
          Object.assign(d.exits.find((e) => e.id === x.id)!, { fast: { refused: j.reason ?? "refused" } });
        });
        bump();
      }
    },
    async moveOut(notes, to, destination, onProgress, opts) {
      const vault = await ensureVault();
      const s = sessionRef.current;
      if (!s) throw new Error("Open your Aztec wallet first.");
      // ADR 0018: through the Eclyps FPC (mainnet), the note being moved out pays its exit's fee.
      const sponsorNote = async (n: NoteView): Promise<SponsorNote | undefined> => {
        if (dep.fees?.user !== "eclypsFpc" || n.root === undefined || !n.leaves) return undefined;
        const note = await deriveNote(vault.seed, n.index);
        const leafIndex = n.leaves.indexOf(note.commitment);
        if (leafIndex < 0) return undefined;
        return { denomination: n.denomination, root: n.root, nullifierKey: note.nullifierKey, secret: note.secret, leafIndex, path: merklePath(n.leaves, leafIndex) };
      };
      for (const n of notes) {
        const amount = usd(n.denomination);
        const index = to === "solana" ? vault.data.nextExit : vault.data.nextEthExit;
        const commitment = to === "solana" ? (await deriveExit(vault.seed, index, address(destination))).commitment : (await deriveEthereumExit(vault.seed, index, destination)).commitment;
        const epochHint = to === "solana" ? (await s.reads.openExitEpoch(n.denomination)).id.toString() : undefined;
        const id = `${to}:${index}`;
        await vault.update((d) => {
          d.exits.push({ id, to, index, destination, denomination: n.denomination, note: n.index, commitment: toHex(commitment), epochHint, ...(to === "solana" && opts?.fast?.includes(n.index) ? { fast: {} } : {}) });
          if (to === "solana") d.nextExit = index + 1;
          else d.nextEthExit = index + 1;
          d.notes.find((x) => x.index === n.index)!.exitId = id;
        });
        bump();
        const words: Record<ClaimStage, string> = { preparing: "Preparing…", proving: `Burning ${amount} on Aztec: proving…`, sending: `Burning ${amount}: sending…`, waiting: `Burning ${amount}: waiting for Aztec…` };
        onProgress?.(words.proving);
        try {
          const tx = await s.exit({ to, denomination: n.denomination, commitment, sponsor: await sponsorNote(n) }, (st) => onProgress?.(words[st]));
          await vault.update((d) => {
            Object.assign(d.exits.find((x) => x.id === id)!, { tx, sentAt: Date.now() });
          });
        } catch (e) {
          // Not burned: the note stays in the balance (its exit index is not reused).
          await vault.update((d) => {
            d.exits = d.exits.filter((x) => x.id !== id);
            delete d.notes.find((x) => x.index === n.index)!.exitId;
          });
          bump();
          throw new Error(explainClaimError(e), { cause: e });
        }
        bump();
      }
      void refreshBalance().catch(() => undefined);
    },
    async claimExit(x, view) {
      if (!signer) throw new Error("Connect a Solana wallet to send the claim. Any wallet can: the USDC goes only to the address you chose.");
      const vault = await ensureVault();
      const sig = await claimExitOnSolana(dep, signer, vault.seed, x, view);
      await vault.update((d) => {
        Object.assign(d.exits.find((e) => e.id === x.id)!, { claimTx: sig, claimedAt: Date.now(), exitEpochId: view.exitEpochId?.toString() });
      });
      bump();
      return sig;
    },
    async claimToEthereum(x, proof) {
      const vault = await ensureVault();
      const tx = await claimOnEthereum(dep, vault.seed, x, proof);
      await vault.update((d) => {
        Object.assign(d.exits.find((e) => e.id === x.id)!, { claimTx: tx, claimedAt: Date.now() });
      });
      bump();
      return tx;
    },
    rescan: async () => runScan(await ensureVault()),
    scanNotice,
    dismissScanNotice: () => setScanNotice(undefined),
    async updateSettings(patch) {
      const vault = await ensureVault();
      await vault.update((d) => Object.assign(d.settings, patch));
      bump();
    },
    async confirmBackup() {
      const vault = await ensureVault();
      await vault.update((d) => {
        d.backup.confirmedAt = Date.now();
      });
      bump();
    },
  }), [dep, vault, data, stored, gate, ensureVault, openVault, cancelGate, lock, rev, snap, snapError, modal, showBalance, signer, usdc, screened, session, warm, status, aztecError, balance, claims, scanNotice, refreshUsdc, refreshScreened, refreshBalance, adopt, openEmbeddedWallet, runScan]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Returns a valid Solana address or undefined. */
export function parseAddress(s: string): Address | undefined {
  try {
    return address(s.trim());
  } catch {
    return undefined;
  }
}
