// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ArcadeV4Launchpad} from "../v4src/ArcadeV4Launchpad.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {ILaunchpadSnipe} from "../v4src/interfaces/IArcadeV4Launchpad.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/**
 * @title DeployV4
 * @notice End-to-end deploy script for the V4 stack: launchpad + anti-sniper
 *         hook. Orchestrates the bootstrap dance:
 *
 *           1. Deploy `ArcadeV4Launchpad` (HOOK starts at 0).
 *           2. Brute-force a CREATE2 salt such that the predicted hook
 *              address has BEFORE_SWAP + AFTER_SWAP permission bits set in
 *              its low 14 bits (V4 PoolManager's per-slot dispatch is
 *              address-bit driven).
 *           3. Deploy the hook with `new X{salt}` using that salt - hook's
 *              constructor takes the launchpad reference, so the launchpad
 *              must exist first.
 *           4. Call `launchpad.setHook(hookAddr)` to lock the wiring.
 *
 *         Required env:
 *           PRIVATE_KEY       = deployer key, funded with USDC for gas on Arc.
 *           ARC_USDC_ADDRESS  = real USDC ERC20 on the target chain.
 *           V4_POOL_MANAGER   = canonical V4 PoolManager address. On Arc this
 *                               is either our own fork or whatever Circle ends
 *                               up deploying. Hard-fails if zero.
 *           TREASURY_ADDRESS  = receives creation fees + hook skims. Defaults
 *                               to the deployer if unset.
 *
 *         Usage:
 *           FOUNDRY_PROFILE=v4 \
 *           PRIVATE_KEY=0x... \
 *           ARC_USDC_ADDRESS=0x... \
 *           V4_POOL_MANAGER=0x... \
 *           TREASURY_ADDRESS=0x... \
 *           forge script v4script/DeployV4.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployV4 is Script {
    uint160 internal constant PERM_MASK = (1 << 14) - 1;
    uint160 internal constant TARGET_FLAGS = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;
    uint256 internal constant MAX_ATTEMPTS = 200_000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address poolManager = vm.envAddress("V4_POOL_MANAGER");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        require(poolManager != address(0), "V4_POOL_MANAGER must be set");
        require(usdc != address(0), "ARC_USDC_ADDRESS must be set");

        vm.startBroadcast(pk);

        // Step 1: launchpad with HOOK = 0.
        ArcadeV4Launchpad launchpad = new ArcadeV4Launchpad(
            IERC20(usdc),
            IPoolManager(poolManager),
            treasury
        );

        // Step 2: mine a salt so the hook CREATE2 address has the right
        // permission bits. The hook constructor's bytecode includes the
        // launchpad address as immutable constructor arg, so the codeHash
        // depends on the launchpad we just deployed.
        bytes memory hookCreationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(
                IPoolManager(poolManager),
                ILaunchpadSnipe(address(launchpad)),
                Currency.wrap(usdc)
            )
        );
        bytes32 codeHash = keccak256(hookCreationCode);

        bytes32 salt;
        address predicted;
        uint256 attempts;
        for (uint256 i = 0; i < MAX_ATTEMPTS; ++i) {
            bytes32 s = bytes32(i);
            address a = vm.computeCreate2Address(s, codeHash, deployer);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                salt = s;
                predicted = a;
                attempts = i;
                break;
            }
        }
        require(predicted != address(0), "salt-mining exhausted MAX_ATTEMPTS");

        // Step 3: CREATE2-deploy the hook at the mined address.
        ArcadeAntiSniperHook hook = new ArcadeAntiSniperHook{salt: salt}(
            IPoolManager(poolManager),
            ILaunchpadSnipe(address(launchpad)),
            Currency.wrap(usdc)
        );
        require(address(hook) == predicted, "deployed hook addr != predicted");

        // Step 4: lock the wiring. After this any further setHook reverts.
        launchpad.setHook(address(hook));

        vm.stopBroadcast();

        console2.log("Chain:           V4 testnet");
        console2.log("Deployer:        ", deployer);
        console2.log("PoolManager:     ", poolManager);
        console2.log("USDC:            ", usdc);
        console2.log("Treasury:        ", treasury);
        console2.log("Launchpad:       ", address(launchpad));
        console2.log("Hook:            ", address(hook));
        console2.log("Hook salt (uint):", uint256(salt));
        console2.log("Salt attempts:   ", attempts);
    }
}
