/**
 * Circle's Iris, substituted on the local stack (Ethereum -> Solana exits, ADR 0009).
 *
 * The local L1 has no CCTP. `scripts/e2e/deploy-local.ts` places a recording TokenMessengerV2
 * (contracts/portal/test/mocks/MockCctp.sol) and a mock USDC at Sepolia's addresses, so the portal
 * burns exactly what it would burn on Sepolia. This module turns a recorded burn into the message
 * Ethereum's TokenMessengerV2 would emit (SDK `encodeExitMessage`, checked against Circle's bytes on
 * a Sepolia fork), fills the nonce and executed finality as Iris does, and attests it with two test
 * attesters. `scripts/e2e/start-local-stack.sh` writes those two attesters into the local
 * validator's MessageTransmitterV2 state (threshold 2, as on devnet), so Circle's real Solana
 * programs verify the attestation. Nothing else in CCTP's state is changed. The keys are the
 * gateway tests' (programs/gateway/tests/common, `test_attesters`): never used on a real network.
 */
import { decodeExitHook, encodeExitMessage } from "@eclyps/sdk";
import { concat, type Hex, hexToBytes, keccak256, parseAbi, type PublicClient, serializeSignature, toHex } from "viem";
import { privateKeyToAddress, sign } from "viem/accounts";

export const TEST_ATTESTER_KEYS: readonly Hex[] = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];

/** The test attesters' Ethereum addresses, as MessageTransmitterV2 stores them (in increasing order). */
export const testAttesters = (): Hex[] =>
  TEST_ATTESTER_KEYS.map((k) => privateKeyToAddress(k)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

/**
 * Iris's attestation: one 65-byte (r, s, v) signature over keccak256(message) per attester, in
 * increasing attester order, low s (as MessageTransmitterV2 requires).
 */
export async function attest(message: Uint8Array): Promise<Hex> {
  const hash = keccak256(message);
  const keys = [...TEST_ATTESTER_KEYS].sort((a, b) => (BigInt(privateKeyToAddress(a)) < BigInt(privateKeyToAddress(b)) ? -1 : 1));
  const sigs = await Promise.all(keys.map(async (privateKey) => serializeSignature(await sign({ hash, privateKey }))));
  return concat(sigs);
}

const MOCK_TOKEN_MESSENGER_ABI = parseAbi([
  "function count() view returns (uint256)",
  "function burn(uint256 i) view returns ((address caller, uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData))",
]);

/**
 * The local stack's Iris for one exit batch: finds the burn the portal made for (denomination,
 * exitEpochId) in the recording TokenMessengerV2, builds the message, fills a fresh nonce and
 * finality 2000, and attests it. Undefined while no such burn exists.
 */
export async function localExitAttestation(
  l1: PublicClient,
  tokenMessenger: Hex,
  denomination: bigint,
  exitEpochId: bigint,
): Promise<{ message: Hex; attestation: Hex } | undefined> {
  const n = await l1.readContract({ address: tokenMessenger, abi: MOCK_TOKEN_MESSENGER_ABI, functionName: "count" });
  for (let i = n; i-- > 0n; ) {
    const b = await l1.readContract({ address: tokenMessenger, abi: MOCK_TOKEN_MESSENGER_ABI, functionName: "burn", args: [i] });
    const hookBytes = hexToBytes(b.hookData);
    if (hookBytes.length !== 51 || hookBytes[0] !== 2) continue;
    const hook = decodeExitHook(hookBytes);
    if (hook.denomination !== denomination || hook.exitEpochId !== exitEpochId || b.destinationDomain !== 5) continue;
    // Iris's nonce is unique per message; any 32 fresh bytes do here.
    const nonce = hexToBytes(keccak256(concat([b.hookData, toHex(i, { size: 32 })])));
    const message = encodeExitMessage({
      tokenMessenger, burnToken: b.burnToken, destinationCaller: hexToBytes(b.destinationCaller), mintRecipient: hexToBytes(b.mintRecipient),
      amount: b.amount, messageSender: b.caller, minFinality: b.minFinalityThreshold, maxFee: b.maxFee, hook: hookBytes,
      nonce, finalityExecuted: 2000,
    });
    return { message: toHex(message), attestation: await attest(message) };
  }
  return undefined;
}
