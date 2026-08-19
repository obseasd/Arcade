// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Stable ABI the launchpad (ArcadeHook) codes against to register and
///         settle staircase (tranche) vesting schedules. The vault itself is
///         immutable and admin-less; see `StaircaseVestingVault`.
interface IStaircaseVestingVault {
    /// @param unlockTime      absolute timestamp this step unlocks at
    /// @param cumulativeBps   cumulative fraction of the vest amount unlocked
    ///                        from this step onward, in basis points of the
    ///                        total (strictly increasing, last == 10000)
    struct Step {
        uint64 unlockTime;
        uint16 cumulativeBps;
    }

    function createVest(address token, address beneficiary, uint256 amount, Step[] calldata steps)
        external
        returns (uint256 vestId);

    function claim(uint256 vestId) external;

    function claimable(uint256 vestId) external view returns (uint256);
}
