/**
 * Rehearsal only: an Iris stand-in for burns on a local validator. It answers
 * GET /v2/messages/5?transactionHash=<sig> like Circle's API: it reads the MessageSent account
 * the burn created, fills the two fields Iris fills (nonce, executed finality) and signs
 * keccak256(message) with the test attester that rehearse.sh enables on the Sepolia fork
 * (key 0xA77E57, as in contracts/portal/test/GatewayMessageFork.t.sol).
 */
import { createServer } from "node:http";
import { type Address, createSolanaRpc, type Signature } from "@solana/kit";
import { bytesToHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CCTP, messageFromMessageSentAccount } from "@eclyps/sdk";

const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899");
const attester = privateKeyToAccount(`0x${(0xa77e57).toString(16).padStart(64, "0")}`);
const port = Number(process.env.IRIS_PORT ?? 8547);

async function attest(sig: string) {
  const tx = await rpc.getTransaction(sig as Signature, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }).send();
  if (!tx) return undefined;
  for (const key of tx.transaction.message.accountKeys as Address[]) {
    const { value } = await rpc.getAccountInfo(key, { encoding: "base64", commitment: "confirmed" }).send();
    if (!value || value.owner !== CCTP.messageTransmitterV2 || value.data[0].length < 100) continue;
    let msg: Uint8Array;
    try {
      msg = new Uint8Array(messageFromMessageSentAccount(new Uint8Array(Buffer.from(value.data[0], "base64"))));
    } catch {
      continue;
    }
    msg.set(crypto.getRandomValues(new Uint8Array(32)), 12); // nonce
    new DataView(msg.buffer).setUint32(144, 2000); // finalityThresholdExecuted
    const message = bytesToHex(msg);
    return { message, attestation: await attester.sign({ hash: keccak256(message) }), status: "complete" };
  }
  return undefined;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const m = url.pathname.match(/^\/v2\/messages\/5$/);
  const sig = url.searchParams.get("transactionHash");
  const found = m && sig ? await attest(sig).catch(() => undefined) : undefined;
  res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(found ? { messages: [found] } : { error: "Message not found" }));
}).listen(port, "127.0.0.1", () => console.log(`iris stand-in on http://127.0.0.1:${port} (attester ${attester.address})`));
