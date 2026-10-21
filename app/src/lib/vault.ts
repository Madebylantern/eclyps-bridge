/**
 * Local encrypted vault (SPEC §10): the 32-byte seed from which every note, exit secret and the
 * Aztec recipient account are derived, plus the user's note book. Encrypted at rest with AES-GCM,
 * opened by a passkey's PRF output (ADR 0016, keys.ts: storage v2) or, where passkeys with PRF are
 * not available, a PBKDF2-SHA256 key from the user's passphrase (storage v1, unchanged). Only when
 * the user picks "Use my wallet instead" (ADR 0016 amended 2026-10-19, an owner-directed exception
 * to SPEC §1.2 anti-pattern 4, with its risk stated) do the seed and the vault key come from a wallet
 * signature over one fixed, domain-bound message. Nothing leaves this browser unless the user
 * exports it.
 *
 * The seed is shown to the user as a 24-word recovery phrase (the seed is the BIP-39 entropy, so
 * older 64-hex backups restore the same notes).
 */
import { seedFromHex, seedToHex, seedToMnemonic } from "@eclyps/sdk";
import {
  b64,
  type EnvelopeV2,
  newDataKey,
  openPasskeySlot,
  openSlot,
  openWalletSlot,
  type PasskeySlot,
  passkeySlot,
  passphraseKek,
  type PassphraseSlot,
  passphraseSlot,
  seal,
  seedFromPrf,
  seedFromSignature,
  type Slot,
  unb64,
  unseal,
  type WalletSlot,
  walletSlot,
} from "./keys";

const STORAGE_KEY = "eclyps.vault.v1";
const ITERATIONS = 600_000;
export const VAULT_CRYPTO = { cipher: "AES-GCM-256", kdf: "PBKDF2-SHA256", iterations: ITERATIONS } as const;

/** Privacy plans offered by Shield. "totality" deposits inside the next Totality window (totality.ts). */
export type PlanKind = "fast" | "balanced" | "private" | "totality";
/**
 * How a group of notes came about: one Shield action (a plan), notes found on chain from the seed
 * ("recovered"), notes from before transfers existed ("earlier"), or an older spread plan whose
 * window is not known ("spread").
 */
export type TransferKind = PlanKind | "spread" | "recovered" | "earlier";
export const RECOVERED = "recovered";
export const EARLIER = "earlier";

export interface StoredNote {
  index: number;
  denominationIndex: number;
  denomination: string;
  commitment: string;
  /** The transfer (one Shield action) this note belongs to; see VaultData.transfers. */
  planId: string;
  /** Planned deposit time (ms) while the note is scheduled and not yet deposited. */
  scheduledAt?: number;
  /** Set once deposited (by this app or found on chain). */
  epochId?: string;
  leafIndex?: number;
  /** Unknown for recovered notes. */
  depositSig?: string;
  depositedAt?: number;
  /** The Solana wallet that signed the deposit; a refund must be signed by it. */
  depositWallet?: string;
  /** Found on chain from the seed rather than deposited from this vault. */
  recovered?: boolean;
  claimTx?: string;
  claimedAt?: number;
  refundSig?: string;
  refundedAt?: number;
  /** Burned on Aztec by this exit (VaultData.exits): the note has left the private balance. */
  exitId?: string;
}

/**
 * One exit (Move out): one note burned on Aztec, committed to a destination (ADR 0009 to Solana,
 * ADR 0014 §4 to Ethereum). The secret is not stored: it derives from the seed and `index` (domain
 * 3 for Solana, 4 for Ethereum), so a restored phrase can rebuild it. Saved before the burn is sent.
 */
