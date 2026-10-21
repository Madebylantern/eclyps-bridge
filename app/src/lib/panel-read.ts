/**
 * Reads for the control panel (panel.ts): balances on Solana, Ethereum and Aztec, and the bridge's
 * own accounts. Every read stands alone, so one slow or failing chain never blanks the others.
 */
import { type Address, address } from "@solana/kit";
import { createPublicClient, http, parseAbi } from "viem";
import type { Deployment } from "./deployment";
import { type Chain, l1Usdc, type PanelDeployment, type Wallet, walletsOf } from "./panel";
import { readConfig, rpcFor } from "./solana";

export type Read = { value: bigint } | { error: string };

const settle = async (p: Promise<bigint>): Promise<Read> => {
  try {
    return { value: await p };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** `total_supply` in the token's storage layout (aztec/artifacts/token_contract-Token.json). */
const TOKEN_TOTAL_SUPPLY_SLOT = 8n;

async function aztecNode(dep: Deployment) {
  const [{ createAztecNodeClient }, { getFeeJuiceBalance }, { AztecAddress }, { Fr }] = await Promise.all([
    import("@aztec-labs/aztec.js/node"),
    import("@aztec-labs/aztec.js/utils"),
    import("@aztec-labs/aztec.js/addresses"),
    import("@aztec-labs/aztec.js/fields"),
  ]);
  const node = createAztecNodeClient(dep.aztec.node, { maxBatchSize: 3 } as never);
  return {
    feeJuice: (a: string) => getFeeJuiceBalance(AztecAddress.fromStringUnsafe(a), node),
    totalSupply: async (token: string) => (await node.getPublicStorageAt("latest", AztecAddress.fromStringUnsafe(token), new Fr(TOKEN_TOTAL_SUPPLY_SLOT))).toBigInt(),
  };
}

export interface PanelState {
  wallets: (Wallet & { balance: Read })[];
  bridge: {
    /** USDC by place; each a read of its own. */
    escrow: Read; feeVault: Read; treasury: Read; exitCustody: Read; portal?: Read; aztecSupply?: Read;
    netDeposits?: bigint; depositCap?: bigint; paused?: boolean;
  };
  at: number;
}

export async function readPanel(dep: PanelDeployment): Promise<PanelState> {
  const rpc = rpcFor(dep);
  const l1 = createPublicClient({ transport: http(dep.l1.rpc) });
  const cfg = await readConfig(dep).catch(() => undefined);
  const wallets = walletsOf(dep, cfg ? { admin: cfg.admin, guardian: cfg.guardian } : undefined);
  const az = dep.aztec.node ? aztecNode(dep) : undefined;
  const token = async (a: Address) => BigInt((await rpc.getTokenAccountBalance(a).send()).value.amount);
  const fromConfig = (pick: (c: NonNullable<typeof cfg>) => Address) =>
    settle(cfg ? token(pick(cfg)) : Promise.reject(new Error("the gateway config could not be read")));
  const byChain: Record<Chain, (a: string) => Promise<bigint>> = {
    solana: async (a) => BigInt((await rpc.getBalance(address(a)).send()).value),
    ethereum: (a) => l1.getBalance({ address: a as `0x${string}` }),
    aztec: async (a) => (await az!).feeJuice(a),
  };
  const usdc = l1Usdc(dep.l1.chainId);
  const [balances, escrow, feeVault, treasury, exitCustody, portal, aztecSupply] = await Promise.all([
    Promise.all(wallets.map((w) => settle(byChain[w.chain](w.address)))),
    fromConfig((c) => c.escrow),
    fromConfig((c) => c.feeVault),
    fromConfig((c) => c.params.treasury),
    fromConfig((c) => c.exitCustody),
    usdc && dep.l1.portal ? settle(l1.readContract({ address: usdc, abi: ERC20, functionName: "balanceOf", args: [dep.l1.portal as `0x${string}`] })) : undefined,
    az && dep.aztec.token ? settle(az.then((n) => n.totalSupply(dep.aztec.token))) : undefined,
  ]);
  return {
    wallets: wallets.map((w, i) => ({ ...w, balance: balances[i]! })),
    bridge: {
      escrow, feeVault, treasury, exitCustody, portal, aztecSupply,
      netDeposits: cfg?.netDeposits, depositCap: cfg?.params.depositCap, paused: cfg?.pausedDeposits,
    },
    at: Date.now(),
  };
}
