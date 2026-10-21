/**
 * Client for the Solana gateway program (programs/gateway, ADR 0005), built on @solana/kit.
 * Discriminators and layouts come from the Anchor IDL (target/idl/eclyps_gateway.json).
 */
import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import { CCTP, cctpReceiveAccounts, decodeExitHook, EXIT_MESSAGE_LENGTH, CCTP_MESSAGE } from "./cctp.js";
import { exitCommitment } from "./exit.js";
import { BATCH_TREE_DEPTH, toBytes32 } from "./merkle.js";

export const GATEWAY_PROGRAM_ID = address("4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf");
export const TOKEN_PROGRAM_ID = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE_ID = address("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * A deposit that has not crossed can be refunded to its depositor once its epoch has been open
 * this long *and* has rolled over at least once (it could not form a batch). 216,000 slots is
 * about 24 hours. Mirrors programs/gateway/src/constants.rs (ADR 0010).
 */
export const REFUND_DELAY_SLOTS = 216_000n;

/** Hard ceiling on the user fee, in basis points (programs/gateway/src/constants.rs, ADR 0012). */
export const FEE_CAP_BPS = 50;
/** The associated token account program (deterministic USDC accounts per wallet). */
export const ASSOCIATED_TOKEN_PROGRAM_ID = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  openEpoch: [75, 57, 218, 33, 173, 254, 207, 136],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  closeEpoch: [13, 87, 7, 133, 109, 14, 83, 25],
  sendBatch: [212, 9, 35, 132, 25, 80, 77, 213],
  refundDeposit: [19, 19, 78, 50, 187, 10, 162, 229],
  proposeParams: [94, 141, 220, 182, 171, 53, 52, 182],
  applyParams: [188, 203, 86, 124, 178, 34, 133, 116],
  cancelParams: [100, 172, 113, 60, 25, 68, 80, 172],
  setGuardian: [147, 243, 50, 121, 154, 164, 50, 30],
  proposeAdmin: [121, 214, 199, 212, 87, 39, 117, 234],
  acceptAdmin: [112, 42, 45, 90, 116, 181, 13, 170],
  receiveExit: [116, 172, 66, 55, 37, 62, 186, 147],
  claimExit: [109, 115, 53, 37, 198, 221, 203, 41],
  configAccount: [155, 12, 170, 224, 30, 250, 204, 130],
  epochAccount: [93, 83, 120, 89, 151, 138, 152, 108],
  exitBatchAccount: [17, 17, 84, 46, 189, 101, 178, 15],
  // V2 lanes (ADR 0015, 0017)
  initLanes: [214, 225, 88, 158, 48, 41, 175, 213],
  proposeLaneParams: [223, 247, 91, 70, 228, 25, 82, 249],
  cancelLaneParams: [165, 47, 14, 184, 196, 144, 116, 192],
  applyLaneParams: [238, 255, 242, 169, 104, 29, 51, 33],
  disablePoolFronts: [112, 99, 93, 232, 64, 38, 230, 160],
  depositExpress: [33, 235, 249, 185, 162, 69, 177, 15],
  sendExpressBatch: [112, 179, 41, 148, 83, 43, 176, 226],
  frontExit: [13, 148, 16, 122, 154, 40, 210, 83],
  frontExitFromPool: [198, 124, 164, 33, 50, 249, 167, 189],
  writeOffFront: [154, 25, 20, 75, 199, 198, 233, 14],
  lpDeposit: [27, 77, 210, 69, 12, 43, 148, 16],
  lpWithdraw: [205, 206, 130, 170, 173, 51, 11, 169],
  lanesAccount: [55, 239, 91, 41, 56, 38, 184, 52],
  expressEpochAccount: [184, 236, 58, 26, 167, 110, 125, 117],
  frontAccount: [146, 90, 67, 216, 213, 150, 165, 145],
  liquidityAccount: [54, 252, 249, 226, 137, 172, 121, 58],
  lpPositionAccount: [105, 241, 37, 200, 224, 2, 252, 90],
  // Screening deposits (ADR 0019)
  initScreening: [50, 115, 106, 113, 219, 18, 122, 182],
  blockAddress: [199, 140, 68, 34, 1, 27, 188, 74],
  proposeUnblock: [110, 197, 6, 236, 65, 126, 193, 168],
  cancelUnblock: [59, 142, 169, 114, 208, 105, 252, 251],
  unblock: [194, 49, 173, 43, 246, 164, 14, 11],
  screeningAccount: [18, 162, 71, 155, 201, 67, 119, 112],
  blockedAddressAccount: [83, 135, 150, 189, 205, 251, 26, 174],
} as const;

const utf8 = (s: string) => new TextEncoder().encode(s);
const enc = getAddressEncoder();
const u64le = (x: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};
const concat = (...parts: ArrayLike<number>[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function pda(program: Address, seeds: Uint8Array[]): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
}

export const configPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("config")]);
export const escrowPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("escrow")]);
/** Holds the fees of deposits that have not crossed (ADR 0012). */
export const feeVaultPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("fee_vault")]);
export const epochPda = (denominationIndex: number, epochId: bigint) =>
  pda(GATEWAY_PROGRAM_ID, [utf8("epoch"), Uint8Array.of(denominationIndex), u64le(epochId)]);
/**
 * Exit (ADR 0009). The exit authority is the CCTP destinationCaller of every exit message and owns
 * exit custody, the USDC account CCTP pays exits into and `claim_exit` pays out of.
 */
export const exitAuthorityPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("exit_authority")]);
export const exitCustodyPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("exit_custody")]);
/** One per (denomination index, exit epoch id). */
export const exitBatchPda = (denominationIndex: number, exitEpochId: bigint) =>
  pda(GATEWAY_PROGRAM_ID, [utf8("exit_batch"), Uint8Array.of(denominationIndex), u64le(exitEpochId)]);
/** The gateway's ProgramData account (upgradeable loader); it records the upgrade authority. */
export const programDataPda = () => pda(BPF_LOADER_UPGRADEABLE_ID, [new Uint8Array(enc.encode(GATEWAY_PROGRAM_ID))]);

export interface Params {
  epochLenSlots: bigint;
  minBatchSize: number;
  perEpochCap: number;
  /** User fee on each note, paid on top of the denomination (<= FEE_CAP_BPS). */
  feeBps: number;
  /** The part of `feeBps` paid to whoever sends the batch (<= feeBps); the rest to `treasury`. */
  finisherBps: number;
  /** Bound on the principal that has entered and not been refunded, USDC base units. Raise-only. */
  depositCap: bigint;
  /** USDC token account that receives the treasury share at send_batch. */
  treasury: Address;
}

/** `amount × bps / 10_000`, rounded down: the program's rule for a note's fee and its shares. */
export const bpsOf = (amount: bigint, bps: number): bigint => (amount * BigInt(bps)) / 10_000n;

const ro = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const ws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER });
const rs = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER });

/** Borsh `Params`: u64 | u16 ×4 | u64 | Pubkey (56 bytes). */
export const PARAMS_LEN = 56;

