/**
 * Writes scripts/e2e/.local/message-transmitter.json: Circle's MessageTransmitterV2 state from the
 * devnet fixtures with its two enabled attesters replaced by the local Iris's test attesters
 * (finisher/src/local-iris.ts; threshold 2 stays, as on devnet). start-local-stack.sh loads it in
 * place of the fixture, so receive_exit runs through Circle's real Solana programs on the local
 * validator, exactly as the gateway tests do in LiteSVM (`set_test_attesters`). Local only.
 *   pnpm exec tsx e2e/local-attesters.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { hexToBytes } from "viem";
import { testAttesters } from "../../finisher/src/local-iris.js";

const MT_STATE = "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU"; // PDA "message_transmitter"
const fixture = new URL(`../../programs/gateway/tests/fixtures/cctp-devnet/${MT_STATE}.json`, import.meta.url);
// The file is edited as text: its rentEpoch (u64::MAX) does not survive JSON.parse.
const text = readFileSync(fixture, "utf8");
const j = JSON.parse(text);
if (j.pubkey !== MT_STATE) throw new Error("unexpected MessageTransmitter fixture");
const original = j.account.data[0] as string;
const data = Buffer.from(original, "base64");
// Layout (Anchor `MessageTransmitter`): disc 8 | owner 32 | pending_owner 32 | attester_manager 32 |
// pauser 32 | paused u8 @136 | local_domain u32 @137 | version u32 @141 | signature_threshold u32
// @145 | enabled_attesters Vec<Pubkey> (len u32 @149, 32 bytes each from @153) | max_message_body_size u64.
const u32 = (o: number) => data.readUInt32LE(o);
if (data.length !== 225 || data[136] !== 0 || u32(137) !== 5 || u32(141) !== 1 || u32(145) !== 2 || u32(149) !== 2) {
  throw new Error("MessageTransmitter layout changed: check the fixture (see programs/gateway/tests/common, set_test_attesters)");
}
testAttesters().forEach((a, i) => {
  const slot = Buffer.alloc(32);
  Buffer.from(hexToBytes(a)).copy(slot, 12);
  slot.copy(data, 153 + 32 * i);
});
writeFileSync(new URL("./.local/message-transmitter.json", import.meta.url), text.replace(original, data.toString("base64")));
console.log(`local MessageTransmitterV2 attesters: ${testAttesters().join(", ")}`);
