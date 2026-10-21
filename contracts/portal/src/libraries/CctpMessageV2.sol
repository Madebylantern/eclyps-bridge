// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

/// @notice Read-only views over a CCTP V2 burn message (MessageV2 header + BurnMessageV2 body).
/// All integers are big-endian. Offsets: circlefin/evm-cctp-contracts
/// src/messages/v2/MessageV2.sol and BurnMessageV2.sol; verified against a real
/// devnet -> Sepolia message (test/fixtures/iris-devnet-hook-message.json). See ADR 0002.
library CctpMessageV2 {
    // Header
    uint256 internal constant VERSION = 0;
    uint256 internal constant SOURCE_DOMAIN = 4;
    uint256 internal constant DESTINATION_DOMAIN = 8;
    uint256 internal constant NONCE = 12;
    uint256 internal constant SENDER = 44;
    uint256 internal constant RECIPIENT = 76;
    uint256 internal constant DESTINATION_CALLER = 108;
    uint256 internal constant MIN_FINALITY = 140;
    uint256 internal constant FINALITY_EXECUTED = 144;
    uint256 internal constant BODY = 148;
    // Body (absolute)
    uint256 internal constant BODY_VERSION = BODY + 0;
    uint256 internal constant BURN_TOKEN = BODY + 4;
    uint256 internal constant MINT_RECIPIENT = BODY + 36;
    uint256 internal constant AMOUNT = BODY + 68;
    uint256 internal constant MESSAGE_SENDER = BODY + 100;
    uint256 internal constant MAX_FEE = BODY + 132;
    uint256 internal constant FEE_EXECUTED = BODY + 164;
    uint256 internal constant EXPIRATION_BLOCK = BODY + 196;
    uint256 internal constant HOOK_DATA = BODY + 228; // 376; runs to the end, no length prefix

    error MessageTooShort();

    function checkLength(bytes calldata m) internal pure {
        if (m.length < HOOK_DATA) revert MessageTooShort();
    }

    function u32At(bytes calldata m, uint256 o) private pure returns (uint32) {
        return uint32(bytes4(m[o:o + 4]));
    }

    function b32At(bytes calldata m, uint256 o) private pure returns (bytes32) {
        return bytes32(m[o:o + 32]);
    }

    function version(bytes calldata m) internal pure returns (uint32) {
        return u32At(m, VERSION);
    }

    function sourceDomain(bytes calldata m) internal pure returns (uint32) {
        return u32At(m, SOURCE_DOMAIN);
    }

    function destinationDomain(bytes calldata m) internal pure returns (uint32) {
        return u32At(m, DESTINATION_DOMAIN);
    }

    function nonce(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, NONCE);
    }

    function sender(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, SENDER);
    }

    function recipient(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, RECIPIENT);
    }

    function destinationCaller(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, DESTINATION_CALLER);
    }

    function minFinalityThreshold(bytes calldata m) internal pure returns (uint32) {
        return u32At(m, MIN_FINALITY);
    }

    function finalityThresholdExecuted(bytes calldata m) internal pure returns (uint32) {
        return u32At(m, FINALITY_EXECUTED);
    }

    function bodyVersion(bytes calldata m) internal pure returns (uint32) {
        return u32At(m, BODY_VERSION);
    }

    function burnToken(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, BURN_TOKEN);
    }

    function mintRecipient(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, MINT_RECIPIENT);
    }

    function amount(bytes calldata m) internal pure returns (uint256) {
        return uint256(b32At(m, AMOUNT));
    }

    function messageSender(bytes calldata m) internal pure returns (bytes32) {
        return b32At(m, MESSAGE_SENDER);
    }

    function maxFee(bytes calldata m) internal pure returns (uint256) {
        return uint256(b32At(m, MAX_FEE));
    }

    function feeExecuted(bytes calldata m) internal pure returns (uint256) {
        return uint256(b32At(m, FEE_EXECUTED));
    }

    function expirationBlock(bytes calldata m) internal pure returns (uint256) {
        return uint256(b32At(m, EXPIRATION_BLOCK));
    }

    function hookData(bytes calldata m) internal pure returns (bytes calldata) {
        return m[HOOK_DATA:];
    }
}
