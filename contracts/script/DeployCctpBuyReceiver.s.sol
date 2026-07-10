// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeCctpBuyReceiver} from "../src/cctp/ArcadeCctpBuyReceiver.sol";

/**
 * Deploys ArcadeCctpBuyReceiver on Arc (the "bridge and buy" landing contract).
 *
 * Required env:
 *   PRIVATE_KEY               deployer key
 *   MESSAGE_TRANSMITTER_V2    CCTP V2 MessageTransmitterV2 on Arc
 *                             (testnet: 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275)
 *   ARC_USDC_ADDRESS          native USDC (0x3600000000000000000000000000000000000000)
 *   LAUNCHPAD_ADDRESS         the current ArcadeLaunchpad
 *
 * Usage:
 *   forge script script/DeployCctpBuyReceiver.s.sol --rpc-url $ARC_RPC --broadcast
 */
contract DeployCctpBuyReceiver is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address messageTransmitter = vm.envAddress("MESSAGE_TRANSMITTER_V2");
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address launchpad = vm.envAddress("LAUNCHPAD_ADDRESS");

        vm.startBroadcast(pk);
        ArcadeCctpBuyReceiver receiver = new ArcadeCctpBuyReceiver(
            messageTransmitter,
            usdc,
            launchpad
        );
        vm.stopBroadcast();

        console2.log("ArcadeCctpBuyReceiver:", address(receiver));
        console2.log("  messageTransmitter:", messageTransmitter);
        console2.log("  usdc:", usdc);
        console2.log("  launchpad:", launchpad);
        console2.log("Set NEXT_PUBLIC_CCTP_BUY_RECEIVER to the address above.");
    }
}