export function encodeParams(p: Params): Uint8Array {
  const b = new Uint8Array(PARAMS_LEN);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, p.epochLenSlots, true);
  dv.setUint16(8, p.minBatchSize, true);
  dv.setUint16(10, p.perEpochCap, true);
  dv.setUint16(12, p.feeBps, true);
  dv.setUint16(14, p.finisherBps, true);
  dv.setBigUint64(16, p.depositCap, true);
  b.set(enc.encode(p.treasury), 24);
  return b;
}

/** The associated USDC (or any SPL) token account of `owner`. */
export const associatedTokenAddress = (owner: Address, mint: Address) =>
  pda(ASSOCIATED_TOKEN_PROGRAM_ID, [new Uint8Array(enc.encode(owner)), new Uint8Array(enc.encode(TOKEN_PROGRAM_ID)), new Uint8Array(enc.encode(mint))]);

/** Creates `owner`'s associated token account for `mint` if it does not exist (paid by `payer`). */
export async function createAssociatedTokenIdempotentIx(payer: Address, owner: Address, mint: Address): Promise<Instruction> {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [ws(payer), w(await associatedTokenAddress(owner, mint)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM_ID), ro(TOKEN_PROGRAM_ID)],
    data: Uint8Array.of(1),
  };
}

/**
 * `admin` must be the program's upgrade authority (ADR 0010): only the deployer can initialize, so
 * nobody can front-run it and choose the portal. `params.treasury` must already be a USDC token
 * account (ADR 0012).
 */
export async function initializeIx(a: {
  admin: Address;
  usdcMint: Address;
  guardian: Address;
  /** Ethereum portal, 0x-prefixed 20-byte address. */
  portal: string;
  denominations: bigint[];
  params: Params;
  adminLifetimeSecs: bigint;
}): Promise<Instruction> {
  const hex = a.portal.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error("portal must be a 20-byte hex address");
  const portal = new Uint8Array(32);
  for (let i = 0; i < 20; i++) portal[12 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  const dens = new Uint8Array(4 + 8 * a.denominations.length);
  new DataView(dens.buffer).setUint32(0, a.denominations.length, true);
  a.denominations.forEach((d, i) => dens.set(u64le(d), 4 + 8 * i));
  const lifetime = new Uint8Array(8);
  new DataView(lifetime.buffer).setBigInt64(0, a.adminLifetimeSecs, true);
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.admin),
      w(await configPda()),
      ro(a.usdcMint),
      w(await escrowPda()),
      w(await feeVaultPda()),
      ro(await exitAuthorityPda()),
      w(await exitCustodyPda()),
      ro(a.params.treasury),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(GATEWAY_PROGRAM_ID),
      ro(await programDataPda()),
    ],
    data: concat(DISC.initialize, enc.encode(a.guardian), portal, dens, encodeParams(a.params), lifetime),
  };
}

export async function openEpochIx(payer: Address, denominationIndex: number, currentEpochId: bigint): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [ws(payer), ro(await configPda()), w(await epochPda(denominationIndex, currentEpochId)), ro(SYSTEM_PROGRAM_ID)],
    data: concat(DISC.openEpoch, [denominationIndex]),
  };
}

/**
 * Deposits one note: `source` pays the denomination into the escrow and the epoch's fee into the
 * fee vault (ADR 0012), so it needs `denomination + fee` (see `depositFeeBps`).
 */
export async function depositIx(a: {
  payer: Address;
  authority: Address;
  source: Address;
  usdcMint: Address;
  denominationIndex: number;
  currentEpochId: bigint;
  /** Note commitment, 32-byte big-endian field element (ADR 0004). */
  commitment: Uint8Array;
}): Promise<Instruction> {
  const authority = a.authority === a.payer ? ws(a.authority) : rs(a.authority);
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.payer),
      authority,
      w(await configPda()),
      w(await epochPda(a.denominationIndex, a.currentEpochId)),
      w(a.source),
      w(await escrowPda()),
      w(await feeVaultPda()),
      ro(a.usdcMint),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      // The depositor's screening record (ADR 0019); a gateway built before it ignores it.
      ro(await blockedPda(a.authority)),
    ],
    data: concat(DISC.deposit, [a.denominationIndex], a.commitment),
  };
}

export async function closeEpochIx(denominationIndex: number, currentEpochId: bigint): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [w(await configPda()), w(await epochPda(denominationIndex, currentEpochId))],
    data: concat(DISC.closeEpoch, [denominationIndex]),
  };
}

/**
 * Finisher instruction; `messageSentEventData` must be a fresh keypair that signs. The batch's
 * fees are paid out here (ADR 0012): the finisher's share to `finisherUsdc`, a USDC account the
 * payer owns, and the rest to `treasury`, which must be the config's `params.treasury`.
 */
export async function sendBatchIx(a: {
  payer: Address;
  usdcMint: Address;
  messageSentEventData: Address;
  denominationIndex: number;
  epochId: bigint;
  finisherUsdc: Address;
  treasury: Address;
}): Promise<Instruction> {
  const tmm = CCTP.tokenMessengerMinterV2;
  const mt = CCTP.messageTransmitterV2;
  const config = await configPda();
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.payer),
      ro(config),
      w(await epochPda(a.denominationIndex, a.epochId)),
      w(await escrowPda()),
      w(await feeVaultPda()),
      w(a.finisherUsdc),
      w(a.treasury),
      w(a.usdcMint),
      ws(a.messageSentEventData),
      ro(await pda(tmm, [utf8("sender_authority")])),
      ro(await pda(tmm, [utf8("denylist_account"), new Uint8Array(enc.encode(config))])),
      w(await pda(mt, [utf8("message_transmitter")])),
      ro(await pda(tmm, [utf8("token_messenger")])),
      ro(await pda(tmm, [utf8("remote_token_messenger"), utf8(String(CCTP.domains.ethereum))])),
      ro(await pda(tmm, [utf8("token_minter")])),
      w(await pda(tmm, [utf8("local_token"), new Uint8Array(enc.encode(a.usdcMint))])),
      ro(await pda(tmm, [utf8("__event_authority")])),
      ro(mt),
      ro(tmm),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.sendBatch, [a.denominationIndex], u64le(a.epochId)),
  };
}

/**
 * Returns one stuck deposit to its depositor (ADR 0010): the denomination and the fee it paid
 * (ADR 0012). `authority` must be the account that signed the deposit; `destination` is any USDC
 * token account it owns. Only for the current, still open epoch of the denomination, after
 * REFUND_DELAY_SLOTS and at least one rollover.
 */
export async function refundDepositIx(a: {
  authority: Address;
  destination: Address;
  usdcMint: Address;
  denominationIndex: number;
  currentEpochId: bigint;
  /** The note commitment that was deposited, 32-byte big-endian. */
  commitment: Uint8Array;
}): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.authority),
      w(await configPda()),
      w(await epochPda(a.denominationIndex, a.currentEpochId)),
      w(a.destination),
      w(await escrowPda()),
      w(await feeVaultPda()),
      ro(a.usdcMint),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.refundDeposit, [a.denominationIndex], a.commitment),
  };
}

