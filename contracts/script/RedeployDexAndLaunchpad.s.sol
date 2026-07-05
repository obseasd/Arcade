// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeV2Zap} from "../src/dex/ArcadeV2Zap.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeIdentityIssuer} from "../src/identity/ArcadeIdentityIssuer.sol";
import {ArcadeMultiSwap, IArcadeV4SwapRouterMin, IArcadeV4LaunchpadMin} from "../src/swap/ArcadeMultiSwap.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {ArcadeTwitterEscrowV3} from "../src/launchpad/ArcadeTwitterEscrowV3.sol";
import {IArcadeV3Factory, IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IArcadeV2Factory} from "../src/dex/interfaces/IArcadeV2Factory.sol";
import {IArcadeV2Router} from "../src/dex/interfaces/IArcadeV2Router.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title RedeployDexAndLaunchpad
 * @notice Redeploys the V2 DEX (factory + router) AND the full launchpad chain
 *         so the seed-gated-pair migration fix (2026-07-05) goes live. The fix
 *         changes ArcadeV2Factory (createPairGated/setLaunchpad), ArcadeV2Pair
 *         (seedGate), and ArcadeLaunchpad (_migrate direct clearing-price seed),
 *         so the old reused factory/router from the escrow-rewire redeploy
 *         CANNOT carry it — a fresh factory + router is mandatory, which
 *         cascades to a fresh launchpad chain (locker/tokenVault/v3Router/
 *         multiSwap/escrow all reference the launchpad).
 *
 *         The critical new step vs. RedeployLaunchpadChain is
 *         `factory.setLaunchpad(launchpad)` (step 3): without it every
 *         createToken reverts because createToken now pre-creates the
 *         seed-gated migration pair via the launchpad-only createPairGated.
 *
 *         Reuses only the v3 factory (unchanged). Bootstrap order mirrors
 *         RedeployLaunchpadChain for the escrow<->locker<->launchpad cycle.
 *
 *         Build both layers, then unset the v3 profile before running:
 *           forge build
 *           FOUNDRY_PROFILE=v3 forge build
 *           unset FOUNDRY_PROFILE
 *
 *         Required env:
 *           PRIVATE_KEY            = deployer key (== escrow owner AND factory
 *                                    feeToSetter, so setLocker/setV3Infra/
 *                                    setLaunchpad land in this broadcast)
 *           ARC_USDC_ADDRESS       = Arc USDC (0x3600...0000)
 *           TREASURY_ADDRESS       = fee recipient (MAINNET: a multisig, never
 *                                    the deployer EOA)
 *           ARCADE_BACKEND_SIGNER  = escrow trusted signer
 *           V3_FACTORY             = reused v3 factory
 *           V3_NPM                 = reused v3 NonfungiblePositionManager (for the V3 zap)
 *         Optional env:
 *           ESCROW_OWNER (default deployer), ARC_WETH_ADDRESS (default known WETH),
 *           V4_ROUTER (default 0), V4_LAUNCHPAD (default 0)
 *
 *         Usage:
 *           PRIVATE_KEY=0x... ARC_USDC_ADDRESS=0x3600...0000 \
 *           TREASURY_ADDRESS=0x... ARCADE_BACKEND_SIGNER=0x... V3_FACTORY=0x... \
 *           forge script script/RedeployDexAndLaunchpad.s.sol --rpc-url arc_testnet --broadcast
 *
 *         Post-deploy ops (NOT done here):
 *           - Update the Vercel NEXT_PUBLIC_* block (incl. V2_FACTORY + V2_ROUTER)
 *             and web/public/deployments.json to the new addresses.
 *           - Already-graduated tokens on the OLD launchpad (e.g. KFX) do not
 *             migrate to this deployment; re-launch or manually seed if needed.
 */
