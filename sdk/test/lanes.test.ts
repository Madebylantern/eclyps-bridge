/**
 * V2 lanes (ADR 0015 Cross now, ADR 0017 fronted exits and the liquidity pool) against the
 * program: the instructions in fixtures/lanes.json succeeded in the gateway's LiteSVM tests
 * (programs/gateway/tests/lanes.rs lanes_fixture_for_the_sdk), so the SDK's builders, PDAs and
 * decoders must reproduce them exactly.
 */
import { AccountRole, address, type Instruction } from "@solana/kit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exitClaimInputs, exitCommitment } from "../src/exit.js";
import { root } from "../src/merkle.js";
import { findCommitment } from "../src/recovery.js";
import {
  claimExitIx,
  crossingPoolPda,
  crossNowQuote,
  decodeExpressEpoch,
  decodeFront,
  decodeLanes,
  decodeLiquidity,
  decodeLpPosition,
  DEFAULT_ADDRESS,
  depositExpressIx,
  encodeLaneParams,
  expressAsEpoch,
  EXPRESS_EPOCH_BIT,
  expressPda,
  frontExitFromPoolIx,
  frontExitIx,
  frontPda,
  GATEWAY_PROGRAM_ID,
  isExpressEpochId,
  LANE_PARAMS_LEN,
  lanesPda,
  liquidityPda,
  liquidityVaultPda,
  lpAmountFor,
  lpDepositIx,
  lpPositionPda,
  lpSharesFor,
  lpWithdrawIx,
  nextExpressId,
  poolCapacity,
  poolFrontQuote,
  sendExpressBatchIx,
} from "../src/gateway.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/lanes.json", import.meta.url), "utf8"));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
type FxAccount = { address: string; writable: boolean; signer: boolean };
const role = (a: FxAccount) =>
  a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
const shape = (ix: Instruction) => ({
  program: ix.programAddress,
  accounts: ix.accounts!.map((a) => ({ address: a.address, role: a.role })),
  data: Buffer.from(ix.data!).toString("base64"),
});
const expected = (x: { accounts: FxAccount[]; data: string }) => ({
  program: GATEWAY_PROGRAM_ID,
  accounts: x.accounts.map((a) => ({ address: a.address, role: role(a) })),
  data: x.data,
});
const mint = address(fx.usdcMint);
const s = fx.signers;
const t = fx.tokenAccounts;
const leaves: bigint[] = fx.exits.map((e: { leaf: string }) => BigInt(e.leaf));

describe("V2 PDAs", () => {
  it("derive the program's addresses", async () => {
    expect(await lanesPda()).toBe(fx.accounts.lanes.address);
    expect(await crossingPoolPda()).toBe(fx.accounts.crossingPool);
    expect(await liquidityPda()).toBe(fx.accounts.liquidity.address);
    expect(await liquidityVaultPda()).toBe(fx.accounts.liquidityVault);
    expect(await expressPda(1, EXPRESS_EPOCH_BIT)).toBe(fx.accounts.express.address);
    expect(await frontPda(leaves[0]!)).toBe(fx.accounts.front.address);
    expect(await frontPda(leaves[1]!)).toBe(fx.accounts.poolFront.address);
    expect(await lpPositionPda(address(s.lp))).toBe(fx.accounts.lpPosition.address);
  });
});

