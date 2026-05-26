// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DeployTestnet
 * @notice Deploys Arcade to Arc testnet. Uses the live Arc USDC address (NOT a mock).
 *
 *   Required env:
 *     PRIVATE_KEY        = deployer key, funded with Arc testnet USDC for gas
 *     ARC_USDC_ADDRESS   = real Arc USDC ERC20 address (must be set before deploy)
 *     TREASURY_ADDRESS   = address that receives platform fees + creation fees
 *
 * Usage:
 *   forge script script/DeployTestnet.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployTestnet is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        vm.startBroadcast(pk);

        ArcadeV2Factory factory = new ArcadeV2Factory(deployer);
        ArcadeV2Router router = new ArcadeV2Router(address(factory));
        ArcadeLaunchpad launchpad = new ArcadeLaunchpad(IERC20(usdc), factory, treasury);

        console2.log("Chain:       Arc testnet");
        console2.log("USDC:        ", usdc);
        console2.log("Treasury:    ", treasury);
        console2.log("V2 Factory:  ", address(factory));
        console2.log("V2 Router:   ", address(router));
        console2.log("Launchpad:   ", address(launchpad));

        vm.stopBroadcast();
    }
}
