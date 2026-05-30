// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {ILaunchpadSnipe} from "../v4src/interfaces/IArcadeV4Launchpad.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

/**
 * @title MineHookSalt
 * @notice Brute-forces a CREATE2 salt so that the deployed hook's address
 *         encodes exactly the permission flags it declares.
 *
 *         V4's PoolManager checks the hook ADDRESS' low 14 bits against the
 *         permissions a hook claims. For our hook we want only
 *         BEFORE_SWAP_FLAG (bit 7) set. The deployer mines a salt off-chain
 *         until they find one that produces such an address, then deploys
 *         with that salt via CREATE2.
 *
 *         At the search space size for one flag set (1/2^13 ≈ 1 in 8192),
 *         this typically finds a match in well under a second.
 *
 *         Usage:
 *           FOUNDRY_PROFILE=v4 \
 *           DEPLOYER=0x... \
 *           POOL_MANAGER=0x... \
 *           LAUNCHPAD=0x... \
 *           USDC=0x... \
 *           forge script v4script/MineHookSalt.s.sol
 *
 *         The script prints the salt + predicted address. Pass that salt to
 *         the actual deploy script via CREATE2 (vm.deployCode or a custom
 *         deployer contract that does `new X{salt: s}(...)`).
 */
contract MineHookSalt is Script {
    /// @notice Mask covering all 14 permission bits in V4 hook addresses.
    uint160 internal constant PERM_MASK = (1 << 14) - 1;
    /// @notice Bits we want set on the deployed hook's address - mirrors
    ///         getHookPermissions(): BEFORE_SWAP + AFTER_SWAP.
    uint160 internal constant TARGET_FLAGS = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG;

    /// @notice Max salts to try before giving up. 1 in 4096 chance per attempt
    ///         for two permission flags; we cap at 200k for paranoia.
    uint256 internal constant MAX_ATTEMPTS = 200_000;

    function run() external view {
        address deployer = vm.envAddress("DEPLOYER");
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        ILaunchpadSnipe launchpad = ILaunchpadSnipe(vm.envAddress("LAUNCHPAD"));
        Currency usdc = Currency.wrap(vm.envAddress("USDC"));

        bytes memory creationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(poolManager, launchpad, usdc)
        );
        bytes32 codeHash = keccak256(creationCode);

        for (uint256 i = 0; i < MAX_ATTEMPTS; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = vm.computeCreate2Address(salt, codeHash, deployer);
            if (_matchesPermissions(predicted)) {
                console2.log("Found salt after", i, "attempts");
                console2.log("Salt (uint):", i);
                console2.logBytes32(salt);
                console2.log("Hook address:", predicted);
                console2.log("Address low 14 bits (hex):");
                console2.logBytes32(bytes32(uint256(uint160(predicted) & PERM_MASK)));
                return;
            }
        }
        revert("No salt found within MAX_ATTEMPTS");
    }

    /// @dev Address is acceptable iff its low 14 bits equal exactly TARGET_FLAGS.
    function _matchesPermissions(address a) internal pure returns (bool) {
        return uint160(a) & PERM_MASK == TARGET_FLAGS;
    }
}
