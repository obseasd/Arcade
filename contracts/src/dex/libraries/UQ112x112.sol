// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-point 112.112 helper used by V2 pair price accumulators.
library UQ112x112 {
    uint224 internal constant Q112 = 2 ** 112;

    function encode(uint112 y) internal pure returns (uint224 z) {
        unchecked {
            z = uint224(y) * Q112;
        }
    }

    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        unchecked {
            z = x / uint224(y);
        }
    }
}
