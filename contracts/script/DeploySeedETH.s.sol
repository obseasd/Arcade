// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";

/**
 * @notice Testnet-only ERC20 with the symbol "ETH" so the explore page has a
 *         real ETH/USDC pool to surface. 18 decimals, mints 1,000,000 to the
 *         deployer on construction.
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
 * @notice Spins up a test-only ETH ERC20, then seeds an Arcade V2 USDC/ETH
 *         pair so the new /explore page has a non-launchpad pool to render.
 *         Run once on Arc testnet.
 *
 *         Required env:
 *           PRIVATE_KEY        = deployer key, funded with Arc USDC for gas
 *           V2_FACTORY         = Arcade V2 factory (defaults to the address
 *                                in web/public/deployments.json)
 *           V2_ROUTER          = Arcade V2 router (same default source)
 *           USDC               = Arc USDC (defaults to the canonical address)
 *
 *         Optional env:
 *           SEED_USDC_AMOUNT   = USDC to seed the pair with, raw 6dp. Default
 *                                1_000_000_000 (= 1,000 USDC).
 *           SEED_ETH_AMOUNT    = ETH-token to seed the pair with, raw 18dp.
 *                                Default 0.4 ether (implies ~$2,500 per ETH).
 *
 *         Usage:
 *           forge script script/DeploySeedETH.s.sol \
 *             --rpc-url arc_testnet \
 *             --broadcast
 */
contract DeploySeedETH is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address usdc = vm.envOr(
            "USDC",
            address(0x3600000000000000000000000000000000000000)
        );
        // Defaults match web/public/deployments.json + web/.env.local (the live
        // Vercel front-end). If you deploy against different addresses, override
        // via the V2_FACTORY / V2_ROUTER env vars at runtime.
        address v2Factory = vm.envOr(
            "V2_FACTORY",
            address(0x289b18cBFD9f2a2657c021F80423137Af6233332)
        );
        address v2Router = vm.envOr(
            "V2_ROUTER",
            address(0x529d7250652aAaA11b4E2407e8b49fa9ae0E5041)
        );

        uint256 seedUsdc = vm.envOr("SEED_USDC_AMOUNT", uint256(1_000_000_000));
        uint256 seedEth = vm.envOr("SEED_ETH_AMOUNT", uint256(0.4 ether));

        vm.startBroadcast(pk);

        // Mint the deployer enough ETH-token to cover the seed plus a buffer
        // for future top-ups.
        SeedETH eth = new SeedETH(deployer, seedEth * 100);
        console2.log("SeedETH deployed:", address(eth));

        // Approve the V2 router for both legs.
        require(
            IERC20(usdc).approve(v2Router, seedUsdc),
            "DeploySeedETH: USDC approve failed (check USDC balance on deployer)"
        );
        eth.approve(v2Router, seedEth);

        // addLiquidity creates the pair if it doesn't exist and seeds it.
        // amountAMin/amountBMin = 0 since this is the very first liquidity
        // event and there are no front-running concerns on a fresh pair.
        (uint256 amtUsdc, uint256 amtEth, uint256 lp) = ArcadeV2Router(v2Router).addLiquidity(
            usdc,
            address(eth),
            seedUsdc,
            seedEth,
            0,
            0,
            deployer,
            block.timestamp + 600
        );
        console2.log("Liquidity added - USDC:", amtUsdc);
        console2.log("Liquidity added - ETH :", amtEth);
        console2.log("LP minted              :", lp);

        // Resolve the pair address for the deploy log.
        address pair = ArcadeV2Factory(v2Factory).getPair(usdc, address(eth));
        console2.log("USDC/ETH pair          :", pair);

        vm.stopBroadcast();
    }
}
