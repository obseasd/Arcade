// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Launchpad surface the anti-sniper hook reads on every swap.
///         Implemented by `ArcadeV4Launchpad`; named separately so the hook
///         doesn't pull the whole launchpad source into its dependency tree.
interface ILaunchpadSnipe {
    function currentSnipeBps(address token) external view returns (uint256);
    function treasury() external view returns (address);
}
