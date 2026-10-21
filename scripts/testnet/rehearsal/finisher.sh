# Sourced by `rehearse.sh finisher`, after the deposit phase: the testnet finisher
# (finisher/src/testnet.ts) on the stand-ins, with its own throwaway keys. It shows:
#   1. one pass while Iris is down: close_epoch and send_batch; the relay fails and backs off;
#   2. Iris back, the finisher left running: attestation, relay, then it waits for Aztec (the L1->L2
#      message is on the fork, so the Aztec testnet never includes it); a second finisher on the
#      same state is refused; SIGTERM stops it cleanly;
#   3. a restart sends, relays and registers nothing again;
#   4. a lost record is rebuilt from the chains (epoch status, the burn, the portal's events);
#   5. a lone deposit: once its epoch has ended below the batch minimum, the finisher rolls it over
#      (so it becomes refundable, ADR 0010), and again only after the new end.
F="$R/finisher"
mkdir -p "$F"
fids=$(ECLYPS_KEYS="$F/keys" pnpm -s exec tsx testnet/rehearsal/accounts.ts)
fsol=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["solana"])' "$fids")
feth=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sepolia"])' "$fids")
solana airdrop 1 "$fsol" -u "$SOLANA_RPC_URL" >/dev/null
cast rpc anvil_setBalance "$feth" 0xDE0B6B3A7640000 -r "$L1" >/dev/null # 1 ETH on the fork
echo "finisher keys (throwaway): solana $fsol, sepolia $feth"
# The fork's portal is bound to a placeholder claim for $1: name it, so the batch reaches the Aztec step.
python3 - "$ECLYPS_RECORD" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
r["aztec"]["claims"]["1000000"] = "0x00000000000000000000000000000000000000000000000000000000000ec1a1"
json.dump(r, open(sys.argv[1], "w"), indent=2)
EOF

export DEPLOYMENT="$ECLYPS_RECORD" FINISHER_SOLANA_KEYPAIR="$F/keys/devnet.json" FINISHER_SEPOLIA_KEY="$F/keys/sepolia.key"
export FINISHER_STATE="$F/state/finisher-state.json"
# node --import tsx: the finisher is the process itself, so a signal reaches it.
finisher() { (cd "$repo/finisher" && exec node --import tsx src/testnet.ts "$@"); }
batch() { python3 -c 'import json,sys; b=json.load(open(sys.argv[1]))["batches"]["1000000:0"]; print(json.dumps({k: b.get(k) for k in sys.argv[2:]}))' "$FINISHER_STATE" "$@"; }
has() { python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["batches"]["1000000:0"].get(sys.argv[2]) else 1)' "$FINISHER_STATE" "$1"; }
fail() { echo "FAIL: $*"; exit 1; }

echo "--- 1. one pass while Iris is down"
finisher --once
has burnSig || fail "the batch was not sent"
has message && fail "attested without Iris"
batch sent sentByUs reward failures lastError

echo "--- 2. Iris back; the finisher left running (a pass every 5 s)"
start_iris
# exec: $! is the finisher itself, so SIGTERM reaches it.
(cd "$repo/finisher" && FINISHER_INTERVAL=5 exec node --import tsx src/testnet.ts) > "$F/run.log" 2>&1 &
fpid=$!
pids+=("$fpid") # stopped by the cleanup trap if this script fails
for _ in $(seq 1 90); do has l1ToL2Hash 2>/dev/null && break; sleep 2; done
has l1ToL2Hash || { cat "$F/run.log"; fail "not relayed"; }
sleep 12 # one more pass: register_batch waits for Aztec
echo "a second finisher on the same state:"
if finisher --once > "$F/second.log" 2>&1; then fail "a second finisher ran"; fi
cat "$F/second.log"
kill -TERM "$fpid"
wait "$fpid" || true
cat "$F/run.log"
[ -e "$FINISHER_STATE.lock" ] && fail "lock not released"
batch relayTx l1ToL2Hash l1ToL2Index registered

echo "--- 3. restart: nothing is done twice"
finisher --once | tee "$F/restart.log"
if grep -E "close_epoch|CCTP burn|Sepolia tx .* sent|Aztec tx" "$F/restart.log"; then fail "a step ran twice"; fi

echo "--- 4. the record is lost: rebuilt from the chains"
mv "$FINISHER_STATE" "$F/state-before.json"
finisher --once | tee "$F/rebuild.log"
if grep -E "close_epoch|CCTP burn|Sepolia tx .* sent|Aztec tx" "$F/rebuild.log"; then fail "a step ran twice"; fi
python3 - "$F/state-before.json" "$FINISHER_STATE" <<'EOF'
import json, sys
a = json.load(open(sys.argv[1]))["batches"]["1000000:0"]
b = json.load(open(sys.argv[2]))["batches"]["1000000:0"]
for k in ["root", "leafCount", "burnSig", "sentByUs", "reward", "l1ToL2Hash", "l1ToL2Index"]:
    assert a.get(k) == b.get(k), (k, a.get(k), b.get(k))
assert not a.get("registered") and not b.get("registered")
print(f"rebuilt: same burn, reward {b['reward']} (USDC base units) and L1->L2 message {b['l1ToL2Hash']} at leaf {b['l1ToL2Index']}")
EOF
[ "$(cast call "$portal" "received(uint64,uint64)(bool)" 1000000 0 -r "$L1")" = true ] || fail "portal did not receive the batch"

echo "--- 5. a lone deposit: its epoch is rolled over once per end"
# The finisher, not run.ts, sent run 0: record its burn, so run.ts deposits into the next epoch.
python3 - "$ECLYPS_RECORD" "$FINISHER_STATE" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
r["runs"][0]["burnSig"] = json.load(open(sys.argv[2]))["batches"]["1000000:0"]["burnSig"]
json.dump(r, open(sys.argv[1], "w"), indent=2)
EOF
pnpm -s exec tsx testnet/run.ts deposit 1
(cd "$repo/finisher" && FINISHER_INTERVAL=5 exec node --import tsx src/testnet.ts) > "$F/rollover.log" 2>&1 &
fpid=$!
pids+=("$fpid")
for _ in $(seq 1 240); do # two epoch ends, about 4 minutes each
  [ "$(grep -c '] rollover \$1 #1' "$F/rollover.log")" -ge 2 ] && break
  sleep 3
done
kill -TERM "$fpid"
wait "$fpid" || true
grep -E "close_epoch|rollover|stopped" "$F/rollover.log"
if grep -E "close_epoch .*#1" "$F/rollover.log"; then fail "closed an epoch below the batch minimum"; fi
python3 - "$F/rollover.log" <<'EOF'
import re, sys
log = open(sys.argv[1]).read().splitlines()
lines = [l for l in log if "] rollover $1 #1" in l]
assert len(lines) >= 2, "expected two rollovers, one per end"
t = [sum(int(x) * m for x, m in zip(l[1:9].split(":"), (3600, 60, 1))) for l in lines]
n = [int(re.search(r"\(rollover (\d+),", l).group(1)) for l in lines]
assert n[:2] == [1, 2], n  # read from the epoch on chain: no extra rollover in between
assert t[1] - t[0] >= 60, t  # waited for the new end (2,250 slots later) while a pass ran every 5 s
assert "2 rollovers" in log[-1], log[-1]
print(f"rollovers: #1, then #2 {t[1] - t[0]} s later (the next end); none in between")
EOF
echo "finisher rehearsal OK: close, send (earned the finisher share), Iris, relay; register waits for Aztec; resumes and rebuilds without repeating a step; rolls a lone deposit's epoch over once per end"
