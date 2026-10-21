// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

/// @notice CCTP V2 MessageTransmitterV2 receive entry point
/// (circlefin/evm-cctp-contracts src/interfaces/IReceiver.sol, re-declared because
/// upstream is pinned to solc 0.7.6).
interface IReceiverV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation)
        external
        returns (bool success);
}

/// @notice CCTP V2 TokenMessengerV2 burn entry point (circlefin/evm-cctp-contracts
/// src/v2/TokenMessengerV2.sol). It pulls `amount` of `burnToken` from msg.sender (who must have
/// approved it), burns it, and has MessageTransmitterV2 emit `MessageSent` with
/// messageSender = msg.sender.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
