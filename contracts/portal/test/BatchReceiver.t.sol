// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {BatchReceiver} from "../src/BatchReceiver.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {BatchHook} from "../src/libraries/BatchHook.sol";
import {CctpTestBase} from "./CctpTestBase.sol";
import {MockMessageTransmitter, MockUSDC} from "./mocks/MockCctp.sol";

contract BatchReceiverTest is CctpTestBase {
    MockUSDC usdc;
    MockMessageTransmitter mt;
    BatchReceiver receiver;

    function setUp() public {
        usdc = new MockUSDC();
        mt = new MockMessageTransmitter(usdc);
        receiver = new BatchReceiver(
            IReceiverV2(address(mt)),
            IERC20Minimal(address(usdc)),
            SOLANA_TMM,
            SEPOLIA_TOKEN_MESSENGER,
            SOLANA_DEVNET_USDC,
            GATEWAY
        );
    }

    function relay(Msg memory m) internal returns (BatchHook.Batch memory) {
        return receiver.relay(encode(m), "");
    }

    function test_relay_decodes_root_and_receives_funds() public {
        Msg memory m = goodMsg(address(receiver), 7, 8);
        vm.expectEmit(address(receiver));
        emit BatchReceiver.BatchReceived(ROOT, HUNDRED, 7, 8, 800e6, m.nonce);
        BatchHook.Batch memory b = relay(m);
        assertEq(b.root, ROOT);
        assertEq(b.epochId, 7);
        assertEq(b.leafCount, 8);
        assertEq(b.denomination, HUNDRED);
        assertEq(usdc.balanceOf(address(receiver)), 800e6);
        assertTrue(receiver.received(HUNDRED, 7));
    }

    function test_hook_layout_is_51_bytes_big_endian() public pure {
        bytes memory h = hook(0x0102030405060708, 0x1112131415161718, 0x2122, ROOT);
        assertEq(h.length, 51);
        assertEq(uint8(h[0]), 1);
        assertEq(uint8(h[1]), 0x01);
        assertEq(uint8(h[8]), 0x08);
        assertEq(uint8(h[9]), 0x11);
        assertEq(uint8(h[17]), 0x21);
        assertEq(uint8(h[18]), 0x22);
        assertEq(uint8(h[19]), uint8(ROOT[0]));
    }

    function test_replay_of_same_epoch_rejected() public {
        relay(goodMsg(address(receiver), 7, 8));
        Msg memory again = goodMsg(address(receiver), 7, 8);
        again.nonce = keccak256("another nonce");
        vm.expectRevert(abi.encodeWithSelector(BatchReceiver.AlreadyReceived.selector, HUNDRED, 7));
        relay(again);
    }

    function test_same_epoch_other_denomination_ok() public {
        relay(goodMsg(address(receiver), 7, 8));
        Msg memory m = goodMsg(address(receiver), 7, 2);
        m.amount = 2 * 1000e6;
        m.hookData = hook(1000e6, 7, 2, ROOT);
        relay(m);
        assertEq(usdc.balanceOf(address(receiver)), 800e6 + 2000e6);
    }

    function test_rejects_wrong_source_domain() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.sourceDomain = 6;
        vm.expectRevert(abi.encodeWithSelector(BatchReceiver.WrongSourceDomain.selector, 6));
        relay(m);
    }

    function test_rejects_generic_message_from_other_solana_program() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.sender = keccak256("some program using send_message");
        vm.expectRevert(abi.encodeWithSelector(BatchReceiver.WrongSender.selector, m.sender));
        relay(m);
    }

    function test_rejects_wrong_recipient() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.recipient = toB32(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(BatchReceiver.WrongRecipient.selector, m.recipient));
        relay(m);
    }

    function test_rejects_open_destination_caller() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.destinationCaller = bytes32(0);
        vm.expectRevert(
            abi.encodeWithSelector(BatchReceiver.WrongDestinationCaller.selector, bytes32(0))
        );
        relay(m);
    }

    function test_rejects_wrong_burn_token() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.burnToken = keccak256("not usdc");
        vm.expectRevert(abi.encodeWithSelector(BatchReceiver.WrongBurnToken.selector, m.burnToken));
        relay(m);
    }

    function test_rejects_wrong_mint_recipient() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.mintRecipient = toB32(address(0xBEEF));
        vm.expectRevert(
            abi.encodeWithSelector(BatchReceiver.WrongMintRecipient.selector, m.mintRecipient)
        );
        relay(m);
    }

    function test_rejects_batch_from_other_solana_account() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.messageSender = keccak256("attacker wallet");
        vm.expectRevert(
            abi.encodeWithSelector(BatchReceiver.WrongMessageSender.selector, m.messageSender)
        );
        relay(m);
    }

    function test_rejects_fast_transfer_fee() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.maxFee = 1e6;
        m.feeExecuted = 1;
        vm.expectRevert(abi.encodeWithSelector(BatchReceiver.FeeCharged.selector, 1));
        relay(m);
    }

    function test_rejects_amount_not_matching_hook() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.amount = 799e6;
        vm.expectRevert(BatchReceiver.BadBatch.selector);
        relay(m);
    }

    function test_rejects_bad_hook_version_and_length() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.hookData[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(BatchHook.BadHookVersion.selector, 2));
        relay(m);
        m = goodMsg(address(receiver), 1, 8);
        m.hookData = bytes.concat(m.hookData, hex"00");
        vm.expectRevert(abi.encodeWithSelector(BatchHook.BadHookLength.selector, 52));
        relay(m);
    }

    function test_rejects_non_field_root_and_bad_counts() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.hookData = hook(HUNDRED, 1, 8, bytes32(type(uint256).max));
        vm.expectRevert(BatchReceiver.BadBatch.selector);
        relay(m);
        m = goodMsg(address(receiver), 1, 257);
        vm.expectRevert(BatchReceiver.BadBatch.selector);
        relay(m);
        m = goodMsg(address(receiver), 1, 0);
        vm.expectRevert(BatchReceiver.BadBatch.selector);
        relay(m);
    }

    function test_failed_relay_leaves_nonce_reusable() public {
        Msg memory m = goodMsg(address(receiver), 1, 8);
        m.amount = 1; // inconsistent with hook -> revert before receiveMessage
        vm.expectRevert(BatchReceiver.BadBatch.selector);
        relay(m);
        assertFalse(mt.usedNonces(m.nonce));
    }

    function testFuzz_roundtrip(uint64 epochId, uint16 leafCount, bytes32 root) public {
        leafCount = uint16(bound(leafCount, 1, 256));
        root = bytes32(
            bound(
                uint256(root),
                0,
                21888242871839275222246405745257275088548364400416034343698204186575808495616
            )
        );
        Msg memory m = goodMsg(address(receiver), epochId, leafCount);
        m.hookData = hook(HUNDRED, epochId, leafCount, root);
        BatchHook.Batch memory b = relay(m);
        assertEq(b.root, root);
        assertEq(b.epochId, epochId);
        assertEq(b.leafCount, leafCount);
        assertEq(usdc.balanceOf(address(receiver)), uint256(leafCount) * HUNDRED);
    }
}
