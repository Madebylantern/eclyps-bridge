// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {BatchReceiver} from "../src/BatchReceiver.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";

/// Sepolia deploy for the S1 live run (testnet only; ask the owner first).
///   GATEWAY_SENDER=0x<32-byte Solana owner pubkey> forge script script/DeployBatchReceiver.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $SEPOLIA_PRIVATE_KEY --broadcast
contract DeployBatchReceiver is Script {
    function run() external returns (BatchReceiver r) {
        require(block.chainid == 11155111, "Sepolia only");
        bytes32 gatewaySender = vm.envBytes32("GATEWAY_SENDER");
        vm.startBroadcast();
        r = new BatchReceiver(
            IReceiverV2(0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275), // MessageTransmitterV2
            IERC20Minimal(0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238), // USDC
            0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893, // Solana TMM V2
            0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA, // TokenMessengerV2
            0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7, // devnet USDC mint
            gatewaySender
        );
        vm.stopBroadcast();
        console.log("BatchReceiver", address(r));
    }
}
