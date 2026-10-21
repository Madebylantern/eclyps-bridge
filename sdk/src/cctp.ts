/**
 * Circle CCTP V2 on Solana: `deposit_for_burn_with_hook` builder and the Eclyps batch hook.
 * Layouts and addresses: ADR 0002 (circlefin/solana-cctp-contracts release-2026-06-18T210820).
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
import { assertField, BATCH_TREE_DEPTH } from "./merkle.js";

export const CCTP = {
  /** Same program ids on devnet and mainnet. */
  messageTransmitterV2: address("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC"),
  tokenMessengerMinterV2: address("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"),
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  systemProgram: address("11111111111111111111111111111111"),
  domains: { ethereum: 0, solana: 5 },
  /** Iris finality thresholds: 2000 = finalized ("standard", fee-free, exact mint). */
  finality: { fast: 1000, standard: 2000 },
} as const;

export const DEVNET = {
  usdcMint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  iris: "https://iris-api-sandbox.circle.com",
} as const;

export const SEPOLIA = {
  chainId: 11155111,
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
} as const;

/** sha256("global:deposit_for_burn_with_hook")[0..8] */
const DEPOSIT_FOR_BURN_WITH_HOOK = Uint8Array.from([111, 245, 62, 131, 204, 108, 223, 155]);

const utf8 = (s: string) => new TextEncoder().encode(s);

async function pda(program: Address, seeds: (string | Uint8Array)[]): Promise<Address> {
  const [a] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: seeds.map((s) => (typeof s === "string" ? utf8(s) : s)),
  });
  return a;
}

