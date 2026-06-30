// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap, IArcadeV4SwapRouterMin, IArcadeV4LaunchpadMin} from "../src/swap/ArcadeMultiSwap.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {ArcadeTwitterEscrowV3} from "../src/launchpad/ArcadeTwitterEscrowV3.sol";
import {IArcadeV3Factory, IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IArcadeV2Factory} from "../src/dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Router} from "../src/dex/interfaces/IArcadeV2Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title RedeployLaunchpadChain
 * @notice Redeploys ONLY the launchpad chain so the Twitter escrow is wired
 *         back in after the 2026-06-30 Path B redeploy (which left
 *         locker.twitterEscrow == 0). REUSES the existing Path B DEX core
 *         (v2 factory/router, v3 factory) + the v3 quoter/zaps/NPM/compounder;
 *         only escrow, locker, launchpad, tokenVault, v3Router and multiSwap
 *         are fresh.
 *
 *         Bootstrap order resolves the escrow<->locker and launchpad<->locker
 *         circular constructor dependencies:
 *           1. launchpad  (no locker arg; locker is wired later via setV3Infra)
 *           2. escrow     (LOCKER unset; signer + owner only)
 *           3. locker     (immutable twitterEscrow = escrow, launchpad known)
 *           4. escrow.setLocker(locker)        (owner-only, owner == deployer)
 *           5. tokenVault (launchpad)
 *           6. v3Router   (v3Factory, usdc, launchpad)
 *           7. launchpad.setV3Infra(locker, v3Router, tokenVault)  (deployer-only)
 *           8. multiSwap  (reuses v2 core + new launchpad + new v3Router)
 *
 *         Build BOTH layers first, then UNSET the v3 profile before the script
 *         (the v3 profile has skip=[] and would compile broken v4):
 *           forge build
 *           FOUNDRY_PROFILE=v3 forge build
 *           unset FOUNDRY_PROFILE
 *
 *         Required env:
 *           PRIVATE_KEY            = deployer key (must equal the escrow owner so
 *                                    setLocker + setV3Infra land in this broadcast)
 *           ARC_USDC_ADDRESS       = Arc USDC (0x3600...0000)
 *           TREASURY_ADDRESS       = fee recipient (Path B treasury)
 *           ARCADE_BACKEND_SIGNER  = escrow trusted signer (testnet: the deployer
 *                                    EOA, so the existing Vercel signer keeps working)
 *           V2_FACTORY             = reused Path B v2 factory
 *           V2_ROUTER              = reused Path B v2 router
 *           V3_FACTORY             = reused Path B v3 factory
 *         Optional env:
 *           ESCROW_OWNER (default deployer), ARC_WETH_ADDRESS (default known WETH),
 *           V4_ROUTER (default 0), V4_LAUNCHPAD (default 0)
 *
 *         Usage:
 *           PRIVATE_KEY=0x... ARC_USDC_ADDRESS=0x3600...0000 \
 *           TREASURY_ADDRESS=0x... ARCADE_BACKEND_SIGNER=0x... \
 *           V2_FACTORY=0x... V2_ROUTER=0x... V3_FACTORY=0x... \
 *           forge script script/RedeployLaunchpadChain.s.sol --rpc-url arc_testnet --broadcast
 */
