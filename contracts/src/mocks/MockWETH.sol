// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock WETH for local/test deployments. 18 decimals, public faucet.
/// Used as the quote token for POOL_WETH launches in tests.
contract MockWETH is ERC20 {
    constructor() ERC20("Mock Wrapped Ether", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
