// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap} from "../src/swap/ArcadeMultiSwap.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {IArcadeV3Factory} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DeployTestnet
 * @notice Deploys Arcade to Arc testnet. Uses the live Arc USDC address (NOT a mock).
 *
 *   Required env:
 *     PRIVATE_KEY        = deployer key, funded with Arc testnet USDC for gas
 *     ARC_USDC_ADDRESS   = real Arc USDC ERC20 address (must be set before deploy)
 *     TREASURY_ADDRESS   = address that receives platform fees + creation fees
 *
 * Usage:
 *   forge script script/DeployTestnet.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployTestnet is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        vm.startBroadcast(pk);

        ArcadeV2Factory factory = new ArcadeV2Factory(deployer);
        ArcadeV2Router router = new ArcadeV2Router(address(factory));

        // Uniswap V3 fork for CLANKER_V3 locked-LP vaults.
        // Requires out-v3 artifacts: run `FOUNDRY_PROFILE=v3 forge build` first.
        address v3Factory = _deployV3Factory();

        ArcadeLaunchpad launchpad = new ArcadeLaunchpad(
            IERC20(usdc), factory, address(router), treasury, IArcadeV3Factory(v3Factory)
        );
        ArcadeMultiSwap multiSwap = new ArcadeMultiSwap(
            IERC20(usdc), factory, router, IArcadeLaunchpad(address(launchpad))
        );

        address v3Locker = _deployV3Locker(address(launchpad), v3Factory);
        address v3Router = _deployV3Aux("out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json", v3Factory, usdc);
        address v3Quoter = _deployV3Aux("out-v3/ArcadeV3Quoter.sol/ArcadeV3Quoter.json", v3Factory, usdc);
        ArcadeTokenVault tokenVault = new ArcadeTokenVault(address(launchpad));
        launchpad.setV3Infra(v3Locker, v3Router, address(tokenVault));
        // Enable the 2% and 3% fee tiers (1% is on by default in the V3 factory).
        IArcadeV3Factory(v3Factory).enableFeeAmount(20_000, 200);
        IArcadeV3Factory(v3Factory).enableFeeAmount(30_000, 200);

        // Activate `feeTo` so 1/6 of all V2 LP fees route to the treasury
        // (= 0.05% of swap volume) instead of all going to LPs.
        factory.setFeeTo(treasury);

        console2.log("Chain:       Arc testnet");
        console2.log("USDC:        ", usdc);
        console2.log("Treasury:    ", treasury);
        console2.log("V2 Factory:  ", address(factory));
        console2.log("V2 Router:   ", address(router));
        console2.log("V3 Factory:  ", v3Factory);
        console2.log("V3 Locker:   ", v3Locker);
        console2.log("V3 Router:   ", v3Router);
        console2.log("V3 Quoter:   ", v3Quoter);
        console2.log("Token Vault: ", address(tokenVault));
        console2.log("Launchpad:   ", address(launchpad));
        console2.log("MultiSwap:   ", address(multiSwap));

        vm.stopBroadcast();
    }

    // ---- V3 deployment helpers (from the out-v3 0.7.6 artifacts) ----

    function _deployV3Factory() internal returns (address factory) {
        bytes memory code = vm.getCode("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json");
        assembly {
            factory := create(0, add(code, 0x20), mload(code))
        }
        require(factory != address(0), "v3 factory deploy failed");
    }

    function _deployV3Locker(address launchpad_, address factory_) internal returns (address locker) {
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json"),
            abi.encode(launchpad_, factory_)
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
}
