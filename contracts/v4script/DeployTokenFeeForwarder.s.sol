// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TokenFeeForwarder} from "../src/launchpad/TokenFeeForwarder.sol";

/// @notice Deploys the TokenFeeForwarder that relays the CLANKER token-leg fees
///         and emits an indexed `Forwarded` event for the subgraph to join to the
///         escrow's USDC-side Claim.
///
///         Env:
///           PRIVATE_KEY        deployer key (funded).
///           OWNER_ADDRESS      Ownable2Step owner (the treasury Safe). Defaults
///                              to the deployer if unset (testnet turnkey).
///           FORWARDER_CALLER   the backend forwarder wallet, seeded into the
///                              allowlist. Defaults to the deployer (testnet, where
///                              the operator IS the forwarder wallet).
contract DeployTokenFeeForwarder is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address owner = vm.envOr("OWNER_ADDRESS", deployer);
        address caller = vm.envOr("FORWARDER_CALLER", deployer);

        vm.startBroadcast(pk);
        TokenFeeForwarder forwarder = new TokenFeeForwarder(owner, caller);
        vm.stopBroadcast();

        console2.log("TokenFeeForwarder:", address(forwarder));
        console2.log("  owner:         ", owner);
        console2.log("  initialCaller: ", caller);
        console2.log("=========================================");
        console2.log("Frontend wiring:");
        console2.log("  NEXT_PUBLIC_TOKEN_FEE_FORWARDER_ADDRESS =", address(forwarder));
        console2.log("  deployments.json addresses.tokenFeeForwarder =", address(forwarder));
        console2.log("ACTION (backend): the forwarder wallet must approve this");
        console2.log("  contract for each launch token before forward(), and be");
        console2.log("  allow-listed here (initialCaller seeds one).");
    }
}
