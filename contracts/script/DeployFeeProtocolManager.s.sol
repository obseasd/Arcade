// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {FeeProtocolManager} from "src/FeeProtocolManager.sol";

interface IV3FactoryOwner {
    function owner() external view returns (address);
    function setOwner(address) external;
}

/**
 * Deploy the FeeProtocolManager and (optionally) hand the V3 factory ownership to
 * it, so ordinary pools auto-enable feeProtocol while launch/locked pools stay 0.
 *
 * envs:
 *   V3_FACTORY_ADDRESS  - the Uniswap-V3-fork factory
 *   V3_LOCKER_ADDRESS   - ArcadeV3Locker (the launch registry / distinguisher)
 *   OWNER_ADDRESS       - the Safe (owns the manager; keeps every lever)
 *   TREASURY_ADDRESS    - harvest destination (fixed)
 *   HANDOVER (optional) - "true" to also call factory.setOwner(manager) NOW; only
 *                         works if the broadcasting key is the CURRENT factory
 *                         owner. If the factory is already Safe-owned, skip this
 *                         and do the handover as a Safe tx: setOwner(manager).
 *
 * After the manager owns the factory, wire the launchpad to call
 * feeProtocolManager.forceZero(pool) right after lockSingleSided, and the keeper
 * to sync(pool) on PoolCreated / forceZero(pool) on PositionLocked.
 */
contract DeployFeeProtocolManager is Script {
    function run() external returns (FeeProtocolManager mgr) {
        address factory = vm.envAddress("V3_FACTORY_ADDRESS");
        address locker = vm.envAddress("V3_LOCKER_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        bool handover = vm.envOr("HANDOVER", false);

        vm.startBroadcast();
        mgr = new FeeProtocolManager(factory, locker, owner, treasury);
        if (handover) {
            // Only succeeds if the broadcaster is the current factory owner.
            IV3FactoryOwner(factory).setOwner(address(mgr));
        }
        vm.stopBroadcast();

        console2.log("FeeProtocolManager:", address(mgr));
        console2.log("factory owner now:", IV3FactoryOwner(factory).owner());
    }
}
