// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

// Deploys ArcadeV3Zap - single-asset V3 zap helper (max-range only).
// Loads the pre-compiled 0.7.6 artifact and forwards constructor args
// via assembly create. Mirrors DeployArcadeV3PositionManager's pattern.
//
// Prerequisites (one-time setup, run from contracts/):
//   1. bash scripts/patch-v3-periphery.sh   (idempotent)
//   2. FOUNDRY_PROFILE=v3 forge build
//
// Required env:
//   PRIVATE_KEY = deployer key, funded with Arc USDC for gas
//
// Optional env:
//   V3_FACTORY = Arcade V3 factory address. Default matches gen-5.
//   V3_NPM     = Arcade V3 NPM address. Default matches gen-5b
//                (the post-init-hash-patch redeploy).
//
// Usage:
//   forge script script/DeployArcadeV3Zap.s.sol:DeployArcadeV3Zap \
//     --rpc-url arc_testnet --broadcast
contract DeployArcadeV3Zap is Script {
    function run() external returns (address zap) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address factory = vm.envOr(
            "V3_FACTORY",
            address(0x7Eb534f517Cfe55324B772005Af6DAc8457b7Ac2)
        );
        address npm = vm.envOr(
            "V3_NPM",
            address(0x07D3fE5e44b454CE59861fB3F0326702618dFB92)
        );

        vm.startBroadcast(pk);

        bytes memory code = vm.getCode("out-v3/ArcadeV3Zap.sol/ArcadeV3Zap.json");
        // ArcadeV3Zap constructor signature: (address factory_, address npm_)
        bytes memory args = abi.encode(factory, npm);
        bytes memory creation = bytes.concat(code, args);
        assembly {
            zap := create(0, add(creation, 0x20), mload(creation))
        }
        require(zap != address(0), "zap deploy failed");

        vm.stopBroadcast();

        console2.log("ArcadeV3Zap            :", zap);
        console2.log("Wired to V3 factory    :", factory);
        console2.log("Wired to V3 NPM        :", npm);
        console2.log("");
        console2.log("Add to Vercel env vars (Production + Preview):");
        console2.log("  NEXT_PUBLIC_V3_ZAP_ADDRESS=", zap);
    }
}
