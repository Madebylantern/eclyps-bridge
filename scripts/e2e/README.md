# S6 — end to end (ADR 0006)

## Local full path (no funds)

```
scripts/e2e/start-local-stack.sh       # solana-test-validator :8899, Aztec local network (anvil :8545, node :8080)
(cd contracts/portal && forge build) && (cd aztec && aztec compile) && aztec codegen aztec/target -o aztec/artifacts
cd scripts && pnpm exec tsx e2e/local-full.ts      # Node >= 24.12; PROVE=1 for real client proofs
kill $(cat scripts/e2e/.local/*.pid)               # stop
```

1. **Solana.** `solana-test-validator` runs our gateway and Circle's CCTP V2 programs and state.
   Both are loaded offline from `programs/gateway/tests/fixtures/cctp-devnet`. The script:
   - deposits 4 × $100 seed-derived notes;
   - runs `close_epoch`;
   - runs `send_batch`, which is a real CCTP burn from the gateway PDA carrying the batch hook.
2. **Iris (substituted).** The script fills in the nonce and executed finality, as Iris does.
3. **Ethereum, run (a).** `forge test --match-contract GatewayMessageFork` on a **Sepolia fork**
   with the same message bytes. `EclypsPortal` is placed at the address the gateway committed to.
   It runs against Circle's real CCTP V2 contracts (with a test attester) and the **real Aztec
   testnet Inbox**.
4. **Ethereum, run (b).** The same message goes to the Aztec local network's L1. That chain has
   no CCTP, so a mock transmitter stands in.
5. **Aztec.**
   - `register_batch` consumes the L1→L2 message.
   - The private claim uses a Merkle path built from **public Solana account data**.
   - The note is claimed to a fresh account.
6. **Checks:**
   - fork leg passes;
   - recipient's private balance is $100 and public balance is 0;
   - the portal holds the USDC;
   - the recipient appears neither in L1 calldata nor in public L2 effects.

## Local round trip (no funds)

```
scripts/e2e/start-local-stack.sh
cd scripts && pnpm exec tsx e2e/deploy-local.ts && pnpm exec tsx e2e/local-roundtrip.ts
```

One run, with the finisher as a separate process (ADR 0009, "Evidence (round trip)"):
1. **In.** 4 × $100 and 4 × $10 deposits; the finisher carries both batches; 8 private claims to a
   fresh Aztec account.
2. **Out on Aztec.** 4 × `exit` ($100) to fresh Solana addresses, 1 × `exit_to_ethereum` ($10) to
   a fresh Ethereum address, sent by the account with the SponsoredFPC paying.
3. **Finisher.** `close_exit_epoch`, then `exitBatch` through Aztec's real Outbox once the epoch
   is proven, then `receive_exit` through Circle's real Solana programs.
4. **Claims.** `claim_exit` to each Solana address; `claimToEthereum` by a relayer.
5. **Checks:** exact amounts everywhere, exit custody back to 0, replays refused, and no
   destination or Aztec account in the exits' public effects.

What the local stack substitutes for Circle (the local L1 has no CCTP):
- `deploy-local.ts` places a mock USDC and a recording TokenMessengerV2 at Sepolia's addresses;
- the finisher's local Iris (`finisher/src/local-iris.ts`) turns the recorded burn into Circle's
  message and attests it with two test attesters, which `start-local-stack.sh` writes into the
  validator's MessageTransmitterV2 state (`local-attesters.ts`).

Helpers: `crowd.ts` keeps the crowd's notes in `.local/crowd-notes.json`; `crowd-exit.ts` claims
them and moves them out, so an exit batch fills (minimum 4); `aztec-blocks.ts` produces Aztec
blocks while a demo waits for a proof.

## Testnet path (needs owner approval and test funds)

Devnet → Sepolia → Aztec testnet runs the same steps, with these differences:
- The gateway is deployed to devnet. `initialize` takes the Sepolia portal address.
- Iris attests for real: `s1-cctp/relay.ts` polls the sandbox API.
- The claim contract is on Aztec testnet (SponsoredFPC for fees).

Funding needed: devnet SOL + devnet USDC (faucet.circle.com, browser), and Sepolia ETH.
