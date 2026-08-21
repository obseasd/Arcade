// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeSwapFeeRouter} from "../src/swap/ArcadeSwapFeeRouter.sol";

/// @notice Deploys the ArcadeSwapFeeRouter: the fee-taking hop for EXTERNAL
///         launchpad/memecoin swaps (radardex, sharc, canonical Uniswap on Arc).
///
///         Env:
///           PRIVATE_KEY      deployer key.
///           OWNER_ADDRESS    Ownable2Step owner (treasury Safe). Default deployer.
///           TREASURY_ADDRESS fee recipient. Default OWNER_ADDRESS.
///           FEE_BPS          initial fee (default 50 = 0.50%; cap 200).
///           FEE_ROUTERS      comma-separated venue routers to allow-list at
///                            construction (the external DEX routers whose pools
///                            we route through). Empty = allow-list later via
///                            setRouterAllowed from the Safe.
contract DeployArcadeSwapFeeRouter is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER_ADDRESS", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", owner);
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(50));
        address[] memory routers = vm.envOr("FEE_ROUTERS", ",", new address[](0));

        vm.startBroadcast(pk);
        ArcadeSwapFeeRouter feeRouter = new ArcadeSwapFeeRouter(owner, treasury, uint16(feeBps), routers);
        vm.stopBroadcast();

        console2.log("ArcadeSwapFeeRouter:", address(feeRouter));
        console2.log("  owner:    ", owner);
        console2.log("  treasury: ", treasury);
        console2.log("  feeBps:   ", feeBps);
        console2.log("  routers seeded:", routers.length);
        console2.log("=========================================");
        console2.log("Frontend wiring:");
        console2.log("  NEXT_PUBLIC_SWAP_FEE_ROUTER_ADDRESS =", address(feeRouter));
        console2.log("  deployments.json addresses.swapFeeRouter =", address(feeRouter));
        console2.log("ACTION (Safe): setRouterAllowed(...) for each external venue");
        console2.log("  router you want to route + fee (radardex/sharc/uniswap URs).");
    }
}
