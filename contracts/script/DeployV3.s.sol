// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/**
 * @title DeployV3
 * @notice Deploys the Uniswap V3 core Factory onto the target chain from its
 *         pre-compiled 0.7.6 artifact. The Factory embeds the pool init code,
 *         so deploying it is enough to create pools afterwards — we don't need
 *         the V3 periphery (NonfungiblePositionManager / SwapRouter), which
 *         drags in WETH9, an NFT descriptor and an incompatible OpenZeppelin
 *         version. Arcade's locked-LP vault talks to pools directly.
 *
 * Prerequisite: compile v3-core first so the artifact exists:
 *   FOUNDRY_PROFILE=v3 forge build
 *
 * Usage (local):
 *   PRIVATE_KEY=0xac09... forge script script/DeployV3.s.sol --rpc-url anvil --broadcast
 * Usage (Arc testnet):
 *   PRIVATE_KEY=0x... forge script script/DeployV3.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployV3 is Script {
    function run() external returns (address factory) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);

        // Deploy from the 0.7.6 artifact built by the `v3` profile.
        bytes memory factoryCode = vm.getCode("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json");
        assembly {
            factory := create(0, add(factoryCode, 0x20), mload(factoryCode))
        }
        require(factory != address(0), "V3 factory deploy failed");

        console2.log("UniswapV3Factory:", factory);
        console2.log("  (fee tiers 0.05%/0.3%/1% enabled by default)");

        vm.stopBroadcast();
    }
}
