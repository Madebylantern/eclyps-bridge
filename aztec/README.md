# aztec/ — Aztec side (Aztec.nr, targets Aztec testnet 6.0.0-rc.3)

| Crate | What |
| --- | --- |
| `claim/` | `EclypsClaim`: `register_batch` (public, consumes the portal's L1→L2 message, stores the root) and `claim` (private Merkle membership + nullifier, mints a private note), ADR 0003. Exits: `exit` (private burn, commitment appended to the exit epoch's tree) and `close_exit_epoch` (public, one L2→L1 message per epoch), ADR 0009; `exit_to_ethereum` (private burn, one L2→L1 message), ADR 0014 §4. |
| `fpc/` | `EclypsFPC` (ADR 0018, for Aztec mainnet, not deployed): pays the fee of a user's claim or exit from its own Fee Juice. Private `sponsor` proves a deposited note under a root a served claim contract registered, spends one of the note's sponsor slots, caps the declared gas, elects itself fee payer and ends setup. No public code runs in setup. |
| `minter/` | `EclypsMinter` (ADR 0020): the token's only minter. Claim contracts mint through it; it checks in public that the caller is a listed claim contract minting its own denomination. `wire` (admin, once) gives it the token and the first claims; `list` adds one more, minting 7 days later; listings never change or go away; `renounce` fixes the list for good. |
| `claim_test/` | TXE tests using `circuits/vectors`: S5 acceptance and registration (`lib.nr`), exits (`exit.nr`), the FPC (`sponsor.nr`), the minter (`minter.nr`). TXE drops L2→L1 messages; `scripts/s2-aztec/local-exit.ts` checks them on a local network. |
| `vendor/token_contract/` | The AIP-20 `Token` of `defi-wonderland/aztec-standards` (MIT), vendored from `a3859e5` with its test module dropped and its dependencies on our aztec-nr pin (ADR 0020). Created with `constructor_with_minter`: EclypsMinter is its only minter, for good; no admin, no transfer hook. |

Toolchain (ADR 0001): `VERSION=6.0.0-rc.3 bash -i <(curl -sL https://install.aztec.network/6.0.0-rc.3)`
(Node ≥ 24.12; no Docker). Then:

```
aztec compile     # nargo 1.0.0-rc.3 + bb transpile/VKs
aztec test        # TXE; needs `nc`
```

Format only our crates (`aztec-nargo fmt` inside `claim/` and `claim_test/`); keep `vendor/` verbatim.