/** 0x-prefixed 20-byte EVM address -> 32 bytes (12 zero bytes + address). */
export function evmAddressToBytes32(evm: string): Uint8Array {
  const hex = evm.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`bad EVM address ${evm}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export interface BatchHook {
  /** USDC base units (6 decimals). */
  denomination: bigint;
  epochId: bigint;
  leafCount: number;
  root: bigint;
}

export const BATCH_HOOK_VERSION = 1;
export const BATCH_HOOK_LENGTH = 51;

/** Packed big-endian: version u8 | denomination u64 | epochId u64 | leafCount u16 | root bytes32. */
export function encodeBatchHook(h: BatchHook): Uint8Array {
  const maxLeaves = 2 ** BATCH_TREE_DEPTH;
  if (h.leafCount < 1 || h.leafCount > maxLeaves) throw new RangeError("leafCount out of range");
  if (h.denomination <= 0n || h.denomination >= 2n ** 64n) throw new RangeError("denomination");
  if (h.epochId < 0n || h.epochId >= 2n ** 64n) throw new RangeError("epochId");
  assertField(h.root);
  const out = new Uint8Array(BATCH_HOOK_LENGTH);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, BATCH_HOOK_VERSION);
  dv.setBigUint64(1, h.denomination);
  dv.setBigUint64(9, h.epochId);
  dv.setUint16(17, h.leafCount);
  for (let i = 0, r = h.root; i < 32; i++, r >>= 8n) out[50 - i] = Number(r & 0xffn);
  return out;
}

export function decodeBatchHook(b: Uint8Array): BatchHook {
  if (b.length !== BATCH_HOOK_LENGTH || b[0] !== BATCH_HOOK_VERSION) throw new Error("bad hook");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let root = 0n;
  for (let i = 19; i < 51; i++) root = (root << 8n) | BigInt(b[i]!);
  return {
    denomination: dv.getBigUint64(1),
    epochId: dv.getBigUint64(9),
    leafCount: dv.getUint16(17),
    root,
  };
}

export interface DepositForBurnWithHookArgs {
  owner: Address;
  eventRentPayer: Address;
  burnTokenAccount: Address;
  /** Fresh keypair address; must sign. */
  messageSentEventData: Address;
  usdcMint: Address;
  amount: bigint;
  destinationDomain: number;
  /** 32 bytes, e.g. evmAddressToBytes32(receiver). */
  mintRecipient: Uint8Array;
  destinationCaller: Uint8Array;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Uint8Array;
}

export function encodeDepositForBurnWithHookData(a: DepositForBurnWithHookArgs): Uint8Array {
  if (a.mintRecipient.length !== 32 || a.destinationCaller.length !== 32) throw new Error("bytes32");
  if (a.hookData.length === 0) throw new Error("hook data must be non-empty");
  const out = new Uint8Array(100 + a.hookData.length);
  const dv = new DataView(out.buffer);
  out.set(DEPOSIT_FOR_BURN_WITH_HOOK, 0);
  dv.setBigUint64(8, a.amount, true);
  dv.setUint32(16, a.destinationDomain, true);
  out.set(a.mintRecipient, 20);
  out.set(a.destinationCaller, 52);
  dv.setBigUint64(84, a.maxFee, true);
  dv.setUint32(92, a.minFinalityThreshold, true);
  dv.setUint32(96, a.hookData.length, true);
  out.set(a.hookData, 100);
  return out;
}

/** Builds TokenMessengerMinterV2.deposit_for_burn_with_hook (18-account form). */
export async function depositForBurnWithHookIx(a: DepositForBurnWithHookArgs): Promise<Instruction> {
  const tmm = CCTP.tokenMessengerMinterV2;
  const mt = CCTP.messageTransmitterV2;
  const enc = getAddressEncoder();
  const ro = (addr: Address) => ({ address: addr, role: AccountRole.READONLY });
  const w = (addr: Address) => ({ address: addr, role: AccountRole.WRITABLE });
  return {
    programAddress: tmm,
    accounts: [
      { address: a.owner, role: AccountRole.READONLY_SIGNER },
      { address: a.eventRentPayer, role: AccountRole.WRITABLE_SIGNER },
      ro(await pda(tmm, ["sender_authority"])),
      w(a.burnTokenAccount),
      ro(await pda(tmm, ["denylist_account", new Uint8Array(enc.encode(a.owner))])),
      w(await pda(mt, ["message_transmitter"])),
      ro(await pda(tmm, ["token_messenger"])),
      ro(await pda(tmm, ["remote_token_messenger", String(a.destinationDomain)])),
      ro(await pda(tmm, ["token_minter"])),
      w(await pda(tmm, ["local_token", new Uint8Array(enc.encode(a.usdcMint))])),
      w(a.usdcMint),
      { address: a.messageSentEventData, role: AccountRole.WRITABLE_SIGNER },
      ro(mt),
      ro(tmm),
      ro(CCTP.tokenProgram),
      ro(CCTP.systemProgram),
      ro(await pda(tmm, ["__event_authority"])),
      ro(tmm),
    ],
    data: encodeDepositForBurnWithHookData(a),
  };
}

// ---------- Exit (Ethereum -> Solana), ADR 0009 ----------

/** The exit hook: the batch hook's 51-byte layout with version 2. */
export interface ExitHook {
  /** USDC base units (6 decimals). */
  denomination: bigint;
  exitEpochId: bigint;
  /** Exits in the batch (1..=256). */
  count: number;
  /** Root of the exit tree (Poseidon, depth 8). */
  root: bigint;
}

export const EXIT_HOOK_VERSION = 2;

/** Packed big-endian: version 2 | denomination u64 | exitEpochId u64 | count u16 | root bytes32. */
export function encodeExitHook(h: ExitHook): Uint8Array {
  if (h.count < 1 || h.count > 2 ** BATCH_TREE_DEPTH) throw new RangeError("count out of range");
  if (h.denomination <= 0n || h.denomination >= 2n ** 64n) throw new RangeError("denomination");
  if (h.exitEpochId < 0n || h.exitEpochId >= 2n ** 64n) throw new RangeError("exitEpochId");
  assertField(h.root);
  const out = new Uint8Array(BATCH_HOOK_LENGTH);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, EXIT_HOOK_VERSION);
  dv.setBigUint64(1, h.denomination);
  dv.setBigUint64(9, h.exitEpochId);
  dv.setUint16(17, h.count);
  for (let i = 0, r = h.root; i < 32; i++, r >>= 8n) out[50 - i] = Number(r & 0xffn);
  return out;
}

export function decodeExitHook(b: Uint8Array): ExitHook {
  if (b.length !== BATCH_HOOK_LENGTH || b[0] !== EXIT_HOOK_VERSION) throw new Error("bad exit hook");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let root = 0n;
  for (let i = 19; i < 51; i++) root = (root << 8n) | BigInt(b[i]!);
  return { denomination: dv.getBigUint64(1), exitEpochId: dv.getBigUint64(9), count: dv.getUint16(17), root };
}

/**
 * Offsets in a CCTP V2 message (MessageV2 header + BurnMessageV2 body), all big-endian. Same as
 * the portal's CctpMessageV2.sol and the gateway's exit_message.rs.
 */
export const CCTP_MESSAGE = {
  version: 0,
  sourceDomain: 4,
  destinationDomain: 8,
  nonce: 12,
  sender: 44,
  recipient: 76,
  destinationCaller: 108,
  minFinality: 140,
  finalityExecuted: 144,
  bodyVersion: 148,
  burnToken: 152,
  mintRecipient: 184,
  amount: 216,
  messageSender: 248,
  maxFee: 280,
  feeExecuted: 312,
  expirationBlock: 344,
  hookData: 376,
} as const;

/** An exit message is exactly this long: 376 + the 51-byte hook. */
export const EXIT_MESSAGE_LENGTH = CCTP_MESSAGE.hookData + BATCH_HOOK_LENGTH;

export interface ExitMessage {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Uint8Array;
  sender: Uint8Array;
  recipient: Uint8Array;
  destinationCaller: Uint8Array;
  finalityExecuted: number;
  burnToken: Uint8Array;
  mintRecipient: Uint8Array;
  amount: bigint;
  messageSender: Uint8Array;
  feeExecuted: bigint;
  hook: ExitHook;
}

/** Reads an exit message as Iris returns it (no validation beyond the layout; the gateway checks). */
export function decodeExitMessage(m: Uint8Array): ExitMessage {
  if (m.length !== EXIT_MESSAGE_LENGTH) throw new Error(`exit message must be ${EXIT_MESSAGE_LENGTH} bytes`);
  const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
  const b32 = (o: number) => m.slice(o, o + 32);
  const u256 = (o: number) => m.slice(o, o + 32).reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
  const O = CCTP_MESSAGE;
  return {
    sourceDomain: dv.getUint32(O.sourceDomain),
    destinationDomain: dv.getUint32(O.destinationDomain),
    nonce: b32(O.nonce),
    sender: b32(O.sender),
    recipient: b32(O.recipient),
    destinationCaller: b32(O.destinationCaller),
    finalityExecuted: dv.getUint32(O.finalityExecuted),
    burnToken: b32(O.burnToken),
    mintRecipient: b32(O.mintRecipient),
    amount: u256(O.amount),
    messageSender: b32(O.messageSender),
    feeExecuted: u256(O.feeExecuted),
    hook: decodeExitHook(m.subarray(O.hookData)),
  };
}

/**
 * What the portal's `depositForBurnWithHook` passes to Ethereum's TokenMessengerV2, which builds the
 * exit message from it. EVM addresses are 0x strings; Solana accounts 32 bytes.
 */
export interface ExitBurn {
  /** TokenMessengerV2 on Ethereum: the message's `sender`. */
  tokenMessenger: string;
  burnToken: string;
  destinationCaller: Uint8Array;
  mintRecipient: Uint8Array;
  amount: bigint;
  /** The portal: `messageSender` in the body. */
  messageSender: string;
  minFinality: number;
  maxFee: bigint;
  hook: Uint8Array;
  /** Filled by Iris; zero in Ethereum's MessageSent. */
  nonce?: Uint8Array;
  finalityExecuted?: number;
}

/**
 * The exit message as Ethereum's TokenMessengerV2 emits it (MessageV2 + BurnMessageV2, big-endian,
 * source domain 0, destination domain 5, recipient Solana's TokenMessengerMinterV2), with Iris's
 * nonce and executed finality when given. The local stack has no CCTP on its L1: its "Iris" builds
 * the message from the burn the portal made (finisher/src/local-iris.ts). Checked against the
 * bytes Circle's contracts emitted on a Sepolia fork.
 */
export function encodeExitMessage(b: ExitBurn): Uint8Array {
  if (b.hook.length !== BATCH_HOOK_LENGTH) throw new Error("exit hook must be 51 bytes");
  const m = new Uint8Array(EXIT_MESSAGE_LENGTH);
  const dv = new DataView(m.buffer);
  const O = CCTP_MESSAGE;
  const u256 = (o: number, x: bigint) => {
    if (x < 0n || x >= 1n << 256n) throw new RangeError("uint256");
    for (let i = 31; i >= 0; i--, x >>= 8n) m[o + i] = Number(x & 0xffn);
  };
  dv.setUint32(O.version, 1);
  dv.setUint32(O.sourceDomain, CCTP.domains.ethereum);
  dv.setUint32(O.destinationDomain, CCTP.domains.solana);
  if (b.nonce) m.set(b.nonce, O.nonce);
  m.set(evmAddressToBytes32(b.tokenMessenger), O.sender);
  m.set(getAddressEncoder().encode(CCTP.tokenMessengerMinterV2), O.recipient);
  m.set(b.destinationCaller, O.destinationCaller);
  dv.setUint32(O.minFinality, b.minFinality);
  dv.setUint32(O.finalityExecuted, b.finalityExecuted ?? 0);
  dv.setUint32(O.bodyVersion, 1);
  m.set(evmAddressToBytes32(b.burnToken), O.burnToken);
  m.set(b.mintRecipient, O.mintRecipient);
  u256(O.amount, b.amount);
  m.set(evmAddressToBytes32(b.messageSender), O.messageSender);
  u256(O.maxFee, b.maxFee);
  m.set(b.hook, O.hookData);
  return m;
}

/**
 * The accounts MessageTransmitterV2.receive_message and TokenMessengerMinterV2
 * handle_receive_finalized_message read for a burn from Ethereum (domain 0) of `burnToken`
 * (32 bytes, e.g. Ethereum USDC), paid in `usdcMint`. `feeRecipient` is the TokenMessenger
 * state's `fee_recipient` (see `decodeTokenMessengerFeeRecipient`); its USDC account is passed
 * even though an exit pays no fee.
 */
export async function cctpReceiveAccounts(a: { usdcMint: Address; burnToken: Uint8Array; feeRecipient: Address; nonce?: Uint8Array }) {
  const tmm = CCTP.tokenMessengerMinterV2;
  const mt = CCTP.messageTransmitterV2;
  const enc = getAddressEncoder();
  const mint = new Uint8Array(enc.encode(a.usdcMint));
  const ata = (await getProgramDerivedAddress({
    programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [new Uint8Array(enc.encode(a.feeRecipient)), new Uint8Array(enc.encode(CCTP.tokenProgram)), mint],
  }))[0];
  return {
    messageTransmitter: await pda(mt, ["message_transmitter"]),
    usedNonce: a.nonce ? await pda(mt, ["used_nonce", a.nonce]) : undefined,
    authorityPda: await pda(mt, ["message_transmitter_authority", new Uint8Array(enc.encode(tmm))]),
    mtEventAuthority: await pda(mt, ["__event_authority"]),
    tokenMessenger: await pda(tmm, ["token_messenger"]),
    remoteTokenMessenger: await pda(tmm, ["remote_token_messenger", String(CCTP.domains.ethereum)]),
    tokenMinter: await pda(tmm, ["token_minter"]),
    localToken: await pda(tmm, ["local_token", mint]),
    tokenPair: await pda(tmm, ["token_pair", String(CCTP.domains.ethereum), a.burnToken]),
    feeRecipientTokenAccount: ata,
    custody: await pda(tmm, ["custody", mint]),
    tmmEventAuthority: await pda(tmm, ["__event_authority"]),
  };
}

/**
 * `fee_recipient` of TokenMessengerMinterV2's TokenMessenger state account (PDA "token_messenger"):
 * disc 8 | denylister 32 | owner 32 | pending_owner 32 | message_body_version u32 | authority_bump u8 |
 * fee_recipient 32 | ...
 */
export function decodeTokenMessengerFeeRecipient(data: Uint8Array): Address {
  if (data.length < 141) throw new Error("not a TokenMessenger account");
  return getAddressDecoder().decode(data.subarray(109, 141));
}

/**
 * MessageSent account (MT V2): 8-byte discriminator, rent_payer (32), created_at (i64),
 * then a Borsh `Vec<u8>` holding the message. Nonce/finality/fee fields are zero here;
 * Iris fills them in, so always relay Iris's copy (ADR 0002).
 */
export function messageFromMessageSentAccount(data: Uint8Array): Uint8Array {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = dv.getUint32(48, true);
  return data.subarray(52, 52 + len);
}
