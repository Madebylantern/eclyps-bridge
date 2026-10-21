/** Prints a Solana address as 0x-prefixed 32-byte hex (CCTP `messageSender` encoding). */
import { address, getAddressEncoder } from "@solana/kit";

const a = process.argv[2];
if (!a) throw new Error("usage: pubkey-hex.ts <base58 address>");
console.log(`0x${Buffer.from(getAddressEncoder().encode(address(a))).toString("hex")}`);
