// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

/// @notice Eclyps batch hook carried in CCTP V2 hookData (ADR 0002). Packed, big-endian, 51 bytes:
///   [0]      version     uint8   = 1
///   [1..9]   denomination uint64 (USDC base units, 6 decimals)
///   [9..17]  epochId     uint64
///   [17..19] leafCount   uint16
///   [19..51] root        bytes32 (Poseidon BN254 batch root, ADR 0004)
/// The leading version byte keeps hookData clear of Circle's reserved "cctp-forward" prefix.
library BatchHook {
    uint8 internal constant VERSION = 1;
    uint256 internal constant LENGTH = 51;

    struct Batch {
        uint64 denomination;
        uint64 epochId;
        uint16 leafCount;
        bytes32 root;
    }

    error BadHookLength(uint256 length);
    error BadHookVersion(uint8 version);

    function decode(bytes calldata h) internal pure returns (Batch memory b) {
        if (h.length != LENGTH) revert BadHookLength(h.length);
        if (uint8(h[0]) != VERSION) revert BadHookVersion(uint8(h[0]));
        b.denomination = uint64(bytes8(h[1:9]));
        b.epochId = uint64(bytes8(h[9:17]));
        b.leafCount = uint16(bytes2(h[17:19]));
        b.root = bytes32(h[19:51]);
    }

    function encode(Batch memory b) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, b.denomination, b.epochId, b.leafCount, b.root);
    }
}