/**
 * Admin only, before the sunset: propose new params. The caps are raise-only; a change of the fee,
 * its finisher share or the treasury waits 14 days, any other change 7 days (ADR 0012).
 */
export async function proposeParamsIx(admin: Address, params: Params): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(admin), w(await configPda())],
    data: concat(DISC.proposeParams, encodeParams(params)),
  };
}

/** Anyone, once the timelock has passed (and before the sunset): apply the pending params. */
export async function applyParamsIx(): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [w(await configPda())],
    data: Uint8Array.from(DISC.applyParams),
  };
}

/** Admin only: drop the pending params. */
export async function cancelParamsIx(admin: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(admin), w(await configPda())],
    data: Uint8Array.from(DISC.cancelParams),
  };
}

/** Admin only, before the sunset: replace the guardian (for example after a lost key). */
export async function setGuardianIx(admin: Address, guardian: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(admin), w(await configPda())],
    data: concat(DISC.setGuardian, enc.encode(guardian)),
  };
}

/** Admin only, before the sunset: step one of a two-step admin transfer. */
export async function proposeAdminIx(admin: Address, newAdmin: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(admin), w(await configPda())],
    data: concat(DISC.proposeAdmin, enc.encode(newAdmin)),
  };
}

/** Signed by the proposed admin: step two. The sunset date does not move. */
export async function acceptAdminIx(newAdmin: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(newAdmin), w(await configPda())],
    data: Uint8Array.from(DISC.acceptAdmin),
  };
}

export function computeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data };
}

// ---------- account decoding (Borsh, little-endian) ----------

