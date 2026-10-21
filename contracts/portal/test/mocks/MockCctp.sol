// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {IReceiverV2, ITokenMessengerV2} from "../../src/interfaces/ICctp.sol";
import {CctpMessageV2} from "../../src/libraries/CctpMessageV2.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
    }
}

/// @notice Mimics MessageTransmitterV2 + TokenMessengerV2 for unit tests: no signature check,
/// but enforces destinationCaller and nonce reuse, and mints amount - feeExecuted.
contract MockMessageTransmitter is IReceiverV2 {
    using CctpMessageV2 for bytes;

    MockUSDC public immutable usdc;
    mapping(bytes32 => bool) public usedNonces;

    constructor(MockUSDC usdc_) {
        usdc = usdc_;
    }

    function receiveMessage(bytes calldata m, bytes calldata) external returns (bool) {
        bytes32 caller = m.destinationCaller();
        require(
            caller == bytes32(0) || caller == bytes32(uint256(uint160(msg.sender))),
            "Invalid caller for message"
        );
        require(!usedNonces[m.nonce()], "Nonce already used");
        usedNonces[m.nonce()] = true;
        usdc.mint(address(uint160(uint256(m.mintRecipient()))), m.amount() - m.feeExecuted());
        return true;
    }
}

/// @notice Mimics TokenMessengerV2.depositForBurnWithHook for unit tests: Circle's argument
/// checks, pulls `amount` from the caller (which needs the allowance) and burns it, and records
/// every call.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    struct Burn {
        address caller;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    Burn[] internal burns;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(hookData.length > 0, "Hook data is empty");
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        MockUSDC(burnToken).transferFrom(msg.sender, address(this), amount);
        MockUSDC(burnToken).burn(amount);
        burns.push(
            Burn(
                msg.sender,
                amount,
                destinationDomain,
                mintRecipient,
                burnToken,
                destinationCaller,
                maxFee,
                minFinalityThreshold,
                hookData
            )
        );
    }

    function count() external view returns (uint256) {
        return burns.length;
    }

    function burn(uint256 i) external view returns (Burn memory) {
        return burns[i];
    }
}
