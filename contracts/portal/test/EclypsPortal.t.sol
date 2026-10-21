// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {EclypsPortal} from "../src/EclypsPortal.sol";
import {DataStructures, IRegistry} from "../src/interfaces/IAztec.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {CctpTestBase} from "./CctpTestBase.sol";
import {MockMessageTransmitter, MockUSDC} from "./mocks/MockCctp.sol";
import {MockInbox, MockOutbox, MockRegistry, MockRollup} from "./mocks/MockAztec.sol";

contract EclypsPortalTest is CctpTestBase {
    // SECRET_HASH_ZERO (CctpTestBase) is checked against Noir's compute_secret_hash in
    // aztec/claim_test.
    bytes32 constant CLAIM_100 = keccak256("aztec claim contract for $100");

    MockUSDC usdc;
    MockMessageTransmitter mt;
    MockInbox inbox;
    EclypsPortal portal;

    function setUp() public {
        usdc = new MockUSDC();
        mt = new MockMessageTransmitter(usdc);
        inbox = new MockInbox();
        portal = new EclypsPortal(
            IReceiverV2(address(mt)),
            IERC20Minimal(address(usdc)),
            SOLANA_TMM,
            SEPOLIA_TOKEN_MESSENGER,
            SOLANA_DEVNET_USDC,
            GATEWAY,
            IRegistry(address(new MockRegistry(new MockRollup(inbox, new MockOutbox(2914217885))))),
            SECRET_HASH_ZERO,
            EXIT_AUTHORITY,
            EXIT_CUSTODY
        );
        portal.bindClaimContract(HUNDRED, CLAIM_100);
    }

    function test_content_matches_shared_vector() public view {
        string memory j = vm.readFile("../../circuits/vectors/merkle.json");
        bytes32 root = vm.parseJsonBytes32(j, ".root_batch_depth_16_leaves");
        assertEq(
            portal.batchContent(root, 16 * uint256(HUNDRED), 7, HUNDRED),
            0x00eff7e0b0702dd21fdef9972fb9871e273d657bbd90796281fabce77f6477c8
        );
    }

    function test_forwards_root_to_claim_contract() public {
        Msg memory m = goodMsg(address(portal), 7, 16);
        portal.relay(encode(m), "");
        assertEq(inbox.count(), 1);
        (
            DataStructures.L2Actor memory recipient,
            bytes32 content,
            bytes32 secretHash,
            address sender
        ) = inbox.sent(0);
        assertEq(recipient.actor, CLAIM_100);
        assertEq(recipient.version, 2914217885);
        assertEq(content, portal.batchContent(ROOT, 1600e6, 7, HUNDRED));
        assertEq(secretHash, SECRET_HASH_ZERO);
        assertEq(sender, address(portal));
        assertEq(usdc.balanceOf(address(portal)), 1600e6, "USDC stays in the portal as backing");
    }

    function test_unbound_denomination_reverts_and_keeps_nonce() public {
        Msg memory m = goodMsg(address(portal), 8, 2);
        m.amount = 2 * 1000e6;
        m.hookData = hook(1000e6, 8, 2, ROOT);
        vm.expectRevert(abi.encodeWithSelector(EclypsPortal.UnboundDenomination.selector, 1000e6));
        portal.relay(encode(m), "");
        assertFalse(mt.usedNonces(m.nonce));
        portal.bindClaimContract(1000e6, keccak256("claim $1000"));
        portal.relay(encode(m), "");
        assertEq(inbox.count(), 1);
    }

    function test_bind_once_and_only_binder() public {
        vm.expectRevert(abi.encodeWithSelector(EclypsPortal.AlreadyBound.selector, HUNDRED));
        portal.bindClaimContract(HUNDRED, keccak256("other"));
        vm.prank(address(0xBAD));
        vm.expectRevert(EclypsPortal.NotBinder.selector);
        portal.bindClaimContract(1000e6, keccak256("other"));
        vm.expectRevert(EclypsPortal.ZeroClaimContract.selector);
        portal.bindClaimContract(1000e6, bytes32(0));
    }
}
