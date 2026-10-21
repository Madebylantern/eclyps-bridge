# contracts/portal — Ethereum side (Foundry)

- `BatchReceiver` (S1): receives the gateway's CCTP V2 burn and decodes the batch hook (ADR 0002).
- `EclypsPortal`:
  - `relay`: a batch from Solana in, its root forwarded to the Aztec claim contract through the
    Inbox (ADR 0003);
  - `exitBatch`: a closed exit epoch out. It consumes the claim contract's message from the Aztec
    Outbox and burns `count × denomination` USDC back to the gateway through CCTP V2, with the
    exit hook (ADR 0009);
  - `claimToEthereum`: one exit to Ethereum. It rebuilds the commitment
    `sha256ToField(recipient, exitSecret)` and the message, consumes it from the Outbox and pays
    exactly one denomination to `recipient`. Anyone may send it (ADR 0014 §4).

Constructor: the forward arguments, then `exitAuthority` and `exitCustody`. These are the gateway's
exit PDAs as bytes32, derived with SDK `exitAuthorityPda()` / `exitCustodyPda()`. A new gateway
program id needs a new portal.

Tools: Foundry 1.8.5 (forge), solc 0.8.30 (evm prague), forge-std v1.17.0 (submodule).

```
git submodule update --init
forge test                                              # unit + fixture tests, offline
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test   # + fork tests vs real CCTP
```

| Tests | What |
| --- | --- |
| `BatchReceiver.t.sol`, `EclypsPortal.t.sol` | forward path, mocks |
| `ExitBatch.t.sol` | `exitBatch` with a mock Outbox (Aztec's checks) and a recording TokenMessengerV2 |
| `ClaimToEthereum.t.sol` | `claimToEthereum` with the same mock Outbox; a batch exit and an Ethereum exit can never be consumed as each other |
| `*Fork.t.sol` | Sepolia fork, Circle's real CCTP V2 and USDC; `ExitBatchFork.t.sol` checks the exit message against the one the gateway accepted, and pays an Ethereum exit in real USDC |

Fixtures:
- `test/fixtures/exit-burn-sepolia-fork.json` is the exit message from the fork. The gateway's
  `exit_message` tests and the SDK read it. Rewrite it with `ECLYPS_WRITE_FIXTURES=true` (fork
  run).
- `circuits/vectors/exit.json` holds the exit hook and content vectors;
  `circuits/vectors/exit-ethereum.json` the Ethereum exit commitment and content vectors.