class Reader {
  o = 0;
  dv: DataView;
  constructor(public b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8() { return this.b[this.o++]!; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64() { const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
  i64() { const v = this.dv.getBigInt64(this.o, true); this.o += 8; return v; }
  bytes(n: number) { const v = this.b.slice(this.o, this.o + n); this.o += n; return v; }
  addr() { return getAddressDecoder().decode(this.bytes(32)); }
  disc(expected: readonly number[]) {
    const d = this.bytes(8);
    if (!d.every((x, i) => x === expected[i])) throw new Error("account discriminator mismatch");
  }
}

export interface ConfigAccount {
  admin: Address;
  guardian: Address;
  usdcMint: Address;
  escrow: Address;
  /** Fees of deposits that have not crossed (ADR 0012). */
  feeVault: Address;
  /** Exits that arrived and are not claimed yet (ADR 0009). */
  exitCustody: Address;
  portal: Uint8Array;
  denominations: bigint[];
  currentEpoch: bigint[];
  /** Principal that has entered and not been refunded; bounded by `params.depositCap`. */
  netDeposits: bigint;
  params: Params;
  /** A proposed change and when it can be applied (unix seconds). */
  pending?: { params: Params; eta: bigint };
  pausedDeposits: boolean;
  pauseExpiry: bigint;
  adminExpiryTs: bigint;
  /** The guardian cannot pause again before this time (ADR 0010). */
  pauseCooldownUntil: bigint;
  /** Proposed admin waiting to accept, if any. */
  pendingAdmin?: Address;
}

function readParams(r: Reader): Params {
  return {
    epochLenSlots: r.u64(), minBatchSize: r.u16(), perEpochCap: r.u16(), feeBps: r.u16(), finisherBps: r.u16(),
    depositCap: r.u64(), treasury: r.addr(),
  };
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const r = new Reader(data);
  r.disc(DISC.configAccount);
  const admin = r.addr(), guardian = r.addr(), usdcMint = r.addr(), escrow = r.addr(), feeVault = r.addr();
  const exitCustody = r.addr();
  const portal = r.bytes(32);
  const denominations = [r.u64(), r.u64(), r.u64(), r.u64()];
  const currentEpoch = [r.u64(), r.u64(), r.u64(), r.u64()];
  const netDeposits = r.u64();
  const params = readParams(r);
  const pending = r.u8() === 1 ? { params: readParams(r), eta: r.i64() } : undefined;
  const pausedDeposits = r.u8() === 1;
  const pauseExpiry = r.i64(), adminExpiryTs = r.i64();
  r.u8(); r.u8(); r.u8(); r.u8(); r.u8(); // bump, escrow, fee_vault, exit_authority, exit_custody bumps
  const pauseCooldownUntil = r.i64();
  const pendingAdmin = r.u8() === 1 ? r.addr() : undefined;
  return {
    admin, guardian, usdcMint, escrow, feeVault, exitCustody, portal, denominations, currentEpoch, netDeposits, params, pending,
    pausedDeposits, pauseExpiry, adminExpiryTs, pauseCooldownUntil, pendingAdmin,
  };
}

/** Principal that can still enter before the deposit cap (USDC base units). */
export const depositRoom = (cfg: Pick<ConfigAccount, "netDeposits" | "params">): bigint =>
  cfg.params.depositCap > cfg.netDeposits ? cfg.params.depositCap - cfg.netDeposits : 0n;

/**
 * The fee rate the next deposit of a denomination pays: the open epoch's snapshot if it exists
 * (it is the current epoch), else the config's fee, which the epoch snapshots when it opens.
 */
export const depositFeeBps = (cfg: Pick<ConfigAccount, "params">, currentEpoch?: Pick<EpochAccount, "status" | "feeBps">): number =>
  currentEpoch?.status === "Open" ? currentEpoch.feeBps : cfg.params.feeBps;

/** What one deposit takes from the wallet: the note plus its fee. */
export const depositCost = (denomination: bigint, feeBps: number): bigint => denomination + bpsOf(denomination, feeBps);

/** The config's portal as a 0x-prefixed, lower-case 20-byte address. */
export function configPortalAddress(cfg: Pick<ConfigAccount, "portal">): string {
  return "0x" + Array.from(cfg.portal.slice(12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True when the on-chain gateway sends batches to the portal this client expects. A client must
 * not deposit into a gateway whose portal it does not recognise (ADR 0010).
 */
export function portalMatches(cfg: Pick<ConfigAccount, "portal">, expectedPortal: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(expectedPortal) && configPortalAddress(cfg) === expectedPortal.toLowerCase();
}

export type EpochStatus = "Open" | "Closed" | "Sent";

export interface EpochAccount {
  denominationIndex: number;
  denomination: bigint;
  epochId: bigint;
  openedSlot: bigint;
  endSlot: bigint;
  rollovers: number;
  status: EpochStatus;
  root: bigint;
  /** Fee and finisher share in force when the epoch opened: its deposits, payout and refunds use them. */
  feeBps: number;
  finisherBps: number;
  leaves: bigint[];
  /** Who signed each leaf's deposit (same order as `leaves`); a refund pays back to them. */
  depositors: Address[];
}

const toBig = (b: Uint8Array) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);

export function decodeEpoch(data: Uint8Array): EpochAccount {
  const r = new Reader(data);
  r.disc(DISC.epochAccount);
  const denominationIndex = r.u8();
  const denomination = r.u64(), epochId = r.u64(), openedSlot = r.u64(), endSlot = r.u64();
  const rollovers = r.u32();
  const status = (["Open", "Closed", "Sent"] as const)[r.u8()]!;
  const root = toBig(r.bytes(32));
  r.u8(); // bump
  const feeBps = r.u16(), finisherBps = r.u16();
  const n = r.u32();
  const leaves = Array.from({ length: n }, () => toBig(r.bytes(32)));
  const m = r.u32();
  const depositors = Array.from({ length: m }, () => r.addr());
  return { denominationIndex, denomination, epochId, openedSlot, endSlot, rollovers, status, root, feeBps, finisherBps, leaves, depositors };
}

/** The fee each deposit of `epoch` paid, which a refund returns with the note. */
export const epochNoteFee = (epoch: Pick<EpochAccount, "denomination" | "feeBps">): bigint => bpsOf(epoch.denomination, epoch.feeBps);

export interface RefundStatus {
  refundable: boolean;
  /** Slot from which the deposit becomes refundable, if its epoch stays open and rolls over. */
  fromSlot: bigint;
  reason?: "crossing" | "too-early" | "no-rollover";
}

/**
 * Whether a deposit in `epoch` can be refunded at `slot`. Only deposits that have not crossed
 * can be: the epoch is still open, has been open for REFUND_DELAY_SLOTS and has rolled over at
 * least once because it had too few deposits.
 */
export function refundStatus(epoch: Pick<EpochAccount, "status" | "openedSlot" | "rollovers">, slot: bigint): RefundStatus {
  const fromSlot = epoch.openedSlot + REFUND_DELAY_SLOTS;
  if (epoch.status !== "Open") return { refundable: false, fromSlot, reason: "crossing" };
  if (slot < fromSlot) return { refundable: false, fromSlot, reason: "too-early" };
  if (epoch.rollovers < 1) return { refundable: false, fromSlot, reason: "no-rollover" };
  return { refundable: true, fromSlot };
}

// ---------- exit (ADR 0009) ----------

/**
 * Compute limit for a receive_exit transaction. CCTP's receive_message costs about 190k CU with
 * two attesters (each signature is a secp256k1 recovery); receive_exit measured 215-219k in LiteSVM.
 */
export const RECEIVE_EXIT_COMPUTE_UNITS = 400_000;
/** claim_exit measured 30k CU (39k when it creates the destination's USDC account). */
export const CLAIM_EXIT_COMPUTE_UNITS = 100_000;

/** The `ExitBatch` address an exit message lands in: its hook's denomination index and exit epoch. */
export async function exitBatchPdaOfMessage(message: Uint8Array, denominations: bigint[]): Promise<Address> {
  const hook = decodeExitHook(message.subarray(CCTP_MESSAGE.hookData));
  const idx = denominations.findIndex((d) => d !== 0n && d === hook.denomination);
  if (idx < 0) throw new Error(`denomination ${hook.denomination} is not one of the gateway's`);
  return exitBatchPda(idx, hook.exitEpochId);
}

/**
 * Finisher instruction: receives one exit batch from Ethereum (Iris's `message` and
 * `attestation`), so CCTP pays it into exit custody and the gateway stores its root.
 * `denominations` and `cctpFeeRecipient` come from the gateway Config and CCTP's TokenMessenger
 * state (`decodeTokenMessengerFeeRecipient`).
 *
 * It does not fit a legacy transaction (21 accounts, a 427-byte message and a 130-byte
 * attestation): send it as a v0 transaction with an address lookup table holding
 * `receiveExitLookupTableAddresses`, and a compute limit of RECEIVE_EXIT_COMPUTE_UNITS.
 */
export async function receiveExitIx(a: {
  payer: Address;
  usdcMint: Address;
  message: Uint8Array;
  attestation: Uint8Array;
  denominations: bigint[];
  cctpFeeRecipient: Address;
}): Promise<Instruction> {
  if (a.message.length !== EXIT_MESSAGE_LENGTH) throw new Error(`exit message must be ${EXIT_MESSAGE_LENGTH} bytes`);
  const cctp = await cctpReceiveAccounts({
    usdcMint: a.usdcMint,
    burnToken: a.message.slice(CCTP_MESSAGE.burnToken, CCTP_MESSAGE.burnToken + 32),
    feeRecipient: a.cctpFeeRecipient,
    nonce: a.message.slice(CCTP_MESSAGE.nonce, CCTP_MESSAGE.nonce + 32),
  });
  const len = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.payer),
      ro(await configPda()),
      ro(await exitAuthorityPda()),
      w(await exitCustodyPda()),
      w(await exitBatchPdaOfMessage(a.message, a.denominations)),
      ro(cctp.messageTransmitter),
      w(cctp.usedNonce!),
      ro(cctp.authorityPda),
      ro(cctp.mtEventAuthority),
      ro(cctp.tokenMessenger),
      ro(cctp.remoteTokenMessenger),
      ro(cctp.tokenMinter),
      w(cctp.localToken),
      ro(cctp.tokenPair),
      w(cctp.feeRecipientTokenAccount),
      w(cctp.custody),
      ro(cctp.tmmEventAuthority),
      ro(CCTP.messageTransmitterV2),
      ro(CCTP.tokenMessengerMinterV2),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.receiveExit, len(a.message.length), a.message, len(a.attestation.length), a.attestation),
  };
}

/**
 * The 18 accounts of receive_exit that are the same for every exit message (everything but the
 * payer, the ExitBatch and CCTP's used-nonce PDA): the contents of the address lookup table a
 * finisher creates once per deployment. `burnToken` is Ethereum USDC as bytes32
 * (`evmAddressToBytes32`); it selects CCTP's token pair.
 */
export async function receiveExitLookupTableAddresses(a: { usdcMint: Address; burnToken: Uint8Array; cctpFeeRecipient: Address }): Promise<Address[]> {
  const c = await cctpReceiveAccounts({ usdcMint: a.usdcMint, burnToken: a.burnToken, feeRecipient: a.cctpFeeRecipient });
  return [
    await configPda(), await exitAuthorityPda(), await exitCustodyPda(),
    c.messageTransmitter, c.authorityPda, c.mtEventAuthority, c.tokenMessenger, c.remoteTokenMessenger, c.tokenMinter,
    c.localToken, c.tokenPair, c.feeRecipientTokenAccount, c.custody, c.tmmEventAuthority,
    CCTP.messageTransmitterV2, CCTP.tokenMessengerMinterV2, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID,
  ];
}

/**
 * Pays one exit (ADR 0009): leaf `leafIndex` of exit batch (denominationIndex, exitEpochId) is
 * `exitCommitment(destination, secret)`, proven by its depth-8 `path` (`exitClaimInputs` in
 * exit.ts). Anyone can send it (`payer` pays the rent of the destination's USDC account if it is
 * missing); the USDC goes to `destination`'s associated USDC account.
 *
 * Fronted exits (ADR 0017): the program always derives the leaf's Front PDA (passed here). When a
 * solver or the liquidity pool fronted the exit, pass `front` (from `decodeFront`): the claim
 * then pays the whole denomination to the fronter (`front.payee`), credits the pool, and returns
 * the record's rent to `front.rentPayer`. Without `front`, the last three accounts are the payer;
 * the program ignores them when nothing was fronted, and refuses the claim when something was.
 * The extra accounts are ignored by a gateway without V2, so this builder works before and after
 * the upgrade.
 */
export async function claimExitIx(a: {
  payer: Address;
  usdcMint: Address;
  denominationIndex: number;
  exitEpochId: bigint;
  leafIndex: number;
  path: bigint[];
  destination: Address;
  secret: bigint;
  front?: { payee: Address; rentPayer: Address };
}): Promise<Instruction> {
  if (a.path.length !== BATCH_TREE_DEPTH) throw new RangeError(`path must have ${BATCH_TREE_DEPTH} nodes`);
  if (!Number.isInteger(a.leafIndex) || a.leafIndex < 0 || a.leafIndex >= 2 ** BATCH_TREE_DEPTH) throw new RangeError("leafIndex");
  const leafIndex = new Uint8Array(2);
  new DataView(leafIndex.buffer).setUint16(0, a.leafIndex, true);
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.payer),
      ro(await configPda()),
      w(await exitBatchPda(a.denominationIndex, a.exitEpochId)),
      ro(await exitAuthorityPda()),
      w(await exitCustodyPda()),
      ro(a.destination),
      w(await associatedTokenAddress(a.destination, a.usdcMint)),
      ro(a.usdcMint),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      w(await frontPda(exitCommitment(a.destination, a.secret))),
      w(a.front?.payee ?? a.payer),
      w(a.front?.rentPayer ?? a.payer),
      w(a.front ? await liquidityPda() : a.payer),
    ],
    data: concat(
      DISC.claimExit,
      [a.denominationIndex],
      u64le(a.exitEpochId),
      leafIndex,
      ...a.path.map(toBytes32),
      enc.encode(a.destination),
      toBytes32(a.secret),
    ),
  };
}

