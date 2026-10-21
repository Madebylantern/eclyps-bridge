// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {EclypsPortal} from "../src/EclypsPortal.sol";
import {AztecHash, DataStructures, IRegistry} from "../src/interfaces/IAztec.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {ExitHook} from "../src/libraries/ExitHook.sol";
import {CctpTestBase} from "./CctpTestBase.sol";
import {MockMessageTransmitter, MockTokenMessengerV2, MockUSDC} from "./mocks/MockCctp.sol";
import {MockInbox, MockOutbox, MockRegistry, MockRollup} from "./mocks/MockAztec.sol";

/// @notice EclypsPortal.exitBatch (ADR 0009) with a mock Outbox that makes Aztec's checks and a
/// mock TokenMessengerV2 that records the burn. ExitBatchFork.t.sol runs it on Circle's real
/// contracts.
contract ExitBatchTest is CctpTestBase {
    uint256 constant ROLLUP_VERSION = 2914217885;
    uint256 constant R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 constant CLAIM_100 = keccak256("aztec claim contract for $100");
    bytes32 constant CLAIM_1000 = keccak256("aztec claim contract for $1,000");
    string constant VECTORS = "../../circuits/vectors/exit.json";
    string constant SOLANA_FIXTURE = "../../sdk/test/fixtures/exit-claim.json";

    MockUSDC usdc;
    MockMessageTransmitter mt;
    MockTokenMessengerV2 tm;
    MockOutbox outbox;
    IRegistry registry;
    EclypsPortal portal;

    struct Vector {
        uint64 denomination;
        uint64 exitEpochId;
        uint16 count;
        bytes32 root;
        bytes hook;
        bytes32 content;
    }

    function setUp() public {
        usdc = new MockUSDC();
        mt = new MockMessageTransmitter(usdc);
        // At Sepolia's TokenMessengerV2 address, so forward messages built by goodMsg relay too.
        deployCodeTo("MockCctp.sol:MockTokenMessengerV2", SEPOLIA_TOKEN_MESSENGER);
        tm = MockTokenMessengerV2(SEPOLIA_TOKEN_MESSENGER);
        outbox = new MockOutbox(ROLLUP_VERSION);
        registry = IRegistry(address(new MockRegistry(new MockRollup(new MockInbox(), outbox))));
        portal = deploy(EXIT_AUTHORITY, EXIT_CUSTODY);
        portal.bindClaimContract(HUNDRED, CLAIM_100);
        portal.bindClaimContract(THOUSAND, CLAIM_1000);
    }

    function deploy(bytes32 exitAuthority, bytes32 exitCustody) internal returns (EclypsPortal) {
        return new EclypsPortal(
            IReceiverV2(address(mt)),
            IERC20Minimal(address(usdc)),
            SOLANA_TMM,
            SEPOLIA_TOKEN_MESSENGER,
            SOLANA_DEVNET_USDC,
            GATEWAY,
            registry,
            SECRET_HASH_ZERO,
            exitAuthority,
            exitCustody
        );
    }

    // ---------- helpers ----------

    function vector(uint256 i) internal view returns (Vector memory v) {
        string memory j = vm.readFile(VECTORS);
        string memory p = string.concat(".vectors[", vm.toString(i), "]");
        v.denomination = uint64(vm.parseJsonUint(j, string.concat(p, ".denomination")));
        v.exitEpochId = uint64(vm.parseJsonUint(j, string.concat(p, ".exitEpochId")));
        v.count = uint16(vm.parseJsonUint(j, string.concat(p, ".count")));
        v.root = vm.parseJsonBytes32(j, string.concat(p, ".root"));
        v.hook = vm.parseJsonBytes(j, string.concat(p, ".hook"));
        v.content = vm.parseJsonBytes32(j, string.concat(p, ".content"));
    }

    /// The L2->L1 message a claim contract `sender` sends to `recipient` on `chainId`.
    function l2ToL1(bytes32 sender, address recipient, uint256 chainId, bytes32 content)
        internal
        pure
        returns (DataStructures.L2ToL1Msg memory)
    {
        return DataStructures.L2ToL1Msg(
            DataStructures.L2Actor(sender, ROLLUP_VERSION),
            DataStructures.L1Actor(recipient, chainId),
            content
        );
    }

    function h(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return AztecHash.sha256ToField(bytes.concat(a, b));
    }

    /// Proves `m` in Aztec epoch `epoch`: a 4-leaf L2->L1 tree with `m` at leaf 2, inserted for
    /// one checkpoint, as the rollup inserts it once the epoch is proven.
    function prove(DataStructures.L2ToL1Msg memory m, uint256 epoch)
        internal
        returns (EclypsPortal.OutboxProof memory p)
    {
        bytes32 s0 = keccak256(abi.encode("sibling", epoch, 0)) >> 8;
        bytes32 s1 = keccak256(abi.encode("sibling", epoch, 1)) >> 8;
        bytes32 s3 = keccak256(abi.encode("sibling", epoch, 3)) >> 8;
        bytes32 left = h(s0, s1);
        outbox.insert(epoch, 1, h(left, h(AztecHash.messageHash(m), s3)));
        p.epoch = epoch;
        p.numCheckpointsInEpoch = 1;
        p.leafIndex = 2;
        p.path = new bytes32[](2);
        p.path[0] = s3;
        p.path[1] = left;
    }

    /// The message the bound claim contract sends for `v`, proven in Aztec epoch `epoch`.
    function proveExit(Vector memory v, uint256 epoch)
        internal
        returns (EclypsPortal.OutboxProof memory)
    {
        bytes32 content = portal.exitContent(v.root, v.count, v.exitEpochId, v.denomination);
        return prove(
            l2ToL1(portal.claimContract(v.denomination), address(portal), block.chainid, content),
            epoch
        );
    }

    function exit(Vector memory v, EclypsPortal.OutboxProof memory p) internal returns (uint256) {
        return portal.exitBatch(v.root, v.count, v.exitEpochId, v.denomination, p);
    }

    function leafId(EclypsPortal.OutboxProof memory p) internal pure returns (uint256) {
        return (1 << p.path.length) + p.leafIndex;
    }

    // ---------- encodings ----------

    /// circuits/vectors/exit.json, generated independently (Python); the SDK and the gateway check
    /// the same file.
    function test_content_and_hook_match_shared_vectors() public view {
        for (uint256 i; i < 4; ++i) {
            Vector memory v = vector(i);
            assertEq(portal.exitContent(v.root, v.count, v.exitEpochId, v.denomination), v.content);
            assertEq(ExitHook.encode(v.denomination, v.exitEpochId, v.count, v.root), v.hook);
        }
    }

    // ---------- happy path ----------

    function test_exit_burns_to_solana_with_every_field() public {
        Vector memory v = vector(0); // $1,000 x 3, exit epoch 7 (the Solana leg's fixture batch)
        usdc.mint(address(portal), 10_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(v, 42);

        vm.expectEmit(address(portal));
        emit EclypsPortal.ExitBatchSent(
            v.denomination, v.exitEpochId, v.root, v.count, 3000e6, v.content
        );
        uint256 amount = exit(v, p);

        assertEq(amount, 3000e6);
        assertEq(tm.count(), 1, "one CCTP burn");
        MockTokenMessengerV2.Burn memory b = tm.burn(0);
        assertEq(b.caller, address(portal), "messageSender = the portal");
        assertEq(b.amount, 3000e6, "count x denomination");
        assertEq(b.destinationDomain, 5, "Solana");
        assertEq(b.mintRecipient, EXIT_CUSTODY, "exit custody");
        assertEq(b.burnToken, address(usdc), "USDC");
        assertEq(b.destinationCaller, EXIT_AUTHORITY, "exit authority");
        assertEq(b.maxFee, 0, "no fee");
        assertEq(b.minFinalityThreshold, 2000, "standard");
        assertEq(b.hookData, v.hook, "hook = the shared vector");
        // The hook the gateway received and paid in LiteSVM (written by the Rust test).
        bytes memory solana = vm.parseBytes(
            string.concat("0x", vm.parseJsonString(vm.readFile(SOLANA_FIXTURE), ".receive.message"))
        );
        assertEq(b.hookData, slice(solana, 376, 427), "hook = the one receive_exit accepted");

        assertEq(usdc.balanceOf(address(portal)), 7000e6, "burned from the portal's USDC");
        assertEq(usdc.allowance(address(portal), address(tm)), 0, "no allowance left");
        assertTrue(portal.exited(v.denomination, v.exitEpochId));
        assertTrue(outbox.hasMessageBeenConsumedAtEpoch(42, leafId(p)), "Outbox message consumed");
    }

    /// The edges of the hook: $10,000, the largest exit epoch id, a full tree, root r - 1.
    function test_full_tree_largest_id_and_largest_root() public {
        Vector memory v = vector(3);
        portal.bindClaimContract(v.denomination, keccak256("claim $10,000"));
        usdc.mint(address(portal), uint256(v.count) * v.denomination);
        assertEq(uint256(v.root), R - 1);
        exit(v, proveExit(v, 1));
        assertEq(tm.burn(0).hookData, v.hook);
        assertEq(tm.burn(0).amount, 2_560_000e6);
        assertEq(usdc.balanceOf(address(portal)), 0);
    }

    /// The USDC a forward relay leaves in the portal is what an exit burns.
    function test_forward_relay_then_exit_round_trip() public {
        portal.relay(encode(goodMsg(address(portal), 5, 16)), "");
        assertEq(usdc.balanceOf(address(portal)), 1600e6);
        Vector memory v = Vector(HUNDRED, 0, 16, ROOT, "", bytes32(0));
        exit(v, proveExit(v, 3));
        assertEq(usdc.balanceOf(address(portal)), 0);
        assertEq(tm.burn(0).hookData, ExitHook.encode(HUNDRED, 0, 16, ROOT));
    }

    /// Any valid exit burns count x denomination with the hook of exactly its inputs.
    function testFuzz_exit(uint16 count, uint64 exitEpochId, bytes32 root, bool big) public {
        count = uint16(bound(count, 1, 256));
        root = bytes32(bound(uint256(root), 0, R - 1));
        Vector memory v = Vector(big ? THOUSAND : HUNDRED, exitEpochId, count, root, "", 0);
        usdc.mint(address(portal), uint256(count) * v.denomination);
        exit(v, proveExit(v, 9));
        bytes memory hook = tm.burn(0).hookData;
        assertEq(hook.length, 51);
        assertEq(uint8(hook[0]), 2);
        assertEq(uint64(bytes8(b32At(hook, 1))), v.denomination);
        assertEq(uint64(bytes8(b32At(hook, 9))), exitEpochId);
        assertEq(uint16(bytes2(b32At(hook, 17))), count);
        assertEq(b32At(hook, 19), root);
        assertEq(tm.burn(0).amount, uint256(count) * v.denomination);
        assertEq(usdc.balanceOf(address(portal)), 0);
    }

    // ---------- the Outbox message must be exactly the bound claim contract's, to this portal ----------

    function test_rejects_message_from_another_l2_sender() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 3000e6);
        bytes32 content = portal.exitContent(v.root, v.count, v.exitEpochId, v.denomination);
        // Any L2 contract can send this content to the portal; only the $1,000 claim contract counts.
        EclypsPortal.OutboxProof memory p =
            prove(l2ToL1(keccak256("attacker"), address(portal), block.chainid, content), 1);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(v, p);
        // The $100 claim contract cannot exit $1,000 notes either.
        p = prove(l2ToL1(CLAIM_100, address(portal), block.chainid, content), 2);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(v, p);
        assertEq(tm.count(), 0);
        assertFalse(portal.exited(v.denomination, v.exitEpochId));
    }

    function test_rejects_message_to_another_recipient_or_chain() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 3000e6);
        bytes32 content = portal.exitContent(v.root, v.count, v.exitEpochId, v.denomination);
        EclypsPortal.OutboxProof memory p =
            prove(l2ToL1(CLAIM_1000, address(0xBEEF), block.chainid, content), 1);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(v, p);
        p = prove(l2ToL1(CLAIM_1000, address(portal), 1, content), 2);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(v, p);
        // Nobody but the portal can consume the portal's message (front-running the Outbox).
        DataStructures.L2ToL1Msg memory m =
            l2ToL1(CLAIM_1000, address(portal), block.chainid, content);
        p = prove(m, 3);
        vm.prank(address(0xBAD));
        vm.expectPartialRevert(MockOutbox.Outbox__InvalidRecipient.selector);
        outbox.consume(m, p.epoch, p.numCheckpointsInEpoch, p.leafIndex, p.path);
        exit(v, p);
        assertEq(tm.count(), 1);
    }

    function test_rejects_content_that_differs_from_the_message() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 10_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        // Same proof, any other field: the rebuilt content differs, so the leaf does.
        Vector memory w = vector(0);
        w.root = bytes32(uint256(v.root) ^ 1);
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(w, p);
        w = vector(0);
        w.count = 2;
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(w, p);
        w = vector(0);
        w.exitEpochId = 8;
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(w, p);
        // A wrong epoch or leaf index does not verify either.
        p.epoch = 2;
        vm.expectPartialRevert(MockOutbox.Outbox__NothingToConsumeAtEpoch.selector);
        exit(v, p);
        p.epoch = 1;
        p.leafIndex = 1;
        vm.expectPartialRevert(MockOutbox.MerkleLib__InvalidRoot.selector);
        exit(v, p);
        assertEq(tm.count(), 0);
    }

    // ---------- one CCTP message per (denomination, exit epoch) ----------

    function test_replay_is_rejected() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 10_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        exit(v, p);
        vm.expectRevert(
            abi.encodeWithSelector(EclypsPortal.AlreadyExited.selector, THOUSAND, uint64(7))
        );
        exit(v, p);
        assertEq(tm.count(), 1);
        assertEq(usdc.balanceOf(address(portal)), 7000e6);
    }

    /// Even if Aztec sent a second message for the same exit epoch (another root), the portal
    /// burns once, and the second message stays unconsumed.
    function test_second_message_for_the_same_exit_epoch_is_rejected() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 10_000e6);
        exit(v, proveExit(v, 1));
        Vector memory w = vector(0);
        w.root = keccak256("another root") >> 8;
        EclypsPortal.OutboxProof memory p = proveExit(w, 2);
        vm.expectRevert(
            abi.encodeWithSelector(EclypsPortal.AlreadyExited.selector, THOUSAND, uint64(7))
        );
        exit(w, p);
        assertFalse(outbox.hasMessageBeenConsumedAtEpoch(2, leafId(p)));
        assertEq(tm.count(), 1);
    }

    /// The Outbox alone also refuses a consumed message (the portal checks `exited` first).
    function test_outbox_refuses_a_consumed_message() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 10_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        exit(v, p);
        DataStructures.L2ToL1Msg memory m =
            l2ToL1(CLAIM_1000, address(portal), block.chainid, v.content);
        vm.prank(address(portal));
        vm.expectPartialRevert(MockOutbox.Outbox__AlreadyNullified.selector);
        outbox.consume(m, p.epoch, p.numCheckpointsInEpoch, p.leafIndex, p.path);
    }

    // ---------- inputs ----------

    function test_rejects_unknown_denomination() public {
        Vector memory v = vector(3); // $10,000: no claim contract bound
        usdc.mint(address(portal), 3_000_000e6);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        vm.expectRevert(
            abi.encodeWithSelector(EclypsPortal.UnboundDenomination.selector, v.denomination)
        );
        exit(v, p);
    }

    function test_rejects_zero_and_257_exits() public {
        usdc.mint(address(portal), 1_000_000e6);
        Vector memory v = vector(0);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        uint16[2] memory bad = [uint16(0), 257];
        for (uint256 i; i < 2; ++i) {
            v.count = bad[i];
            vm.expectRevert(abi.encodeWithSelector(EclypsPortal.BadExitCount.selector, bad[i]));
            exit(v, p);
        }
    }

    function test_rejects_non_canonical_root() public {
        usdc.mint(address(portal), 10_000e6);
        Vector memory v = vector(0);
        v.root = bytes32(R);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        vm.expectRevert(abi.encodeWithSelector(EclypsPortal.NonCanonicalRoot.selector, v.root));
        exit(v, p);
        v.root = bytes32(type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(EclypsPortal.NonCanonicalRoot.selector, v.root));
        exit(v, p);
    }

    function test_rejects_amount_over_u64() public {
        uint64 huge = uint64(1) << 56; // 256 x 2^56 = 2^64 does not fit a Solana u64
        portal.bindClaimContract(huge, keccak256("claim huge"));
        Vector memory v = Vector(huge, 1, 256, ROOT, "", 0);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        vm.expectRevert(abi.encodeWithSelector(EclypsPortal.AmountTooLarge.selector, 1 << 64));
        exit(v, p);
        v.count = 255; // 255 x 2^56 fits
        usdc.mint(address(portal), 255 * uint256(huge));
        exit(v, proveExit(v, 2));
        assertEq(tm.burn(0).amount, 255 * uint256(huge));
    }

    /// A revert leaves the Outbox message and the exit epoch untouched, so the exit can be retried.
    function test_insufficient_balance_reverts_and_can_be_retried() public {
        Vector memory v = vector(0);
        usdc.mint(address(portal), 2999e6);
        EclypsPortal.OutboxProof memory p = proveExit(v, 1);
        vm.expectRevert(
            abi.encodeWithSelector(EclypsPortal.InsufficientBalance.selector, 2999e6, 3000e6)
        );
        exit(v, p);
        assertFalse(outbox.hasMessageBeenConsumedAtEpoch(1, leafId(p)));
        assertFalse(portal.exited(v.denomination, v.exitEpochId));
        usdc.mint(address(portal), 1e6);
        exit(v, p);
        assertEq(usdc.balanceOf(address(portal)), 0);
    }

    function test_constructor_requires_both_exit_accounts() public {
        vm.expectRevert(EclypsPortal.ZeroExitAccount.selector);
        deploy(bytes32(0), EXIT_CUSTODY);
        vm.expectRevert(EclypsPortal.ZeroExitAccount.selector);
        deploy(EXIT_AUTHORITY, bytes32(0));
        EclypsPortal p = deploy(EXIT_AUTHORITY, EXIT_CUSTODY);
        assertEq(p.exitAuthority(), EXIT_AUTHORITY);
        assertEq(p.exitCustody(), EXIT_CUSTODY);
        assertEq(address(p.tokenMessenger()), SEPOLIA_TOKEN_MESSENGER);
        assertEq(address(p.outbox()), address(outbox));
    }
}
