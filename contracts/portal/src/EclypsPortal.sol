// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {BatchReceiver} from "./BatchReceiver.sol";
import {
    AztecHash,
    DataStructures,
    IInbox,
    IOutbox,
    IRegistry,
    IRollup
} from "./interfaces/IAztec.sol";
import {IERC20Minimal, IReceiverV2, ITokenMessengerV2} from "./interfaces/ICctp.sol";
import {BatchHook} from "./libraries/BatchHook.sol";
import {ExitHook} from "./libraries/ExitHook.sol";

/// @title EclypsPortal
/// @notice Ethereum leg of the gateway.
/// - Forward (ADR 0003): receives a batch over CCTP (BatchReceiver) and forwards its root into
///   Aztec as one L1->L2 message to the claim contract of that denomination. The USDC stays here.
///   Content = sha256ToField(abi.encode(root, total, epochId, denomination)), mirrored by
///   `batch_content_hash` in aztec/claim.
/// - Exit (ADR 0009): `exitBatch` consumes the claim contract's L2->L1 message for a closed exit
///   epoch from the Aztec Outbox and burns count x denomination of that USDC back to the Solana
///   gateway through CCTP V2, with the exit root in the hook.
/// - Leave to Ethereum (ADR 0014 §4): `claimToEthereum` consumes the claim contract's L2->L1
///   message for one exit and pays one denomination of that USDC to the recipient it commits to.
contract EclypsPortal is BatchReceiver {
    /// @notice CCTP finality for exits: finalized ("standard"), fee-free, so the mint is exact.
    uint32 public constant EXIT_MIN_FINALITY = 2000;
    /// @notice First word of an Ethereum exit's content: the ASCII bytes of
    /// "eclyps:exit-to-ethereum" as a big-endian integer (aztec/claim `ETHEREUM_EXIT_TAG`). An exit
    /// batch's content starts with its root instead, and is 128 bytes, not 96: neither kind of
    /// message can be consumed as the other.
    uint256 public constant ETHEREUM_EXIT_TAG = 0x65636c7970733a657869742d746f2d657468657265756d;

    IInbox public immutable inbox;
    IOutbox public immutable outbox;
    uint256 public immutable rollupVersion;
    /// @notice computeSecretHash([0]) (Aztec Poseidon2). Registration is permissionless on L2; the
    /// content authenticates the batch, so the secret is a public constant.
    bytes32 public immutable registerSecretHash;
    /// @notice May bind each denomination's claim contract once (Aztec addresses depend on the
    /// portal address, so they cannot be constructor arguments). Phase 1: precompute instead.
    address public immutable binder;
    /// @notice The local TokenMessengerV2 (the `recipient` of forward messages) burns exits.
    ITokenMessengerV2 public immutable tokenMessenger;
    /// @notice Gateway PDA ["exit_authority"] (Solana): the CCTP destinationCaller of every exit,
    /// so only the gateway's `receive_exit` can receive it.
    bytes32 public immutable exitAuthority;
    /// @notice Gateway PDA ["exit_custody"] (Solana): the USDC account CCTP pays exits into.
    bytes32 public immutable exitCustody;

    mapping(uint64 denomination => bytes32 claimContract) public claimContract;
    /// @notice At most one CCTP message per (denomination, exitEpochId), even if Aztec sent two.
    mapping(uint64 denomination => mapping(uint64 exitEpochId => bool)) public exited;

    /// @notice Where the exit message sits in the Outbox (Aztec's L2->L1 membership witness).
    struct OutboxProof {
        uint256 epoch;
        uint256 numCheckpointsInEpoch;
        uint256 leafIndex;
        bytes32[] path;
    }

    event ClaimContractBound(uint64 indexed denomination, bytes32 claimContract);
    event BatchForwarded(
        bytes32 indexed root,
        uint64 indexed denomination,
        uint64 indexed epochId,
        bytes32 content,
        bytes32 messageKey,
        uint256 messageIndex
    );
    /// @notice CCTP V2 assigns no nonce on Ethereum (Iris does); find the message by this tx.
    event ExitBatchSent(
        uint64 indexed denomination,
        uint64 indexed exitEpochId,
        bytes32 indexed root,
        uint16 count,
        uint256 amount,
        bytes32 content
    );
    /// @notice One exit from Aztec paid on Ethereum. The recipient is public from here on; which
    /// note or Aztec account it came from is not.
    event ExitedToEthereum(
        uint64 indexed denomination, address indexed recipient, bytes32 commitment, bytes32 content
    );

    error NotBinder();
    error AlreadyBound(uint64 denomination);
    error ZeroClaimContract();
    error UnboundDenomination(uint64 denomination);
    error ZeroExitAccount();
    error BadExitCount(uint16 count);
    error NonCanonicalRoot(bytes32 root);
    error AmountTooLarge(uint256 amount);
    error AlreadyExited(uint64 denomination, uint64 exitEpochId);
    error InsufficientBalance(uint256 balance, uint256 amount);
    error ApproveFailed();
    error BurnMismatch(uint256 burned, uint256 expected);
    error ZeroRecipient();
    error TransferFailed();

    constructor(
        IReceiverV2 messageTransmitter_,
        IERC20Minimal usdc_,
        bytes32 solanaTokenMessenger_,
        address localTokenMessenger_,
        bytes32 solanaUsdcMint_,
        bytes32 gatewaySender_,
        IRegistry aztecRegistry_,
        bytes32 registerSecretHash_,
        bytes32 exitAuthority_,
        bytes32 exitCustody_
    )
        BatchReceiver(
            messageTransmitter_,
            usdc_,
            solanaTokenMessenger_,
            localTokenMessenger_,
            solanaUsdcMint_,
            gatewaySender_
        )
    {
        if (exitAuthority_ == bytes32(0) || exitCustody_ == bytes32(0)) {
            revert ZeroExitAccount();
        }
        IRollup rollup = aztecRegistry_.getCanonicalRollup();
        inbox = rollup.getInbox();
        outbox = rollup.getOutbox();
        rollupVersion = rollup.getVersion();
        registerSecretHash = registerSecretHash_;
        binder = msg.sender;
        tokenMessenger = ITokenMessengerV2(localTokenMessenger_);
        exitAuthority = exitAuthority_;
        exitCustody = exitCustody_;
    }

    function bindClaimContract(uint64 denomination, bytes32 claim) external {
        if (msg.sender != binder) revert NotBinder();
        if (claim == bytes32(0)) revert ZeroClaimContract();
        if (claimContract[denomination] != bytes32(0)) revert AlreadyBound(denomination);
        claimContract[denomination] = claim;
        emit ClaimContractBound(denomination, claim);
    }

    /// @notice The L1->L2 content for a batch; public so clients and tests can recompute it.
    function batchContent(bytes32 root, uint256 total, uint64 epochId, uint64 denomination)
        public
        pure
        returns (bytes32)
    {
        return AztecHash.sha256ToField(
            abi.encode(root, total, uint256(epochId), uint256(denomination))
        );
    }

    /// @notice The L2->L1 content of a closed exit epoch, as the claim contract must send it:
    /// sha256ToField of four 32-byte big-endian words (root, count, exitEpochId, denomination).
    function exitContent(bytes32 root, uint16 count, uint64 exitEpochId, uint64 denomination)
        public
        pure
        returns (bytes32)
    {
        return AztecHash.sha256ToField(
            abi.encode(root, uint256(count), uint256(exitEpochId), uint256(denomination))
        );
    }

    /// @notice Sends a closed exit epoch to Solana. Permissionless: the Outbox proof authenticates
    /// it. Consumes the claim contract's L2->L1 message, then burns count x denomination USDC
    /// through CCTP V2 to the gateway's exit custody with the exit hook. A revert leaves the
    /// message in the Outbox, so the call can be retried.
    function exitBatch(
        bytes32 root,
        uint16 count,
        uint64 exitEpochId,
        uint64 denomination,
        OutboxProof calldata proof
    ) external returns (uint256 amount) {
        bytes32 claim = claimContract[denomination];
        if (claim == bytes32(0)) revert UnboundDenomination(denomination);
        if (count == 0 || count > MAX_LEAVES) revert BadExitCount(count);
        if (uint256(root) >= BN254_R) revert NonCanonicalRoot(root);
        // Solana amounts are u64.
        amount = uint256(count) * denomination;
        if (amount > type(uint64).max) revert AmountTooLarge(amount);
        if (exited[denomination][exitEpochId]) revert AlreadyExited(denomination, exitEpochId);
        exited[denomination][exitEpochId] = true;

        // The message is rebuilt from the bound claim contract, this portal and the content, so
        // the proof only verifies for exactly what that claim contract sent to this portal.
        bytes32 content = exitContent(root, count, exitEpochId, denomination);
        outbox.consume(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(claim, rollupVersion),
                recipient: DataStructures.L1Actor(address(this), block.chainid),
                content: content
            }),
            proof.epoch,
            proof.numCheckpointsInEpoch,
            proof.leafIndex,
            proof.path
        );

        _burnToSolana(amount, ExitHook.encode(denomination, exitEpochId, count, root));
        emit ExitBatchSent(denomination, exitEpochId, root, count, amount, content);
    }

    /// @notice What the app commits to when it leaves Aztec for Ethereum:
    /// sha256ToField(abi.encode(recipient, exitSecret)). Truncated like every Aztec content so it
    /// fits a field on Aztec.
    function ethereumExitCommitment(address recipient, bytes32 exitSecret)
        public
        pure
        returns (bytes32)
    {
        return AztecHash.sha256ToField(abi.encode(recipient, exitSecret));
    }

    /// @notice The L2->L1 content of one exit to Ethereum, as the claim contract sends it:
    /// sha256ToField of three 32-byte words (ETHEREUM_EXIT_TAG, commitment, denomination).
    function ethereumExitContent(bytes32 commitment, uint64 denomination)
        public
        pure
        returns (bytes32)
    {
        return AztecHash.sha256ToField(
            abi.encode(ETHEREUM_EXIT_TAG, commitment, uint256(denomination))
        );
    }

    /// @notice Pays one exit from Aztec to `recipient` on Ethereum. Permissionless (a relayer may
    /// pay the gas): the money can only go to the recipient the exit committed to. Rebuilds the
    /// commitment and the message from the bound claim contract, consumes it from the Outbox
    /// (once, by the Outbox's own nullifier) and transfers exactly `denomination` USDC. A revert
    /// leaves the message in the Outbox, so the call can be retried.
    function claimToEthereum(
        uint64 denomination,
        address recipient,
        bytes32 exitSecret,
        OutboxProof calldata proof
    ) external {
        bytes32 claim = claimContract[denomination];
        if (claim == bytes32(0)) revert UnboundDenomination(denomination);
        if (recipient == address(0)) revert ZeroRecipient();

        bytes32 commitment = ethereumExitCommitment(recipient, exitSecret);
        bytes32 content = ethereumExitContent(commitment, denomination);
        outbox.consume(
            DataStructures.L2ToL1Msg({
                sender: DataStructures.L2Actor(claim, rollupVersion),
                recipient: DataStructures.L1Actor(address(this), block.chainid),
                content: content
            }),
            proof.epoch,
            proof.numCheckpointsInEpoch,
            proof.leafIndex,
            proof.path
        );

        uint256 balance = usdc.balanceOf(address(this));
        if (balance < denomination) revert InsufficientBalance(balance, denomination);
        if (!usdc.transfer(recipient, denomination)) revert TransferFailed();
        emit ExitedToEthereum(denomination, recipient, commitment, content);
    }

    /// @dev Approves exactly `amount` for this one call; TokenMessengerV2 pulls all of it, so no
    /// allowance is left between exits.
    function _burnToSolana(uint256 amount, bytes memory hook) internal {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance < amount) revert InsufficientBalance(balance, amount);
        if (!usdc.approve(address(tokenMessenger), amount)) revert ApproveFailed();
        tokenMessenger.depositForBurnWithHook(
            amount,
            SOLANA_DOMAIN,
            exitCustody,
            address(usdc),
            exitAuthority,
            0, // maxFee: a standard transfer is fee-free, so Solana receives exactly `amount`
            EXIT_MIN_FINALITY,
            hook
        );
        uint256 burned = balance - usdc.balanceOf(address(this));
        if (burned != amount) revert BurnMismatch(burned, amount);
    }

    function _onBatch(BatchHook.Batch memory b, uint256 amount) internal override {
        bytes32 claim = claimContract[b.denomination];
        // Reverting keeps the CCTP nonce unused: the batch can be relayed once bound.
        if (claim == bytes32(0)) revert UnboundDenomination(b.denomination);
        bytes32 content = batchContent(b.root, amount, b.epochId, b.denomination);
        (bytes32 key, uint256 index) = inbox.sendL2Message(
            DataStructures.L2Actor(claim, rollupVersion), content, registerSecretHash
        );
        emit BatchForwarded(b.root, b.denomination, b.epochId, content, key, index);
    }
}
