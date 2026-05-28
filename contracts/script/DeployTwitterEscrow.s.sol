// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeTwitterEscrow} from "../src/launchpad/ArcadeTwitterEscrow.sol";

/**
 * @title DeployTwitterEscrow
 * @notice One-shot deploy of the Twitter attribution escrow. Reads the V3
 *         locker address and trusted signer from env. The signer address is
 *         the PUBLIC address of the backend wallet whose private key sits in
 *         Vercel as ARCADE_BACKEND_PRIVATE_KEY.
 *
 *   Required env:
 *     PRIVATE_KEY                     deployer key
 *     ARCADE_V3_LOCKER_ADDRESS        address of the already-deployed ArcadeV3Locker
 *     ARCADE_TWITTER_SIGNER_ADDRESS   public address of the backend signing wallet
 *
 *   Usage:
 *     forge script script/DeployTwitterEscrow.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployTwitterEscrow is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address locker = vm.envAddress("ARCADE_V3_LOCKER_ADDRESS");
        address signer = vm.envAddress("ARCADE_TWITTER_SIGNER_ADDRESS");

        vm.startBroadcast(pk);
        ArcadeTwitterEscrow escrow = new ArcadeTwitterEscrow(locker, signer);
        vm.stopBroadcast();

        console2.log("ArcadeTwitterEscrow:", address(escrow));
        console2.log("LOCKER:", locker);
        console2.log("TRUSTED_SIGNER:", signer);
    }
}