describe("Cross now (ADR 0015)", () => {
  it("builds the deposit_express that crossed alone, paid by the pool", async () => {
    const d = fx.depositExpress;
    const ix = await depositExpressIx({
      payer: address(s.user), authority: address(s.user), source: address(t.user), usdcMint: mint,
      denominationIndex: d.denominationIndex, expressId: BigInt(d.expressId), commitment: hexBytes(d.commitment), maxExpressFee: BigInt(d.maxExpressFee),
    });
    expect(shape(ix)).toEqual(expected(d.ix));
  });

  it("builds the send_express_batch that burned it", async () => {
    const ix = await sendExpressBatchIx({
      payer: address(s.finisher), usdcMint: mint, messageSentEventData: address(s.event), denominationIndex: 1,
      expressId: EXPRESS_EPOCH_BIT, finisherUsdc: address(t.finisher), treasury: address(fx.treasury),
    });
    expect(shape(ix)).toEqual(expected(fx.sendExpressBatch));
  });

  it("decodes Lanes and the express epoch", () => {
    const l = decodeLanes(b64(fx.accounts.lanes.data));
    const p = fx.laneParams;
    expect(l.params).toEqual({
      expressFee: BigInt(p.expressFee), frontFeeCapBps: p.frontFeeCapBps, poolFeeBps: p.poolFeeBps,
      poolMaxOutstanding: BigInt(p.poolMaxOutstanding), keeper: p.keeper,
    });
    expect(l.version).toBe(1);
    expect(l.crossingPool).toBe(fx.accounts.crossingPool);
    expect(l.expressNext).toEqual([0n, 1n, 0n, 0n]);
    expect(l.poolPaid).toBe(BigInt(p.expressFee));
    expect(l.pending).toBeUndefined();
    expect(nextExpressId(l, 1)).toBe(EXPRESS_EPOCH_BIT | 1n);
    expect(encodeLaneParams(l.params).length).toBe(LANE_PARAMS_LEN);
    const x = decodeExpressEpoch(b64(fx.accounts.express.data));
    expect(x.status).toBe("Sent");
    expect(x.expressId).toBe(EXPRESS_EPOCH_BIT);
    expect(isExpressEpochId(x.expressId)).toBe(true);
    expect(isExpressEpochId(5n)).toBe(false);
    expect(x.leaf).toBe(BigInt(fx.depositExpress.commitment));
    expect(x.depositor).toBe(s.user);
    expect(x.paidByPool).toBe(true);
    expect(x.expressFee).toBe(BigInt(p.expressFee));
    expect(x.fee).toBe(5_000_000n); // 0.5 % of $1,000
    expect(x.finisherFee).toBe(3_000_000n);
    // Seen as a batch of one: its leaf is found like any deposit's, and its fee rate is the note's.
    const e = expressAsEpoch(x);
    expect(e).toMatchObject({ epochId: EXPRESS_EPOCH_BIT, status: "Sent", leaves: [x.leaf], feeBps: 50, finisherBps: 30, depositors: [s.user] });
    expect(findCommitment([e], x.leaf)).toEqual({ denominationIndex: 1, epochId: EXPRESS_EPOCH_BIT, leafIndex: 0 });
    expect(root([x.leaf])).toBe(x.root);
  });

  it("quotes the price: on us while the pool holds one fee, then the user pays it", () => {
    const base = { expressFee: 1_200_000n, denomination: 100_000_000n, feeBps: 50 };
    expect(crossNowQuote({ ...base, poolBalance: 1_200_000n })).toEqual({ expressFee: 1_200_000n, onUs: true, userPays: 100_500_000n });
    expect(crossNowQuote({ ...base, poolBalance: 1_199_999n })).toEqual({ expressFee: 1_200_000n, onUs: false, userPays: 101_700_000n });
    expect(crossNowQuote({ ...base, expressFee: 0n, poolBalance: 0n }).onUs).toBe(false);
  });
});