export interface ExitBatchAccount {
  denominationIndex: number;
  denomination: bigint;
  exitEpochId: bigint;
  root: bigint;
  /** Exits in the batch: leaves 0..count. */
  count: number;
  claimedCount: number;
  /** Bit i % 8 of byte i / 8 is set once leaf i is paid (`exitClaimed`). */
  claimed: Uint8Array;
  cctpNonce: Uint8Array;
  receivedSlot: bigint;
}

export function decodeExitBatch(data: Uint8Array): ExitBatchAccount {
  const r = new Reader(data);
  r.disc(DISC.exitBatchAccount);
  const denominationIndex = r.u8();
  const denomination = r.u64(), exitEpochId = r.u64();
  const root = toBig(r.bytes(32));
  const count = r.u16(), claimedCount = r.u16();
  const claimed = r.bytes(32), cctpNonce = r.bytes(32);
  const receivedSlot = r.u64();
  return { denominationIndex, denomination, exitEpochId, root, count, claimedCount, claimed, cctpNonce, receivedSlot };
}

/** Whether leaf `leafIndex` of the batch has been paid. */
export const exitClaimed = (batch: Pick<ExitBatchAccount, "claimed">, leafIndex: number): boolean =>
  ((batch.claimed[leafIndex >> 3] ?? 0) & (1 << (leafIndex & 7))) !== 0;

// ---------- address lookup tables (receive_exit, ADR 0009) ----------

/** Solana's address lookup table program. */
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = address("AddressLookupTab1e1111111111111111111111111");

/**
 * CreateLookupTable: the table lives at the PDA of (authority, recentSlot). `recentSlot` must be a
 * slot the cluster still remembers (a recent confirmed one). Returns the instruction and the table.
 */
export async function createLookupTableIx(a: { authority: Address; payer: Address; recentSlot: bigint }): Promise<{ ix: Instruction; table: Address }> {
  const [table, bump] = await getProgramDerivedAddress({
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    seeds: [enc.encode(a.authority), u64le(a.recentSlot)],
  });
  const ix: Instruction = {
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    accounts: [w(table), { address: a.authority, role: AccountRole.READONLY_SIGNER }, ws(a.payer), ro(SYSTEM_PROGRAM_ID)],
    data: concat([0, 0, 0, 0], u64le(a.recentSlot), [bump]),
  };
  return { ix, table };
}

/** ExtendLookupTable: appends `addresses` (about 20 fit one transaction). Usable from the next slot. */
export function extendLookupTableIx(a: { table: Address; authority: Address; payer: Address; addresses: Address[] }): Instruction {
  return {
    programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
    accounts: [w(a.table), { address: a.authority, role: AccountRole.READONLY_SIGNER }, ws(a.payer), ro(SYSTEM_PROGRAM_ID)],
    data: concat([2, 0, 0, 0], u64le(BigInt(a.addresses.length)), ...a.addresses.map((x) => enc.encode(x))),
  };
}

/** The addresses a lookup table holds (its 56-byte header, then 32 bytes each). */
export function decodeLookupTable(data: Uint8Array): Address[] {
  const out: Address[] = [];
  const dec = getAddressDecoder();
  for (let o = 56; o + 32 <= data.length; o += 32) out.push(dec.decode(data.subarray(o, o + 32)));
  return out;
}

// ================================================================== V2 lanes (ADR 0015, 0017)
//
// Cross now (express epochs paid by the crossing pool, then by the user), fronted exits and the
// liquidity pool that funds them. New accounts only; none exists until the admin runs init_lanes,
// so a client checks `lanesPda()` before offering any of it.

/** Express epoch ids carry this bit (programs/gateway/src/constants.rs). */
export const EXPRESS_EPOCH_BIT = 1n << 63n;
export const isExpressEpochId = (id: bigint) => (id & EXPRESS_EPOCH_BIT) !== 0n;
/** Hard bounds (constants.rs). */
export const MAX_EXPRESS_FEE = 50_000_000n;
export const FRONT_FEE_HARD_CAP_BPS = 50;
export const FRONT_WRITE_OFF_SECS = 7 * 86_400;
export const LP_VIRTUAL = 1_000_000n;
/** deposit_express measured 49k CU in LiteSVM (one Poseidon root of a one-leaf tree). */
export const DEPOSIT_EXPRESS_COMPUTE_UNITS = 200_000;

export const lanesPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("lanes")]);
/** The crossing pool: anyone tops it up with a plain USDC transfer (ADR 0015). */
export const crossingPoolPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("crossing_pool")]);
/** `expressId` includes EXPRESS_EPOCH_BIT. */
export const expressPda = (denominationIndex: number, expressId: bigint) =>
  pda(GATEWAY_PROGRAM_ID, [utf8("express"), Uint8Array.of(denominationIndex), u64le(expressId)]);
