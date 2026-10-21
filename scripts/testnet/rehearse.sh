#!/usr/bin/env bash
# Rehearses testnet/run.ts on stand-ins for the public networks: no funds, nothing public.
#   :8899  solana-test-validator with Circle's CCTP V2 programs and state (devnet fixtures, offline).
#          The gateway is NOT preloaded, so `run.ts program` runs the real `solana program deploy`
#          (without the gateway's program key, it is preloaded and `run.ts program` only initializes).
#   :8546  anvil fork of Sepolia: Circle's real CCTP V2 contracts and the real Aztec testnet Inbox.
#          A test attester is enabled, as in contracts/portal/test/GatewayMessageFork.t.sol.
#   :8547  Iris stand-in (rehearsal/iris.ts) that attests the local burn with that test attester.
# Phases rehearsed: portal, program, deposit, burn, relay. The Aztec testnet is only read (registry
# address, L1->L2 message index); register/claim need the real Inbox and run only in the funded run.
# Keys and records go to scripts/testnet/.rehearsal/ (git-ignored, recreated each time).
#   scripts/testnet/rehearse.sh            run.ts burn + relay
#   scripts/testnet/rehearse.sh finisher   the testnet finisher instead (finisher/src/testnet.ts), with
#                                          its own throwaway keys: close, send, Iris, relay, then it
#                                          waits for Aztec; stopped, restarted, and rebuilt from the chains;
#                                          then a lone deposit whose epoch it rolls over once per end
# (Node >= 24.12 on PATH; anchor build and forge build done)
set -euo pipefail
mode="${1:-run}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
R="$here/.rehearsal"
fx="$repo/programs/gateway/tests/fixtures/cctp-devnet"
SEPOLIA_UPSTREAM="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
L1=http://127.0.0.1:8546
MT=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275

rm -rf "$R" && mkdir -p "$R/keys"
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

export ECLYPS_KEYS="$R/keys" ECLYPS_RECORD="$R/record.json"
# The finisher rehearsal shows rollovers, so its slots are faster: 16 ticks (about 100 ms) instead of
# 64, so an epoch (2,250 slots, the program's minimum) ends in about 4 minutes instead of 15.
ticks=()
if [ "$mode" = finisher ]; then ticks=(--ticks-per-slot 16); fi
export SOLANA_RPC_URL=http://127.0.0.1:8899 SEPOLIA_RPC_URL=$L1 IRIS_URL=http://127.0.0.1:8547
cd "$repo/scripts"
ids=$(pnpm -s exec tsx testnet/rehearsal/accounts.ts)
user=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["solana"])' "$ids")
deployer=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sepolia"])' "$ids")
echo "rehearsal keys: solana $user, sepolia $deployer"

# --- Solana: CCTP programs + state, our USDC account; no gateway ---
for p in CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC; do
  gunzip -c "$fx/$p.so.gz" > "$R/$p.so"
done
accounts=()
for f in "$fx"/*.json "$R/keys/usdc-account.json"; do
  accounts+=(--account "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pubkey"])' "$f")" "$f")
done
# The real deploy needs the gateway's program key (the owner's, git-ignored). Without it, preload the
# gateway with the rehearsal key as upgrade authority, which initialize requires (ADR 0010).
gateway=4GG6NHxUSSDbVoXZu9BbVVRTG5gYuKqjkhNw3DVoB1jf
preload=()
if [ "$(solana address -k "$repo/target/deploy/eclyps_gateway-keypair.json" 2>/dev/null)" != "$gateway" ]; then
  echo "target/deploy/eclyps_gateway-keypair.json is not the gateway's program key: preloading the gateway"
  preload=(--upgradeable-program "$gateway" "$repo/target/deploy/eclyps_gateway.so" "$R/keys/devnet.json")
fi
solana-test-validator --reset --quiet --ledger "$R/ledger" "${preload[@]}" "${ticks[@]}" \
  --bpf-program CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe "$R/CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe.so" \
  --bpf-program CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC "$R/CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC.so" \
  "${accounts[@]}" > "$R/solana.log" 2>&1 &
pids+=($!)

# --- Sepolia fork ---
anvil --fork-url "$SEPOLIA_UPSTREAM" --chain-id 11155111 --port 8546 --silent > "$R/anvil.log" 2>&1 &
pids+=($!)

until solana cluster-version -u "$SOLANA_RPC_URL" >/dev/null 2>&1; do sleep 1; done
until cast chain-id -r "$L1" >/dev/null 2>&1; do sleep 1; done
echo "fork chain id $(cast chain-id -r "$L1")"
solana airdrop 10 "$user" -u "$SOLANA_RPC_URL" >/dev/null

# Enable the test attester on the fork (Circle's attester manager, impersonated) and fund the deployer.
mgr=$(cast call "$MT" "attesterManager()(address)" -r "$L1")
cast rpc anvil_impersonateAccount "$mgr" -r "$L1" >/dev/null
cast rpc anvil_setBalance "$mgr" 0x56BC75E2D63100000 -r "$L1" >/dev/null
cast rpc anvil_setBalance "$deployer" 0x56BC75E2D63100000 -r "$L1" >/dev/null
attester=$(cast wallet address --private-key 0x0000000000000000000000000000000000000000000000000000000000a77e57)
cast send "$MT" "enableAttester(address)" "$attester" --from "$mgr" --unlocked -r "$L1" >/dev/null
cast send "$MT" "setSignatureThreshold(uint256)" 1 --from "$mgr" --unlocked -r "$L1" >/dev/null
echo "test attester $attester enabled on the fork"

start_iris() {
  pnpm -s exec tsx testnet/rehearsal/iris.ts > "$R/iris.log" 2>&1 &
  pids+=($!)
  until curl -s -o /dev/null "$IRIS_URL/v2/messages/5"; do sleep 0.5; done
}
# The finisher rehearsal starts Iris late, to show the finisher waiting for it and resuming.
[ "$mode" = finisher ] || start_iris

# --- the run, phase by phase ---
pnpm -s exec tsx testnet/run.ts portal
portal=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["l1"]["portal"])' "$ECLYPS_RECORD")
# The Aztec claim contracts live on the real testnet; bind a placeholder for $1 on the fork.
cast send "$portal" "bindClaimContract(uint64,bytes32)" 1000000 0x00000000000000000000000000000000000000000000000000000000000ec1a1 \
  --private-key "$(cat "$R/keys/sepolia.key")" -r "$L1" >/dev/null
pnpm -s exec tsx testnet/run.ts program
pnpm -s exec tsx testnet/run.ts deposit
if [ "$mode" = finisher ]; then
  source "$here/rehearsal/finisher.sh"
  exit 0
fi
pnpm -s exec tsx testnet/run.ts burn
pnpm -s exec tsx testnet/run.ts relay

python3 - "$ECLYPS_RECORD" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
run = r["runs"][0]
assert run.get("relayTx") and run.get("l1ToL2Hash"), run
print(f"rehearsal OK: {len(run['deposits'])} deposits, root {run['root']}, relay gas {run['relayGas']}, L1->L2 leaf {run['l1ToL2Index']}")
EOF
