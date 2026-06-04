// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Testnet-only ERC20 with the symbol "ETH" so the explore page has a
 *         real ETH/USDC pool to surface. 18 decimals, mints 1,000,000 tokens
 *         to the deployer on construction so there's plenty of supply for
 *         seeding pairs and topping up testers.
 *
 *         NOT a real WETH - no deposit()/withdraw(). Use the real WETH at
 *         0x9570EBA9eE39Aa4933f64d6add280faAB289a847 when wiring POOL_WETH
 *         launches in production.
 */
contract SeedETH is ERC20 {
    constructor(address mintTo, uint256 amount) ERC20("Ether (Seed)", "ETH") {
        _mint(mintTo, amount);
    }
}

/**
 * @title DeploySeedETH
 * @notice Standalone ETH ERC20 deploy for Arc testnet. Mints 1,000,000 tokens
 *         to the deployer, no liquidity wiring - seed the USDC/ETH pair via
 *         the frontend instead (the V2 router's transferFrom uses the live
 *         USDC blocklist precompile which reverts under forge simulation but
 *         works fine when called from a wallet via eth_sendTransaction).
 *
 *         Required env:
 *           PRIVATE_KEY        = deployer key, funded with Arc USDC for gas
 *
 *         Optional env:
 *           SEED_ETH_AMOUNT    = total ETH-token supply minted to the deployer
 *                                (raw 18dp). Default 1,000,000 ether.
 *
 *         Usage:
 *           forge script script/DeploySeedETH.s.sol:DeploySeedETH \
 *             --rpc-url arc_testnet \
 *             --broadcast
 *
 *         After the broadcast lands, head to https://www.arcade.trading/positions,
 *         hit "+ New position", paste the printed token address, set amounts
 *         and submit. The first add creates the pair on the live factory and
 *         seeds it in one tx.
 */
contract DeploySeedETH is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 supply = vm.envOr("SEED_ETH_AMOUNT", uint256(1_000_000 ether));

        vm.startBroadcast(pk);
        SeedETH eth = new SeedETH(deployer, supply);
        vm.stopBroadcast();

        console2.log("SeedETH deployed at:", address(eth));
        console2.log("Initial supply to  :", deployer);
        console2.log("Supply amount      :", supply);
        console2.log("Add liquidity via  : https://www.arcade.trading/positions (+ New position)");
    }
}
