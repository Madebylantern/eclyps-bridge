// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {EclypsPortal} from "../src/EclypsPortal.sol";
import {AztecHash, IRegistry} from "../src/interfaces/IAztec.sol";
import {IERC20Minimal, IReceiverV2} from "../src/interfaces/ICctp.sol";
import {BatchHook} from "../src/libraries/BatchHook.sol";
import {CctpTestBase} from "./CctpTestBase.sol";

interface IAttestable {
    function attesterManager() external view returns (address);
    function enableAttester(address) external;
    function setSignatureThreshold(uint256) external;
}

/// @notice S6 Ethereum leg against real deployed contracts. The message is the one the *gateway
/// program* produced (scripts/e2e/local-full.ts: gateway PDA burned through Circle's CCTP V2
/// programs on a local validator), with Iris's two fields filled. On a Sepolia fork we deploy
/// EclypsPortal at the address the gateway committed to and relay into Circle's real CCTP V2
/// contracts and the **real Aztec testnet Inbox** (registry 0xA0BF…71c6Ba). Only the attester
/// is substituted. Skipped unless SEPOLIA_RPC_URL is set and the fixture exists.
contract GatewayMessageForkTest is CctpTestBase {
    string constant FIXTURE = "test/fixtures/gateway-local-burn.json";
    address constant AZTEC_TESTNET_REGISTRY = 0xA0BFb1B494FB49041e5c6e8c2C1BE09cD171c6Ba;
    // The Inbox is resolved through the registry: Aztec testnet upgrades add a new canonical rollup
    // (and Inbox), so a pinned address goes stale (rollup 2914217885 -> 3409706519 on 2026-10-12).
    uint256 attesterKey = 0xA77E57;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0 || !vm.exists(FIXTURE)) vm.skip(true);
        vm.createSelectFork(rpc);
        IAttestable mt = IAttestable(SEPOLIA_MESSAGE_TRANSMITTER);
        vm.startPrank(mt.attesterManager());
        mt.enableAttester(vm.addr(attesterKey));
        mt.setSignatureThreshold(1);
        vm.stopPrank();
    }

    struct Fixture {
        bytes message;
        address portal;
        bytes32 gatewaySender;
        bytes32 root;
        uint64 epochId;
        uint64 denomination;
        uint16 leafCount;
    }

    function load() internal view returns (Fixture memory f) {
        string memory j = vm.readFile(FIXTURE);
        f.message = vm.parseJsonBytes(j, ".message");
        f.portal = vm.parseJsonAddress(j, ".portal");
        f.gatewaySender = vm.parseJsonBytes32(j, ".gatewaySender");
        f.root = vm.parseJsonBytes32(j, ".root");
        f.epochId = uint64(vm.parseJsonUint(j, ".epochId"));
        f.denomination = uint64(vm.parseJsonUint(j, ".denomination"));
        f.leafCount = uint16(vm.parseJsonUint(j, ".leafCount"));
    }

    function deployPortalAt(Fixture memory f) internal returns (EclypsPortal portal) {
        deployCodeTo(
            "EclypsPortal.sol:EclypsPortal",
            abi.encode(
                IReceiverV2(SEPOLIA_MESSAGE_TRANSMITTER),
                IERC20Minimal(SEPOLIA_USDC),
                SOLANA_TMM,
                SEPOLIA_TOKEN_MESSENGER,
                SOLANA_DEVNET_USDC,
                f.gatewaySender,
                IRegistry(AZTEC_TESTNET_REGISTRY),
                SECRET_HASH_ZERO,
                EXIT_AUTHORITY,
                EXIT_CUSTODY
            ),
            f.portal
        );
        portal = EclypsPortal(f.portal);
        vm.prank(portal.binder());
        portal.bindClaimContract(
            f.denomination, keccak256("aztec testnet claim contract (placeholder)")
        );
    }

    function test_gateway_message_reaches_real_aztec_testnet_inbox() public {
        Fixture memory f = load();
        EclypsPortal portal = deployPortalAt(f);
        address inbox = address(IRegistry(AZTEC_TESTNET_REGISTRY).getCanonicalRollup().getInbox());
        assertEq(
            address(portal.inbox()),
            inbox,
            "portal uses the registry's canonical Aztec testnet Inbox"
        );
        emit log_named_address("Aztec testnet Inbox (canonical rollup)", inbox);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, keccak256(f.message));
        vm.recordLogs();
        BatchHook.Batch memory b = portal.relay(f.message, abi.encodePacked(r, s, v));
        // Real CCTP receive + mint + Aztec Inbox insert (open question 3).
        emit log_named_uint(
            "relay gas (CCTP V2 receive + Aztec testnet Inbox)", vm.lastCallGas().gasTotalUsed
        );

        uint256 total = uint256(f.denomination) * f.leafCount;
        assertEq(b.root, f.root, "root decoded on Ethereum == root computed by the gateway");
        assertEq(IERC20Minimal(SEPOLIA_USDC).balanceOf(f.portal), total, "real USDC minted");
        checkLogs(f, total, inbox);
    }

    function checkLogs(Fixture memory f, uint256 total, address inbox) internal {
        bytes32 content = AztecHash.sha256ToField(
            abi.encode(f.root, total, uint256(f.epochId), uint256(f.denomination))
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool inboxSaw;
        bool forwarded;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == inbox) inboxSaw = true;
            if (
                logs[i].emitter == f.portal
                    && logs[i].topics[0] == EclypsPortal.BatchForwarded.selector
            ) {
                (bytes32 c,,) = abi.decode(logs[i].data, (bytes32, bytes32, uint256));
                assertEq(c, content, "forwarded content == claim contract's batch_content_hash");
                forwarded = true;
            }
        }
        assertTrue(inboxSaw, "Aztec testnet Inbox emitted MessageSent");
        assertTrue(forwarded, "portal emitted BatchForwarded");
    }
}