/** The Front record of an exit leaf (`exitCommitment(destination, secret)`). */
export const frontPda = (leaf: bigint) => pda(GATEWAY_PROGRAM_ID, [utf8("front"), toBytes32(leaf)]);
export const liquidityPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("liquidity")]);
export const liquidityVaultPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("liquidity_vault")]);
export const lpPositionPda = async (owner: Address) => pda(GATEWAY_PROGRAM_ID, [utf8("lp"), new Uint8Array(enc.encode(owner))]);

export interface LaneParams {
  /** USDC base units an express crossing pays the finisher; from the crossing pool while it can. */
  expressFee: bigint;
  /** The most any front keeps, in basis points of the denomination. */
  frontFeeCapBps: number;
  /** What a pool front keeps (<= frontFeeCapBps). */
  poolFeeBps: number;
  /** Bound on the pool's unpaid advances (USDC base units). */
  poolMaxOutstanding: bigint;
  /** The key that signs pool fronts; the default address means pool fronts are off. */
  keeper: Address;
}

/** Borsh `LaneParams`: u64 | u16 | u16 | u64 | Pubkey (52 bytes). */
export const LANE_PARAMS_LEN = 52;
export const DEFAULT_ADDRESS = address("11111111111111111111111111111111");

export function encodeLaneParams(p: LaneParams): Uint8Array {
  const b = new Uint8Array(LANE_PARAMS_LEN);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, p.expressFee, true);
  dv.setUint16(8, p.frontFeeCapBps, true);
  dv.setUint16(10, p.poolFeeBps, true);
  dv.setBigUint64(12, p.poolMaxOutstanding, true);
  b.set(enc.encode(p.keeper), 20);
  return b;
}

/** Admin only, once: creates Lanes, the crossing pool and the liquidity pool (turns V2 on). */
export async function initLanesIx(admin: Address, usdcMint: Address, params: LaneParams): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(admin), ro(await configPda()), w(await lanesPda()), w(await crossingPoolPda()), w(await liquidityPda()),
      w(await liquidityVaultPda()), ro(usdcMint), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.initLanes, encodeLaneParams(params)),
  };
}

/** Admin only: 14 days when a fee rate changes, else 7. */
export async function proposeLaneParamsIx(admin: Address, params: LaneParams): Promise<Instruction> {
  return { programAddress: GATEWAY_PROGRAM_ID, accounts: [rs(admin), ro(await configPda()), w(await lanesPda())], data: concat(DISC.proposeLaneParams, encodeLaneParams(params)) };
}
export async function cancelLaneParamsIx(admin: Address): Promise<Instruction> {
  return { programAddress: GATEWAY_PROGRAM_ID, accounts: [rs(admin), ro(await configPda()), w(await lanesPda())], data: Uint8Array.from(DISC.cancelLaneParams) };
}
/** Anyone, after the timelock. */
export async function applyLaneParamsIx(): Promise<Instruction> {
  return { programAddress: GATEWAY_PROGRAM_ID, accounts: [ro(await configPda()), w(await lanesPda())], data: Uint8Array.from(DISC.applyLaneParams) };
}
/** Admin or guardian, at once: stops pool fronts. */
export async function disablePoolFrontsIx(signer: Address): Promise<Instruction> {
  return { programAddress: GATEWAY_PROGRAM_ID, accounts: [rs(signer), ro(await configPda()), w(await lanesPda())], data: Uint8Array.from(DISC.disablePoolFronts) };
}

/**
 * Cross now (ADR 0015): one note in its own express epoch, closed at once. `source` pays the
 * denomination and the note's fee, plus the express fee when the crossing pool cannot; the
 * program refuses if that is above `maxExpressFee` (0 = "only if it is on us").
 * `expressId` is `lanes.expressNext[i] | EXPRESS_EPOCH_BIT` (`nextExpressId`).
 */
export async function depositExpressIx(a: {
  payer: Address;
  authority: Address;
  source: Address;
  usdcMint: Address;
  denominationIndex: number;
  expressId: bigint;
  commitment: Uint8Array;
  maxExpressFee: bigint;
}): Promise<Instruction> {
  // As the program declares it; a payer that is also the authority is merged to writable signer.
  const authority = rs(a.authority);
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.payer), authority, w(await configPda()), w(await lanesPda()), w(await expressPda(a.denominationIndex, a.expressId)),
      w(a.source), w(await escrowPda()), w(await feeVaultPda()), w(await crossingPoolPda()), ro(a.usdcMint),
      ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID), ro(await blockedPda(a.authority)),
    ],
    data: concat(DISC.depositExpress, [a.denominationIndex], a.commitment, u64le(a.maxExpressFee)),
  };
}

/** Finisher: send_batch for an express epoch (pays the express fee to `finisherUsdc`). */
export async function sendExpressBatchIx(a: {
  payer: Address;
  usdcMint: Address;
  messageSentEventData: Address;
  denominationIndex: number;
  expressId: bigint;
  finisherUsdc: Address;
  treasury: Address;
}): Promise<Instruction> {
  const ix = await sendBatchIx({ ...a, epochId: 0n });
  const accounts = [...ix.accounts!];
  accounts[2] = w(await expressPda(a.denominationIndex, a.expressId));
  return { programAddress: GATEWAY_PROGRAM_ID, accounts, data: concat(DISC.sendExpressBatch, [a.denominationIndex], u64le(a.expressId)) };
}

/**
 * A solver fronts an exit (ADR 0017): pays `destination` denomination − fee now from
 * `solverUsdc` and is repaid the whole denomination into `payeeUsdc` by claim_exit. Only before
 * the exit batch (denominationIndex, exitEpochId) arrives on Solana.
 */
export async function frontExitIx(a: {
  solver: Address;
  solverUsdc: Address;
  payeeUsdc: Address;
  usdcMint: Address;
  denominationIndex: number;
  exitEpochId: bigint;
  destination: Address;
  secret: bigint;
  fee: bigint;
}): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.solver), ro(await configPda()), ro(await lanesPda()), ro(await exitBatchPda(a.denominationIndex, a.exitEpochId)),
      w(await frontPda(exitCommitment(a.destination, a.secret))), w(a.solverUsdc), ro(a.payeeUsdc), ro(a.destination),
      w(await associatedTokenAddress(a.destination, a.usdcMint)), ro(a.usdcMint), ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.frontExit, [a.denominationIndex], u64le(a.exitEpochId), enc.encode(a.destination), toBytes32(a.secret), u64le(a.fee)),
  };
}

/** The keeper fronts an exit from the liquidity pool, at the pool's fixed fee. */
export async function frontExitFromPoolIx(a: {
  keeper: Address;
  usdcMint: Address;
  denominationIndex: number;
  exitEpochId: bigint;
  destination: Address;
  secret: bigint;
}): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.keeper), ro(await configPda()), ro(await lanesPda()), w(await liquidityPda()), w(await liquidityVaultPda()),
      ro(await exitBatchPda(a.denominationIndex, a.exitEpochId)), w(await frontPda(exitCommitment(a.destination, a.secret))),
      ro(a.destination), w(await associatedTokenAddress(a.destination, a.usdcMint)), ro(a.usdcMint), ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.frontExitFromPool, [a.denominationIndex], u64le(a.exitEpochId), enc.encode(a.destination), toBytes32(a.secret)),
  };
}

