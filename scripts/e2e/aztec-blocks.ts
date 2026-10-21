/**
 * The local Aztec network builds blocks only when there are transactions. This sends `count`
 * throwaway transactions (small contract deploys) (one block each, from the prefunded test account), so epochs end and get
 * proven while a demo waits on an L2->L1 message. Local only.
 *   pnpm exec tsx e2e/aztec-blocks.ts [count]
 */
import { readFileSync } from "node:fs";
import { getInitialTestAccountsData } from "@aztec-labs/accounts/testing";
import { createAztecNodeClient, waitForNode } from "@aztec-labs/aztec.js/node";
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded";
import { EclypsMinterContract } from "../../aztec/artifacts/EclypsMinter.js";

const dep = JSON.parse(readFileSync(new URL("./.local/deployment.json", import.meta.url), "utf8"));
const node = createAztecNodeClient(dep.aztec.node);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, { pxe: { proverEnabled: false } });
const [acc0] = await getInitialTestAccountsData();
const me = await wallet.createSchnorrInitializerlessAccount(acc0!.secret, acc0!.salt, acc0!.signingKey);
for (let i = 0; i < Number(process.argv[2] ?? 2); i++) await EclypsMinterContract.deploy(wallet, me.address).send({ from: me.address });
process.exit(0);
