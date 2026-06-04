// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

// Deploys ArcadeV3PositionManager - the canonical Uniswap V3
// NonfungiblePositionManager rebranded for Arcade - by loading its
// pre-compiled 0.7.6 artifact and forwarding constructor args via create.
// Same pattern as DeployV3.s.sol for the core Factory.
//
// Prerequisites (one-time setup):
//   1. Vendor the OZ 0.7-compatible release that v3-periphery was authored
//      against. v5 (in lib/openzeppelin-contracts) is the wrong API surface.
//        rm -rf lib/oz-v3
//        forge install oz-v3=OpenZeppelin/openzeppelin-contracts@v3.4.1-solc-0.7-2 --no-git
//   2. Compile the 0.7.6 layer (writes the NPM artifact to out-v3/):
//        FOUNDRY_PROFILE=v3 forge build
//
// Required env:
//   PRIVATE_KEY = deployer key, funded with Arc USDC for gas
//
// Optional env (defaults pulled from web/public/deployments.json):
//   V3_FACTORY = ArcadeV3 factory address
//   WETH9      = WETH9 address. Default address(0) - Arc has no native ETH
//                and the WETH-touching helpers in NPM are inert when zero.
//
// Usage:
//   forge script script/DeployArcadeV3PositionManager.s.sol:DeployArcadeV3PositionManager \
//     --rpc-url arc_testnet --broadcast
contract DeployArcadeV3PositionManager is Script {
    function run() external returns (address npm) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address factory = vm.envOr(
            "V3_FACTORY",
            address(0xB9339dE1eeC40d4f513aBD567DAb6837fc7D63D6)
        );
        address weth = vm.envOr("WETH9", address(0));

        vm.startBroadcast(pk);

        bytes memory bytecode = vm.getCode(
            "out-v3/ArcadeV3PositionManager.sol/ArcadeV3PositionManager.json"
        );
        bytes memory deployCode = abi.encodePacked(bytecode, abi.encode(factory, weth));

        assembly {
            npm := create(0, add(deployCode, 0x20), mload(deployCode))
        }
        require(npm != address(0), "V3 NPM deploy failed");

        vm.stopBroadcast();

        console2.log("ArcadeV3PositionManager deployed at:", npm);
        console2.log("Wired to V3 factory               :", factory);
        console2.log("WETH9 (inert on Arc when 0)       :", weth);
        console2.log("");
        console2.log("Add to Vercel env vars (Production + Preview):");
        console2.log("  NEXT_PUBLIC_V3_NPM_ADDRESS=", npm);
    }
}
