/**
 * Prints the Aztec testnet facts the testnet run depends on: node version, L1 contracts (registry,
 * inbox), rollup version, and whether the SponsoredFPC (fee sponsor, zero salt) exists and is funded.
 *   pnpm exec tsx testnet/aztec-info.ts   [AZTEC_NODE_URL=…]
 */
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts";
import { Fr } from "@aztec-labs/aztec.js/fields";
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node";
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils";
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC";

const url = process.env.AZTEC_NODE_URL ?? "https://aztec-testnet.drpc.org";
const node = createAztecNodeClient(url);
const info = await node.getNodeInfo();
const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(0n) });
const onChain = await node.getContract(fpc.address);
console.log(JSON.stringify({
  url,
  nodeVersion: info.nodeVersion,
  l1ChainId: info.l1ChainId,
  rollupVersion: info.rollupVersion,
  registry: info.l1ContractAddresses.registryAddress.toString(),
  inbox: info.l1ContractAddresses.inboxAddress.toString(),
  blockNumber: await node.getBlockNumber(),
  sponsoredFpc: fpc.address.toString(),
  sponsoredFpcDeployed: Boolean(onChain),
  sponsoredFpcFeeJuice: (await getFeeJuiceBalance(fpc.address, node)).toString(),
}, null, 2));
