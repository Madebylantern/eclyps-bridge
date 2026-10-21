// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {CctpMessageV2} from "../src/libraries/CctpMessageV2.sol";

/// Parser offsets checked against a real Solana devnet -> Sepolia CCTP V2 message with
/// hook data, as returned by Iris (fetched 2026-10-11; not an Eclyps message).
contract IrisFixtureTest is Test {
    using CctpMessageV2 for bytes;

    function parse(bytes calldata m)
        external
        pure
        returns (bytes32[8] memory b, uint256[8] memory u, bytes memory hook)
    {
        b = [
            m.nonce(),
            m.sender(),
            m.recipient(),
            m.destinationCaller(),
            m.burnToken(),
            m.mintRecipient(),
            m.messageSender(),
            bytes32(0)
        ];
        u = [
            uint256(m.version()),
            m.sourceDomain(),
            m.destinationDomain(),
            m.minFinalityThreshold(),
            m.finalityThresholdExecuted(),
            m.amount(),
            m.feeExecuted(),
            m.bodyVersion()
        ];
        hook = m.hookData();
    }

    function test_real_message_offsets() public view {
        string memory j = vm.readFile("test/fixtures/iris-devnet-hook-message.json");
        bytes memory message = vm.parseJsonBytes(j, ".message");
        (bytes32[8] memory b, uint256[8] memory u, bytes memory hook) = this.parse(message);
        assertEq(b[0], vm.parseJsonBytes32(j, ".nonce"));
        assertEq(b[1], vm.parseJsonBytes32(j, ".sender"));
        assertEq(b[2], vm.parseJsonBytes32(j, ".recipient"));
        assertEq(b[3], vm.parseJsonBytes32(j, ".destinationCaller"));
        assertEq(b[4], vm.parseJsonBytes32(j, ".burnToken"));
        assertEq(b[5], vm.parseJsonBytes32(j, ".mintRecipient"));
        assertEq(b[6], vm.parseJsonBytes32(j, ".messageSender"));
        assertEq(u[0], 1);
        assertEq(u[1], vm.parseJsonUint(j, ".sourceDomain"));
        assertEq(u[2], vm.parseJsonUint(j, ".destinationDomain"));
        assertEq(u[3], vm.parseJsonUint(j, ".minFinalityThreshold"));
        assertEq(u[4], vm.parseJsonUint(j, ".finalityThresholdExecuted"));
        assertEq(u[5], vm.parseJsonUint(j, ".amount"));
        assertEq(u[6], vm.parseJsonUint(j, ".feeExecuted"));
        assertEq(u[7], 1);
        assertEq(hook, vm.parseJsonBytes(j, ".hookData"));
        assertEq(message.length, 376 + hook.length);
    }
}
