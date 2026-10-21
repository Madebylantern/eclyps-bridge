# circuits/ — shared hash and Merkle definitions (S3, ADR 0004)

One tree definition, four implementations, one vector file.

| Path | What | Run |
| --- | --- | --- |
| `vectors/merkle.json` | Canonical vectors (pairs, 16 note commitments, roots at depth 4 and 8, zero hashes, paths) | regenerate: `cargo run -p eclyps-merkle --example gen_vectors > circuits/vectors/merkle.json` |
| `merkle-rs/` | Rust crate `eclyps-merkle` used by the gateway program. `sol_poseidon` syscall on SBF, light-poseidon on host | `cargo test -p eclyps-merkle` |
| `syscall-probe/` | Tiny SBF program; LiteSVM (mainnet feature set) checks the syscall roots against the vectors and reports CU | `cargo build-sbf --manifest-path circuits/syscall-probe/Cargo.toml && cargo test -p eclyps-syscall-probe -- --nocapture` |
| `merkle-nr/` | Noir library `eclyps_merkle` (noir-lang/poseidon v0.4.0, `bn254::hash_2`) | `cd circuits/merkle-nr && nargo test` |
| `../sdk/src/merkle.ts` | TypeScript (poseidon-lite), cross-checked against circomlibjs | `pnpm --filter @eclyps/sdk test` |
| `scripts/gen-noir-vectors.mjs` | Regenerates `merkle-nr/src/vectors.nr` from the JSON | `node circuits/scripts/gen-noir-vectors.mjs` |
| `vectors/exit.json` | Exit hook (51-byte CCTP hookData) and exit L2→L1 content vectors (ADR 0009). Checked by the portal, the SDK, the gateway and the Aztec claim contract (TXE) | regenerate: `python3 circuits/scripts/gen-exit-vectors.py > circuits/vectors/exit.json` |
| `vectors/exit-ethereum.json` | Leave to Ethereum: commitment `sha256ToField(recipient, exitSecret)` and L2→L1 content with its tag (ADR 0014 §4). Checked by the portal, the SDK and the claim contract (TXE) | regenerate: `python3 circuits/scripts/gen-exit-ethereum-vectors.py > circuits/vectors/exit-ethereum.json` |
| `scripts/gen-noir-exit-vectors.mjs` | Writes both exit vector files, and the leaves of the gateway's fixture exit batch, as Noir constants for the claim contract's TXE tests (`aztec/claim_test/src/exit_vectors.nr`) | `node circuits/scripts/gen-noir-exit-vectors.mjs` |

Tool versions: see `docs/decisions/0001-toolchain.md`.
