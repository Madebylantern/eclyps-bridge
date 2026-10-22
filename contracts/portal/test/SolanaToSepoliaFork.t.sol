// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {BatchReceiver} from "../src/BatchReceiver.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {BatchHook} from "../src/libraries/BatchHook.sol";
import {CctpTestBase} from "./CctpTestBase.sol";

interface IAttestable {
    function attesterManager() external view returns (address);
    function enableAttester(address) external;
    function setSignatureThreshold(uint256) external;
}

/// @notice S1 closed loop without funds. The message bytes come from the *real* Solana devnet
/// CCTP V2 programs (simulated deposit_for_burn_with_hook, see the fixture). We fill in the two
/// fields Iris assigns (nonce, finalityThresholdExecuted), substitute a test attester for
/// Circle's, and relay through the *real* Sepolia CCTP V2 contracts into BatchReceiver.
/// Skipped unless SEPOLIA_RPC_URL is set.
contract SolanaToSepoliaForkTest is CctpTestBase {
    uint256 attesterKey = 0xA77E57;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        forkSepolia(rpc);
        IAttestable mt = IAttestable(SEPOLIA_MESSAGE_TRANSMITTER);
        vm.startPrank(mt.attesterManager());
        mt.enableAttester(vm.addr(attesterKey));
        mt.setSignatureThreshold(1);
        vm.stopPrank();
    }

    /// What Iris does before attesting: assign the nonce and the executed finality.
    function irisFill(bytes memory m, bytes32 nonce, uint32 finality) internal pure {
        for (uint256 i; i < 32; ++i) {
            m[12 + i] = nonce[i];
        }
        for (uint256 i; i < 4; ++i) {
            m[144 + i] = bytes1(uint8(finality >> (8 * (3 - i))));
        }
    }

    function test_solana_produced_message_lands_and_root_matches() public {
        string memory j = vm.readFile("test/fixtures/solana-devnet-simulated-burn.json");
        bytes memory message = vm.parseJsonBytes(j, ".message");
        address receiverAddr = vm.parseJsonAddress(j, ".receiver");
        bytes32 gatewaySender = vm.parseJsonBytes32(j, ".gatewaySender");
        bytes32 sentRoot = vm.parseJsonBytes32(j, ".root");

        // Deploy the receiver at the address the Solana burn named as mintRecipient/destinationCaller.
        deployCodeTo(
            "BatchReceiver.sol:BatchReceiver",
            abi.encode(
                IReceiverV2(SEPOLIA_MESSAGE_TRANSMITTER),
                IERC20Minimal(SEPOLIA_USDC),
                SOLANA_TMM,
                SEPOLIA_TOKEN_MESSENGER,
                SOLANA_DEVNET_USDC,
                gatewaySender
            ),
            receiverAddr
        );
        BatchReceiver receiver = BatchReceiver(receiverAddr);

        irisFill(message, keccak256("iris nonce"), 2000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, keccak256(message));
        BatchHook.Batch memory b = receiver.relay(message, abi.encodePacked(r, s, v));

        assertEq(b.root, sentRoot, "decoded root on Sepolia equals the root sent from Solana");
        assertEq(b.epochId, vm.parseJsonUint(j, ".epochId"));
        assertEq(b.denomination, vm.parseJsonUint(j, ".denomination"));
        assertEq(IERC20Minimal(SEPOLIA_USDC).balanceOf(receiverAddr), b.denomination * b.leafCount);
    }
}
