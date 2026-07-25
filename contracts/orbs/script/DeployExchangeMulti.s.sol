// SPDX-License-Identifier: MIT
pragma solidity 0.8.*;

import "forge-std/Test.sol";
import "forge-std/Script.sol";

import {IExchange} from "src/IExchange.sol";
import {ExchangeMulti} from "src/exchange/ExchangeMulti.sol";

/**
 * Deploy the single keeper-only multi-router adapter.
 *
 * envs (comma-separated for the lists):
 *   TAKERS  — allow-listed keeper EOAs that may bid/fill (usually one).
 *   ROUTERS — allow-listed DEX routers the adapter may execute against
 *             (Arcade V2 router, Arcade V3 SwapRouter, XyloNet router, ...).
 *
 * After deploy: pin new limit/DCA orders' ask.exchange to this address, wire the
 * keeper's ORBS_ADAPTER_MULTI env, and (optionally) transferOwnership to the Safe.
 * Add a future DEX with setRouterAllowed(router, true) — no redeploy.
 */
contract DeployExchangeMulti is Script {
    function run() public returns (IExchange) {
        address[] memory takers = vm.envAddress("TAKERS", ",");
        address[] memory routers = vm.envAddress("ROUTERS", ",");

        vm.broadcast();
        return new ExchangeMulti{salt: bytes32(uint256(0))}(takers, routers);
    }
}
