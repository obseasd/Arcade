// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {ILaunchpadSnipe} from "../v4src/interfaces/IArcadeV4Launchpad.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {Currency} from "v4-core/types/Currency.sol";

/**
 * Tests for the salt-mining algorithm that `MineHookSalt.s.sol` uses.
 *
 * Rather than running the script directly (which talks to env vars and
 * console.logs), we re-implement the loop inline against fixed inputs and
 * assert that the address derived from the found salt actually has the
 * right permission bits encoded in its low 14 bits.
 */
contract MineHookSaltTest is Test {
    uint160 internal constant PERM_MASK = (1 << 14) - 1;
    /// @dev Must match `ArcadeAntiSniperHook.getHookPermissions()`.
    ///      BEFORE_SWAP + AFTER_SWAP + BEFORE_SWAP_RETURNS_DELTA +
    ///      AFTER_SWAP_RETURNS_DELTA. The RETURNS_DELTA bits are mandatory
    ///      so pm.take's hook delta gets reconciled (otherwise the swap
    ///      reverts with CurrencyNotSettled).
    uint160 internal constant TARGET_FLAGS = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    address internal constant DEPLOYER = address(0xDEADBEEF);
    address internal constant POOL_MANAGER = address(0xABCD);
    address internal constant LAUNCHPAD = address(0x1234);
    address internal constant USDC_ADDR = address(0x5678);
    address internal constant TREASURY = address(0xBEEF);

    function test_mining_findsSaltWithCorrectPermissions() public view {
        bytes memory creationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(POOL_MANAGER, LAUNCHPAD, Currency.wrap(USDC_ADDR), TREASURY)
        );
        bytes32 codeHash = keccak256(creationCode);

        // 4 fixed bits → 1/2^10 = 1024 expected attempts. Cap at 200k for
        // budget.
        bytes32 foundSalt;
        address predicted;
        for (uint256 i = 0; i < 200_000; ++i) {
            bytes32 salt = bytes32(i);
            address a = vm.computeCreate2Address(salt, codeHash, DEPLOYER);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                foundSalt = salt;
                predicted = a;
                break;
            }
        }

        assertTrue(predicted != address(0), "mining should find a salt within cap");
        assertEq(uint160(predicted) & PERM_MASK, TARGET_FLAGS, "address permissions mismatch");
        assertTrue(uint160(predicted) & Hooks.BEFORE_SWAP_FLAG != 0, "BEFORE_SWAP_FLAG should be set");
        assertTrue(uint160(predicted) & Hooks.AFTER_SWAP_FLAG != 0, "AFTER_SWAP_FLAG should be set");
        assertTrue(
            uint160(predicted) & Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG != 0,
            "BEFORE_SWAP_RETURNS_DELTA_FLAG should be set"
        );
        assertTrue(
            uint160(predicted) & Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG != 0,
            "AFTER_SWAP_RETURNS_DELTA_FLAG should be set"
        );
        console2.log("Found predicted hook address:", predicted);
        console2.logBytes32(foundSalt);
    }

    function test_exactlyDeclaredFlags_areSet() public view {
        bytes memory creationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(POOL_MANAGER, LAUNCHPAD, Currency.wrap(USDC_ADDR), TREASURY)
        );
        bytes32 codeHash = keccak256(creationCode);

        address predicted;
        for (uint256 i = 0; i < 200_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), codeHash, DEPLOYER);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                predicted = a;
                break;
            }
        }
        require(predicted != address(0), "salt not found in test budget");

        // Iterate the 14 permission bits and assert EXACTLY four set.
        uint160 setBits;
        for (uint8 bit = 0; bit < 14; ++bit) {
            if (uint160(predicted) & (uint160(1) << bit) != 0) setBits++;
        }
        assertEq(setBits, 4, "exactly the four declared permission flags should be set");
    }
}
