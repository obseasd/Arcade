// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

// Deploys ArcadeV3PositionDescriptor + ArcadeV3PositionManager - the
// canonical Uniswap V3 NPM rebranded for Arcade - by loading their
// pre-compiled 0.7.6 artifacts and forwarding constructor args via create.
// Same pattern as DeployV3.s.sol for the core Factory.
//
// Prerequisites (one-time setup):
//   1. Vendor the OZ 0.7-compatible release v3-periphery was authored
//      against. v5 (in lib/openzeppelin-contracts) is the wrong API
//      surface.
//        rm -rf lib/oz-v3
//        forge install oz-v3=OpenZeppelin/openzeppelin-contracts@v3.4.1-solc-0.7-2 --no-git
//   2. Compile the 0.7.6 layer (writes both artifacts to out-v3/):
//        FOUNDRY_PROFILE=v3 forge build
//
// Required env:
//   PRIVATE_KEY = deployer key, funded with Arc USDC for gas
//
// Optional env:
//   V3_FACTORY = Arcade V3 factory address. Default matches
//                web/.env.local + web/public/deployments.json.
//   WETH9      = WETH9 address. Default address(0) on Arc - native ETH
//                doesn't exist, the WETH-touching helpers in NPM are
//                inert when this is zero.
//
// Usage:
//   forge script script/DeployArcadeV3PositionManager.s.sol:DeployArcadeV3PositionManager \
//     --rpc-url arc_testnet --broadcast
contract DeployArcadeV3PositionManager is Script {
    function run() external returns (address descriptor, address npm) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address factory = vm.envOr(
            "V3_FACTORY",
            address(0xB9339dE1eeC40d4f513aBD567DAb6837fc7D63D6)
        );
        address weth = vm.envOr("WETH9", address(0));

        vm.startBroadcast(pk);

        // Step 1: deploy the descriptor (returns Arcade-hosted JSON URLs).
        bytes memory descCode = vm.getCode(
            "out-v3/ArcadeV3PositionDescriptor.sol/ArcadeV3PositionDescriptor.json"
        );
        assembly {
            descriptor := create(0, add(descCode, 0x20), mload(descCode))
        }
        require(descriptor != address(0), "descriptor deploy failed");

        // Step 2: deploy the NPM, wiring the freshly-deployed descriptor into
        // the canonical _tokenDescriptor_ slot.
        bytes memory npmCode = vm.getCode(
            "out-v3/ArcadeV3PositionManager.sol/ArcadeV3PositionManager.json"
        );
        bytes memory deployCode = abi.encodePacked(
            npmCode,
            abi.encode(factory, weth, descriptor)
        );
        assembly {
            npm := create(0, add(deployCode, 0x20), mload(deployCode))
        }
        require(npm != address(0), "NPM deploy failed");

        vm.stopBroadcast();

        console2.log("ArcadeV3PositionDescriptor:", descriptor);
        console2.log("ArcadeV3PositionManager   :", npm);
        console2.log("Wired to V3 factory       :", factory);
        console2.log("WETH9 (inert on Arc if 0) :", weth);
        console2.log("");
        console2.log("Add to Vercel env vars (Production + Preview):");
        console2.log("  NEXT_PUBLIC_V3_NPM_ADDRESS=", npm);
    }
}
