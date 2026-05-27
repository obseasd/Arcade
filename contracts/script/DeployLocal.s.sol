// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap} from "../src/swap/ArcadeMultiSwap.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DeployLocal
 * @notice Deploys the full Arcade stack to a local Anvil chain and seeds
 *         demo data (USDC balances, a few launchpad tokens in different
 *         states, and a couple of V2 pools) so the frontend has something
 *         to display.
 *
 * Usage:
 *   anvil  (in one terminal)
 *   forge script script/DeployLocal.s.sol --rpc-url anvil --broadcast \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 */
contract DeployLocal is Script {
    // Standard Anvil accounts
    address constant ANVIL_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant ANVIL_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant ANVIL_2 = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        // ---- Core contracts ----
        MockUSDC usdc = new MockUSDC();
        ArcadeV2Factory factory = new ArcadeV2Factory(deployer);
        ArcadeV2Router router = new ArcadeV2Router(address(factory));
        ArcadeLaunchpad launchpad = new ArcadeLaunchpad(IERC20(address(usdc)), factory, address(router), deployer);
        ArcadeMultiSwap multiSwap = new ArcadeMultiSwap(
            IERC20(address(usdc)), factory, router, IArcadeLaunchpad(address(launchpad))
        );

        // Activate Uniswap V2 `feeTo` — routes 1/6 of all LP fees to the treasury
        // (= 0.05% of swap volume). Treasury is the deployer here for the local demo;
        // on testnet/mainnet, point it at the Arcade multisig.
        factory.setFeeTo(deployer);

        // ---- Fund accounts (so we have USDC to play with) ----
        usdc.mint(deployer, 5_000_000e6);
        usdc.mint(ANVIL_1, 1_000_000e6);
        usdc.mint(ANVIL_2, 1_000_000e6);

        // ---- Seed launchpad with example tokens ----
        usdc.approve(address(launchpad), type(uint256).max);

        // Token #1: just created (PUMP mode, no secondary creator)
        address pepe = launchpad.createToken(
            "Arc Pepe", "APEPE", "ipfs://demo-pepe", IArcadeLaunchpad.LaunchMode.PUMP, address(0), 0
        );

        // Token #2: small buys (active curve) — PUMP mode
        address dog = launchpad.createToken(
            "Arc Doge", "ADOGE", "ipfs://demo-doge", IArcadeLaunchpad.LaunchMode.PUMP, address(0), 0
        );
        launchpad.buy(dog, 500e6, 0);
        launchpad.buy(dog, 1_200e6, 0);

        // Token #3: very close to migration (~95% sold) — CLANKER mode, single creator
        address rocket = launchpad.createToken(
            "Moon Rocket", "ROCKET", "ipfs://demo-rocket", IArcadeLaunchpad.LaunchMode.CLANKER, address(0), 0
        );
        launchpad.buy(rocket, 15_000e6, 0);

        // Token #4: already migrated to V2 — CLANKER mode with two creator receivers (50/50 of creator share)
        address satoshi = launchpad.createToken(
            "Satoshi Cat", "SCAT", "ipfs://demo-satoshi", IArcadeLaunchpad.LaunchMode.CLANKER, ANVIL_2, 5_000
        );
        launchpad.buy(satoshi, 100_000e6, 0); // forces migration

        // ---- Console summary ----
        console2.log("USDC:        ", address(usdc));
        console2.log("V2 Factory:  ", address(factory));
        console2.log("V2 Router:   ", address(router));
        console2.log("Launchpad:   ", address(launchpad));
        console2.log("MultiSwap:   ", address(multiSwap));
        console2.log("APEPE:       ", pepe);
        console2.log("ADOGE:       ", dog);
        console2.log("ROCKET:      ", rocket);
        console2.log("SCAT (migr): ", satoshi);

        vm.stopBroadcast();

        // ---- Write addresses to a JSON file for the frontend ----
        string memory json = string.concat(
            "{",
            '"chainId":31337,',
            '"usdc":"',
            vm.toString(address(usdc)),
            '",',
            '"factory":"',
            vm.toString(address(factory)),
            '",',
            '"router":"',
            vm.toString(address(router)),
            '",',
            '"launchpad":"',
            vm.toString(address(launchpad)),
            '",',
            '"multiSwap":"',
            vm.toString(address(multiSwap)),
            '",',
            '"sampleTokens":[',
            '"',
            vm.toString(pepe),
            '",',
            '"',
            vm.toString(dog),
            '",',
            '"',
            vm.toString(rocket),
            '",',
            '"',
            vm.toString(satoshi),
            '"',
            "]",
            "}"
        );
        vm.writeFile("./deployments/local.json", json);
    }
}
