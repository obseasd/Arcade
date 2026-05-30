// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {
    IPoolManager,
    ILaunchpadSnipe,
    Currency,
    HookPermissions
} from "../v4src/interfaces/IUniswapV4Types.sol";

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
    uint160 internal constant TARGET_FLAGS =
        HookPermissions.BEFORE_SWAP_FLAG | HookPermissions.AFTER_SWAP_FLAG;

    address internal constant DEPLOYER = address(0xDEADBEEF);
    address internal constant POOL_MANAGER = address(0xABCD);
    address internal constant LAUNCHPAD = address(0x1234);
    address internal constant USDC_ADDR = address(0x5678);

    function test_mining_findsSaltWithCorrectPermissions() public view {
        bytes memory creationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(POOL_MANAGER, LAUNCHPAD, Currency.wrap(USDC_ADDR))
        );
        bytes32 codeHash = keccak256(creationCode);

        // Brute-force the same way the script does. With one permission bit,
        // expected attempts ≈ 8 192. Cap at 100k for safety.
        bytes32 foundSalt;
        address predicted;
        for (uint256 i = 0; i < 100_000; ++i) {
            bytes32 salt = bytes32(i);
            address a = vm.computeCreate2Address(salt, codeHash, DEPLOYER);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                foundSalt = salt;
                predicted = a;
                break;
            }
        }

        assertTrue(predicted != address(0), "mining should find a salt within cap");
        // The low 14 bits of the predicted address must equal exactly the
        // permission flags the hook declares.
        assertEq(uint160(predicted) & PERM_MASK, TARGET_FLAGS, "address permissions mismatch");
        // And the BEFORE_SWAP_FLAG (bit 7) must be set explicitly.
        assertTrue(uint160(predicted) & HookPermissions.BEFORE_SWAP_FLAG != 0, "BEFORE_SWAP_FLAG should be set");
        // Sanity log so test output documents a working salt.
        console2.log("Found predicted hook address:", predicted);
        console2.logBytes32(foundSalt);
    }

    function test_exactlyDeclaredFlags_areSet() public view {
        // V4's PoolManager calls every slot whose flag is set on the hook
        // address. Bits we don't implement must NOT be set or the call would
        // revert. Bits we DO implement must be set or the manager skips them.
        bytes memory creationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(POOL_MANAGER, LAUNCHPAD, Currency.wrap(USDC_ADDR))
        );
        bytes32 codeHash = keccak256(creationCode);

        address predicted;
        // The search space for 2 fixed bits is 1 / 2^12 ≈ 4 096 attempts on
        // average. Allow up to 200k for paranoia.
        for (uint256 i = 0; i < 200_000; ++i) {
            address a = vm.computeCreate2Address(bytes32(i), codeHash, DEPLOYER);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                predicted = a;
                break;
            }
        }
        require(predicted != address(0), "salt not found in test budget");

        // Iterate the 14 permission bits and assert exactly two set (BEFORE
        // and AFTER swap).
        uint160 setBits;
        for (uint8 bit = 0; bit < 14; ++bit) {
            if (uint160(predicted) & (uint160(1) << bit) != 0) setBits++;
        }
        assertEq(setBits, 2, "exactly BEFORE_SWAP + AFTER_SWAP flags should be set");
        assertTrue(uint160(predicted) & HookPermissions.BEFORE_SWAP_FLAG != 0);
        assertTrue(uint160(predicted) & HookPermissions.AFTER_SWAP_FLAG != 0);
    }
}
