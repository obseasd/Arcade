// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeV2Zap} from "../src/dex/ArcadeV2Zap.sol";

/**
 * @title DeployArcadeV2Zap
 * @notice One-shot script for the Single Asset Zap helper. Wires it to the
 *         live V2 factory + router (defaults match web/public/deployments.json
 *         and web/.env.local) and logs the address for the operator to paste
 *         into Vercel as NEXT_PUBLIC_V2_ZAP_ADDRESS.
 *
 *         Required env:
 *           PRIVATE_KEY = deployer key, funded with Arc USDC for gas
 *
 *         Optional env (overrides):
 *           V2_FACTORY  = override the V2 factory address
 *           V2_ROUTER   = override the V2 router address
 *
 *         Usage:
 *           forge script script/DeployArcadeV2Zap.s.sol:DeployArcadeV2Zap \
 *             --rpc-url arc_testnet --broadcast
 */
contract DeployArcadeV2Zap is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        // Generation 5 (2026-06-05) addresses. Override via env to deploy
        // against a different stack.
        address factory = vm.envOr(
            "V2_FACTORY",
            address(0x980e766d13FF786023ebaC9c19c9C963a2287f4e)
        );
        address router = vm.envOr(
            "V2_ROUTER",
            address(0xb209df41F8362c2027A919FE9eC2ae8848E2CCb5)
        );

        vm.startBroadcast(pk);
        ArcadeV2Zap zap = new ArcadeV2Zap(factory, router);
        vm.stopBroadcast();

        console2.log("ArcadeV2Zap deployed at:", address(zap));
        console2.log("Wired to factory       :", factory);
        console2.log("Wired to router        :", router);
        console2.log("");
        console2.log("Add to Vercel env vars (Production + Preview):");
        console2.log("  NEXT_PUBLIC_V2_ZAP_ADDRESS=", address(zap));
    }
}
