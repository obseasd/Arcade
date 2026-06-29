// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/**
 * Redeploy ONLY the ArcadeV3SwapRouter with the 2026-06-29 CRITICAL fix
 * (_authorisedPool callback guard). The router is stateless, so this is a clean
 * standalone redeploy — no migration of existing pools/positions needed.
 *
 * Build the 0.7.6 V3 layer first so out-v3 has the FIXED bytecode:
 *   FOUNDRY_PROFILE=v3 forge build
 *
 * Then run (addresses come from deployments.json):
 *   PRIVATE_KEY=0x... \
 *   V3_FACTORY_ADDRESS=<addresses.v3Factory> \
 *   ARC_USDC_ADDRESS=<addresses.usdc> \
 *   LAUNCHPAD_ADDRESS=<addresses.launchpad> \
 *   forge script script/RedeployV3Router.s.sol --rpc-url arc_testnet --broadcast
 *
 * After deploy: set NEXT_PUBLIC_V3_ROUTER_ADDRESS to the new address (Vercel +
 * deployments.json), redeploy the frontend, and have users re-approve the new
 * router on their next trade. See REDEPLOY_2026-06-29.md.
 */
contract RedeployV3Router is Script {
    function run() external {
        address factory = vm.envAddress("V3_FACTORY_ADDRESS");
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address launchpad = vm.envAddress("LAUNCHPAD_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json"),
            abi.encode(factory, usdc, launchpad)
        );
        address router;
        assembly {
            router := create(0, add(code, 0x20), mload(code))
        }
        require(router != address(0), "v3 router deploy failed");
        vm.stopBroadcast();

        console2.log("NEW ArcadeV3SwapRouter:", router);
        console2.log("constructor(factory,usdc,launchpad):", factory, usdc, launchpad);
        console2.log(">>> set NEXT_PUBLIC_V3_ROUTER_ADDRESS to the address above, then redeploy the frontend.");
    }
}
