// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {IERC20Minimal, IReceiverV2} from "./interfaces/ICctp.sol";
import {BatchHook} from "./libraries/BatchHook.sol";
import {CctpMessageV2} from "./libraries/CctpMessageV2.sol";

/// @title BatchReceiver (S1 spike)
/// @notice Receives one CCTP V2 burn from the Solana gateway together with its batch hook,
/// checks that the hook is bound to exactly that burn, and emits the decoded root.
/// S2 extends this into the Ethereum portal, which forwards funds and the root into Aztec.
/// Relaying is permissionless: any party may submit Circle's (message, attestation).
/// Relay order does not matter. If a relay reverts, the CCTP nonce stays unused and the message can be resubmitted.
contract BatchReceiver {
    using CctpMessageV2 for bytes;

    uint32 public constant SOLANA_DOMAIN = 5;
    uint32 public constant ETHEREUM_DOMAIN = 0;
    uint32 public constant CCTP_VERSION = 1;
    uint16 public constant MAX_LEAVES = 256; // 2^BATCH_TREE_DEPTH (ADR 0004)
    uint256 internal constant BN254_R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IReceiverV2 public immutable messageTransmitter;
    IERC20Minimal public immutable usdc;
    /// @notice Solana TokenMessengerMinterV2 program id (the CCTP header `sender`).
    bytes32 public immutable solanaTokenMessenger;
    /// @notice Local TokenMessengerV2 as bytes32 (the CCTP header `recipient`).
    bytes32 public immutable localTokenMessenger;
    /// @notice Solana USDC mint (the burn token).
    bytes32 public immutable solanaUsdcMint;
    /// @notice The only Solana account allowed to originate batches (the burn `messageSender`):
    /// the gateway's PDA in production, or a test wallet in the S1 spike.
    bytes32 public immutable gatewaySender;

    /// @notice Replay lock per (denomination, epochId).
    mapping(uint64 denomination => mapping(uint64 epochId => bool)) public received;

    event BatchReceived(
        bytes32 indexed root,
        uint64 indexed denomination,
        uint64 indexed epochId,
        uint16 leafCount,
        uint256 amount,
        bytes32 cctpNonce
    );

    error WrongVersion();
    error WrongSourceDomain(uint32 domain);
    error WrongDestinationDomain(uint32 domain);
    error WrongSender(bytes32 sender);
    error WrongRecipient(bytes32 recipient);
    error WrongDestinationCaller(bytes32 caller);
    error WrongBurnToken(bytes32 token);
    error WrongMintRecipient(bytes32 recipient);
    error WrongMessageSender(bytes32 messageSender);
    error FeeCharged(uint256 fee);
    error BadBatch();
    error AlreadyReceived(uint64 denomination, uint64 epochId);
    error ReceiveFailed();
    error MintMismatch(uint256 minted, uint256 expected);

    constructor(
        IReceiverV2 messageTransmitter_,
        IERC20Minimal usdc_,
        bytes32 solanaTokenMessenger_,
        address localTokenMessenger_,
        bytes32 solanaUsdcMint_,
        bytes32 gatewaySender_
    ) {
        messageTransmitter = messageTransmitter_;
        usdc = usdc_;
        solanaTokenMessenger = solanaTokenMessenger_;
        localTokenMessenger = bytes32(uint256(uint160(localTokenMessenger_)));
        solanaUsdcMint = solanaUsdcMint_;
        gatewaySender = gatewaySender_;
    }

    /// @notice Validates and receives a batch. Returns the decoded batch.
    function relay(bytes calldata message, bytes calldata attestation)
        external
        returns (BatchHook.Batch memory batch)
    {
        batch = _validate(message);
        received[batch.denomination][batch.epochId] = true;

        uint256 before = usdc.balanceOf(address(this));
        if (!messageTransmitter.receiveMessage(message, attestation)) revert ReceiveFailed();
        uint256 minted = usdc.balanceOf(address(this)) - before;
        uint256 expected = uint256(batch.leafCount) * batch.denomination;
        if (minted != expected) revert MintMismatch(minted, expected);

        emit BatchReceived(
            batch.root, batch.denomination, batch.epochId, batch.leafCount, minted, message.nonce()
        );
        _onBatch(batch, minted);
    }

    /// @notice Extension point: called after funds and root are received (S2: forward to Aztec).
    function _onBatch(BatchHook.Batch memory batch, uint256 amount) internal virtual {}

    /// @notice All checks that do not need the attestation. Public so clients can pre-check.
    function validate(bytes calldata message) external view returns (BatchHook.Batch memory) {
        return _validate(message);
    }

    function _validate(bytes calldata m) internal view returns (BatchHook.Batch memory b) {
        m.checkLength();
        if (m.version() != CCTP_VERSION || m.bodyVersion() != CCTP_VERSION) revert WrongVersion();
        if (m.sourceDomain() != SOLANA_DOMAIN) revert WrongSourceDomain(m.sourceDomain());
        if (m.destinationDomain() != ETHEREUM_DOMAIN) {
            revert WrongDestinationDomain(m.destinationDomain());
        }
        // A generic (non-burn) message from any Solana program could mimic a burn body;
        // sender/recipient pin it to the TokenMessenger pair, which only emits real burns.
        if (m.sender() != solanaTokenMessenger) revert WrongSender(m.sender());
        if (m.recipient() != localTokenMessenger) revert WrongRecipient(m.recipient());
        bytes32 self = bytes32(uint256(uint160(address(this))));
        // MessageTransmitterV2 enforces msg.sender == destinationCaller when it is non-zero.
        // We require it so that nobody else can consume the nonce and skip the hook.
        if (m.destinationCaller() != self) revert WrongDestinationCaller(m.destinationCaller());
        if (m.burnToken() != solanaUsdcMint) revert WrongBurnToken(m.burnToken());
        if (m.mintRecipient() != self) revert WrongMintRecipient(m.mintRecipient());
        if (m.messageSender() != gatewaySender) revert WrongMessageSender(m.messageSender());
        // Denominations must arrive exactly; only standard (fee-free) transfers are accepted.
        if (m.feeExecuted() != 0) revert FeeCharged(m.feeExecuted());

        b = BatchHook.decode(m.hookData());
        if (
            b.denomination == 0 || b.leafCount == 0 || b.leafCount > MAX_LEAVES
                || uint256(b.root) >= BN254_R || m.amount() != uint256(b.leafCount) * b.denomination
        ) revert BadBatch();
        if (received[b.denomination][b.epochId]) revert AlreadyReceived(b.denomination, b.epochId);
    }
}
