// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

/**
 * @title DeployArcadeAutoCompounder
 * @notice One-shot script for the V3 LP auto-management vault. Wires it
 *         to the live ArcadeV3PositionManager (gen 9) + V3 factory and
 *         logs the address for the operator to paste into Vercel as
 *         NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS.
 *
 *         The contract itself is 0.7.6 (shares the canonical V3 NPM
 *         interface with the rest of the v3src/ stack), so we deploy
 *         from its pre-compiled artifact via `vm.getCode` + assembly
 *         `create` — same cross-profile pattern as
 *         DeployArcadeV3PositionManager. The script itself stays on
 *         the default 0.8.24 profile so Foundry's standard library
 *         remappings remain compatible.
 *
 *         Prerequisites:
 *           1. Compile the 0.7.6 layer (writes out-v3/ArcadeAutoCompounder):
 *                FOUNDRY_PROFILE=v3 forge build
 *
 *         Required env:
 *           PRIVATE_KEY   = deployer key, funded with Arc USDC for gas
 *
 *         Optional env (overrides):
 *           V3_NPM        = override the NPM address
 *           V3_FACTORY    = override the V3 factory address
 *           OWNER         = admin / pauser address (multisig in prod).
 *                            Defaults to deployer if unset.
 *           OPERATOR      = keeper wallet authorised to trigger compound /
 *                            pushFees. Defaults to deployer if unset.
 *                            Set to a dedicated hot wallet on Vercel.
 *           FEE_RECIPIENT = protocol-fee sink (treasury multisig).
 *                            Defaults to deployer if unset.
 *           FEE_BPS       = protocol fee in basis points (max 500 = 5%).
 *                            Defaults to 100 (1%).
 *
 *         Usage:
 *           forge script script/DeployArcadeAutoCompounder.s.sol:DeployArcadeAutoCompounder \
 *             --rpc-url arc_testnet --broadcast
 *
 *         Post-deploy operator checklist:
 *           1. Vercel env: NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS=<deployed>
 *           2. Vercel env: COMPOUNDER_OPERATOR_PRIVATE_KEY=<hot wallet
 *              matching OPERATOR>
 *           3. Vercel env: COMPOUNDER_CRON_SECRET=<openssl rand -hex 32>
 *           4. GitHub repo secret: COMPOUNDER_CRON_URL=<prod URL>/api/compounder/cron
 *           5. GitHub repo secret: COMPOUNDER_CRON_SECRET=<same as Vercel>
 *           6. Fund OPERATOR wallet with ~5 USDC on Arc for gas float.
 *           7. Manual run of .github/workflows/compounder-scan.yml to
 *              prime the first sweep.
 */
contract DeployArcadeAutoCompounder is Script {
    function run() external returns (address compounder) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // Gen 9 (2026-06-11) defaults. Override via env if a newer
        // generation needs the compounder before the script is updated.
        address npm = vm.envOr(
            "V3_NPM",
            address(0xB3FDAEE3c1Bc3e08D4b4B9e5bBC3708c1b99AabD)
        );
        address factory = vm.envOr(
            "V3_FACTORY",
            address(0x1acc719F43AaB36b29Df6F9B8ecd02D8704c4D29)
        );

        // Derive the deployer address from the broadcasting key so the
        // role defaults stay sensible even when the operator forgets the
        // OWNER / OPERATOR / FEE_RECIPIENT env overrides (testnet UX).
        address deployer = vm.addr(pk);
        address ownerAddr = vm.envOr("OWNER", deployer);
        address operatorAddr = vm.envOr("OPERATOR", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(100)));

        vm.startBroadcast(pk);

        // Load the 0.7.6 artifact built under the v3 profile and deploy
        // via assembly `create`. Same pattern as DeployArcadeV3PositionManager.
        bytes memory code = vm.getCode(
            "out-v3/ArcadeAutoCompounder.sol/ArcadeAutoCompounder.json"
        );
        bytes memory deployBytes = abi.encodePacked(
            code,
            abi.encode(npm, factory, ownerAddr, operatorAddr, feeRecipient, feeBps)
        );
        assembly {
            compounder := create(0, add(deployBytes, 0x20), mload(deployBytes))
        }
        require(compounder != address(0), "AutoCompounder deploy failed");

        vm.stopBroadcast();

        console2.log("ArcadeAutoCompounder deployed at:", compounder);
        console2.log("  NPM           :", npm);
        console2.log("  Factory       :", factory);
        console2.log("  Owner         :", ownerAddr);
        console2.log("  Operator      :", operatorAddr);
        console2.log("  Fee recipient :", feeRecipient);
        console2.log("  Fee bps       :", uint256(feeBps));
        console2.log("");
        console2.log("Add to Vercel env vars (Production + Preview):");
        console2.log("  NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS=", compounder);
    }
}
