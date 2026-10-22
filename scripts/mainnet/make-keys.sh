#!/usr/bin/env bash
# Makes the mainnet Solana keys on the computer you will deploy from (docs/mainnet-checklist.md §5)
# and prints the public addresses to share. Secrets stay on this computer; nothing is sent.
# It never overwrites a key that already exists, so running it again only prints the addresses.
#
#   bash scripts/mainnet/make-keys.sh [/Volumes/ECLYPS]   # the encrypted USB stick for the admin key
#
# Before: the USB stick formatted APFS (Encrypted) and plugged in. Optional: a Ledger, unlocked, with
# its Ethereum app open and Blind signing on; without one, the Ethereum deployer is a key file.
set -euo pipefail
usb="${1:-/Volumes/ECLYPS}"
dir="${ECLYPS_MAINNET_DIR:-$HOME/.config/eclyps/mainnet}"

need() { command -v "$1" >/dev/null || { echo "$1 is missing. Install it with: $2 (then open a new terminal)"; exit 1; }; }
need solana-keygen 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
need cast 'curl -L https://foundry.paradigm.xyz | bash && foundryup'
need openssl 'it comes with macOS; on Linux: apt install openssl'
[ -d "$usb" ] || { echo "No USB stick at $usb. Format it APFS (Encrypted), name it ECLYPS, plug it in."; exit 1; }
mkdir -p "$dir" && chmod 700 "$dir"

# A new keypair, unless the file exists. solana-keygen shows its seed phrase once: the only backup.
make_key() {
  if [ -e "$1" ]; then echo "$2: keeping $1"; return; fi
  echo; echo "== $2: write the seed phrase below on paper; it is the only backup."
  solana-keygen new --no-bip39-passphrase --outfile "$1"
  chmod 600 "$1"
}
make_key "$usb/solana-admin.json" "Solana admin (on the USB stick)"
make_key "$dir/solana-guardian.json" "Guardian"

# The Ethereum deployer: a Ledger if one answers (unlocked, Ethereum app open), else a key file that
# deploy.ts uses by default. The deployer has no power left after the portal's two binds, so a key
# file is enough; it never leaves this computer.
if eth=$(cast wallet address --ledger --mnemonic-derivation-path "m/44'/60'/0'/0/0" 2>/dev/null); then
  eth_kind="Ledger"
else
  if [ ! -e "$dir/ethereum.key" ]; then
    # 32 random bytes; nothing secret is printed (cast's own output differs between versions).
    (umask 077 && printf '0x%s\n' "$(openssl rand -hex 32)" > "$dir/ethereum.key")
    grep -Eq '^0x[0-9a-fA-F]{64}$' "$dir/ethereum.key" || { rm -f "$dir/ethereum.key"; echo "could not make the Ethereum key"; exit 1; }
    echo; echo "== Ethereum deployer: no Ledger found, so a key file was made at $dir/ethereum.key"
  fi
  eth=$(cast wallet address --private-key "$(cat "$dir/ethereum.key")")
  eth_kind="key file"
fi
echo
echo "Send these (public addresses, safe to share):"
printf "  %-31s%s\n" "Ethereum deployer ($eth_kind)" "$eth" \
  "Solana admin" "$(solana-keygen pubkey "$usb/solana-admin.json")" \
  "Guardian" "$(solana-keygen pubkey "$dir/solana-guardian.json")"
echo
echo "Then eject the USB stick: it is plugged in only for the gateway deploy and init."