contract RedeployLaunchpadChain is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address signer = vm.envAddress("ARCADE_BACKEND_SIGNER");
        address escrowOwner = vm.envOr("ESCROW_OWNER", deployer);
        address weth = vm.envOr("ARC_WETH_ADDRESS", address(0x9570EBA9eE39Aa4933f64d6add280faAB289a847));

        address v2Factory = vm.envAddress("V2_FACTORY");
        address v2Router = vm.envAddress("V2_ROUTER");
        address v3Factory = vm.envAddress("V3_FACTORY");
        address v4Router = vm.envOr("V4_ROUTER", address(0));
        address v4Launchpad = vm.envOr("V4_LAUNCHPAD", address(0));

        require(signer != address(0), "ARCADE_BACKEND_SIGNER must be set");
        require(escrowOwner == deployer, "ESCROW_OWNER must equal deployer so setLocker lands in this broadcast");

        vm.startBroadcast(pk);

        // 1. Launchpad (locker wired later via setV3Infra).
        ArcadeLaunchpad launchpad = new ArcadeLaunchpad(
            IERC20(usdc), IArcadeV2Factory(v2Factory), v2Router, treasury, IArcadeV3Factory(v3Factory), weth
        );

        // 2. Escrow (LOCKER unset, signer + owner only).
        ArcadeTwitterEscrowV3 escrow = new ArcadeTwitterEscrowV3(signer, escrowOwner);

        // 3. Locker with immutable twitterEscrow = escrow.
        address locker = _deployV3Locker(address(launchpad), v3Factory, address(escrow), deployer);

        // 4. Wire the escrow to the locker (one-shot, owner-only).
        escrow.setLocker(locker);

        // 5. Token vault.
        ArcadeTokenVault tokenVault = new ArcadeTokenVault(address(launchpad));

        // 6. V3 router (reads the launchpad for the anti-sniper tax).
        address v3Router = _deployV3Router(v3Factory, usdc, address(launchpad));

        // 7. One-shot V3 infra wiring on the launchpad.
        launchpad.setV3Infra(locker, v3Router, address(tokenVault));

        // 8. MultiSwap over the reused v2 core + the new launchpad + new v3 router.
        ArcadeMultiSwap multiSwap = new ArcadeMultiSwap(
            IERC20(usdc),
            IArcadeV2Factory(v2Factory),
            IArcadeV2Router(v2Router),
            IArcadeLaunchpad(address(launchpad)),
            IArcadeV3Router(v3Router),
            IArcadeV4SwapRouterMin(v4Router),
            IArcadeV4LaunchpadMin(v4Launchpad)
        );

        vm.stopBroadcast();

        console2.log("==== RedeployLaunchpadChain (escrow rewired) ====");
        console2.log("Reused v2Factory: ", v2Factory);
        console2.log("Reused v2Router:  ", v2Router);
        console2.log("Reused v3Factory: ", v3Factory);
        console2.log("--- NEW addresses (update Vercel + deployments.json) ---");
        console2.log("twitterEscrow:    ", address(escrow));
        console2.log("v3Locker:         ", locker);
        console2.log("launchpad:        ", address(launchpad));
        console2.log("v3Router:         ", v3Router);
        console2.log("tokenVault:       ", address(tokenVault));
        console2.log("multiSwap:        ", address(multiSwap));
        console2.log("escrow signer:    ", signer);
        console2.log("escrow owner:     ", escrowOwner);
        console2.log("--------------------------------------------------------");
        console2.log("NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS=", address(escrow));
        console2.log("NEXT_PUBLIC_V3_LOCKER_ADDRESS=", locker);
        console2.log("NEXT_PUBLIC_LAUNCHPAD_ADDRESS=", address(launchpad));
        console2.log("NEXT_PUBLIC_V3_ROUTER_ADDRESS=", v3Router);
        console2.log("NEXT_PUBLIC_TOKEN_VAULT_ADDRESS=", address(tokenVault));
        console2.log("NEXT_PUBLIC_MULTISWAP_ADDRESS=", address(multiSwap));
    }

    // ---- V3 0.7.6 deployment helpers (out-v3 artifacts) ----

    function _deployV3Locker(address launchpad_, address factory_, address twitterEscrow_, address owner_)
        internal
        returns (address locker)
    {
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json"),
            abi.encode(launchpad_, factory_, twitterEscrow_, owner_)
        );
        assembly {
            locker := create(0, add(code, 0x20), mload(code))
        }
        require(locker != address(0), "v3 locker deploy failed");
    }

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
