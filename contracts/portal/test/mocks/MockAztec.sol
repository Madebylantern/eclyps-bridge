// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {
    AztecHash,
    DataStructures,
    IInbox,
    IOutbox,
    IRegistry,
    IRollup
} from "../../src/interfaces/IAztec.sol";

contract MockInbox is IInbox {
    struct Sent {
        DataStructures.L2Actor recipient;
        bytes32 content;
        bytes32 secretHash;
        address sender;
    }

    Sent[] public sent;

    function sendL2Message(
        DataStructures.L2Actor memory recipient,
        bytes32 content,
        bytes32 secretHash
    ) external returns (bytes32, uint256) {
        sent.push(Sent(recipient, content, secretHash, msg.sender));
        return (keccak256(abi.encode(content, sent.length)), sent.length - 1);
    }

    function count() external view returns (uint256) {
        return sent.length;
    }
}

/// @notice The checks of Aztec's Outbox.consume (l1-contracts v6.0.0-rc.6 = Aztec 6.0.0-rc.3,
/// src/core/messagebridge/Outbox.sol), with an open `insert` standing in for the rollup's proven
/// epochs: version, recipient = msg.sender, chain id, the root for (epoch, numCheckpoints), the
/// sha256ToField sibling path (MerkleLib) and the per-epoch nullifier bitmap. Errors keep Aztec's
/// names.
contract MockOutbox is IOutbox {
    uint256 public constant MAX_CHECKPOINTS_PER_EPOCH = 32;
    uint256 public immutable VERSION;

    mapping(uint256 epoch => mapping(uint256 numCheckpoints => bytes32)) public roots;
    mapping(uint256 epoch => mapping(uint256 leafId => bool)) public nullified;

    event MessageConsumed(
        uint256 indexed epoch,
        bytes32 indexed root,
        bytes32 indexed messageHash,
        uint256 leafId,
        uint256 numCheckpointsInEpoch
    );

    error Outbox__PathTooLong();
    error Outbox__LeafIndexOutOfBounds(uint256 leafIndex, uint256 pathLength);
    error Outbox__VersionMismatch(uint256 expected, uint256 actual);
    error Outbox__InvalidRecipient(address expected, address actual);
    error Outbox__InvalidChainId();
    error Outbox__NothingToConsumeAtEpoch(uint256 epoch);
    error Outbox__AlreadyNullified(uint256 epoch, uint256 leafIndex);
    error MerkleLib__InvalidIndexForPathLength();
    error MerkleLib__InvalidRoot(bytes32 expected, bytes32 actual, bytes32 leaf, uint256 index);

    constructor(uint256 version_) {
        VERSION = version_;
    }

    function insert(uint256 epoch, uint256 numCheckpoints, bytes32 root) external {
        roots[epoch][numCheckpoints] = root;
    }

    function consume(
        DataStructures.L2ToL1Msg calldata m,
        uint256 epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) external {
        require(path.length < 256, Outbox__PathTooLong());
        require(
            leafIndex < (1 << path.length), Outbox__LeafIndexOutOfBounds(leafIndex, path.length)
        );
        require(m.sender.version == VERSION, Outbox__VersionMismatch(m.sender.version, VERSION));
        require(
            msg.sender == m.recipient.actor, Outbox__InvalidRecipient(m.recipient.actor, msg.sender)
        );
        require(block.chainid == m.recipient.chainId, Outbox__InvalidChainId());
        require(
            numCheckpointsInEpoch >= 1 && numCheckpointsInEpoch <= MAX_CHECKPOINTS_PER_EPOCH,
            Outbox__NothingToConsumeAtEpoch(epoch)
        );
        bytes32 root = roots[epoch][numCheckpointsInEpoch];
        require(root != bytes32(0), Outbox__NothingToConsumeAtEpoch(epoch));
        uint256 leafId = (1 << path.length) + leafIndex;
        require(!nullified[epoch][leafId], Outbox__AlreadyNullified(epoch, leafId));

        bytes32 leaf = AztecHash.messageHash(m);
        bytes32 node = leaf;
        uint256 index = leafIndex;
        for (uint256 h; h < path.length; ++h) {
            node = (index & 1) == 1
                ? AztecHash.sha256ToField(bytes.concat(path[h], node))
                : AztecHash.sha256ToField(bytes.concat(node, path[h]));
            index >>= 1;
        }
        require(index == 0, MerkleLib__InvalidIndexForPathLength());
        require(node == root, MerkleLib__InvalidRoot(root, node, leaf, leafIndex));

        nullified[epoch][leafId] = true;
        emit MessageConsumed(epoch, root, leaf, leafId, numCheckpointsInEpoch);
    }

    function hasMessageBeenConsumedAtEpoch(uint256 epoch, uint256 leafId)
        external
        view
        returns (bool)
    {
        return nullified[epoch][leafId];
    }
}

contract MockRollup is IRollup {
    IInbox public immutable inboxAddr;
    IOutbox public immutable outboxAddr;

    constructor(IInbox inbox_, IOutbox outbox_) {
        inboxAddr = inbox_;
        outboxAddr = outbox_;
    }

    function getInbox() external view returns (IInbox) {
        return inboxAddr;
    }

    function getOutbox() external view returns (IOutbox) {
        return outboxAddr;
    }

    function getVersion() external pure returns (uint256) {
        return 2914217885; // Aztec testnet rollup version (ADR 0003)
    }
}

contract MockRegistry is IRegistry {
    IRollup public immutable rollup;

    constructor(IRollup rollup_) {
        rollup = rollup_;
    }

    function getCanonicalRollup() external view returns (IRollup) {
        return rollup;
    }
}