export interface StoredExit {
  id: string;
  to: "solana" | "ethereum";
  index: number;
  destination: string;
  denomination: string;
  /** The vault note it spends. */
  note: number;
  commitment: string;
  /** The Aztec transaction that burned the note; set once it is mined. */
  tx?: string;
  sentAt?: number;
  /** Solana: the open exit epoch just before the burn; its commitment lands there or later. */
  epochHint?: string;
  /** Solana: the exit epoch its commitment was appended to (found in the public leaves). */
  exitEpochId?: string;
  /** claim_exit (Solana) or claimToEthereum (Ethereum), once paid. */
  claimTx?: string;
  claimedAt?: number;
  /**
   * Solana, Fast chosen (ADR 0017): asked of the keeper after the burn. `sig` once it fronted the
   * exit from the liquidity pool; `refused` if it would not (the exit then takes the normal path).
   */
  fast?: { sig?: string; at?: number; advanced?: string; refused?: string };
}

export interface TransferMeta {
  kind: TransferKind;
  createdAt: number;
  /** An Ethereum address chosen on the bridge screen, for the exit after the claim (ADR 0014). */
  to?: string;
}

export interface VaultData {
  version: 3;
  seedHex: string;
  nextNote: number;
  /** Next exit index to Solana (domain 3) and to Ethereum (domain 4). */
  nextExit: number;
  nextEthExit: number;
  notes: StoredNote[];
  exits: StoredExit[];
  transfers: Record<string, TransferMeta>;
  settings: {
    /** Window used when re-spreading overdue notes. */
    windowHours: number;
    /** Open the embedded Aztec wallet in the background after unlocking. */
    warmAztec: boolean;
    /** Browser notification when a scheduled deposit falls due (needs permission). */
    notify: boolean;
  };
  backup: { confirmedAt?: number; deferredAt?: number };
  /** After a restore from the phrase: the chain scan for its notes still has to run. */
  rescan?: { pending: boolean; at?: number; found?: number };
  createdAt: number;
}

/** Storage format v1 (passphrase vaults, unchanged since Phase 0): data under the PBKDF2 key. */
interface EnvelopeV1 {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
}
type Envelope = EnvelopeV1 | EnvelopeV2;

/** Encrypted vault file (same envelope as local storage; the passphrase or a passkey is still needed). */
interface VaultFile {
  app: "eclyps";
  kind: "encrypted-vault";
  exportedAt: string;
  envelope: Envelope;
}

/** What unlocks the vault in this browser, read without opening it. */
export interface StoredVault {
  passphrase: boolean;
  /** Credential ids of the passkeys that open it. */
  passkeys: string[];
  /** The seed comes from one of them (ADR 0016), so that passkey brings it back on any device. */
  seedPasskey: boolean;
  /** "Use my wallet instead": the Solana address whose signature opens it (and made its seed). */
  wallet?: string;
}

/** How a vault is opened: a passphrase, a passkey's PRF output, or a wallet's signature. */
export type Secret =
  | { passphrase: string }
  | { passkey: { id: string; prf: Uint8Array } }
  | { wallet: { address: string; signature: Uint8Array } };

type AnyVersion = Partial<Omit<VaultData, "notes" | "version">> & {
  seedHex: string;
  version?: number;
  notes?: (Omit<StoredNote, "planId"> & { planId?: string })[];
};

/**
 * Brings any earlier vault (Phase 0 without a version, v2) to v3. Notes without a transfer go
 * under "Earlier notes"; notes of one v2 Shield action already share a planId and stay together.
 */
