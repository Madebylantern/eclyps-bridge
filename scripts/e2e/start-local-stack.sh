#!/usr/bin/env bash
# Local full-path stack for the S6 e2e (no funds, no testnets):
#   :8899  solana-test-validator  gateway + Circle CCTP V2 programs/state (devnet fixtures, offline;
#                                 MessageTransmitterV2's attesters are the local Iris's test keys)
#   :8545  anvil (Aztec's)        fresh L1 with Aztec's L1 contracts
#   :8080  Aztec local network    6.0.0-rc.3
# The Ethereum leg against Circle's real CCTP and the real Aztec testnet Inbox runs separately as a
# Sepolia-fork Foundry test on the same message bytes (contracts/portal GatewayMessageFork.t.sol).
# Logs and ledgers go to scripts/e2e/.local/. Stop with: kill $(cat scripts/e2e/.local/*.pid)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
local_dir="$here/.local"
mkdir -p "$local_dir"
# The test validator's ledger grows ~100 MB a minute even when idle (Agave 4.x; --limit-blockstore-size
# does not bound RocksDB's write-ahead log), ~3 GB over a full UI demo. When the disk fills, the
# validator dies and every Solana step stalls on refused connections: refuse to start instead.
min_free_gb="${ECLYPS_MIN_FREE_GB:-4}"
free_kb=$(df -Pk "$local_dir" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt $((min_free_gb * 1024 * 1024)) ]; then
  echo "only $((free_kb / 1024)) MB free on $(df -P "$local_dir" | awk 'NR==2 {print $6}'); the local stack needs ${min_free_gb} GB (the Solana ledger grows ~100 MB/min)."
  echo "free some space (e.g. rm -rf app/.next once the app is built: serve.mjs serves app/out) or set ECLYPS_MIN_FREE_GB"
  exit 1
fi
# The ledgers start fresh, so the finisher's record of relayed/registered batches must too.
rm -f "$local_dir/finisher-state.json" "$local_dir/finisher-exits.json" "$local_dir/crowd-notes.json"
fx="$repo/programs/gateway/tests/fixtures/cctp-devnet"

[ -f "$local_dir/accounts.json" ] || (cd "$repo/scripts" && pnpm -s exec tsx e2e/make-local-accounts.ts)
[ -f "$repo/target/deploy/eclyps_gateway.so" ] || (cd "$repo" && anchor build)

# --- Solana ---
for p in CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC; do
  gunzip -c "$fx/$p.so.gz" > "$local_dir/$p.so"
done
# Exits (ADR 0009): receive_exit verifies attestations with Circle's real MessageTransmitterV2, so
# its two enabled attesters become the local Iris's test keys (finisher/src/local-iris.ts).
(cd "$repo/scripts" && pnpm -s exec tsx e2e/local-attesters.ts)
accounts=()
for f in "$fx"/*.json "$local_dir"/*-usdc.json "$local_dir/message-transmitter.json"; do
  [ "$(basename "$f")" = "W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU.json" ] && continue
  accounts+=(--account "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pubkey"])' "$f")" "$f")
done
# The gateway is upgradeable with the local user as upgrade authority: only the upgrade
# authority can initialize it (ADR 0010), and deploy-local.ts / local-full.ts initialize as that user.
solana-test-validator --reset --quiet --ledger "$local_dir/ledger" \
  --upgradeable-program 4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf "$repo/target/deploy/eclyps_gateway.so" "$local_dir/user.json" \
  --bpf-program CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe "$local_dir/CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe.so" \
  --bpf-program CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC "$local_dir/CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC.so" \
  "${accounts[@]}" > "$local_dir/solana.log" 2>&1 &
echo $! > "$local_dir/solana.pid"

# --- Aztec local network (starts anvil on :8545 and the node on :8080) ---
aztec start --local-network > "$local_dir/aztec.log" 2>&1 &
echo $! > "$local_dir/aztec.pid"
echo "waiting for Aztec node..."
until grep -q "Aztec Server listening" "$local_dir/aztec.log"; do
  grep -q "ERROR: cli" "$local_dir/aztec.log" && { echo "Aztec failed; see $local_dir/aztec.log"; exit 1; }
  sleep 2
done
until solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1; do sleep 1; done
echo "stack ready: solana :8899, L1 anvil :8545, aztec :8080"
