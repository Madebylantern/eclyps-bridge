// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {EclypsPortal} from "../src/EclypsPortal.sol";
import {AztecHash, DataStructures, IRegistry} from "../src/interfaces/IAztec.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {CctpTestBase} from "./CctpTestBase.sol";
import {MockMessageTransmitter, MockTokenMessengerV2, MockUSDC} from "./mocks/MockCctp.sol";
import {MockInbox, MockOutbox, MockRegistry, MockRollup} from "./mocks/MockAztec.sol";

/// @notice EclypsPortal.claimToEthereum (ADR 0014 §4): one exit from Aztec, one L2->L1 message, the
/// portal pays the committed recipient. The mock Outbox makes the real Outbox's checks
/// (ExitBatch.t.sol); ExitBatchFork.t.sol pays real Sepolia USDC.
contract ClaimToEthereumTest is CctpTestBase {
    uint256 constant ROLLUP_VERSION = 2914217885;
    bytes32 constant CLAIM_100 = keccak256("aztec claim contract for $100");
    bytes32 constant CLAIM_1000 = keccak256("aztec claim contract for $1,000");
    string constant VECTORS = "../../circuits/vectors/exit-ethereum.json";
    address constant ALICE = address(0xA11CE);
    bytes32 constant SECRET =
        bytes32(uint256(0x2d599ef16cfe8609ee72b1ffd859f5832d677d5bda6d5221f14d48eb4ec4ebe6));

    MockUSDC usdc;
    MockOutbox outbox;
    EclypsPortal portal;

    function setUp() public {
        usdc = new MockUSDC();
        MockMessageTransmitter mt = new MockMessageTransmitter(usdc);
        deployCodeTo("MockCctp.sol:MockTokenMessengerV2", SEPOLIA_TOKEN_MESSENGER);
        outbox = new MockOutbox(ROLLUP_VERSION);
        portal = new EclypsPortal(
            IReceiverV2(address(mt)),
            IERC20Minimal(address(usdc)),
            SOLANA_TMM,
            SEPOLIA_TOKEN_MESSENGER,
            SOLANA_DEVNET_USDC,
            GATEWAY,
            IRegistry(address(new MockRegistry(new MockRollup(new MockInbox(), outbox)))),
            SECRET_HASH_ZERO,
            EXIT_AUTHORITY,
            EXIT_CUSTODY
        );
        portal.bindClaimContract(HUNDRED, CLAIM_100);
        portal.bindClaimContract(THOUSAND, CLAIM_1000);
    }

    // ---------- helpers ----------

    function l2ToL1(bytes32 sender, bytes32 content)
        internal
        view
        returns (DataStructures.L2ToL1Msg memory)
    {
        return DataStructures.L2ToL1Msg(
            DataStructures.L2Actor(sender, ROLLUP_VERSION),
            DataStructures.L1Actor(address(portal), block.chainid),
            content
        );
    }

    function h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return AztecHash.sha256ToField(bytes.concat(a, b));
    }

    /// Proves `m` in Aztec epoch `epoch`: a 2-leaf L2->L1 tree with `m` at leaf 1.
    function prove(DataStructures.L2ToL1Msg memory m, uint256 epoch)
        internal
        returns (EclypsPortal.OutboxProof memory p)
    {
        bytes32 sibling = keccak256(abi.encode("another message", epoch)) >> 8;
        outbox.insert(epoch, 1, h(sibling, AztecHash.messageHash(m)));
        p.epoch = epoch;
        p.numCheckpointsInEpoch = 1;
        p.leafIndex = 1;
        p.path = new bytes32[](1);
        p.path[0] = sibling;
    }

    /// The message `exit_to_ethereum` of the claim contract bound to `denomination` sends.
    function proveExit(uint64 denomination, address recipient, bytes32 secret, uint256 epoch)
        internal
        returns (EclypsPortal.OutboxProof memory)
    {
        bytes32 commitment = portal.ethereumExitCommitment(recipient, secret);
        return prove(
            l2ToL1(
                portal.claimContract(denomination),
                portal.ethereumExitContent(commitment, denomination)
            ),
            epoch
        );
    }

    function leafId(EclypsPortal.OutboxProof memory p) internal pure returns (uint256) {
        return (1 << p.path.length) + p.leafIndex;
    }

    // ---------- encodings ----------

    /// circuits/vectors/exit-ethereum.json, generated independently (Python); the claim contract
    /// (TXE) and the SDK check the same file.
    function test_commitment_and_content_match_shared_vectors() public view {
        string memory j = vm.readFile(VECTORS);
        assertEq(bytes32(portal.ETHEREUM_EXIT_TAG()), vm.parseJsonBytes32(j, ".tag"));
        assertEq(
            bytes32(portal.ETHEREUM_EXIT_TAG()),
            bytes32(uint256(uint184(bytes23("eclyps:exit-to-ethereum")))),
            "the tag is the ASCII text"
        );
        for (uint256 i; i < 4; ++i) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            address recipient = vm.parseJsonAddress(j, string.concat(p, ".recipient"));
            bytes32 secret = vm.parseJsonBytes32(j, string.concat(p, ".exitSecret"));
            uint64 denomination = uint64(vm.parseJsonUint(j, string.concat(p, ".denomination")));
            bytes32 commitment = portal.ethereumExitCommitment(recipient, secret);
            assertEq(commitment, vm.parseJsonBytes32(j, string.concat(p, ".commitment")));
            assertEq(
                portal.ethereumExitContent(commitment, denomination),
                vm.parseJsonBytes32(j, string.concat(p, ".content"))
            );
        }
    }

    // ---------- happy path ----------

    /// Anyone may submit the claim (here a relayer); the USDC goes to the committed recipient.
    function test_relayer_claims_and_the_recipient_is_paid() public {
        usdc.mint(address(portal), 1000e6);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 42);
        bytes32 commitment = portal.ethereumExitCommitment(ALICE, SECRET);

        vm.expectEmit(address(portal));
        emit EclypsPortal.ExitedToEthereum(
            HUNDRED, ALICE, commitment, portal.ethereumExitContent(commitment, HUNDRED)
        );
        vm.prank(address(0x5E1A7E5));
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);

        assertEq(usdc.balanceOf(ALICE), 100e6, "exactly one denomination");
        assertEq(usdc.balanceOf(address(0x5E1A7E5)), 0, "nothing to the relayer");
        assertEq(usdc.balanceOf(address(portal)), 900e6);
        assertTrue(outbox.hasMessageBeenConsumedAtEpoch(42, leafId(p)), "consumed");
    }

    /// Any recipient, secret and bound denomination: paid once, exactly the denomination.
    function testFuzz_claim(address recipient, bytes32 secret, bool big) public {
        vm.assume(recipient != address(0) && recipient != address(portal));
        uint64 d = big ? THOUSAND : HUNDRED;
        usdc.mint(address(portal), d);
        portal.claimToEthereum(d, recipient, secret, proveExit(d, recipient, secret, 7));
        assertEq(usdc.balanceOf(recipient), d);
        assertEq(usdc.balanceOf(address(portal)), 0);
    }

    // ---------- the message must be exactly the exit's ----------

    function test_wrong_recipient_secret_or_denomination_is_refused() public {
        usdc.mint(address(portal), 10_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 1);

        // Front-running with another recipient: the commitment differs, so the leaf does.
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(HUNDRED, address(0xB0B), SECRET, p);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(HUNDRED, ALICE, bytes32(uint256(SECRET) ^ 1), p);
        // The $1,000 claim contract did not send it, and the content names $100.
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(THOUSAND, ALICE, SECRET, p);

        assertEq(usdc.balanceOf(address(0xB0B)), 0);
        assertEq(usdc.balanceOf(ALICE), 0);
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        assertEq(usdc.balanceOf(ALICE), 100e6);
    }

    function test_message_from_another_sender_is_refused() public {
        usdc.mint(address(portal), 10_000e6);
        bytes32 content =
            portal.ethereumExitContent(portal.ethereumExitCommitment(ALICE, SECRET), THOUSAND);
        // Any L2 contract can send this content to the portal; only the $1,000 claim contract counts.
        EclypsPortal.OutboxProof memory p = prove(l2ToL1(keccak256("attacker"), content), 1);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(THOUSAND, ALICE, SECRET, p);
        // The $100 claim contract cannot pay $1,000 either.
        p = prove(l2ToL1(CLAIM_100, content), 2);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(THOUSAND, ALICE, SECRET, p);
        assertEq(usdc.balanceOf(ALICE), 0);
    }

    function test_replay_is_refused_by_the_outbox() public {
        usdc.mint(address(portal), 10_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 1);
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        vm.expectPartialRevert(MockOutbox.Outbox__AlreadyNullified.selector);
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        assertEq(usdc.balanceOf(ALICE), 100e6, "paid once");
    }

    /// Two exits to the same recipient with different secrets are two messages, each paid once.
    function test_two_exits_to_one_recipient_are_two_payments() public {
        usdc.mint(address(portal), 10_000e6);
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, proveExit(HUNDRED, ALICE, SECRET, 1));
        bytes32 other = bytes32(uint256(SECRET) + 1);
        portal.claimToEthereum(HUNDRED, ALICE, other, proveExit(HUNDRED, ALICE, other, 2));
        assertEq(usdc.balanceOf(ALICE), 200e6);
    }

    // ---------- an exit batch and an Ethereum exit are never each other ----------

    /// A closed exit epoch's message (exitContent) cannot be claimed as an Ethereum exit, whatever
    /// recipient and secret are offered: the rebuilt content starts with the tag and is 96 bytes.
    function test_exit_batch_message_cannot_be_claimed_to_ethereum() public {
        usdc.mint(address(portal), 10_000e6);
        bytes32 root = ROOT;
        bytes32 batch = portal.exitContent(root, 3, 7, HUNDRED);
        EclypsPortal.OutboxProof memory p = prove(l2ToL1(CLAIM_100, batch), 1);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(HUNDRED, ALICE, root, p);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.claimToEthereum(HUNDRED, address(uint160(uint256(root))), bytes32(uint256(3)), p);
        assertEq(usdc.balanceOf(ALICE), 0);
        // It is still the exit batch it was.
        portal.exitBatch(root, 3, 7, HUNDRED, p);
        assertTrue(portal.exited(HUNDRED, 7));
    }

    /// An Ethereum exit's message cannot be sent to Solana as an exit batch.
    function test_ethereum_exit_message_cannot_be_sent_as_an_exit_batch() public {
        usdc.mint(address(portal), 10_000e6);
        bytes32 commitment = portal.ethereumExitCommitment(ALICE, SECRET);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 1);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.exitBatch(commitment, 1, 0, HUNDRED, p);
        // The content's own first words as (root, count): still another leaf.
        bytes32 tag = bytes32(portal.ETHEREUM_EXIT_TAG());
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        portal.exitBatch(tag, uint16(uint256(commitment) % 255) + 1, 0, HUNDRED, p);
        assertFalse(portal.exited(HUNDRED, 0));
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        assertEq(usdc.balanceOf(ALICE), 100e6);
    }

    /// The two content formats differ in their first word and in length (96 vs 128 bytes).
    function testFuzz_contents_never_coincide(
        address recipient,
        bytes32 secret,
        bytes32 root,
        uint16 count,
        uint64 id,
        bool big
    ) public view {
        uint64 d = big ? THOUSAND : HUNDRED;
        bytes32 commitment = portal.ethereumExitCommitment(recipient, secret);
        assertTrue(
            portal.ethereumExitContent(commitment, d) != portal.exitContent(root, count, id, d)
        );
        assertTrue(portal.ethereumExitContent(root, d) != portal.exitContent(root, count, id, d));
    }

    // ---------- inputs and balance ----------

    function test_unbound_denomination_is_refused() public {
        uint64 tenThousand = 10_000e6;
        usdc.mint(address(portal), tenThousand);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 1);
        vm.expectRevert(
            abi.encodeWithSelector(EclypsPortal.UnboundDenomination.selector, tenThousand)
        );
        portal.claimToEthereum(tenThousand, ALICE, SECRET, p);
    }

    function test_zero_recipient_is_refused() public {
        usdc.mint(address(portal), 1000e6);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, address(0), SECRET, 1);
        vm.expectRevert(EclypsPortal.ZeroRecipient.selector);
        portal.claimToEthereum(HUNDRED, address(0), SECRET, p);
    }

    /// A revert leaves the Outbox message unconsumed, so the claim can be retried once funded.
    function test_insufficient_balance_reverts_and_can_be_retried() public {
        usdc.mint(address(portal), 99e6);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 1);
        vm.expectRevert(
            abi.encodeWithSelector(EclypsPortal.InsufficientBalance.selector, 99e6, 100e6)
        );
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        assertFalse(outbox.hasMessageBeenConsumedAtEpoch(1, leafId(p)));
        usdc.mint(address(portal), 1e6);
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        assertEq(usdc.balanceOf(ALICE), 100e6);
        assertEq(usdc.balanceOf(address(portal)), 0);
    }

    /// A token that returns false instead of reverting does not count as paid.
    function test_transfer_returning_false_reverts() public {
        usdc.mint(address(portal), 1000e6);
        EclypsPortal.OutboxProof memory p = proveExit(HUNDRED, ALICE, SECRET, 1);
        vm.mockCall(
            address(usdc), abi.encodeWithSelector(MockUSDC.transfer.selector), abi.encode(false)
        );
        vm.expectRevert(EclypsPortal.TransferFailed.selector);
        portal.claimToEthereum(HUNDRED, ALICE, SECRET, p);
        assertFalse(outbox.hasMessageBeenConsumedAtEpoch(1, leafId(p)));
    }
}