export function migrate(d: AnyVersion): VaultData {
  const notes: StoredNote[] = (d.notes ?? []).map((n) => ({ ...n, planId: n.planId ?? EARLIER }));
  const transfers: Record<string, TransferMeta> = { ...(d.transfers ?? {}) };
  for (const n of notes) {
    if (transfers[n.planId]) continue;
    const group = notes.filter((x) => x.planId === n.planId);
    const times = group.map((x) => x.depositedAt ?? x.scheduledAt ?? Infinity);
    const kind: TransferKind =
      n.planId === EARLIER ? "earlier" : n.planId === RECOVERED ? "recovered" : group.some((x) => x.scheduledAt !== undefined) ? "spread" : "fast";
    transfers[n.planId] = { kind, createdAt: Math.min(...times, d.createdAt ?? Date.now()) };
  }
  return {
    version: 3,
    seedHex: d.seedHex,
    nextNote: Math.max(d.nextNote ?? 0, ...notes.map((n) => n.index + 1)),
    nextExit: d.nextExit ?? 0,
    nextEthExit: d.nextEthExit ?? 0,
    notes,
    exits: d.exits ?? [],
    transfers,
    settings: {
      windowHours: d.settings?.windowHours ?? 6,
      warmAztec: d.settings?.warmAztec ?? true,
      notify: d.settings?.notify ?? false,
    },
    backup: d.backup ?? {},
    rescan: d.rescan,
    createdAt: d.createdAt ?? Date.now(),
  };
}

/**
 * An empty note book, read while no vault is open: the bridge, Balance and Privacy show "nothing
 * yet" from it. Its seed is empty, so nothing can ever be derived from it.
 */
export const emptyData = (): VaultData => migrate({ seedHex: "" });

const WRONG_PASSPHRASE = "Wrong passphrase. Check for typos and caps lock, then try again.";
const parseData = (pt: Uint8Array) => migrate(JSON.parse(new TextDecoder().decode(pt)));

/** How the vault is locked while open: v1 keeps the passphrase key, v2 the data key and its slots. */
type Lock = { v: 1; key: CryptoKey; salt: Uint8Array } | { v: 2; dek: Uint8Array; slots: Slot[] };

async function open(env: Envelope, secret: Secret): Promise<{ lock: Lock; data: VaultData }> {
  if (env.v !== 2) {
    if (!("passphrase" in secret)) throw new Error("This vault opens with its passphrase.");
    const salt = unb64(env.salt);
    const key = await passphraseKek(secret.passphrase, salt, ITERATIONS);
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(unb64(env.iv)) }, key, Uint8Array.from(unb64(env.ct)));
    } catch {
      throw new Error(WRONG_PASSPHRASE);
    }
    return { lock: { v: 1, key, salt }, data: parseData(new Uint8Array(pt)) };
  }
  let dek: Uint8Array;
  if ("passphrase" in secret) {
    const slot = env.slots.find((s): s is PassphraseSlot => s.kind === "passphrase");
    if (!slot) throw new Error(env.slots.some((s) => s.kind === "passkey") ? "This vault opens with a passkey." : "This vault opens with your wallet.");
    try {
      dek = await openSlot(slot, await passphraseKek(secret.passphrase, unb64(slot.salt), slot.iterations));
    } catch {
      throw new Error(WRONG_PASSPHRASE);
    }
  } else if ("wallet" in secret) {
    const slot = env.slots.find((s): s is WalletSlot => s.kind === "wallet" && s.address === secret.wallet.address);
    if (!slot) throw new Error("This wallet doesn't open this vault.");
    try {
      dek = await openWalletSlot(slot, secret.wallet.signature);
    } catch {
      throw new Error("This wallet doesn't open this vault.");
    }
  } else {
    const slot = env.slots.find((s): s is PasskeySlot => s.kind === "passkey" && s.id === secret.passkey.id);
    if (!slot) throw new Error("This passkey doesn't open this vault. Try another.");
    try {
      dek = await openPasskeySlot(slot, secret.passkey.prf);
    } catch {
      throw new Error("This passkey doesn't open this vault. Try another.");
    }
  }
  return { lock: { v: 2, dek, slots: env.slots }, data: parseData(await unseal(dek, env)) };
}

const readStored = (): Envelope | undefined => {
  const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Envelope) : undefined;
};

const describe = (env: Envelope): StoredVault =>
  env.v === 2
    ? {
        passphrase: env.slots.some((s) => s.kind === "passphrase"),
        passkeys: env.slots.flatMap((s) => (s.kind === "passkey" ? [s.id] : [])),
        seedPasskey: env.slots.some((s) => s.kind === "passkey" && s.role === "seed"),
        wallet: env.slots.find((s): s is WalletSlot => s.kind === "wallet")?.address,
      }
    : { passphrase: true, passkeys: [], seedPasskey: false };

