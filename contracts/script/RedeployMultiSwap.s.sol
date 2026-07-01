// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeMultiSwap, IArcadeV4SwapRouterMin, IArcadeV4LaunchpadMin} from "../src/swap/ArcadeMultiSwap.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IArcadeV2Factory} from "../src/dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Router} from "../src/dex/interfaces/IArcadeV2Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Redeploy ONLY ArcadeMultiSwap with the H-07 per-leg minOut fix. Stateless
 * aggregator, so a clean standalone redeploy. REUSES the current stack
 * addresses (from deployments.json). After deploy, set
 * NEXT_PUBLIC_MULTISWAP_ADDRESS to the new address (Vercel + deployments.json)
 * and redeploy the frontend. V4 legs stay disabled (v4Router/v4Launchpad = 0,
 * V4 not live) unless the envs are set.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ARC_USDC_ADDRESS=0x3600...0000 \
 *   V2_FACTORY=0x... V2_ROUTER=0x... LAUNCHPAD=0x... V3_ROUTER=0x... \
 *   forge script script/RedeployMultiSwap.s.sol --rpc-url arc_testnet --broadcast
 */
contract RedeployMultiSwap is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address v2Factory = vm.envAddress("V2_FACTORY");
        address v2Router = vm.envAddress("V2_ROUTER");
        address launchpad = vm.envAddress("LAUNCHPAD");
        address v3Router = vm.envAddress("V3_ROUTER");
        address v4Router = vm.envOr("V4_ROUTER", address(0));
        address v4Launchpad = vm.envOr("V4_LAUNCHPAD", address(0));

        vm.startBroadcast(pk);
        ArcadeMultiSwap multiSwap = new ArcadeMultiSwap(
            IERC20(usdc),
            IArcadeV2Factory(v2Factory),
            IArcadeV2Router(v2Router),
            IArcadeLaunchpad(launchpad),
            IArcadeV3Router(v3Router),
            IArcadeV4SwapRouterMin(v4Router),
            IArcadeV4LaunchpadMin(v4Launchpad)
        );
        vm.stopBroadcast();

        console2.log("NEW ArcadeMultiSwap (H-07):", address(multiSwap));
        console2.log("NEXT_PUBLIC_MULTISWAP_ADDRESS=", address(multiSwap));
    }
}
