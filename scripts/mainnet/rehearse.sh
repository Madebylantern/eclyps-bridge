#!/usr/bin/env bash
# Rehearses the mainnet deployment kit (mainnet/deploy.ts) end to end on local stand-ins: no funds,
# nothing public. deploy.ts --rehearsal refuses any non-local endpoint.
#   :8899  solana-test-validator with Circle's MAINNET CCTP V2 programs and state (dumped from
#          mainnet-beta once, cached in .rehearsal/fixtures). The gateway is deployed by the kit
#          (`gateway` step, the real `solana program deploy`).
#   :8546  anvil fork of Ethereum mainnet: Circle's real CCTP V2 contracts and USDC, the real Aztec
#          Registry and the v6 rollup, Inbox and Outbox. AZUP-3's Registry.addRollup(v6) is replayed
#          from the governance address (impersonated), as the payload will do on Oct 26; a test
#          attester is enabled on MessageTransmitterV2 (impersonating Circle's attester manager).
#   :8545  the Aztec local network's own anvil, :8080 its node (6.0.0-rc.3). The sandbox cannot
#          fork mainnet: the Aztec contracts and the Fee Juice bridge run there.
#   :8547  Iris stand-in (testnet/rehearsal/iris.ts) signing with the test attester.
# Every kit step runs twice: the dry run, then (after this script writes the digest to the
# confirmation file, standing in for the owner) the send. The portal is sent through the external
# signer path (unsigned export, sign elsewhere, --signed). Then a $100 crossing (rehearsal/crossing.ts).
#   scripts/mainnet/rehearse.sh [all|up|kit|crossing|down]
# Needs: Node >= 24.12, solana CLI 4.x, anvil/cast, the aztec CLI 6.0.0-rc.3, target/deploy/eclyps_gateway.so
# (anchor build), contracts/portal/out (forge build), and the gateway's program key
# (PROGRAM_KEYPAIR, default target/deploy/eclyps_gateway-keypair.json) for the real deploy.
set -euo pipefail
mode="${1:-all}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
R="$here/.rehearsal"
P="$R/private"
export ECLYPS_MAINNET_DIR="$P" ECLYPS_RECORD="$R/mainnet.json"
export SOLANA_RPC_URL=http://127.0.0.1:8899 ETH_RPC_URL=http://127.0.0.1:8546 AZTEC_NODE_URL=http://127.0.0.1:8080 AZTEC_L1_RPC_URL=http://127.0.0.1:8545
export IRIS_URL=http://127.0.0.1:8547
MAINNET_RPC="${MAINNET_RPC_URL:-https://ethereum-rpc.publicnode.com}"
SOLANA_MAINNET_RPC="${SOLANA_MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}"
PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-$repo/target/deploy/eclyps_gateway-keypair.json}"
FORK=http://127.0.0.1:8546
AZL1=http://127.0.0.1:8545
GOV=0x1102471Eb3378FEE427121c9EfcEa452E4B6B75e
REGISTRY=0x35b22e09Ee0390539439E24f06Da43D83f90e298
V6=0xE37A2663Cc9c119BA41572C40fAb0bbb23a5402f
MT=0x81D40F21F12A8F0E3252Bccb954D722d4c464B64
cd "$repo/scripts"
json() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval("d"+sys.argv[2]))' "$@"; }