export class Vault {
  private constructor(
    private lockState: Lock,
    public data: VaultData,
  ) {}

  static exists(): boolean {
    return typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY) !== null;
  }

  /** What opens the vault in this browser, if there is one. */
  static stored(): StoredVault | undefined {
    try {
      const env = readStored();
      return env ? describe(env) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A new vault: a random seed, or a restored one (which then needs a chain scan for its notes). */
  static async create(passphrase: string, restored?: Uint8Array): Promise<Vault> {
    if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
    const seed = restored ?? crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const data = migrate({ seedHex: seedToHex(seed), createdAt: Date.now() });
    if (restored) {
      // A restored seed was, by definition, already backed up.
      data.backup.confirmedAt = Date.now();
      data.rescan = { pending: true };
    }
    const v = new Vault({ v: 1, key: await passphraseKek(passphrase, salt, ITERATIONS), salt }, data);
    await v.save();
    return v;
  }

  /**
   * A vault whose seed comes from the passkey (ADR 0016). `found` is true when the passkey already
   * existed (another device): its notes are on chain and need a scan.
   */
  static async fromPasskey(pk: { id: string; prf: Uint8Array }, found = false): Promise<Vault> {
    const seed = await seedFromPrf(pk.prf);
    const dek = newDataKey();
    const data = migrate({ seedHex: seedToHex(seed), createdAt: Date.now() });
    if (found) data.rescan = { pending: true };
    const v = new Vault({ v: 2, dek, slots: [await passkeySlot(pk.id, "seed", pk.prf, dek)] }, data);
    await v.save();
    return v;
  }

  /**
   * "Use my wallet instead" (ADR 0016, amended 2026-10-19): the seed from the wallet's signature over
   * the fixed message (keys.ts `walletMessage`, checked by the caller). The same wallet may have
   * made notes on another device, so its notes are looked for on chain before the first deposit.
   */
  static async fromWallet(w: { address: string; signature: Uint8Array }): Promise<Vault> {
    const seed = await seedFromSignature(w.signature);
    const dek = newDataKey();
    const data = migrate({ seedHex: seedToHex(seed), createdAt: Date.now() });
    data.rescan = { pending: true };
    const v = new Vault({ v: 2, dek, slots: [await walletSlot(w.address, w.signature, dek)] }, data);
    await v.save();
    return v;
  }

  static async unlock(secret: string | Secret): Promise<Vault> {
    const env = readStored();
    if (!env) throw new Error("No vault on this device.");
    const { lock, data } = await open(env, typeof secret === "string" ? { passphrase: secret } : secret);
    return new Vault(lock, data);
  }

  /** Reads a vault file: what opens it, so the gate can ask for the right thing. */
  static readFile(text: string): StoredVault {
    let file: VaultFile;
    try {
      file = JSON.parse(text);
    } catch {
      throw new Error("This file isn't a vault file (it isn't JSON).");
    }
    if (file.app !== "eclyps" || file.kind !== "encrypted-vault" || !file.envelope) throw new Error("This file isn't an Eclyps vault file.");
    return describe(file.envelope);
  }

  /** Restores an encrypted vault file (needs the passphrase or a passkey it was encrypted for). */
  static async importFile(text: string, secret: string | Secret): Promise<Vault> {
    Vault.readFile(text);
    const file = JSON.parse(text) as VaultFile;
    const { lock, data } = await open(file.envelope, typeof secret === "string" ? { passphrase: secret } : secret);
    const v = new Vault(lock, data);
    await v.save();
    return v;
  }

  static forget() {
    localStorage.removeItem(STORAGE_KEY);
  }

  get seed(): Uint8Array {
    return seedFromHex(this.data.seedHex);
  }

  /** The 24-word recovery phrase for this vault's seed. */
  get phrase(): string {
    return seedToMnemonic(this.seed);
  }

  /** Credential ids of the passkeys that open this vault. */
  get passkeys(): string[] {
    return this.lockState.v === 2 ? this.lockState.slots.flatMap((s) => (s.kind === "passkey" ? [s.id] : [])) : [];
  }

  /** The seed comes from a passkey (synced passkeys bring it back); else the phrase is the way back. */
  get seedFromPasskey(): boolean {
    return this.lockState.v === 2 && this.lockState.slots.some((s) => s.kind === "passkey" && s.role === "seed");
  }

  /** The wallet whose signature made the seed and opens the vault ("Use my wallet instead"). */
  get wallet(): string | undefined {
    return this.lockState.v === 2 ? this.lockState.slots.find((s): s is WalletSlot => s.kind === "wallet")?.address : undefined;
  }

  /** What brings the seed back without the phrase: the first passkey, the wallet, or nothing. */
  get seedFrom(): "passkey" | "wallet" | undefined {
    return this.seedFromPasskey ? "passkey" : this.wallet ? "wallet" : undefined;
  }

  get hasPassphrase(): boolean {
    return this.lockState.v === 1 || this.lockState.slots.some((s) => s.kind === "passphrase");
  }

  /** The cipher and key derivations, for one mono line. */
  get cryptoLine(): string {
    const kdfs = [
      this.passkeys.length > 0 && "passkey PRF · HKDF-SHA256",
      this.wallet && "wallet signature · HKDF-SHA256",
      this.hasPassphrase && `PBKDF2-SHA256 ${ITERATIONS.toLocaleString("en-US")}×`,
    ].filter(Boolean);
    return `${VAULT_CRYPTO.cipher} · ${kdfs.join(" · ")}`;
  }

  /** Re-checks the passphrase (before revealing the phrase). */
  async checkPassphrase(passphrase: string): Promise<boolean> {
    return this.check({ passphrase });
  }

  /** Re-checks a secret against the stored vault (before revealing the phrase). */
  async check(secret: Secret): Promise<boolean> {
    const env = readStored();
    if (!env) return false;
    try {
      await open(env, secret);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Adds a passkey that opens this vault (ADR 0016 "Add a passkey"): the data key is wrapped under
   * the new passkey's PRF key; the seed does not change. A passphrase vault (v1) moves to v2 and
   * keeps its passphrase as a slot, wrapped under the same PBKDF2 key.
   */
  async addPasskey(pk: { id: string; prf: Uint8Array }) {
    if (this.passkeys.includes(pk.id)) throw new Error("This passkey already opens this vault.");
    if (this.lockState.v === 1) {
      const dek = newDataKey();
      this.lockState = { v: 2, dek, slots: [await passphraseSlot(this.lockState.key, this.lockState.salt, dek)] };
    }
    this.lockState.slots = [...this.lockState.slots, await passkeySlot(pk.id, "added", pk.prf, this.lockState.dek)];
    await this.save();
  }

  /** The encrypted vault as a downloadable file. It is useless without the passphrase or a passkey. */
  exportFile(): string {
    const env = readStored()!;
    const file: VaultFile = { app: "eclyps", kind: "encrypted-vault", exportedAt: new Date().toISOString(), envelope: env };
    return JSON.stringify(file, null, 2);
  }

  async save() {
    const pt = new TextEncoder().encode(JSON.stringify(this.data));
    let env: Envelope;
    if (this.lockState.v === 1) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.lockState.key, pt));
      env = { v: 1, salt: b64(this.lockState.salt), iv: b64(iv), ct: b64(ct) };
    } else {
      env = { v: 2, slots: this.lockState.slots, ...(await seal(this.lockState.dek, pt)) };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(env));
  }

  async update(f: (d: VaultData) => void) {
    f(this.data);
    await this.save();
  }
}

export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
