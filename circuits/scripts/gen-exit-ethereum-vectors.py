"""Writes circuits/vectors/exit-ethereum.json (leave to Ethereum, ADR 0014 section 4) with Python only,
apart from the implementations it checks:
python3 circuits/scripts/gen-exit-ethereum-vectors.py > circuits/vectors/exit-ethereum.json

commitment = sha256ToField(address recipient as a 32-byte word | bytes32 exitSecret)
content    = sha256ToField(u256 TAG | bytes32 commitment | u256 denomination)
             TAG = the ASCII bytes of "eclyps:exit-to-ethereum" as a big-endian integer
sha256ToField(x) = 0x00 || sha256(x)[0:31]
"""
import hashlib
import json
import sys

R = 21888242871839275222246405745257275088548364400416034343698204186575808495617
TAG_TEXT = b"eclyps:exit-to-ethereum"
TAG = int.from_bytes(TAG_TEXT, "big")

cases = [
    # $100 to a plain address, a small secret.
    (0x00000000000000000000000000000000000000AA, 1, 100_000_000),
    # $1,000; every byte of the recipient differs; the secret a typical field element.
    (0x0102030405060708090A0B0C0D0E0F1011121314,
     0x2D599EF16CFE8609EE72B1FFD859F5832D677D5BDA6D5221F14D48EB4EC4EBE6, 1_000_000_000),
    # $1 (testnet denomination), the largest address, the largest canonical secret r - 1.
    (2**160 - 1, R - 1, 1_000_000),
    # $10,000, the zero secret (allowed by the format; the app never derives it).
    (0xDEADBEEF00000000000000000000000000000000, 0, 10_000_000_000),
]


def be(n, width):
    return n.to_bytes(width, "big")


def sha256_to_field(data):
    return b"\x00" + hashlib.sha256(data).digest()[:31]


out = []
for recipient, secret, denomination in cases:
    assert 0 < recipient < 2**160 and 0 <= secret < R and 0 < denomination < 2**64
    commitment = sha256_to_field(be(recipient, 32) + be(secret, 32))
    content = sha256_to_field(be(TAG, 32) + commitment + be(denomination, 32))
    out.append(
        {
            "recipient": "0x" + be(recipient, 20).hex(),
            "exitSecret": "0x" + be(secret, 32).hex(),
            "denomination": str(denomination),
            "commitment": "0x" + commitment.hex(),
            "content": "0x" + content.hex(),
        }
    )

doc = {
    "description": "Leave to Ethereum vectors (ADR 0014 section 4). commitment: made by the app, burned "
    "with on Aztec (EclypsClaim.exit_to_ethereum) and rebuilt by EclypsPortal.claimToEthereum. content: the "
    "L2->L1 message content the claim contract sends and the portal consumes.",
    "tag": "0x" + be(TAG, 32).hex(),
    "tagText": TAG_TEXT.decode(),
    "commitment": "sha256ToField(abi.encode(address recipient, bytes32 exitSecret))",
    "content": "sha256ToField(abi.encode(uint256 tag, bytes32 commitment, uint256 denomination))",
    "vectors": out,
}
json.dump(doc, sys.stdout, indent=2)
sys.stdout.write("\n")
