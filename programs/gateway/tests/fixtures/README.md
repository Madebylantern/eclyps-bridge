# Test fixtures

`cctp-devnet/` holds Circle CCTP V2 as deployed on Solana devnet:
- **Program binaries** (gzip): TokenMessengerMinterV2 `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` and
  MessageTransmitterV2 `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`. Apache-2.0,
  circlefin/solana-cctp-contracts.
- **State accounts** read by a Solana → Ethereum burn: message_transmitter, token_messenger,
  remote_token_messenger (domain 0), token_minter, local_token and the devnet USDC mint.
- **State accounts** an Ethereum → Solana receive reads as well (ADR 0009, `receive_exit`):
  token_pair (domain 0 → Sepolia USDC `0x1c7D…7238`), Circle's USDC custody, and the USDC
  account of `token_messenger.fee_recipient`. These three were added at slot 510663649; the
  program binaries were checked byte-identical to devnet at that slot.

Refresh with `./fetch-cctp-devnet.sh`. It records the slot and checksums (`SHA256SUMS`). The tests load
these into LiteSVM so that `send_batch` and `receive_exit` run against the real CCTP code without a
network. For `receive_exit` the tests replace the two enabled attesters in the message_transmitter
account with test keys (layout in `tests/common/mod.rs`, `set_test_attesters`); nothing else is
changed.
