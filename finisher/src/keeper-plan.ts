/**
 * The reference keeper's rules (ADR 0017, amended): which front requests it accepts, when it pays
 * a destination from the liquidity pool, and which fronts it still has to be repaid for. No I/O:
 * every function is pure, so it is unit-tested (test/keeper.test.ts). The keeper itself is
 * src/keeper.ts.
 *
 * The keeper is the only key that may spend the pool (`front_exit_from_pool`), because Solana
 * cannot see Aztec before the proof: it fronts an exit only after checking, on Aztec, that the
 * exit's leaf is in the claim contract's public exit leaves, in a block already checkpointed on L1
 * (a reorg after that point needs a failed proof window, the risk the pool carries).
 */

/** BN254 scalar field modulus: an exit secret must be below it. */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface FrontRequest {
  /** USDC base units, one of the deployment's denominations. */
  denomination: string;
  denominationIndex: number;
  exitEpochId: bigint;
  /** The leaf's index in its exit epoch (public: the claim contract's exit leaves). */
  leafIndex: number;
  /** The Solana address committed in the exit. */
  destination: string;
  /** The exit secret: with the destination it opens the leaf (the solver learns it early). */
  secret: bigint;
  /** The Aztec transaction that burned the note and appended the leaf. */
  aztecTx: string;
}

/** Reads a POST /front body; returns the reason when it is not a well-formed request. */
export function parseFrontRequest(body: unknown, denominations: string[]): { ok: FrontRequest } | { error: string } {
  if (!body || typeof body !== "object") return { error: "expected a JSON object" };
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
  const denomination = str("denomination");
  const denominationIndex = denomination === undefined ? -1 : denominations.indexOf(denomination);
  if (denomination === undefined || denominationIndex < 0 || denomination === "0") return { error: "unknown denomination" };
  const epoch = str("exitEpochId");
  if (!epoch || !/^\d{1,19}$/.test(epoch)) return { error: "exitEpochId must be a decimal integer" };
  const leafIndex = b.leafIndex;
  if (typeof leafIndex !== "number" || !Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex > 255) return { error: "leafIndex must be 0..255" };
  const destination = str("destination");
  if (!destination || !BASE58.test(destination)) return { error: "destination must be a Solana address" };
  const secretHex = str("secret");
  if (!secretHex || !/^0x[0-9a-fA-F]{1,64}$/.test(secretHex)) return { error: "secret must be 0x-prefixed hex" };
  const secret = BigInt(secretHex);
  if (secret === 0n || secret >= BN254_R) return { error: "secret is not a field element" };
  const aztecTx = str("aztecTx");
  if (!aztecTx || !/^0x[0-9a-fA-F]{64}$/.test(aztecTx)) return { error: "aztecTx must be a 32-byte hex hash" };
  return { ok: { denomination, denominationIndex, exitEpochId: BigInt(epoch), leafIndex, destination, secret, aztecTx: aztecTx.toLowerCase() } };
}

/** What the keeper found about a request, on Aztec and Solana. */
export interface FrontFacts {
  /** The Aztec transaction succeeded, in this block. */
  txOk: boolean;
  txBlock?: number;
  /** The latest Aztec block checkpointed on L1. */
  checkpointed: number;
  /** The claim contract's exit leaf at (exitEpochId, leafIndex), if any (read at the latest block). */
  leafOnAztec?: bigint;
  /** exitCommitment(destination, secret): what the leaf must be. */
  leaf: bigint;
  /** The ExitBatch of (denomination, exitEpochId) exists on Solana: the slow path is open. */
  arrived: boolean;
  /** A Front record exists for this leaf on Solana. */
  fronted: boolean;
  /** What the pool can advance now (`poolCapacity`), and what this front would advance. */
  capacity: bigint;
  advanced: bigint;
}

export type FrontDecision =
  | { action: "front" }
  /** Not yet: ask again later (the app polls). */
  | { action: "wait"; reason: string }
  | { action: "refuse"; reason: string };

/** Whether to front now. Every check the keeper owes the pool's providers is here. */
export function decideFront(f: FrontFacts): FrontDecision {
  if (f.fronted) return { action: "refuse", reason: "already fronted" };
  if (f.arrived) return { action: "refuse", reason: "the exit batch is on Solana: claim it" };
  if (!f.txOk || f.txBlock === undefined) return { action: "wait", reason: "the exit is not mined on Aztec yet" };
  if (f.leafOnAztec === undefined || f.leafOnAztec === 0n) return { action: "wait", reason: "the exit leaf is not readable yet" };
  if (f.leafOnAztec !== f.leaf) return { action: "refuse", reason: "the leaf at that index is another exit" };
  if (f.txBlock > f.checkpointed) return { action: "wait", reason: `waiting for Aztec block ${f.txBlock} to be checkpointed on L1` };
  if (f.advanced > f.capacity) return { action: "refuse", reason: "the pool cannot cover this note now" };
  return { action: "front" };
}

// ---------- the keeper's record ----------

export const KEEPER_STATE_VERSION = 1;

export interface FrontRecord {
  denomination: string;
  index: number;
  exitEpochId: string;
  leafIndex: number;
  destination: string;
  /** Hex. The secret becomes public at the claim anyway; keep the file private until then. */
  secret: string;
  leaf: string;
  aztecTx: string;
  frontSig?: string;
  frontedAt?: number;
  advanced?: string;
  /** claim_exit that repaid the pool (by this keeper or anyone). */
  repaid?: boolean;
  claimSig?: string;
  failures?: number;
  retryAt?: number;
  lastError?: string;
}

export interface KeeperState {
  version: number;
  /** The deployment: gateway config account. */
  config: string;
  fronts: Record<string, FrontRecord>;
}

export const emptyKeeperState = (config: string): KeeperState => ({ version: KEEPER_STATE_VERSION, config, fronts: {} });
export const keeperStateMatches = (s: Partial<KeeperState>, config: string) => s.version === KEEPER_STATE_VERSION && s.config === config;

/** Fronts this keeper made and has not seen repaid. */
export const frontsToRepay = (s: KeeperState): FrontRecord[] => Object.values(s.fronts).filter((f) => f.frontSig && !f.repaid);

export interface KeeperSummary {
  fronted: number;
  repaid: number;
  outstanding: bigint;
}

export function keeperSummary(s: KeeperState): KeeperSummary {
  let fronted = 0, repaid = 0, outstanding = 0n;
  for (const f of Object.values(s.fronts)) {
    if (!f.frontSig) continue;
    fronted++;
    if (f.repaid) repaid++;
    else outstanding += BigInt(f.advanced ?? "0");
  }
  return { fronted, repaid, outstanding };
}

/** The quote the keeper publishes (GET /quote): per denomination, its fee and whether it fits. */
export function quoteLines(denominations: string[], feeOf: (d: bigint) => bigint, capacity: bigint): { denomination: string; fee: string; advanced: string; fits: boolean }[] {
  return denominations
    .filter((d) => d !== "0")
    .map((d) => {
      const fee = feeOf(BigInt(d));
      const advanced = BigInt(d) - fee;
      return { denomination: d, fee: fee.toString(), advanced: advanced.toString(), fits: advanced <= capacity };
    });
}