/** Anyone, a week after a pool front was made and still unpaid. */
export async function writeOffFrontIx(leaf: bigint): Promise<Instruction> {
  return { programAddress: GATEWAY_PROGRAM_ID, accounts: [w(await frontPda(leaf)), w(await liquidityPda())], data: concat(DISC.writeOffFront, toBytes32(leaf)) };
}

export async function lpDepositIx(a: { owner: Address; source: Address; usdcMint: Address; amount: bigint }): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.owner), ro(await configPda()), w(await liquidityPda()), w(await liquidityVaultPda()), w(await lpPositionPda(a.owner)),
      w(a.source), ro(a.usdcMint), ro(TOKEN_PROGRAM_ID), ro(SYSTEM_PROGRAM_ID),
    ],
    data: concat(DISC.lpDeposit, u64le(a.amount)),
  };
}

export async function lpWithdrawIx(a: { owner: Address; destination: Address; usdcMint: Address; shares: bigint }): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [
      ws(a.owner), ro(await configPda()), w(await liquidityPda()), w(await liquidityVaultPda()), w(await lpPositionPda(a.owner)),
      w(a.destination), ro(a.usdcMint), ro(TOKEN_PROGRAM_ID),
    ],
    data: concat(DISC.lpWithdraw, u64le(a.shares)),
  };
}

// ---------- V2 account decoding ----------

function readLaneParams(r: Reader): LaneParams {
  return { expressFee: r.u64(), frontFeeCapBps: r.u16(), poolFeeBps: r.u16(), poolMaxOutstanding: r.u64(), keeper: r.addr() };
}

export interface LanesAccount {
  version: number;
  crossingPool: Address;
  params: LaneParams;
  pending?: { params: LaneParams; eta: bigint };
  expressNext: bigint[];
  /** Express fees the crossing pool has paid so far. */
  poolPaid: bigint;
}

export function decodeLanes(data: Uint8Array): LanesAccount {
  const r = new Reader(data);
  r.disc(DISC.lanesAccount);
  const version = r.u8();
  r.u8(); r.u8(); // bumps
  const crossingPool = r.addr();
  const params = readLaneParams(r);
  const pending = r.u8() === 1 ? { params: readLaneParams(r), eta: r.i64() } : undefined;
  const expressNext = [r.u64(), r.u64(), r.u64(), r.u64()];
  const poolPaid = r.u64();
  return { version, crossingPool, params, pending, expressNext, poolPaid };
}

/** The id the next express crossing of a denomination gets. */
export const nextExpressId = (lanes: Pick<LanesAccount, "expressNext">, denominationIndex: number): bigint =>
  EXPRESS_EPOCH_BIT | (lanes.expressNext[denominationIndex] ?? 0n);

export interface ExpressEpochAccount {
  denominationIndex: number;
  denomination: bigint;
  expressId: bigint;
  openedSlot: bigint;
  status: EpochStatus;
  root: bigint;
  leaf: bigint;
  depositor: Address;
  fee: bigint;
  finisherFee: bigint;
  expressFee: bigint;
  paidByPool: boolean;
}

export function decodeExpressEpoch(data: Uint8Array): ExpressEpochAccount {
  const r = new Reader(data);
  r.disc(DISC.expressEpochAccount);
  r.u8(); r.u8(); // version, bump
  const denominationIndex = r.u8();
  const denomination = r.u64(), expressId = r.u64(), openedSlot = r.u64();
  const status = (["Open", "Closed", "Sent"] as const)[r.u8()]!;
  const root = toBig(r.bytes(32)), leaf = toBig(r.bytes(32));
  const depositor = r.addr();
  const fee = r.u64(), finisherFee = r.u64(), expressFee = r.u64();
  const paidByPool = r.u8() === 1;
  return { denominationIndex, denomination, expressId, openedSlot, status, root, leaf, depositor, fee, finisherFee, expressFee, paidByPool };
}

/**
 * An express epoch seen as a batch of one (`EpochAccount`), so clients treat it like any epoch:
 * its stage, root and leaves for the claim, and `findCommitment` for recovery from the seed. The
 * fee rates are recovered from the stored amounts (exact for whole-dollar denominations).
 */
export function expressAsEpoch(x: ExpressEpochAccount): EpochAccount {
  const bps = (fee: bigint) => (x.denomination > 0n ? Number((fee * 10_000n) / x.denomination) : 0);
  return {
    denominationIndex: x.denominationIndex, denomination: x.denomination, epochId: x.expressId, openedSlot: x.openedSlot, endSlot: x.openedSlot,
    rollovers: 0, status: x.status, root: x.root, feeBps: bps(x.fee), finisherBps: bps(x.finisherFee), leaves: [x.leaf], depositors: [x.depositor],
  };
}

export interface FrontAccount {
  leaf: bigint;
  denominationIndex: number;
  denomination: bigint;
  exitEpochId: bigint;
  fee: bigint;
  advanced: bigint;
  payee: Address;
  rentPayer: Address;
  fromPool: boolean;
  writtenOff: boolean;
  frontedAt: bigint;
}

export function decodeFront(data: Uint8Array): FrontAccount {
  const r = new Reader(data);
  r.disc(DISC.frontAccount);
  r.u8(); r.u8(); // version, bump
  const leaf = toBig(r.bytes(32));
  const denominationIndex = r.u8();
  const denomination = r.u64(), exitEpochId = r.u64(), fee = r.u64(), advanced = r.u64();
  const payee = r.addr(), rentPayer = r.addr();
  const fromPool = r.u8() === 1, writtenOff = r.u8() === 1;
  const frontedAt = r.i64();
  return { leaf, denominationIndex, denomination, exitEpochId, fee, advanced, payee, rentPayer, fromPool, writtenOff, frontedAt };
}

export interface LiquidityAccount {
  vault: Address;
  totalShares: bigint;
  /** Idle USDC: what can be fronted or withdrawn now. */
  liquid: bigint;
  /** Advanced to fronts, not repaid nor written off. */
  outstanding: bigint;
  feesEarned: bigint;
  writtenOff: bigint;
  recovered: bigint;
  fronts: bigint;
}

export function decodeLiquidity(data: Uint8Array): LiquidityAccount {
  const r = new Reader(data);
  r.disc(DISC.liquidityAccount);
  r.u8(); r.u8(); r.u8(); // version, bump, vault bump
  const vault = r.addr();
  const [totalShares, liquid, outstanding, feesEarned, writtenOff, recovered, fronts] = [r.u64(), r.u64(), r.u64(), r.u64(), r.u64(), r.u64(), r.u64()];
  return { vault, totalShares, liquid, outstanding, feesEarned, writtenOff, recovered, fronts };
}

export interface LpPositionAccount {
  owner: Address;
  shares: bigint;
}

export function decodeLpPosition(data: Uint8Array): LpPositionAccount {
  const r = new Reader(data);
  r.disc(DISC.lpPositionAccount);
  r.u8(); r.u8();
  return { owner: r.addr(), shares: r.u64() };
}

