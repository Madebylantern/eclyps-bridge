/**
 * The bridge screen's destinations (ADR 0014). Every route enters Aztec: the default destination is
 * the user's own private balance there, the account derived from the recovery phrase. "An Ethereum
 * address" is offered only where the exit to Ethereum is deployed (`features.exitEthereum`); an
 * Aztec address is never an Ethereum address, so that one is always pasted by the user.
 */
import type { Deployment } from "./deployment";

export type Destination = "aztec" | "ethereum";

/** What the To row offers on this network, the private balance first. */
export function destinations(dep: Pick<Deployment, "features">): Destination[] {
  return dep.features?.exitEthereum === true ? ["aztec", "ethereum"] : ["aztec"];
}

/**
 * A 0x Ethereum address (20 bytes as 40 hex digits), or undefined. The zero address is refused:
 * USDC sent there is lost. Mixed case is accepted as written; the EIP-55 checksum is not checked.
 */
export function parseEthAddress(s: string): `0x${string}` | undefined {
  const t = s.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return undefined;
  if (/^0x0{40}$/.test(t)) return undefined;
  return t as `0x${string}`;
}
