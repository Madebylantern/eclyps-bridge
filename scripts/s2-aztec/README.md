# S2 — Ethereum → Aztec private claim (ADR 0003)

## Local network (no funds)

```
# one-time: Aztec 6.0.0-rc.3 toolchain (Node >= 24.12), see aztec/README.md
aztec start --local-network &                    # anvil :8545 + Aztec node :8080
(cd contracts/portal && forge build)
(cd aztec && aztec compile)
aztec codegen aztec/target -o aztec/artifacts
cd scripts && pnpm exec tsx s2-aztec/local-e2e.ts            # fake proofs (node default)
cd scripts && PROVE=1 pnpm exec tsx s2-aztec/local-e2e.ts    # real client-side proofs
```

The script deploys a mock CCTP transmitter, the real `EclypsPortal`, `Token` and `EclypsClaim`.
It relays a 16-note batch, registers the root on L2 and claims one note privately to a fresh
account. It then checks the private balance and that the recipient appears neither in L1 calldata
nor in the claim's public L2 effects. It also prints the claim's gate profile.

### Exits (ADR 0009, ADR 0014 §4)

```
cd scripts && pnpm exec tsx s2-aztec/local-exit.ts   # same prerequisites, about 80 s
```

It deploys the portal against the local Aztec registry, so the Outbox is Aztec's real one, and a
recording TokenMessengerV2 at the address the portal names (the local L1 has no CCTP). It then:
- burns a note with `exit_to_ethereum` and pays it with `claimToEthereum` from a relayer;
- burns two notes with `exit`, closes the exit epoch and sends it with `exitBatch`.

It checks each L2→L1 message against the SDK's content, that the holder's address is in no exit
transaction's public effects, and that a claim cannot be replayed. It prints L2 gas, L1 gas with
the real Outbox, and gate profiles.

Note: `@aztec-labs/ethereum`'s `deploy-l1-contract` and `contracts` entry points do not resolve in
this workspace (`@noble/curves/bn254`), so this script deploys with viem and reads the Outbox
directly. `local-e2e.ts` imports `deployL1Contract` and stops at startup with that error
(2026-10-13, rc.3).

## Sepolia + Aztec testnet (needs owner-approved test keys)

The same flow uses the real CCTP V2 contracts (S1) and Aztec testnet 6.0.0-rc.3:
- node `https://aztec-testnet.drpc.org`
- registry `0xA0BFb1B494FB49041e5c6e8c2C1BE09cD171c6Ba`
- fees through the testnet SponsoredFPC

It is not run yet: it needs a Sepolia key with ETH to deploy the portal.

`secret-hash.ts` prints `computeSecretHash([0])`, the constant the portal uses.
