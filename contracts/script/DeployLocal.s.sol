// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap, IArcadeV4SwapRouterMin, IArcadeV4LaunchpadMin} from "../src/swap/ArcadeMultiSwap.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {IArcadeV3Factory, IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
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

        // ---- Uniswap V3 fork (for CLANKER_V3 locked-LP vault) ----
        // Requires the out-v3 artifacts: run `FOUNDRY_PROFILE=v3 forge build` first.
        address v3Factory = _deployV3Factory();

        // No WETH on local anvil - POOL_WETH launches are unavailable locally.
        ArcadeLaunchpad launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), factory, address(router), deployer, IArcadeV3Factory(v3Factory), address(0)
        );

        // V3 locker + swap router + quoter so CLANKER_V3 tokens are tradeable.
        // Local deploys don't wire the Twitter escrow integration - pass 0.
        // Audit V3 Locker M-3: owner_ is the deployer in local dev.
        address v3Locker = _deployV3Locker(address(launchpad), v3Factory, address(0), msg.sender);
        address v3Router = _deployV3Router(v3Factory, address(usdc), address(launchpad));
        address v3Quoter = _deployV3Aux("out-v3/ArcadeV3Quoter.sol/ArcadeV3Quoter.json", v3Factory, address(usdc));
        ArcadeTokenVault tokenVault = new ArcadeTokenVault(address(launchpad));
        // Wire locker + router + vault into the launchpad (one-time).
        launchpad.setV3Infra(v3Locker, v3Router, address(tokenVault));

        // MultiSwap depends on the V3 router (so it can route Clanker V3 tokens
        // that have no V2 pair). Deployed AFTER v3Router is wired.
        // Local deploys leave V4 disabled (address(0)) - V4 needs a real
        // PoolManager which isn't part of the anvil setup.
        ArcadeMultiSwap multiSwap = new ArcadeMultiSwap(
            IERC20(address(usdc)),
            factory,
            router,
            IArcadeLaunchpad(address(launchpad)),
            IArcadeV3Router(v3Router),
            IArcadeV4SwapRouterMin(address(0)),
            IArcadeV4LaunchpadMin(address(0))
        );
        // Enable the 2% and 3% fee tiers (1% is enabled by the V3 factory by default).
        IArcadeV3Factory(v3Factory).enableFeeAmount(20_000, 200);
        IArcadeV3Factory(v3Factory).enableFeeAmount(30_000, 200);

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

        // Token #5: CLANKER_V3 — TRUE Clanker launch. No bonding curve: the full
        // supply is locked single-sided in a V3 pool at creation, tradeable
        // immediately, creator earns 80% of perpetual LP fees.
        address vaultCat = launchpad.createToken(
            "Vault Cat", "VCAT", "ipfs://demo-vault", IArcadeLaunchpad.LaunchMode.CLANKER_V3, address(0), 0
        );

        // ---- Console summary ----
        console2.log("USDC:        ", address(usdc));
        console2.log("V2 Factory:  ", address(factory));
        console2.log("V2 Router:   ", address(router));
        console2.log("V3 Factory:  ", v3Factory);
        console2.log("V3 Locker:   ", v3Locker);
        console2.log("V3 Router:   ", v3Router);
        console2.log("V3 Quoter:   ", v3Quoter);
        console2.log("Token Vault: ", address(tokenVault));
        console2.log("Launchpad:   ", address(launchpad));
        console2.log("MultiSwap:   ", address(multiSwap));
        console2.log("APEPE:       ", pepe);
        console2.log("ADOGE:       ", dog);
        console2.log("ROCKET:      ", rocket);
        console2.log("SCAT (migr): ", satoshi);
        console2.log("VCAT (V3):   ", vaultCat);

        vm.stopBroadcast();

        // ---- Write addresses to a JSON file for the frontend ----
        // Use forge's JSON serializer (vm.serializeAddress) rather than one
        // giant `string.concat(...)`: each cheatcode call is opaque to the
        // via_ir optimizer, so it materialises and consumes one address at a
        // time instead of keeping all ~15 live (which overflows the stack).
        string memory obj = "arcadeDeploy";
        vm.serializeUint(obj, "chainId", uint256(31337));
        vm.serializeAddress(obj, "usdc", address(usdc));
        vm.serializeAddress(obj, "factory", address(factory));
        vm.serializeAddress(obj, "router", address(router));
        vm.serializeAddress(obj, "launchpad", address(launchpad));
        vm.serializeAddress(obj, "multiSwap", address(multiSwap));
        vm.serializeAddress(obj, "v3Factory", v3Factory);
        vm.serializeAddress(obj, "v3Locker", v3Locker);
        vm.serializeAddress(obj, "v3Router", v3Router);
        vm.serializeAddress(obj, "v3Quoter", v3Quoter);
        vm.serializeAddress(obj, "tokenVault", address(tokenVault));

        address[] memory samples = new address[](5);
        samples[0] = pepe;
        samples[1] = dog;
        samples[2] = rocket;
        samples[3] = satoshi;
        samples[4] = vaultCat;
        string memory json = vm.serializeAddress(obj, "sampleTokens", samples);
        vm.writeJson(json, "./deployments/local.json");
    }

    // ---- V3 deployment helpers (from the out-v3 0.7.6 artifacts) ----

    function _deployV3Factory() internal returns (address factory) {
        bytes memory code = vm.getCode("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json");
        assembly {
            factory := create(0, add(code, 0x20), mload(code))
        }
        require(factory != address(0), "v3 factory deploy failed");
    }

    function _deployV3Locker(
        address launchpad_,
        address factory_,
        address twitterEscrow_,
        address owner_
    ) internal returns (address locker) {
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json"),
            abi.encode(launchpad_, factory_, twitterEscrow_, owner_)
        );
        assembly {
            locker := create(0, add(code, 0x20), mload(code))
        }
        require(locker != address(0), "v3 locker deploy failed");
    }

    /// @dev Deploys an aux V3 contract whose constructor is (factory, usdc).
    function _deployV3Aux(string memory path, address factory_, address usdc_) internal returns (address addr) {
        bytes memory code = abi.encodePacked(vm.getCode(path), abi.encode(factory_, usdc_));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "v3 aux deploy failed");
    }

    /// @dev Deploys the V3 swap router: constructor is (factory, usdc, launchpad).
    /// The launchpad arg lets the router read & apply the anti-sniper tax.
    function _deployV3Router(address factory_, address usdc_, address launchpad_) internal returns (address addr) {
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json"),
            abi.encode(factory_, usdc_, launchpad_)
        );
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "v3 router deploy failed");
    }
}