contract RedeployDexAndLaunchpad is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address signer = vm.envAddress("ARCADE_BACKEND_SIGNER");
        address escrowOwner = vm.envOr("ESCROW_OWNER", deployer);
        address weth = vm.envOr("ARC_WETH_ADDRESS", address(0x9570EBA9eE39Aa4933f64d6add280faAB289a847));

        address v3Factory = vm.envAddress("V3_FACTORY");
        address v3Npm = vm.envAddress("V3_NPM"); // reused V3 NonfungiblePositionManager (for the V3 zap)
        // Arc ERC-8004 Identity Registry (for the identity issuer). Default is the
        // known Arc testnet address; set ERC8004_REGISTRY=0 to skip the issuer.
        address erc8004Registry = vm.envOr("ERC8004_REGISTRY", address(0x8004A818BFB912233c491871b3d84c89A494BD9e));
        address v4Router = vm.envOr("V4_ROUTER", address(0));
        address v4Launchpad = vm.envOr("V4_LAUNCHPAD", address(0));

        require(signer != address(0), "ARCADE_BACKEND_SIGNER must be set");
        require(escrowOwner == deployer, "ESCROW_OWNER must equal deployer so setLocker lands in this broadcast");

        vm.startBroadcast(pk);

        // 0. Fresh V2 DEX carrying the seed-gate fix. Deployer is the
        //    feeToSetter so setLaunchpad lands in this same broadcast.
        ArcadeV2Factory factory = new ArcadeV2Factory(deployer);
        ArcadeV2Router router = new ArcadeV2Router(address(factory));

        // 1. Launchpad (locker wired later via setV3Infra).
        ArcadeLaunchpad launchpad = new ArcadeLaunchpad(
            IERC20(usdc), IArcadeV2Factory(address(factory)), address(router), treasury, IArcadeV3Factory(v3Factory), weth
        );

        // 2. Authorize the launchpad to create seed-gated migration pairs.
        //    MUST precede any createToken (createToken pre-creates the pair).
        factory.setLaunchpad(address(launchpad));

        // 3. Escrow (LOCKER unset, signer + owner only).
        ArcadeTwitterEscrowV3 escrow = new ArcadeTwitterEscrowV3(signer, escrowOwner);

        // 4. Locker with immutable twitterEscrow = escrow.
        address locker = _deployV3Locker(address(launchpad), v3Factory, address(escrow), deployer);

        // 5. Wire the escrow to the locker (one-shot, owner-only).
        escrow.setLocker(locker);

        // 6. Token vault.
        ArcadeTokenVault tokenVault = new ArcadeTokenVault(address(launchpad));

        // 7. V3 router (reads the launchpad for the anti-sniper tax).
        address v3Router = _deployV3Router(v3Factory, usdc, address(launchpad));

        // 8. One-shot V3 infra wiring on the launchpad.
        launchpad.setV3Infra(locker, v3Router, address(tokenVault));

        // 9. MultiSwap over the new v2 core + the new launchpad + new v3 router.
        ArcadeMultiSwap multiSwap = new ArcadeMultiSwap(
            IERC20(usdc),
            IArcadeV2Factory(address(factory)),
            IArcadeV2Router(address(router)),
            IArcadeLaunchpad(address(launchpad)),
            IArcadeV3Router(v3Router),
            IArcadeV4SwapRouterMin(v4Router),
            IArcadeV4LaunchpadMin(v4Launchpad)
        );

        // 10. Zaps. The V2 zap MUST be fresh (it targets the new factory/router).
        //     The V3 zap carries the delta-only-sweep theft fix, so redeploy it
        //     too (it reuses the unchanged v3 factory + NPM).
        ArcadeV2Zap v2Zap = new ArcadeV2Zap(address(factory), address(router));
        address v3Zap = _deployV3Zap(v3Factory, v3Npm);

        // 11. Identity issuer. MUST be a matched pair with the launchpad: it
        //     reads launchpad.creatorBondedCount() (new ABI), and its own fixes
        //     (CLANKER_V3 tier filter, on-chain metadata, mint dedupe) ship here.
        //     arcadeHook = 0 (V4 not wired). Skipped if ERC8004_REGISTRY unset.
        address identityIssuer = address(0);
        if (erc8004Registry != address(0)) {
            identityIssuer = address(new ArcadeIdentityIssuer(address(launchpad), address(0), erc8004Registry));
        }

        vm.stopBroadcast();

        console2.log("==== RedeployDexAndLaunchpad (seed-gate migration fix) ====");
        console2.log("Reused v3Factory: ", v3Factory);
        console2.log("--- NEW addresses (update Vercel + deployments.json) ---");
        console2.log("v2Factory:        ", address(factory));
        console2.log("v2Router:         ", address(router));
        console2.log("twitterEscrow:    ", address(escrow));
        console2.log("v3Locker:         ", locker);
        console2.log("launchpad:        ", address(launchpad));
        console2.log("v3Router:         ", v3Router);
        console2.log("tokenVault:       ", address(tokenVault));
        console2.log("multiSwap:        ", address(multiSwap));
        console2.log("v2Zap:            ", address(v2Zap));
        console2.log("v3Zap:            ", v3Zap);
        console2.log("identityIssuer:   ", identityIssuer);
        console2.log("--------------------------------------------------------");
        console2.log("NEXT_PUBLIC_V2_FACTORY_ADDRESS=", address(factory));
        console2.log("NEXT_PUBLIC_V2_ROUTER_ADDRESS=", address(router));
        console2.log("NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS=", address(escrow));
        console2.log("NEXT_PUBLIC_V3_LOCKER_ADDRESS=", locker);
        console2.log("NEXT_PUBLIC_LAUNCHPAD_ADDRESS=", address(launchpad));
        console2.log("NEXT_PUBLIC_V3_ROUTER_ADDRESS=", v3Router);
        console2.log("NEXT_PUBLIC_TOKEN_VAULT_ADDRESS=", address(tokenVault));
        console2.log("NEXT_PUBLIC_MULTISWAP_ADDRESS=", address(multiSwap));
        console2.log("NEXT_PUBLIC_V2_ZAP_ADDRESS=", address(v2Zap));
        console2.log("NEXT_PUBLIC_V3_ZAP_ADDRESS=", v3Zap);
        console2.log("NEXT_PUBLIC_IDENTITY_ISSUER_ADDRESS=", identityIssuer);
    }

    function _deployV3Zap(address factory_, address npm_) internal returns (address zap) {
        // ArcadeV3Zap constructor: (address factory_, address npm_)
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3Zap.sol/ArcadeV3Zap.json"),
            abi.encode(factory_, npm_)
        );
        assembly {
            zap := create(0, add(code, 0x20), mload(code))
        }
        require(zap != address(0), "v3 zap deploy failed");
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
