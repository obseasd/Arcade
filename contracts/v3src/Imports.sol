// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

// Pulls the Uniswap V3 Factory implementation into the `v3` profile build so
// its artifact lands in out-v3/ for DeployV3 to deploy via vm.getCode. Nothing
// else imports the Factory implementation directly (we only use it via ABI).
import "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