// ---------- V2 quotes (the program's rules, for the app) ----------

/**
 * What crossing now costs (ADR 0015): the express fee, and whether the crossing pool pays it
 * ("on us": the pool holds at least one express fee). `userPays` is what the wallet gives on top
 * of the note: its fee, plus the express fee when the pool cannot pay.
 */
export function crossNowQuote(a: { expressFee: bigint; poolBalance: bigint; denomination: bigint; feeBps: number }): { expressFee: bigint; onUs: boolean; userPays: bigint } {
  const onUs = a.expressFee > 0n && a.poolBalance >= a.expressFee;
  const fee = bpsOf(a.denomination, a.feeBps);
  return { expressFee: a.expressFee, onUs, userPays: a.denomination + fee + (onUs ? 0n : a.expressFee) };
}

/** How much the pool can front now: its idle funds, within its bound on unpaid advances. */
export function poolCapacity(l: Pick<LiquidityAccount, "liquid" | "outstanding">, p: Pick<LaneParams, "poolMaxOutstanding" | "keeper">): bigint {
  if (p.keeper === DEFAULT_ADDRESS) return 0n;
  const room = p.poolMaxOutstanding > l.outstanding ? p.poolMaxOutstanding - l.outstanding : 0n;
  return l.liquid < room ? l.liquid : room;
}

/** A pool front of one note: its fee, what the destination receives, and whether it fits now. */
export function poolFrontQuote(denomination: bigint, l: Pick<LiquidityAccount, "liquid" | "outstanding">, p: Pick<LaneParams, "poolFeeBps" | "poolMaxOutstanding" | "keeper">): { fee: bigint; advanced: bigint; fits: boolean } {
  const fee = bpsOf(denomination, p.poolFeeBps);
  const advanced = denomination - fee;
  return { fee, advanced, fits: advanced <= poolCapacity(l, p) };
}

/** Shares for a deposit and USDC for shares, rounded down as the program does. */
export const lpSharesFor = (l: Pick<LiquidityAccount, "liquid" | "outstanding" | "totalShares">, amount: bigint) =>
  (amount * (l.totalShares + LP_VIRTUAL)) / (l.liquid + l.outstanding + LP_VIRTUAL);
export const lpAmountFor = (l: Pick<LiquidityAccount, "liquid" | "outstanding" | "totalShares">, shares: bigint) =>
  (shares * (l.liquid + l.outstanding + LP_VIRTUAL)) / (l.totalShares + LP_VIRTUAL);

// ---------- Screening deposits (ADR 0019) ----------
//
// A denylist of depositor addresses kept by the guardian: `deposit` and `deposit_express` refuse an
// authority whose record ["blocked", address] exists. Nothing exists until the admin runs
// init_screening. Refunds, batches, claims and exits never read it.

/** A removal is announced this long before anyone can carry it out (constants.rs). */
export const UNBLOCK_DELAY_SECS = 2 * 86_400;
/** Which list an entry comes from (informational). */
export const LIST = { sanctions: 0, stolenFunds: 1, other: 2 } as const;
export type ListKind = keyof typeof LIST;

export const screeningPda = () => pda(GATEWAY_PROGRAM_ID, [utf8("screening")]);
/** The screening record of `address`; it holds data only while that address is blocked. */
export const blockedPda = (address: Address) => pda(GATEWAY_PROGRAM_ID, [utf8("blocked"), new Uint8Array(enc.encode(address))]);

/** Admin only, once: creates the Screening account (lets addresses be added). */
export async function initScreeningIx(admin: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [ws(admin), ro(await configPda()), w(await screeningPda()), ro(SYSTEM_PROGRAM_ID)],
    data: Uint8Array.from(DISC.initScreening),
  };
}

/** Guardian or admin, at once: `address` can no longer deposit. `signer` pays the record's rent. */
export async function blockAddressIx(a: { signer: Address; address: Address; list: number; reference: Uint8Array }): Promise<Instruction> {
  if (a.reference.length !== 32) throw new Error("reference must be 32 bytes");
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [ws(a.signer), ro(await configPda()), w(await screeningPda()), w(await blockedPda(a.address)), ro(SYSTEM_PROGRAM_ID)],
    data: concat(DISC.blockAddress, enc.encode(a.address), [a.list], a.reference),
  };
}

/** Guardian or admin (anyone after the sunset): announces the removal of `address`. */
export async function proposeUnblockIx(signer: Address, address: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(signer), ro(await configPda()), w(await blockedPda(address))],
    data: concat(DISC.proposeUnblock, enc.encode(address)),
  };
}

/** Guardian or admin, before the sunset: keeps `address` blocked. */
export async function cancelUnblockIx(signer: Address, address: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [rs(signer), ro(await configPda()), w(await blockedPda(address))],
    data: concat(DISC.cancelUnblock, enc.encode(address)),
  };
}

/** Anyone, once the announced removal is due; the record's rent goes back to `rentPayer`. */
export async function unblockIx(address: Address, rentPayer: Address): Promise<Instruction> {
  return {
    programAddress: GATEWAY_PROGRAM_ID,
    accounts: [w(await screeningPda()), w(await blockedPda(address)), w(rentPayer)],
    data: concat(DISC.unblock, enc.encode(address)),
  };
}

export interface ScreeningAccount {
  version: number;
  /** Entries in force now. */
  blocked: number;
  added: bigint;
  removed: bigint;
}

export function decodeScreening(data: Uint8Array): ScreeningAccount {
  const r = new Reader(data);
  r.disc(DISC.screeningAccount);
  const version = r.u8();
  r.u8(); // bump
  return { version, blocked: r.u32(), added: r.u64(), removed: r.u64() };
}

export interface BlockedAddressAccount {
  address: Address;
  list: number;
  reference: Uint8Array;
  addedAt: bigint;
  addedBy: Address;
  rentPayer: Address;
  /** 0 = no removal announced; otherwise `unblock` works from this unix time. */
  unblockEta: bigint;
}

export function decodeBlockedAddress(data: Uint8Array): BlockedAddressAccount {
  const r = new Reader(data);
  r.disc(DISC.blockedAddressAccount);
  r.u8(); r.u8(); // version, bump
  const address = r.addr();
  const list = r.u8();
  const reference = r.bytes(32);
  const addedAt = r.i64();
  const addedBy = r.addr(), rentPayer = r.addr();
  return { address, list, reference, addedAt, addedBy, rentPayer, unblockEta: r.i64() };
}

/** The first 8 bytes of every screening record, and its size (getProgramAccounts filters). */
export const BLOCKED_ADDRESS_DISCRIMINATOR = Uint8Array.from(DISC.blockedAddressAccount);
export const BLOCKED_ADDRESS_LEN = 187;

/** Whether the bytes read at `blockedPda(address)` are a screening record (the address is blocked). */
export function isBlockedRecord(data: Uint8Array | undefined): boolean {
  if (!data || data.length < 8) return false;
  return DISC.blockedAddressAccount.every((x, i) => data[i] === x);
}