up() {
  free_kb=$(df -Pk "$repo" | awk 'NR==2 {print $4}')
  if [ "$free_kb" -lt $((5 * 1024 * 1024)) ]; then echo "only $((free_kb / 1024)) MB free; the rehearsal needs 5 GB (the Solana ledger grows ~100 MB/min)"; exit 1; fi
  mkdir -p "$R/fixtures"
  rm -rf "$P" "$R/ledger" "$ECLYPS_RECORD" && mkdir -p "$P"
  pnpm -s exec tsx mainnet/rehearsal/accounts.ts > "$R/ids.json"
  echo "rehearsal keys: $(cat "$R/ids.json")"
  # Circle's mainnet CCTP V2 programs and burn state (read-only dumps from mainnet-beta, cached).
  for p in CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC; do
    [ -s "$R/fixtures/$p.so" ] || solana program dump -u "$SOLANA_MAINNET_RPC" "$p" "$R/fixtures/$p.so" >/dev/null
  done
  accounts=()
  for a in $(json "$R/ids.json" '["cctpAccounts"]' | tr -d "[]',"); do
    [ -s "$R/fixtures/$a.json" ] || solana account -u "$SOLANA_MAINNET_RPC" "$a" --output json-compact > "$R/fixtures/$a.json"
    accounts+=(--account "$a" "$R/fixtures/$a.json")
  done
  accounts+=(--account "$(json "$P/depositor-usdc.json" '["pubkey"]')" "$P/depositor-usdc.json")
  solana-test-validator --reset --quiet --ledger "$R/ledger" \
    --bpf-program CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe "$R/fixtures/CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe.so" \
    --bpf-program CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC "$R/fixtures/CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC.so" \
    "${accounts[@]}" > "$R/solana.log" 2>&1 &
  echo $! > "$R/solana.pid"
  # The validator's RocksDB keeps every closed write-ahead log (~600 MB each, one every ~6 min here),
  # which fills a small disk mid-run. The ledger is thrown away afterwards, so closed logs are deleted.
  (while [ -f "$R/solana.pid" ]; do
    open=$(ls -l "/proc/$(cat "$R/solana.pid" 2>/dev/null)/fd" 2>/dev/null | grep -o "rocksdb/[0-9]*\.log" || true)
    for f in "$R"/ledger/rocksdb/*.log; do [ -f "$f" ] && ! grep -q "rocksdb/$(basename "$f")" <<<"$open" && rm -f "$f"; done
    sleep 20
  done) > /dev/null 2>&1 &
  anvil --fork-url "$MAINNET_RPC" --port 8546 --silent > "$R/anvil.log" 2>&1 &
  echo $! > "$R/anvil.pid"
  if ! curl -s -o /dev/null localhost:8080; then
    aztec start --local-network > "$R/aztec.log" 2>&1 &
    echo $! > "$R/aztec.pid"
  fi
  until solana cluster-version -u "$SOLANA_RPC_URL" >/dev/null 2>&1; do sleep 1; done
  until cast chain-id -r "$FORK" >/dev/null 2>&1; do sleep 1; done
  until grep -q "Aztec Server listening" "$R/aztec.log" 2>/dev/null || curl -s -o /dev/null localhost:8080; do sleep 2; done
  admin=$(json "$R/ids.json" '["admin"]'); depositor=$(json "$R/ids.json" '["depositor"]'); guardian=$(json "$R/ids.json" '["guardian"]')
  eth=$(json "$R/ids.json" '["ethereum"]')
  for k in "$admin" "$depositor" "$guardian"; do solana airdrop 20 "$k" -u "$SOLANA_RPC_URL" >/dev/null; done
  # AZUP-3's Registry.addRollup(v6), replayed from the governance address on the fork.
  cast rpc anvil_impersonateAccount "$GOV" -r "$FORK" >/dev/null
  cast rpc anvil_setBalance "$GOV" 0x56BC75E2D63100000 -r "$FORK" >/dev/null
  cast send "$REGISTRY" "addRollup(address)" "$V6" --from "$GOV" --unlocked -r "$FORK" >/dev/null
  echo "fork: canonical rollup $(cast call "$REGISTRY" "getCanonicalRollup()(address)" -r "$FORK") (v6 = $V6)"
  # Test attester on Circle's mainnet MessageTransmitterV2 (fork only).
  mgr=$(cast call "$MT" "attesterManager()(address)" -r "$FORK")
  cast rpc anvil_impersonateAccount "$mgr" -r "$FORK" >/dev/null
  cast rpc anvil_setBalance "$mgr" 0x56BC75E2D63100000 -r "$FORK" >/dev/null
  attester=$(cast wallet address --private-key 0x0000000000000000000000000000000000000000000000000000000000a77e57)
  cast send "$MT" "enableAttester(address)" "$attester" --from "$mgr" --unlocked -r "$FORK" >/dev/null
  cast send "$MT" "setSignatureThreshold(uint256)" 1 --from "$mgr" --unlocked -r "$FORK" >/dev/null
  cast rpc anvil_setBalance "$eth" 0x56BC75E2D63100000 -r "$FORK" >/dev/null
  # The sandbox's L1: ETH for the deployer and Fee Juice (AZTEC) from its test handler.
  cast rpc anvil_setBalance "$eth" 0x56BC75E2D63100000 -r "$AZL1" >/dev/null
  handler=$(curl -s -X POST localhost:8080 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["l1ContractAddresses"]["feeAssetHandlerAddress"])')
  for _ in 1 2 3; do cast send "$handler" "mint(address)" "$eth" --private-key "$(cat "$P/ethereum.key")" -r "$AZL1" >/dev/null; done
  # The sandbox builds blocks only on transactions: keep it moving so L1→L2 messages land.
  pnpm -s exec tsx mainnet/rehearsal/nudge.ts > "$R/nudge.log" 2>&1 &
  echo $! > "$R/nudge.pid"
  pnpm -s exec tsx testnet/rehearsal/iris.ts > "$R/iris.log" 2>&1 &
  echo $! > "$R/iris.pid"
  until curl -s -o /dev/null "$IRIS_URL/v2/messages/5"; do sleep 0.5; done
  # The kit deploys target/deploy/eclyps_gateway.so; anchor build writes it.
  [ -f "$repo/target/deploy/eclyps_gateway.so" ] || { echo "target/deploy/eclyps_gateway.so missing: anchor build"; exit 1; }
  echo "stack up: solana :8899 (mainnet CCTP), fork :8546, aztec :8080 (+ L1 :8545), iris :8547"
}

kit() { pnpm -s exec tsx mainnet/deploy.ts "$@" --rehearsal; }
# The owner's part: read the dry run, write its digest to the confirmation file. Then send.
confirm_send() {
  local name=$1; shift
  local out d
  out=$(kit "$@" 2>&1 | tee -a "$R/kit.log")
  echo "$out" | tail -n 25
  d=$(grep -o 'plan digest: [0-9a-f]*' <<<"$out" | tail -1 | cut -d' ' -f3 || true)
  if [ -z "$d" ]; then echo "($name: nothing to send)"; return 0; fi
  mkdir -p "$P/confirm" && echo "$d" > "$P/confirm/$name.ok"
  kit "$@" --send 2>&1 | tee -a "$R/kit.log" | tail -n 25
}
expect_refusal() {
  local what=$1; shift
  if "$@" > "$R/refusal.log" 2>&1; then echo "FAIL  $what: it did not refuse"; cat "$R/refusal.log"; exit 1; fi
  echo "PASS  $what: $(grep -o 'refus[^.]*' "$R/refusal.log" | head -1)"
}

kitrun() {
  admin=$(json "$R/ids.json" '["admin"]'); guardian=$(json "$R/ids.json" '["guardian"]'); eth=$(json "$R/ids.json" '["ethereum"]')
  echo "--- the gate refuses ---"
  rm -f "$P/confirm/gate-selftest.ok"
  expect_refusal "send without a confirmation file" kit gate-selftest --send
  mkdir -p "$P/confirm" && echo 0000000000000000 > "$P/confirm/gate-selftest.ok"
  expect_refusal "send with a stale digest" kit gate-selftest --send
  rm -f "$P/confirm/gate-selftest.ok"
  expect_refusal "--rehearsal with a public endpoint" env ETH_RPC_URL=https://ethereum-rpc.publicnode.com pnpm -s exec tsx mainnet/deploy.ts preflight --rehearsal
  # Mainnet mode, gate only (no network): --send needs --mainnet and the file.
  T="$R/mainnet-gate"; rm -rf "$T"; mkdir -p "$T/confirm"
  expect_refusal "mainnet --send without --mainnet" env -u SOLANA_RPC_URL -u ETH_RPC_URL -u AZTEC_NODE_URL -u AZTEC_L1_RPC_URL ECLYPS_MAINNET_DIR="$T" ECLYPS_RECORD="$T/m.json" pnpm -s exec tsx mainnet/deploy.ts gate-selftest --send
  expect_refusal "mainnet --send --mainnet without the file" env -u SOLANA_RPC_URL -u ETH_RPC_URL -u AZTEC_NODE_URL -u AZTEC_L1_RPC_URL ECLYPS_MAINNET_DIR="$T" ECLYPS_RECORD="$T/m.json" pnpm -s exec tsx mainnet/deploy.ts gate-selftest --send --mainnet
  echo "--- kit, step by step ---"
  kit preflight 2>&1 | tee -a "$R/kit.log" | grep -E "PASS|FAIL|WARN|checks"
  confirm_send gateway gateway --program-keypair "$PROGRAM_KEYPAIR"
  # The portal through the external signer: unsigned export, signed elsewhere, then broadcast.
  confirm_send portal portal --from "$eth"
  if [ -f "$P/unsigned-portal.json" ] && [ ! -f "$P/portal.raw.done" ]; then
    pnpm -s exec tsx mainnet/rehearsal/sign.ts "$P/unsigned-portal.json" "$P/portal.raw"
    kit portal --from "$eth" --send --signed "$P/portal.raw" 2>&1 | tee -a "$R/kit.log" | tail -n 3
    touch "$P/portal.raw.done"
  fi
  confirm_send init init --guardian "$guardian"
  kit aztec 2>&1 | tail -n 3 # creates the Aztec admin key (dry run), so fee-juice knows where to bridge
  confirm_send fee-juice-admin fee-juice --to admin --amount 500 --max-gwei 1000 # the sandbox L1 runs at ~60 gwei
  confirm_send aztec aztec
  confirm_send fee-juice-fpc fee-juice --to fpc --amount 500 --max-gwei 1000
  confirm_send aztec aztec
  confirm_send wire wire
  kit verify 2>&1 | tee -a "$R/kit.log" | grep -E "PASS|FAIL|WARN|checks"
}

crossing() {
  pnpm -s exec tsx mainnet/rehearsal/crossing.ts 2>&1 | tee "$R/crossing.log"
  guardian=$(json "$R/ids.json" '["guardian"]')
  confirm_send pause_deposits pause --guardian-keypair "$P/solana-guardian.json"
  confirm_send unpause_deposits unpause --guardian-keypair "$P/solana-guardian.json"
}

down() {
  # The Aztec local network runs its own anvil as a child: stop the children first.
  [ -f "$R/aztec.pid" ] && pkill -P "$(cat "$R/aztec.pid")" 2>/dev/null || true
  for f in "$R"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  sleep 2
  rm -rf "$R/ledger" "$P/pxe"
  echo "stopped; ledger and PXE deleted (records and logs kept in $R)"
}

case "$mode" in
  up) up ;;
  kit) kitrun ;;
  crossing) crossing ;;
  down) down ;;
  all) trap down EXIT; up; kitrun; crossing ;;
  *) echo "usage: rehearse.sh [all|up|kit|crossing|down]"; exit 1 ;;
esac
