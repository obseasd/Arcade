// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeIncentiveDistributor} from "../src/incentive/ArcadeIncentiveDistributor.sol";

/**
 * Deploys ArcadeIncentiveDistributor on Arc (escrow-backed liquidity-incentive
 * campaigns; the on-chain backend for /swap/incentivize).
 *
 * Required env:
 *   PRIVATE_KEY        deployer key (becomes owner)
 *   INCENTIVE_OPERATOR address allowed to post cumulative Merkle roots
 *                      (testnet: the deployer EOA; mainnet: a multisig/backend)
 *
 * Usage:
 *   forge script script/DeployIncentiveDistributor.s.sol --rpc-url $ARC_RPC --broadcast
 */
contract DeployIncentiveDistributor is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address operator = vm.envAddress("INCENTIVE_OPERATOR");

        vm.startBroadcast(pk);
        ArcadeIncentiveDistributor dist = new ArcadeIncentiveDistributor(operator);
        vm.stopBroadcast();

        console2.log("ArcadeIncentiveDistributor:", address(dist));
        console2.log("  owner:", vm.addr(pk));
        console2.log("  operator:", operator);
        console2.log("Set NEXT_PUBLIC_INCENTIVE_DISTRIBUTOR to the address above.");
    }
}
