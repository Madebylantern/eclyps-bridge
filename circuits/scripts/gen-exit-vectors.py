"""Writes circuits/vectors/exit.json (exit hook + exit content, ADR 0009) with Python only, apart from
the implementations it checks: python3 circuits/scripts/gen-exit-vectors.py > circuits/vectors/exit.json

hook    = u8 2 | u64 BE denomination | u64 BE exitEpochId | u16 BE count | bytes32 root
content = sha256ToField(root32 | u256 BE count | u256 BE exitEpochId | u256 BE denomination)
          sha256ToField(x) = 0x00 || sha256(x)[0:31]
"""
import hashlib
import json
import sys

R = 21888242871839275222246405745257275088548364400416034343698204186575808495617

cases = [
    # The Solana leg's fixture batch (sdk/test/fixtures/exit-claim.json): $1,000 x 3, exit epoch 7.
    (1_000_000_000, 7, 3, 0x29CDD3F1226EE08FDF0EB1E902F95E91F8FE9A2D5889954132C68B63771820B9),
    # Smallest: one $100 exit in exit epoch 0, root 1.
    (100_000_000, 0, 1, 1),
    # Byte order: every byte of the id differs; count 255 = 0x00ff; $1 (testnet denomination).
    (1_000_000, 0x0102030405060708, 255, 0x0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF),
    # Edges: $10,000, the largest id, a full tree (256 = 0x0100), the largest canonical root r - 1.
    (10_000_000_000, 2**64 - 1, 256, R - 1),
]


def be(n, width):
    return n.to_bytes(width, "big")


out = []
for denomination, exit_epoch_id, count, root in cases:
    assert 0 < denomination < 2**64 and 0 <= exit_epoch_id < 2**64 and 1 <= count <= 256 and root < R
    assert denomination * count < 2**64
    hook = bytes([2]) + be(denomination, 8) + be(exit_epoch_id, 8) + be(count, 2) + be(root, 32)
    assert len(hook) == 51
    words = be(root, 32) + be(count, 32) + be(exit_epoch_id, 32) + be(denomination, 32)
    content = b"\x00" + hashlib.sha256(words).digest()[:31]
    out.append(
        {
            "denomination": str(denomination),
            "exitEpochId": str(exit_epoch_id),
            "count": count,
            "root": "0x" + be(root, 32).hex(),
            "hook": "0x" + hook.hex(),
            "content": "0x" + content.hex(),
        }
    )

doc = {
    "description": "Exit vectors (ADR 0009). hook: the 51-byte CCTP hookData the portal's exitBatch "
    "burns with and the gateway's receive_exit parses. content: the L2->L1 message content "
    "the Aztec claim contract sends and the portal consumes.",
    "hook": "u8 version 2 | u64 denomination | u64 exitEpochId | u16 count | bytes32 root (big-endian)",
    "content": "sha256ToField(abi.encode(bytes32 root, uint256 count, uint256 exitEpochId, uint256 denomination)): "
    "0x00 followed by the first 31 bytes of sha256 over four 32-byte big-endian words",
    "vectors": out,
}
json.dump(doc, sys.stdout, indent=2)
sys.stdout.write("\n")
