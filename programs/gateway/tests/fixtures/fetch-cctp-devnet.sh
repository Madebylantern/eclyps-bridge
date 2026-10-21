#!/usr/bin/env bash
# Refreshes the CCTP V2 devnet fixtures used by the gateway's send_batch and receive_exit tests:
# Circle's deployed program binaries (gzip), the state accounts a Solana -> Ethereum burn reads,
# and those an Ethereum -> Solana receive reads (ADR 0009).
# Source: Solana devnet via the public RPC. Programs are Apache-2.0 (circlefin/solana-cctp-contracts).
set -euo pipefail
cd "$(dirname "$0")/cctp-devnet"
URL=${SOLANA_RPC_URL:-https://api.devnet.solana.com}
TMM=CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe
MT=CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC
for p in $TMM $MT; do
  solana program dump -u "$URL" "$p" "$p.so" >/dev/null
  gzip -9 -n -f "$p.so"
done
# message_transmitter, token_messenger, remote_token_messenger(domain 0), token_minter,
# local_token(devnet USDC), devnet USDC mint; for receives: token_pair(domain 0, Sepolia USDC),
# custody(devnet USDC), and the USDC ATA of token_messenger.fee_recipient.
ACCOUNTS=(
  W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU
  AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W
  3EzN2mcmdfSNGXRCAixSpTteK6ywdmFDZZWvkMnznFt9
  E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux
  7MwmWTK2R9Na6rnoSAEt5gytFmSZj9WLVdazvxvru9AU
  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
  AR6mnr7XRVDUvK7SDGKpREBwGQMxZbKRsY22gXN8bvQU
  CFUgYpbas5UdJkwwSobYgzhFqFuj6C8MfXwBetE3o4SY
  2cDia1Ga9XDBGWVyFmaqiE7FKMDEtcy3xoRCW7B7S4es
)
for a in "${ACCOUNTS[@]}"; do
  solana account -u "$URL" "$a" --output json-compact > "$a.json"
done
solana slot -u "$URL" > fetched-at-slot.txt
sha256sum ./*.so.gz ./*.json > SHA256SUMS
echo "fixtures refreshed at slot $(cat fetched-at-slot.txt)"
