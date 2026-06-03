// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeHook} from "../v4src/ArcadeHook.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/**
 * @title MineHookSalt
 * @notice Brute-force a CREATE2 salt so the deployed ArcadeHook's address
 *         encodes the permission flags it declares via getHookPermissions().
 *
 *         V4's PoolManager checks the hook ADDRESS's low 14 bits against the
 *         permissions the hook claims. ArcadeHook claims 10 bits = 0x3ECE
 *         (see V4_HOOK_SPEC.md Section 3 + ArcadeHook.getHookPermissions).
 *
 *         At 10 bits the expected hit rate is 1 in 2^10 = 1024 salts. We cap
 *         at 500_000 attempts which leaves a ~488x safety margin (Geometric
 *         distribution: 500k attempts at p=1/1024 misses with probability
 *         < 10^-200).
 *
 *         Usage:
 *           FOUNDRY_PROFILE=v4 \
 *           DEPLOYER=0x... \
 *           POOL_MANAGER=0x... \
 *           USDC=0x... \
 *           LOCKED_VAULT=0x... \
 *           TREASURY=0x... \
 *           TWITTER_ESCROW=0x... \
 *           OWNER=0x... \
 *           forge script v4script/MineHookSalt.s.sol
 *
 *         Prints the salt, predicted address, and attempt count. Pass the salt
 *         to the deploy script via env or CREATE2 directly. The actual deploy
 *         loop in DeployV4.s.sol re-runs the same algorithm so this script is
 *         optional — useful for previewing the hook address before committing
 *         to a deploy ceremony.
 */
contract MineHookSalt is Script {
    /// @notice Mask covering all 14 permission bits in V4 hook addresses.
    uint160 internal constant PERM_MASK = (1 << 14) - 1;

    /// @notice Bits the deployed hook address MUST have set. Mirrors
    ///         ArcadeHook.getHookPermissions() exactly. Drift here vs the hook
    ///         is caught at deploy time by DeployV4's runtime assertion, but
    ///         the cheaper guard is keeping this constant in sync.
    uint160 internal constant TARGET_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;

    uint256 internal constant MAX_ATTEMPTS = 500_000;

    /// @notice See DeployV4.s.sol: foundry's `new Contract{salt: s}` routes
    ///         through this canonical CREATE2 factory, not msg.sender.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external view {
        address deployer = vm.envAddress("DEPLOYER");
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        Currency usdc = Currency.wrap(vm.envAddress("USDC"));
        address lockedVault = vm.envAddress("LOCKED_VAULT");
        address treasury = vm.envAddress("TREASURY");
        address twitterEscrow = vm.envOr("TWITTER_ESCROW", address(0));
        address owner = vm.envOr("OWNER", deployer);

        require(TARGET_FLAGS == 0x3ECE, "TARGET_FLAGS drift from 0x3ECE");

        bytes memory creationCode = abi.encodePacked(
            type(ArcadeHook).creationCode,
            abi.encode(poolManager, usdc, lockedVault, treasury, twitterEscrow, owner)
        );
        bytes32 codeHash = keccak256(creationCode);

        // `deployer` (the EOA) is kept for log readability but the actual
        // CREATE2 source is the deterministic deployer below.
        deployer;
        for (uint256 i = 0; i < MAX_ATTEMPTS; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = vm.computeCreate2Address(salt, codeHash, CREATE2_DEPLOYER);
            if (_matchesPermissions(predicted)) {
                console2.log("Found salt after attempts:", i);
                console2.log("Salt (uint):              ", i);
                console2.logBytes32(salt);
                console2.log("Predicted hook addr:      ", predicted);
                console2.log("Addr low 14 bits (hex):");
                console2.logBytes32(bytes32(uint256(uint160(predicted) & PERM_MASK)));
                console2.log("Expected (0x3ECE):");
                console2.logBytes32(bytes32(uint256(TARGET_FLAGS)));
                return;
            }
        }
        revert("No salt found within MAX_ATTEMPTS");
    }

    /// @dev Address acceptable iff its low 14 bits equal exactly TARGET_FLAGS.
    function _matchesPermissions(address a) internal pure returns (bool) {
        return uint160(a) & PERM_MASK == TARGET_FLAGS;
    }
}