describe("fronted exits and the pool (ADR 0017)", () => {
  it("builds the front_exit and front_exit_from_pool that paid early", async () => {
    const e0 = fx.exits[0], e1 = fx.exits[1];
    const solver = await frontExitIx({
      solver: address(s.solver), solverUsdc: address(t.solver), payeeUsdc: address(t.solver), usdcMint: mint,
      denominationIndex: 1, exitEpochId: BigInt(fx.frontExit.exitEpochId), destination: address(e0.destination), secret: BigInt(e0.secret), fee: BigInt(fx.frontExit.fee),
    });
    expect(shape(solver)).toEqual(expected(fx.frontExit.ix));
    const pool = await frontExitFromPoolIx({
      keeper: address(s.keeper), usdcMint: mint, denominationIndex: 1, exitEpochId: 3n, destination: address(e1.destination), secret: BigInt(e1.secret),
    });
    expect(shape(pool)).toEqual(expected(fx.frontExitFromPool.ix));
  });

  it("builds the claim_exit that repaid the solver", async () => {
    const e0 = fx.exits[0];
    for (const e of fx.exits) expect(exitCommitment(address(e.destination), BigInt(e.secret))).toBe(BigInt(e.leaf));
    const { path } = exitClaimInputs(leaves, address(e0.destination), BigInt(e0.secret));
    expect(path.map((x) => BigInt(x))).toEqual(fx.claimFronted.path.map((x: string) => BigInt(x)));
    const front = decodeFront(b64(fx.accounts.front.data));
    const ix = await claimExitIx({
      payer: address(s.solver), usdcMint: mint, denominationIndex: 1, exitEpochId: 3n, leafIndex: 0, path,
      destination: address(e0.destination), secret: BigInt(e0.secret), front: { payee: front.payee, rentPayer: front.rentPayer },
    });
    expect(shape(ix)).toEqual(expected(fx.claimFronted.ix));
  });

  it("decodes the Front records", () => {
    const f = decodeFront(b64(fx.accounts.front.data));
    expect(f).toMatchObject({ leaf: leaves[0], denominationIndex: 1, denomination: 1_000_000_000n, exitEpochId: 3n, fee: 2_000_000n, advanced: 998_000_000n, payee: t.solver, rentPayer: s.solver, fromPool: false, writtenOff: false });
    const p = decodeFront(b64(fx.accounts.poolFront.data));
    expect(p).toMatchObject({ leaf: leaves[1], fee: 1_000_000n, advanced: 999_000_000n, payee: fx.accounts.liquidityVault, rentPayer: s.keeper, fromPool: true });
  });

  it("builds the LP deposit and withdrawal, and decodes the pool", async () => {
    const dep = await lpDepositIx({ owner: address(s.lp), source: address(t.lp), usdcMint: mint, amount: BigInt(fx.lpDeposit.amount) });
    expect(shape(dep)).toEqual(expected(fx.lpDeposit.ix));
    const wd = await lpWithdrawIx({ owner: address(s.lp), destination: address(t.lp), usdcMint: mint, shares: BigInt(fx.lpWithdraw.shares) });
    expect(shape(wd)).toEqual(expected(fx.lpWithdraw.ix));
    const l = decodeLiquidity(b64(fx.accounts.liquidity.data));
    expect(l.vault).toBe(fx.accounts.liquidityVault);
    expect(l.liquid).toBe(BigInt(fx.accounts.liquidity.liquid));
    expect(l.outstanding).toBe(0n);
    expect(l.totalShares).toBe(BigInt(fx.accounts.liquidity.totalShares));
    expect(l.feesEarned).toBe(1_000_000n); // the pool front's fee, realized at repayment
    expect(l.fronts).toBe(1n);
    const pos = decodeLpPosition(b64(fx.accounts.lpPosition.data));
    expect(pos).toEqual({ owner: s.lp, shares: BigInt(fx.accounts.lpPosition.shares) });
  });

  it("prices shares as the program does and offers Fast only within capacity", () => {
    const l = { liquid: 3_000_000_000n, outstanding: 0n, totalShares: 3_000_000_000n };
    expect(lpSharesFor(l, 1_000_000_000n)).toBe(1_000_000_000n);
    const grown = { liquid: 3_001_000_000n, outstanding: 0n, totalShares: 3_000_000_000n };
    expect(lpAmountFor(grown, 1_000_000_000n)).toBe(1_000_333_222n);
    expect(lpSharesFor(grown, 1_000_333_222n)).toBeLessThanOrEqual(1_000_000_000n);
    const p = { poolFeeBps: 10, poolMaxOutstanding: 10_000_000_000n, keeper: address(s.keeper) };
    expect(poolCapacity({ liquid: 5_000_000_000n, outstanding: 0n }, p)).toBe(5_000_000_000n);
    expect(poolCapacity({ liquid: 5_000_000_000n, outstanding: 9_500_000_000n }, p)).toBe(500_000_000n);
    expect(poolCapacity({ liquid: 5_000_000_000n, outstanding: 0n }, { ...p, keeper: DEFAULT_ADDRESS })).toBe(0n);
    expect(poolFrontQuote(1_000_000_000n, { liquid: 999_000_000n, outstanding: 0n }, p)).toEqual({ fee: 1_000_000n, advanced: 999_000_000n, fits: true });
    expect(poolFrontQuote(1_000_000_000n, { liquid: 998_999_999n, outstanding: 0n }, p).fits).toBe(false);
  });
});
