// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {EclypsPortal} from "../src/EclypsPortal.sol";
import {AztecHash, DataStructures, IRegistry} from "../src/interfaces/IAztec.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {BatchHook} from "../src/libraries/BatchHook.sol";
import {ExitHook} from "../src/libraries/ExitHook.sol";
import {CctpTestBase} from "./CctpTestBase.sol";
import {MockInbox, MockOutbox, MockRegistry, MockRollup} from "./mocks/MockAztec.sol";

interface IAttestable {
    function attesterManager() external view returns (address);
    function enableAttester(address) external;
    function setSignatureThreshold(uint256) external;
}

interface ITotalSupply {
    function totalSupply() external view returns (uint256);
}

/// @notice exitBatch against Circle's *deployed* Sepolia CCTP V2 (TokenMessengerV2 ->
/// TokenMinterV2 -> USDC burn -> MessageTransmitterV2 `MessageSent`). Only the Aztec Outbox is a
/// mock (the Aztec leg does not exist yet); `test_fork_real_aztec_testnet_outbox_is_reached`
/// shows the call shape against the real testnet Outbox.
///
/// The portal is deployed at the address and with the exit accounts named by the exit message the
/// gateway received and paid in LiteSVM with Circle's real Solana programs
/// (sdk/test/fixtures/exit-claim.json, written by programs/gateway/tests/exit.rs). Its USDC comes
/// from a real CCTP forward relay. The message `MessageSent` carries, after Iris fills the nonce and
/// the executed finality, must be byte-for-byte that message. The raw bytes are kept in
/// test/fixtures/exit-burn-sepolia-fork.json for the gateway's `exit_message::parse` and the SDK.
/// Skipped unless SEPOLIA_RPC_URL is set.
contract ExitBatchForkTest is CctpTestBase {
    string constant SOLANA_FIXTURE = "../../sdk/test/fixtures/exit-claim.json";
    string constant FIXTURE = "test/fixtures/exit-burn-sepolia-fork.json";
    address constant AZTEC_TESTNET_REGISTRY = 0xA0BFb1B494FB49041e5c6e8c2C1BE09cD171c6Ba;
    bytes32 constant MESSAGE_SENT = keccak256("MessageSent(bytes)");
    uint256 constant ROLLUP_VERSION = 2914217885; // MockRollup
    uint256 attesterKey = 0xA77E57;

    struct Exit {
        bytes solanaMessage; // as received on Solana (Iris fields filled)
        address portal;
        bytes32 exitAuthority;
        bytes32 exitCustody;
        uint64 denomination;
        uint64 exitEpochId;
        uint16 count;
        bytes32 root;
    }

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        IAttestable mt = IAttestable(SEPOLIA_MESSAGE_TRANSMITTER);
        vm.startPrank(mt.attesterManager());
        mt.enableAttester(vm.addr(attesterKey));
        mt.setSignatureThreshold(1);
        vm.stopPrank();
    }

    /// The exit the Solana leg received: every input of exitBatch is read from its bytes.
    function solanaExit() internal view returns (Exit memory e) {
        string memory hexMsg = vm.parseJsonString(vm.readFile(SOLANA_FIXTURE), ".receive.message");
        e.solanaMessage = vm.parseBytes(string.concat("0x", hexMsg));
        e.exitAuthority = b32At(e.solanaMessage, 108);
        e.exitCustody = b32At(e.solanaMessage, 184);
        bytes32 sender = b32At(e.solanaMessage, 248);
        require(uint256(sender) >> 160 == 0, "messageSender is not an EVM address");
        e.portal = address(uint160(uint256(sender)));
        e.denomination = uint64(bytes8(b32At(e.solanaMessage, 377)));
        e.exitEpochId = uint64(bytes8(b32At(e.solanaMessage, 385)));
        e.count = uint16(bytes2(b32At(e.solanaMessage, 393)));
        e.root = b32At(e.solanaMessage, 395);
    }

    function attest(bytes memory message) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, keccak256(message));
        return abi.encodePacked(r, s, v);
    }

    function deployPortal(Exit memory e, MockOutbox outbox) internal returns (EclypsPortal portal) {
        deployCodeTo(
            "EclypsPortal.sol:EclypsPortal",
            abi.encode(
                IReceiverV2(SEPOLIA_MESSAGE_TRANSMITTER),
                IERC20Minimal(SEPOLIA_USDC),
                SOLANA_TMM,
                SEPOLIA_TOKEN_MESSENGER,
                SOLANA_DEVNET_USDC,
                GATEWAY,
                IRegistry(address(new MockRegistry(new MockRollup(new MockInbox(), outbox)))),
                SECRET_HASH_ZERO,
                e.exitAuthority,
                e.exitCustody
            ),
            e.portal
        );
        portal = EclypsPortal(e.portal);
        vm.prank(portal.binder());
        portal.bindClaimContract(e.denomination, keccak256("aztec claim contract (placeholder)"));
    }

    /// Funds the portal as production does: a real CCTP forward batch from the gateway.
    function forwardRelay(EclypsPortal portal, Exit memory e) internal {
        Msg memory m = goodMsg(address(portal), 99, e.count);
        m.amount = uint256(e.count) * e.denomination;
        m.hookData = BatchHook.encode(BatchHook.Batch(e.denomination, 99, e.count, ROOT));
        bytes memory message = encode(m);
        portal.relay(message, attest(message));
    }

    /// The claim contract's L2->L1 message, inserted in the mock Outbox as a proven epoch would be.
    function proveExit(EclypsPortal portal, MockOutbox outbox, Exit memory e)
        internal
        returns (EclypsPortal.OutboxProof memory p)
    {
        DataStructures.L2ToL1Msg memory m = DataStructures.L2ToL1Msg(
            DataStructures.L2Actor(portal.claimContract(e.denomination), ROLLUP_VERSION),
            DataStructures.L1Actor(address(portal), block.chainid),
            portal.exitContent(e.root, e.count, e.exitEpochId, e.denomination)
        );
        bytes32 sibling = keccak256("another L2->L1 message") >> 8;
        outbox.insert(
            5, 1, AztecHash.sha256ToField(bytes.concat(AztecHash.messageHash(m), sibling))
        );
        p.epoch = 5;
        p.numCheckpointsInEpoch = 1;
        p.path = new bytes32[](1);
        p.path[0] = sibling;
    }

    function calldataGas(bytes memory data) internal pure returns (uint256 gas) {
        for (uint256 i; i < data.length; ++i) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }

    function messageSent(Vm.Log[] memory logs) internal pure returns (bytes memory message) {
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == SEPOLIA_MESSAGE_TRANSMITTER && logs[i].topics[0] == MESSAGE_SENT)
            {
                message = abi.decode(logs[i].data, (bytes));
                ++found;
            }
        }
        require(found == 1, "exactly one CCTP message");
    }

    function test_fork_exit_burns_through_real_cctp_into_the_message_solana_accepts() public {
        Exit memory e = solanaExit();
        MockOutbox outbox = new MockOutbox(ROLLUP_VERSION);
        EclypsPortal portal = deployPortal(e, outbox);
        forwardRelay(portal, e);
        uint256 amount = uint256(e.count) * e.denomination;
        IERC20Minimal usdc = IERC20Minimal(SEPOLIA_USDC);
        assertEq(usdc.balanceOf(address(portal)), amount, "real USDC from the forward relay");
        uint256 supply = ITotalSupply(SEPOLIA_USDC).totalSupply();
        EclypsPortal.OutboxProof memory p = proveExit(portal, outbox, e);

        // Each call of a test starts with cold accounts and slots, as a transaction of its own.
        vm.recordLogs();
        portal.exitBatch(e.root, e.count, e.exitEpochId, e.denomination, p);
        uint256 execution = vm.lastFrameGas().gasTotalUsed;
        bytes memory raw = messageSent(vm.getRecordedLogs());
        emit log_named_uint("exitBatch execution gas (real CCTP V2, mock Outbox)", execution);
        emit log_named_uint(
            "exitBatch transaction gas (+ 21,000 + calldata)",
            21_000
                + calldataGas(
                    abi.encodeCall(
                        EclypsPortal.exitBatch, (e.root, e.count, e.exitEpochId, e.denomination, p)
                    )
                ) + execution
        );

        // Every field Solana's exit_message::parse reads, at its offset (ADR 0009).
        assertEq(raw.length, 427, "376 + 51-byte hook");
        assertEq(u32At(raw, 0), 1, "version");
        assertEq(u32At(raw, 4), 0, "source domain: Ethereum");
        assertEq(u32At(raw, 8), 5, "destination domain: Solana");
        assertEq(b32At(raw, 12), bytes32(0), "nonce: Iris assigns it");
        assertEq(b32At(raw, 44), toB32(SEPOLIA_TOKEN_MESSENGER), "sender: TokenMessengerV2");
        assertEq(b32At(raw, 76), SOLANA_TMM, "recipient: Solana TokenMessengerMinterV2");
        assertEq(b32At(raw, 108), e.exitAuthority, "destinationCaller: exit authority");
        assertEq(u32At(raw, 140), 2000, "minFinalityThreshold: standard");
        assertEq(u32At(raw, 144), 0, "finalityThresholdExecuted: Iris fills it");
        assertEq(u32At(raw, 148), 1, "body version");
        assertEq(b32At(raw, 152), toB32(SEPOLIA_USDC), "burn token: Sepolia USDC");
        assertEq(b32At(raw, 184), e.exitCustody, "mintRecipient: exit custody");
        assertEq(uint256(b32At(raw, 216)), amount, "amount: count x denomination");
        assertEq(b32At(raw, 248), toB32(address(portal)), "messageSender: the portal");
        assertEq(uint256(b32At(raw, 280)), 0, "maxFee");
        assertEq(uint256(b32At(raw, 312)), 0, "feeExecuted");
        assertEq(uint256(b32At(raw, 344)), 0, "expirationBlock");
        assertEq(
            slice(raw, 376, 427),
            ExitHook.encode(e.denomination, e.exitEpochId, e.count, e.root),
            "exit hook"
        );

        // What Iris does before attesting; the result is the message the gateway received.
        bytes memory filled = slice(raw, 0, raw.length);
        for (uint256 i; i < 32; ++i) {
            filled[12 + i] = e.solanaMessage[12 + i];
        }
        filled[146] = 0x07;
        filled[147] = 0xd0; // 2000
        assertEq(filled, e.solanaMessage, "= the message receive_exit accepted in LiteSVM");

        assertEq(usdc.balanceOf(address(portal)), 0, "burned from the portal");
        assertEq(supply - ITotalSupply(SEPOLIA_USDC).totalSupply(), amount, "USDC supply burned");
        assertTrue(portal.exited(e.denomination, e.exitEpochId));

        keepFixture(raw, e, amount);

        // A second exit for the same epoch never reaches CCTP.
        vm.expectRevert(
            abi.encodeWithSelector(
                EclypsPortal.AlreadyExited.selector, e.denomination, e.exitEpochId
            )
        );
        portal.exitBatch(e.root, e.count, e.exitEpochId, e.denomination, p);
    }

    /// The raw bytes for the gateway's parse test and the SDK. Compared, or rewritten with
    /// ECLYPS_WRITE_FIXTURES=true.
    function keepFixture(bytes memory raw, Exit memory e, uint256 amount) internal {
        if (!vm.envOr("ECLYPS_WRITE_FIXTURES", false)) {
            assertEq(raw, vm.parseJsonBytes(vm.readFile(FIXTURE), ".message"), FIXTURE);
            return;
        }
        string memory o = "fixture";
        vm.serializeString(
            o,
            "source",
            "test/ExitBatchFork.t.sol: MessageSent of EclypsPortal.exitBatch on a Sepolia fork (real CCTP V2), before Iris fills nonce (12) and finalityThresholdExecuted (144)"
        );
        vm.serializeAddress(o, "portal", e.portal);
        vm.serializeAddress(o, "tokenMessenger", SEPOLIA_TOKEN_MESSENGER);
        vm.serializeAddress(o, "usdc", SEPOLIA_USDC);
        vm.serializeBytes32(o, "exitAuthority", e.exitAuthority);
        vm.serializeBytes32(o, "exitCustody", e.exitCustody);
        vm.serializeString(o, "denomination", vm.toString(e.denomination));
        vm.serializeString(o, "exitEpochId", vm.toString(e.exitEpochId));
        vm.serializeUint(o, "count", e.count);
        vm.serializeBytes32(o, "root", e.root);
        vm.serializeString(o, "amount", vm.toString(amount));
        vm.writeJson(vm.serializeBytes(o, "message", raw), FIXTURE);
    }

    /// The message `exit_to_ethereum` sends, inserted in the mock Outbox as a proven epoch would be.
    function proveEthereumExit(
        EclypsPortal portal,
        MockOutbox outbox,
        uint64 denomination,
        address recipient,
        bytes32 secret,
        uint256 epoch
    ) internal returns (EclypsPortal.OutboxProof memory p) {
        DataStructures.L2ToL1Msg memory m = DataStructures.L2ToL1Msg(
            DataStructures.L2Actor(portal.claimContract(denomination), ROLLUP_VERSION),
            DataStructures.L1Actor(address(portal), block.chainid),
            portal.ethereumExitContent(
                portal.ethereumExitCommitment(recipient, secret), denomination
            )
        );
        bytes32 sibling = keccak256("another L2->L1 message") >> 8;
        outbox.insert(
            epoch, 1, AztecHash.sha256ToField(bytes.concat(AztecHash.messageHash(m), sibling))
        );
        p.epoch = epoch;
        p.numCheckpointsInEpoch = 1;
        p.path = new bytes32[](1);
        p.path[0] = sibling;
    }

    /// Leave to Ethereum (ADR 0014 §4) with real Sepolia USDC that a real CCTP forward relay left
    /// in the portal: claimToEthereum pays exactly one denomination to the committed recipient.
    function test_fork_claim_to_ethereum_pays_real_usdc() public {
        Exit memory e = solanaExit();
        MockOutbox outbox = new MockOutbox(ROLLUP_VERSION);
        EclypsPortal portal = deployPortal(e, outbox);
        forwardRelay(portal, e);
        IERC20Minimal usdc = IERC20Minimal(SEPOLIA_USDC);
        uint256 funded = usdc.balanceOf(address(portal));
        address recipient = makeAddr("fresh Ethereum recipient");
        bytes32 secret = keccak256("exit secret") >> 8;
        EclypsPortal.OutboxProof memory p =
            proveEthereumExit(portal, outbox, e.denomination, recipient, secret, 5);

        vm.prank(makeAddr("relayer"));
        portal.claimToEthereum(e.denomination, recipient, secret, p);
        uint256 execution = vm.lastFrameGas().gasTotalUsed;
        uint256 calldataCost = calldataGas(
            abi.encodeCall(EclypsPortal.claimToEthereum, (e.denomination, recipient, secret, p))
        );
        emit log_named_uint(
            "claimToEthereum execution gas (real USDC, new holder, mock Outbox)", execution
        );
        emit log_named_uint(
            "claimToEthereum transaction gas (+ 21,000 + calldata)",
            21_000 + calldataCost + execution
        );
        assertEq(usdc.balanceOf(recipient), e.denomination, "one denomination of real USDC");
        assertEq(usdc.balanceOf(address(portal)), funded - e.denomination);

        // A second exit to a recipient that already holds USDC.
        bytes32 secret2 = bytes32(uint256(secret) + 1);
        p = proveEthereumExit(portal, outbox, e.denomination, recipient, secret2, 6);
        portal.claimToEthereum(e.denomination, recipient, secret2, p);
        emit log_named_uint(
            "claimToEthereum execution gas (real USDC, existing holder, mock Outbox)",
            vm.lastFrameGas().gasTotalUsed
        );
        assertEq(usdc.balanceOf(recipient), 2 * uint256(e.denomination));

        vm.expectPartialRevert(MockOutbox.Outbox__AlreadyNullified.selector);
        portal.claimToEthereum(e.denomination, recipient, secret2, p);
    }

    /// The portal's Outbox call reaches the real Aztec testnet Outbox (registry -> canonical
    /// rollup) and passes its version, recipient and chain checks: it stops only at the missing
    /// proven root, with the Outbox's own error.
    function test_fork_real_aztec_testnet_outbox_is_reached() public {
        Exit memory e = solanaExit();
        deployCodeTo(
            "EclypsPortal.sol:EclypsPortal",
            abi.encode(
                IReceiverV2(SEPOLIA_MESSAGE_TRANSMITTER),
                IERC20Minimal(SEPOLIA_USDC),
                SOLANA_TMM,
                SEPOLIA_TOKEN_MESSENGER,
                SOLANA_DEVNET_USDC,
                GATEWAY,
                IRegistry(AZTEC_TESTNET_REGISTRY),
                SECRET_HASH_ZERO,
                e.exitAuthority,
                e.exitCustody
            ),
            e.portal
        );
        EclypsPortal portal = EclypsPortal(e.portal);
        vm.prank(portal.binder());
        portal.bindClaimContract(e.denomination, keccak256("aztec claim contract (placeholder)"));
        assertEq(
            address(portal.outbox()),
            address(IRegistry(AZTEC_TESTNET_REGISTRY).getCanonicalRollup().getOutbox())
        );
        emit log_named_address("Aztec testnet Outbox", address(portal.outbox()));

        EclypsPortal.OutboxProof memory p;
        p.epoch = 1 << 64; // never proven
        p.numCheckpointsInEpoch = 1;
        p.path = new bytes32[](1);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("Outbox__NothingToConsumeAtEpoch(uint256)")), p.epoch
            )
        );
        portal.exitBatch(e.root, e.count, e.exitEpochId, e.denomination, p);
        assertFalse(portal.outbox().hasMessageBeenConsumedAtEpoch(p.epoch, 2));

        // claimToEthereum makes the same call shape.
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("Outbox__NothingToConsumeAtEpoch(uint256)")), p.epoch
            )
        );
        portal.claimToEthereum(e.denomination, address(0xA11CE), bytes32(uint256(1)), p);
    }
}
