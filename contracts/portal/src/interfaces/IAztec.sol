// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

/// @notice Minimal subset of Aztec l1-contracts for Aztec 6.0.0-rc.3, re-declared to avoid vendoring
/// the whole tree (ADR 0003, ADR 0009). Aztec 6.0.0-rc.3 ships its L1 contracts in the npm package
/// aztec-foundation/l1-artifacts 6.0.0-rc.6 (AztecProtocol/aztec-packages tag v6.0.0-rc.6,
/// l1-contracts/src/core/...). The Inbox, Outbox, DataStructures and Hash used here are identical to
/// v6.0.0-rc.1. `Epoch` is `type Epoch is uint256` upstream, so it is a uint256 in the ABI.
library DataStructures {
    struct L1Actor {
        address actor;
        uint256 chainId;
    }

    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }

    struct L2ToL1Msg {
        L2Actor sender;
        L1Actor recipient;
        bytes32 content;
    }
}

interface IInbox {
    /// @return key of the message and its compact cumulative index (= L1->L2 tree leaf index)
    function sendL2Message(
        DataStructures.L2Actor memory recipient,
        bytes32 content,
        bytes32 secretHash
    ) external returns (bytes32, uint256);
}

interface IOutbox {
    /// @notice Consumes an L2->L1 message once. Reverts unless msg.sender is the recipient, the
    /// chain id and rollup version match, and `path` proves the message under the root the rollup
    /// inserted for (`epoch`, `numCheckpointsInEpoch`).
    function consume(
        DataStructures.L2ToL1Msg calldata message,
        uint256 epoch,
        uint256 numCheckpointsInEpoch,
        uint256 leafIndex,
        bytes32[] calldata path
    ) external;

    /// @param leafId (1 << path.length) + leafIndex
    function hasMessageBeenConsumedAtEpoch(uint256 epoch, uint256 leafId)
        external
        view
        returns (bool);
}

interface IRollup {
    function getInbox() external view returns (IInbox);
    function getOutbox() external view returns (IOutbox);
    function getVersion() external view returns (uint256);
}

interface IRegistry {
    function getCanonicalRollup() external view returns (IRollup);
}

library AztecHash {
    /// @notice Hash.sha256ToField: sha256 truncated to 31 bytes so it fits the BN254 field.
    function sha256ToField(bytes memory data) internal pure returns (bytes32) {
        return bytes32(bytes.concat(new bytes(1), bytes31(sha256(data))));
    }

    /// @notice Hash.sha256ToField(L2ToL1Msg): the Outbox leaf of an L2->L1 message.
    function messageHash(DataStructures.L2ToL1Msg memory m) internal pure returns (bytes32) {
        return sha256ToField(
            abi.encodePacked(
                m.sender.actor, m.sender.version, m.recipient.actor, m.recipient.chainId, m.content
            )
        );
    }
}
