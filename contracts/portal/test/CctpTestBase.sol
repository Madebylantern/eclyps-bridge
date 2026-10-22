// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {BatchHook} from "../src/libraries/BatchHook.sol";

/// @notice Builds CCTP V2 burn messages byte-for-byte as Iris returns them.
abstract contract CctpTestBase is Test {
    /// How far behind Sepolia's head the fork tests start. Forking at "latest" through a load-balanced
    /// public RPC can fail: one backend names the newest block, the next has not seen it yet.
    uint256 internal constant FORK_LAG = 8;

    /// Forks Sepolia `FORK_LAG` blocks behind its head.
    function forkSepolia(string memory rpc) internal {
        bytes memory head = vm.rpc(rpc, "eth_blockNumber", "[]");
        uint256 n;
        for (uint256 i = 0; i < head.length; i++) {
            n = (n << 8) | uint8(head[i]);
        }
        vm.createSelectFork(rpc, n - FORK_LAG);
    }

    // Live values (ADR 0002): Solana devnet / Ethereum Sepolia.
    bytes32 internal constant SOLANA_TMM =
        0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893;
    bytes32 internal constant SOLANA_DEVNET_USDC =
        0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7;
    address internal constant SEPOLIA_TOKEN_MESSENGER = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA;
    address internal constant SEPOLIA_MESSAGE_TRANSMITTER =
        0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275;
    address internal constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    bytes32 internal constant GATEWAY = keccak256("eclyps gateway PDA (test)");
    // Gateway exit PDAs for program 4GG6NHxU…B1jf (ADR 0009 table; SDK exitAuthorityPda and
    // exitCustodyPda): the exit destinationCaller and mintRecipient.
    bytes32 internal constant EXIT_AUTHORITY =
        0xda65c3d97adae3d9f14bd063b2e7fc056247fed734ffc3c7eacd96fc40aa9221;
    bytes32 internal constant EXIT_CUSTODY =
        0xa3e45bcc294c9f86dd3017373f545720c2aa6f9fbdf07b822dcc3ffa6e735dd5;
    // computeSecretHash([0]) from @aztec-labs/stdlib 6.0.0-rc.3 (scripts/s2-aztec/secret-hash.ts).
    bytes32 internal constant SECRET_HASH_ZERO =
        0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250;
    uint64 internal constant HUNDRED = 100e6;
    uint64 internal constant THOUSAND = 1000e6;
    bytes32 internal constant ROOT =
        0x0c5e5b6d0a4b8ff4ad3dcc28c0e0d75b78f6a8b9e8d0c7c6b8b0a1c2d3e4f501;

    struct Msg {
        uint32 version;
        uint32 sourceDomain;
        uint32 destinationDomain;
        bytes32 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes32 destinationCaller;
        uint32 minFinality;
        uint32 finalityExecuted;
        uint32 bodyVersion;
        bytes32 burnToken;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 messageSender;
        uint256 maxFee;
        uint256 feeExecuted;
        uint256 expirationBlock;
        bytes hookData;
    }

    function toB32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// Big-endian readers over a message held in memory (CctpMessageV2 reads calldata).
    function b32At(bytes memory m, uint256 o) internal pure returns (bytes32 v) {
        require(m.length >= o + 32, "out of range");
        assembly {
            v := mload(add(add(m, 32), o))
        }
    }

    function u32At(bytes memory m, uint256 o) internal pure returns (uint32) {
        return uint32(bytes4(b32At(m, o)));
    }

    function slice(bytes memory m, uint256 from, uint256 to)
        internal
        pure
        returns (bytes memory s)
    {
        s = new bytes(to - from);
        for (uint256 i; i < s.length; ++i) {
            s[i] = m[from + i];
        }
    }

    function hook(uint64 denomination, uint64 epochId, uint16 leafCount, bytes32 root)
        internal
        pure
        returns (bytes memory)
    {
        return BatchHook.encode(BatchHook.Batch(denomination, epochId, leafCount, root));
    }

    /// A well-formed message for `receiver`: `leafCount` notes of $100 in epoch `epochId`.
    function goodMsg(address receiver, uint64 epochId, uint16 leafCount)
        internal
        pure
        returns (Msg memory m)
    {
        m = Msg({
            version: 1,
            sourceDomain: 5,
            destinationDomain: 0,
            nonce: keccak256(abi.encode("nonce", epochId, leafCount)),
            sender: SOLANA_TMM,
            recipient: toB32(SEPOLIA_TOKEN_MESSENGER),
            destinationCaller: toB32(receiver),
            minFinality: 2000,
            finalityExecuted: 2000,
            bodyVersion: 1,
            burnToken: SOLANA_DEVNET_USDC,
            mintRecipient: toB32(receiver),
            amount: uint256(leafCount) * HUNDRED,
            messageSender: GATEWAY,
            maxFee: 0,
            feeExecuted: 0,
            expirationBlock: 0,
            hookData: hook(HUNDRED, epochId, leafCount, ROOT)
        });
    }

    function encode(Msg memory m) internal pure returns (bytes memory) {
        bytes memory header = abi.encodePacked(
            m.version,
            m.sourceDomain,
            m.destinationDomain,
            m.nonce,
            m.sender,
            m.recipient,
            m.destinationCaller,
            m.minFinality,
            m.finalityExecuted
        );
        bytes memory body = abi.encodePacked(
            m.bodyVersion,
            m.burnToken,
            m.mintRecipient,
            m.amount,
            m.messageSender,
            m.maxFee,
            m.feeExecuted,
            m.expirationBlock,
            m.hookData
        );
        return bytes.concat(header, body);
    }
}
