// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {BatchReceiver} from "../src/BatchReceiver.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {BatchHook} from "../src/libraries/BatchHook.sol";
import {CctpTestBase} from "./CctpTestBase.sol";

interface IAttestable {
    function attesterManager() external view returns (address);
    function enableAttester(address) external;
    function setSignatureThreshold(uint256) external;
    function usedNonces(bytes32) external view returns (uint256);
}

/// @notice Runs BatchReceiver against Circle's *deployed* Sepolia CCTP V2 contracts
/// (MessageTransmitterV2 -> TokenMessengerV2 -> TokenMinterV2 -> USDC). The only
/// test-time change is the attester set: we cannot obtain Circle's signatures for a
/// synthetic message, so we impersonate the attester manager and enable a test attester.
/// Everything after signature verification is the real code path, including the
/// Solana (domain 5) remote TokenMessenger and the devnet USDC -> Sepolia USDC token pair.
/// Skipped unless SEPOLIA_RPC_URL is set.
contract BatchReceiverForkTest is CctpTestBase {
    BatchReceiver receiver;
    IAttestable mt = IAttestable(SEPOLIA_MESSAGE_TRANSMITTER);
    IERC20Minimal usdc = IERC20Minimal(SEPOLIA_USDC);
    uint256 attesterKey = 0xA77E57;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        receiver = new BatchReceiver(
            IReceiverV2(SEPOLIA_MESSAGE_TRANSMITTER),
            usdc,
            SOLANA_TMM,
            SEPOLIA_TOKEN_MESSENGER,
            SOLANA_DEVNET_USDC,
            GATEWAY
        );

        vm.startPrank(mt.attesterManager());
        mt.enableAttester(vm.addr(attesterKey));
        mt.setSignatureThreshold(1);
        vm.stopPrank();
    }

    function attest(bytes memory message) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, keccak256(message));
        return abi.encodePacked(r, s, v);
    }

    function test_fork_real_cctp_mints_and_root_decodes() public {
        Msg memory m = goodMsg(address(receiver), 42, 3);
        bytes memory message = encode(m);
        vm.expectEmit(address(receiver));
        emit BatchReceiver.BatchReceived(ROOT, HUNDRED, 42, 3, 300e6, m.nonce);
        BatchHook.Batch memory b = receiver.relay(message, attest(message));
        assertEq(b.root, ROOT, "decoded root equals the root sent");
        assertEq(usdc.balanceOf(address(receiver)), 300e6, "real USDC minted");
        assertEq(mt.usedNonces(m.nonce), 1, "nonce consumed");
    }

    function test_fork_tampered_hook_fails_attestation() public {
        Msg memory m = goodMsg(address(receiver), 43, 3);
        bytes memory signed = encode(m);
        bytes memory attestation = attest(signed);
        // Swap the root after attestation: the digest covers hookData, so this must fail.
        m.hookData = hook(HUNDRED, 43, 3, bytes32(uint256(ROOT) ^ 1));
        vm.expectRevert(); // "Invalid signature: not attester" (recovered address differs)
        receiver.relay(encode(m), attestation);
        assertEq(usdc.balanceOf(address(receiver)), 0);
    }

    function test_fork_third_party_cannot_consume_our_message() public {
        Msg memory m = goodMsg(address(receiver), 44, 3);
        bytes memory message = encode(m);
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("Invalid caller for message"));
        IReceiverV2(SEPOLIA_MESSAGE_TRANSMITTER).receiveMessage(message, attest(message));
    }
}
