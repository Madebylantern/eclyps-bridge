/**
 * Eclyps finisher (SPEC §5.2): a permissionless client that carries closed batches across.
 * Anyone can run one; it holds no user data and chooses only *when* things happen.
 *
 *   Solana:   close_epoch when an epoch ended or filled; send_batch for closed epochs (CCTP burn).
 *             send_batch pays the finisher's share of the batch's fees (ADR 0012) into this
 *             finisher's own USDC account
 *   Ethereum: fetch the attested message (Iris) and EclypsPortal.relay it
 *   Aztec:    EclypsClaim.register_batch once the L1->L2 message is consumable
 *
 * The deployment's `network` picks the mode (Node >= 24.12):
 *   local    local.ts, the local stack of scripts/e2e (Iris substituted, mock transmitter)
 *            DEPLOYMENT=../scripts/e2e/.local/deployment.json pnpm --filter @eclyps/finisher local [--once]
 *   testnet  testnet.ts, Solana devnet -> Sepolia -> Aztec testnet, left running
 *            pnpm --filter @eclyps/finisher testnet [-- --once]
 *   mainnet  testnet.ts too, Solana -> Ethereum -> Aztec mainnet (src/network.ts: the gate)
 *            ECLYPS_MAINNET_OK=1 DEPLOYMENT=… pnpm --filter @eclyps/finisher mainnet
 */
import { readFileSync } from "node:fs";

const DEPLOYMENT = process.env.DEPLOYMENT ?? "../scripts/e2e/.local/deployment.json";
const { network } = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as { network?: string };
// Mainnet goes through the same gate as `pnpm mainnet` (--mainnet or NETWORK=mainnet, ECLYPS_MAINNET_OK=1).
if (network === "testnet" || network === "mainnet") await import("./testnet.js");
else if (network === "local") await import("./local.js");
else throw new Error(`${DEPLOYMENT}: unknown network "${network}"`);
