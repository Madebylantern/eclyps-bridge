// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

/// @notice Eclyps exit hook carried in CCTP V2 hookData from Ethereum to Solana (ADR 0009): the
/// batch hook's layout (BatchHook.sol, ADR 0002) with version 2. Packed, big-endian, 51 bytes:
///   [0]      version       uint8   = 2
///   [1..9]   denomination  uint64 (USDC base units, 6 decimals)
///   [9..17]  exitEpochId   uint64
///   [17..19] count         uint16
///   [19..51] root          bytes32 (Poseidon BN254 exit tree root, depth 8)
/// Identical to the SDK's `encodeExitHook` and the gateway's `exit_message::exit_hook`.
library ExitHook {
    uint8 internal constant VERSION = 2;
    uint256 internal constant LENGTH = 51;

    function encode(uint64 denomination, uint64 exitEpochId, uint16 count, bytes32 root)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(VERSION, denomination, exitEpochId, count, root);
    }
}
