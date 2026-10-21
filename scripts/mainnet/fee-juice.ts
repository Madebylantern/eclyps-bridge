/**
 * Fee Juice status and refill plan (ADR 0018). Read-only: it sends nothing and spends nothing.
 *
 *   pnpm exec tsx mainnet/fee-juice.ts [deployments/mainnet.json] [--account <aztec address>]...
 *
 * Prints the Fee Juice of the Eclyps FPC (`fees.eclypsFpc.address`) and of each `--account` (the
 * finisher, the admin), the current minimum fee, what one transaction of each kind costs at that
 * fee, and, below a low mark (`fees.fpcFeeJuice`, `fees.operatorFeeJuice`), how much to bridge.
 * Bridging is an L1 transaction through the FeeJuicePortal: the owner sends it.
 */
import { readFileSync } from "node:fs";
import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { type FeesConfig, feeJuiceFor, refillAmount } from "@eclyps/sdk";

const args = process.argv.slice(2);
const file = args[0] && !args[0].startsWith("--") ? args[0] : new URL("../../deployments/mainnet.json", import.meta.url).pathname;
const accounts = args.flatMap((a, i) => (a === "--account" && args[i + 1] ? [args[i + 1]!] : []));
const dep = JSON.parse(readFileSync(file, "utf8")) as { aztec: { node: string }; fees?: FeesConfig };
if (!dep.aztec.node) throw new Error(`${file}: aztec.node is empty (no Aztec node to read from yet)`);

const node = createAztecNodeClient(dep.aztec.node, { maxBatchSize: 3 });
const fees = await node.getCurrentMinFees();
const perMana = fees.feePerL2Gas;
const fj = (b: bigint) => (Number(b / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 3 });

// Measured on Aztec testnet (rc.3; open question 3, ADR 0018), in mana (L2 gas).
const MANA: Record<string, bigint> = {
  claim: 721_166n,
  exit_to_ethereum: 696_104n,
  "exit (Solana), typical": 1_093_713n,
  "exit (Solana), worst": 3_000_000n,
  register_batch: 1_348_566n,
  close_exit_epoch: 3_175_410n,
};
console.log(`min fee: ${perMana} per mana (${fj(perMana * 1_000_000n)} Fee Juice per million mana)`);
for (const [k, m] of Object.entries(MANA)) console.log(`  ${k.padEnd(24)} ${m.toLocaleString("en-US").padStart(10)} mana ≈ ${fj(feeJuiceFor(m, perMana))} Fee Juice`);

async function show(label: string, addr: string, policy?: { low: number; target: number }) {
  const balance = await getFeeJuiceBalance(AztecAddress.fromStringUnsafe(addr), node);
  const refill = policy ? refillAmount(balance, policy) : 0n;
  console.log(`${label} ${addr}: ${fj(balance)} Fee Juice${refill > 0n ? ` · LOW: bridge ${fj(refill)}` : ""}`);
}

const fpc = dep.fees?.eclypsFpc?.address;
if (fpc) await show("Eclyps FPC", fpc, dep.fees?.fpcFeeJuice);
else console.log("Eclyps FPC: not deployed (fees.eclypsFpc.address is empty)");
for (const a of accounts) await show("account", a, dep.fees?.operatorFeeJuice);
