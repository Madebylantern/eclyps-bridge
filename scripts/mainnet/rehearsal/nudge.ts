/**
 * Rehearsal only: the local Aztec network builds blocks only when it has transactions, and its
 * anvil mines only on transactions, so an L1→L2 message (a Fee Juice bridge, the replayed batch
 * message) would wait forever. Every 15 s this mines an L1 block on the sandbox's anvil and sends
 * a throwaway L2 transaction from the sandbox's prefunded test account (no proofs). Local only.
 */
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { EclypsMinterContract } from "../../../aztec/artifacts/EclypsMinter.js";

const AZTEC = "http://127.0.0.1:8080", L1 = "http://127.0.0.1:8545";
const node = createAztecNodeClient(AZTEC);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: false } });
const [acc0] = await getInitialTestAccountsData();
const me = await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
const mine = () => fetch(L1, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_mine", params: [] }) });
for (;;) {
  try {
    await mine();
    await EclypsMinterContract.deploy(wallet, me.address).send({ from: me.address });
    console.log(`nudged at L2 block ${await node.getBlockNumber()}`);
  } catch (e) {
    console.log(`nudge failed: ${String(e).slice(0, 200)}`);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
