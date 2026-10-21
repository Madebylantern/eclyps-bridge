/**
 * S1, Ethereum side: fetch Circle's attested message for a Solana burn signature from Iris
 * (sandbox), then call BatchReceiver.relay on Sepolia and print the decoded root.
 *
 *   SEPOLIA_RPC_URL=... SEPOLIA_PRIVATE_KEY=0x... RECEIVER=0x... \
 *     NODE_USE_ENV_PROXY=1 pnpm --filter @eclyps/scripts exec tsx s1-cctp/relay.ts <solana-signature>
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { CCTP, DEVNET, decodeBatchHook, toHex } from "@eclyps/sdk";

const sig = process.argv[2];
if (!sig) throw new Error("usage: relay.ts <solana-signature>");
const RECEIVER = process.env.RECEIVER as `0x${string}`;
const KEY = process.env.SEPOLIA_PRIVATE_KEY as `0x${string}`;
if (!RECEIVER || !KEY) throw new Error("RECEIVER and SEPOLIA_PRIVATE_KEY are required");
const rpc = http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");

const abi = parseAbi([
  "function relay(bytes message, bytes attestation) returns ((uint64 denomination, uint64 epochId, uint16 leafCount, bytes32 root))",
  "event BatchReceived(bytes32 indexed root, uint64 indexed denomination, uint64 indexed epochId, uint16 leafCount, uint256 amount, bytes32 cctpNonce)",
]);

interface IrisMessage {
  message: `0x${string}`;
  attestation: string;
  status: string;
  decodedMessage?: { decodedMessageBody?: { hookData?: string } };
}

async function fetchAttested(): Promise<IrisMessage> {
  const url = `${DEVNET.iris}/v2/messages/${CCTP.domains.solana}?transactionHash=${sig}`;
  for (let i = 0; i < 120; i++) {
    const res = await fetch(url, { headers: { "user-agent": "eclyps-spike/0.1" } });
    if (res.status === 200) {
      const body = (await res.json()) as { messages: IrisMessage[] };
      const m = body.messages[0];
      if (m && m.status === "complete" && m.attestation !== "PENDING") return m;
      console.log(`iris: ${m?.status ?? "no message"}; waiting`);
    } else {
      console.log(`iris: HTTP ${res.status}; waiting`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("timed out waiting for attestation");
}

async function main() {
  const m = await fetchAttested();
  const hook = Buffer.from(m.message.slice(2), "hex").subarray(376);
  const sent = decodeBatchHook(hook);
  console.log(`attested; hook root=${toHex(sent.root)} epoch=${sent.epochId}`);

  const account = privateKeyToAccount(KEY);
  const wallet = createWalletClient({ account, chain: sepolia, transport: rpc });
  const pub = createPublicClient({ chain: sepolia, transport: rpc });
  const hash = await wallet.writeContract({
    address: RECEIVER,
    abi,
    functionName: "relay",
    args: [m.message, m.attestation as `0x${string}`],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const [ev] = parseEventLogs({ abi, logs: receipt.logs, eventName: "BatchReceived" });
  if (!ev) throw new Error(`no BatchReceived in ${hash}`);
  const ok = BigInt(ev.args.root) === sent.root;
  console.log(`Sepolia tx ${hash}`);
  console.log(`decoded root ${ev.args.root} ${ok ? "== root sent (S1 acceptance)" : "!= root sent"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
