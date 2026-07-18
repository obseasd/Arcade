// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SplitterLaunchFactory} from "../v4src/CreatorSplitter.sol";
import {HolderAirdropDistributor} from "../v4src/HolderAirdropDistributor.sol";

/// @notice Deploys the two hook-adjacent peripherals not in DeployV4:
///         the CreatorSplitter factory and the holder-airdrop distributor.
///         Env: PRIVATE_KEY, ARCADE_HOOK, ARC_USDC_ADDRESS, OWNER_ADDRESS,
///         TREASURY_ADDRESS, AIRDROP_OPERATOR (defaults to deployer).
contract DeployPeripherals is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address hook = vm.envAddress("ARCADE_HOOK");
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address owner = vm.envOr("OWNER_ADDRESS", deployer);
        address operator = vm.envOr("AIRDROP_OPERATOR", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        vm.startBroadcast(pk);
        SplitterLaunchFactory factory = new SplitterLaunchFactory(hook, usdc);
        HolderAirdropDistributor airdrop = new HolderAirdropDistributor(owner, operator, treasury);
        vm.stopBroadcast();

        console2.log("SplitterLaunchFactory:   ", address(factory));
        console2.log("HolderAirdropDistributor:", address(airdrop));
    }
}
