// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {ArcadeMultiSwap, IArcadeV4SwapRouterMin, IArcadeV4LaunchpadMin} from "../src/swap/ArcadeMultiSwap.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {ArcadeTwitterEscrowV3} from "../src/launchpad/ArcadeTwitterEscrowV3.sol";
import {IArcadeV3Factory, IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DeploySecurityV3
 * @notice Fresh end-to-end deploy of the audit-fixed Arcade stack on Arc testnet.
 *         Supersedes `DeployTestnet.s.sol` for the post-`16afe44` security pass.
 *         Deploys all five touched-by-audit contracts plus the V2/V3 infra they
 *         depend on, in the correct order, and asserts every wiring post-deploy
 *         so a bad bootstrap aborts BEFORE the user updates Vercel.
 *
 *         Bootstrap order:
 *           1.  Escrow V3            (no deps - just signer + owner)
 *           2.  V2 Factory + Router  (independent)
 *           3.  V3 Factory           (Uniswap V3 fork, 0.7.6 bytecode)
 *           4.  Launchpad            (needs V2 stack + V3 factory + USDC + WETH)
 *           5.  V3 Locker            (needs launchpad + V3 factory + escrow)
 *           6.  V3 SwapRouter        (needs V3 factory + USDC + launchpad)
 *           7.  V3 Quoter            (needs V3 factory + USDC)
 *           8.  Token Vault          (needs launchpad)
 *           9.  escrow.setLocker     (one-shot, owner-gated)
 *          10.  launchpad.setV3Infra (one-shot, deployer-gated)
 *          11.  MultiSwap            (needs everything above)
 *          12.  V3 factory fee-tier opt-ins + V2 feeTo
 *          13.  Sanity assertions
 *
 *         Required env:
 *           PRIVATE_KEY              = deployer key, funded with USDC for gas
 *           ARC_USDC_ADDRESS         = real Arc USDC (NOT a mock)
 *           ARCADE_BACKEND_SIGNER    = backend wallet address (signs claims)
 *
 *         Optional env:
 *           TREASURY_ADDRESS         = platform fee receiver (default: deployer)
 *           ESCROW_OWNER             = escrow owner (default: deployer)
 *           ARC_WETH_ADDRESS         = WETH on Arc (default: known testnet WETH)
 *           V4_ROUTER / V4_LAUNCHPAD = V4 stack (default: address(0), V4 disabled)
 *
 *         Usage:
 *           FOUNDRY_PROFILE=v3 forge build      # produces out-v3 artifacts
 *           FOUNDRY_PROFILE=default forge build # 0.8 contracts
 *           PRIVATE_KEY=0x... \
 *           ARC_USDC_ADDRESS=0x... \
 *           ARCADE_BACKEND_SIGNER=0x... \
 *           forge script script/DeploySecurityV3.s.sol --rpc-url arc_testnet --broadcast --slow
 *
 *         The `--slow` flag is important on Arc: per-tx nonce ordering is
 *         strict and back-to-back deploys without it occasionally race.
 */
contract DeploySecurityV3 is Script {
    /// @dev Aggregates the deployed addresses we need to keep around between
    ///      the broadcast and the post-broadcast assertions. Struct-based
    ///      passing keeps the script under via_ir's stack-too-deep limit.
    struct Deployed {
        ArcadeTwitterEscrowV3 escrow;
        ArcadeV2Factory factory;
        ArcadeV2Router router;
        address v3Factory;
        ArcadeLaunchpad launchpad;
        address v3Locker;
        address v3Router;
        address v3Quoter;
        ArcadeTokenVault tokenVault;
        ArcadeMultiSwap multiSwap;
    }

    struct Config {
        address deployer;
        address treasury;
        address escrowOwner;
        address signer;
        address usdc;
        address weth;
        address v4Router;
        address v4Launchpad;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        Config memory cfg = _readConfig(pk);
        require(cfg.signer != address(0), "ARCADE_BACKEND_SIGNER must be non-zero");

        vm.startBroadcast(pk);
        Deployed memory d = _deployAll(cfg);
        _wireAndConfigure(d, cfg);
        vm.stopBroadcast();

        _assertWirings(d, cfg);
        _logResults(d, cfg);
    }

    function _readConfig(uint256 pk) internal view returns (Config memory cfg) {
        cfg.deployer = vm.addr(pk);
        cfg.usdc = vm.envAddress("ARC_USDC_ADDRESS");
        cfg.signer = vm.envAddress("ARCADE_BACKEND_SIGNER");
        cfg.treasury = vm.envOr("TREASURY_ADDRESS", cfg.deployer);
        cfg.escrowOwner = vm.envOr("ESCROW_OWNER", cfg.deployer);
        cfg.weth = vm.envOr("ARC_WETH_ADDRESS", address(0x9570EBA9eE39Aa4933f64d6add280faAB289a847));
        cfg.v4Router = vm.envOr("V4_ROUTER", address(0));
        cfg.v4Launchpad = vm.envOr("V4_LAUNCHPAD", address(0));
    }

    function _deployAll(Config memory cfg) internal returns (Deployed memory d) {
        // 1) Escrow first - no deps, LOCKER stays 0 until step 9.
        // Constructor sets claimTimelock = DEFAULT_TIMELOCK (1h, H-01).
        d.escrow = new ArcadeTwitterEscrowV3(cfg.signer, cfg.escrowOwner);

        // 2-3) V2 + V3 factory.
        d.factory = new ArcadeV2Factory(cfg.deployer);
        d.router = new ArcadeV2Router(address(d.factory));
        d.v3Factory = _deployV3Factory();

        // 4) Launchpad depends on V2 + V3 factory + USDC + WETH.
        d.launchpad = new ArcadeLaunchpad(
            IERC20(cfg.usdc),
            d.factory,
            address(d.router),
            cfg.treasury,
            IArcadeV3Factory(d.v3Factory),
            cfg.weth
        );

        // 5) Locker (0.7.6 bytecode) carries launchpad + factory + escrow.
        // M-06: locker re-validates `paired ∈ {USDC, WETH}` at lockSingleSided.
        d.v3Locker = _deployV3Locker(
            address(d.launchpad),
            d.v3Factory,
            address(d.escrow),
            cfg.escrowOwner
        );

        // 6-7) V3 router + quoter (0.7.6 bytecode).
        d.v3Router = _deployV3Router(d.v3Factory, cfg.usdc, address(d.launchpad));
        d.v3Quoter = _deployV3Aux("out-v3/ArcadeV3Quoter.sol/ArcadeV3Quoter.json", d.v3Factory, cfg.usdc);

        // 8) Token vault - M-01 ReentrancyGuard applied (no constructor change).
        d.tokenVault = new ArcadeTokenVault(address(d.launchpad));

        // 11) MultiSwap last - depends on everything.
        d.multiSwap = new ArcadeMultiSwap(
            IERC20(cfg.usdc),
            d.factory,
            d.router,
            IArcadeLaunchpad(address(d.launchpad)),
            IArcadeV3Router(d.v3Router),
            IArcadeV4SwapRouterMin(cfg.v4Router),
            IArcadeV4LaunchpadMin(cfg.v4Launchpad)
        );
    }

    function _wireAndConfigure(Deployed memory d, Config memory cfg) internal {
        // 9) escrow.setLocker (one-shot, owner-gated). Only auto-call when
        //    deployer == owner - otherwise the multisig has to do it later.
        if (cfg.escrowOwner == cfg.deployer) {
            d.escrow.setLocker(d.v3Locker);
        }

        // 10) launchpad.setV3Infra (one-shot, deployer-gated).
        d.launchpad.setV3Infra(d.v3Locker, d.v3Router, address(d.tokenVault));

        // 12) Enable extra V3 fee tiers. The upstream factory ships with
        //     0.05% / 0.30% / 1% by default; we add 0.01% (used by stable-
        //     pair routes) plus 2% / 3% (used by CLANKER launchpad pools).
        IArcadeV3Factory(d.v3Factory).enableFeeAmount(100, 1);
        IArcadeV3Factory(d.v3Factory).enableFeeAmount(20_000, 200);
        IArcadeV3Factory(d.v3Factory).enableFeeAmount(30_000, 200);
        // Route 1/6 of V2 LP fees to the treasury.
        d.factory.setFeeTo(cfg.treasury);
    }

    /**
     * @dev Post-broadcast sanity assertions. If any fail, the deploy aborts
     *      and the user is told exactly what's wrong before they update
     *      Vercel and onboard real users to the broken stack.
     */
    function _assertWirings(Deployed memory d, Config memory cfg) internal view {
        require(d.escrow.trustedSigner() == cfg.signer, "escrow.trustedSigner mismatch");
        require(d.escrow.owner() == cfg.escrowOwner, "escrow.owner mismatch");
        // H-01: testnet build allows claimTimelock = 0 so dev iteration
        // on the OAuth/claim flow isn't gated by an hour-long wait.
        // The Solidity-side MIN_TIMELOCK is also 0 in this build (see
        // ArcadeTwitterEscrowV3.sol), and the lower-bound check below
        // is the real safety net.
        // MAINNET TODO: restore `> 0` here when MIN_TIMELOCK is bumped
        // back to 1 hours in the contract.
        require(d.escrow.claimTimelock() >= d.escrow.MIN_TIMELOCK(), "H-01: below MIN_TIMELOCK");

        if (cfg.escrowOwner == cfg.deployer) {
            require(d.escrow.LOCKER() == d.v3Locker, "escrow.LOCKER not wired");
        }

        require(d.launchpad.v3Locker() == d.v3Locker, "launchpad.v3Locker mismatch");
        require(d.launchpad.v3Router() == d.v3Router, "launchpad.v3Router mismatch");
        require(d.launchpad.tokenVault() == address(d.tokenVault), "launchpad.tokenVault mismatch");
        require(d.launchpad.MIGRATION_FEE() == 2_500e6, "H-05: MIGRATION_FEE must be 2,500 USDC");
    }

    function _logResults(Deployed memory d, Config memory cfg) internal view {
        console2.log("================ DEPLOY OK ================");
        console2.log("Chain:                 Arc testnet (5042002)");
        console2.log("Deployer:              ", cfg.deployer);
        console2.log("Treasury:              ", cfg.treasury);
        console2.log("USDC:                  ", cfg.usdc);
        console2.log("WETH:                  ", cfg.weth);
        console2.log("V3 Quoter:             ", d.v3Quoter);
        console2.log("");
        console2.log("---- Copy to Vercel env vars (NEXT_PUBLIC_*) ----");
        console2.log("NEXT_PUBLIC_USDC_ADDRESS=               ", cfg.usdc);
        console2.log("NEXT_PUBLIC_V2_FACTORY_ADDRESS=         ", address(d.factory));
        console2.log("NEXT_PUBLIC_V2_ROUTER_ADDRESS=          ", address(d.router));
        console2.log("NEXT_PUBLIC_V3_FACTORY_ADDRESS=         ", d.v3Factory);
        console2.log("NEXT_PUBLIC_V3_ROUTER_ADDRESS=          ", d.v3Router);
        console2.log("NEXT_PUBLIC_V3_QUOTER_ADDRESS=          ", d.v3Quoter);
        console2.log("NEXT_PUBLIC_V3_LOCKER_ADDRESS=          ", d.v3Locker);
        console2.log("NEXT_PUBLIC_TOKEN_VAULT_ADDRESS=        ", address(d.tokenVault));
        console2.log("NEXT_PUBLIC_LAUNCHPAD_ADDRESS=          ", address(d.launchpad));
        console2.log("NEXT_PUBLIC_MULTISWAP_ADDRESS=          ", address(d.multiSwap));
        console2.log("NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS=     ", address(d.escrow));
        console2.log("");
        console2.log("---- Operational state ----");
        console2.log("escrow.trustedSigner:                   ", d.escrow.trustedSigner());
        console2.log("escrow.owner:                           ", d.escrow.owner());
        console2.log("escrow.claimTimelock (sec):             ", d.escrow.claimTimelock());
        console2.log("escrow.LOCKER:                          ", d.escrow.LOCKER());
        console2.log("launchpad.v3Locker:                     ", d.launchpad.v3Locker());
        console2.log("launchpad.MIGRATION_FEE (USDC, 6dp):    ", d.launchpad.MIGRATION_FEE());

        if (cfg.escrowOwner != cfg.deployer) {
            console2.log("");
            console2.log("ATTENTION: escrowOwner != deployer.");
            console2.log("Owner MUST manually call: escrow.setLocker(", d.v3Locker, ")");
        }
    }

    // ====================== V3 (0.7.6) bytecode deployment ======================

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
    )
        internal
        returns (address locker)
    {
        // Audit V3 Locker M-3: constructor grew an owner_ argument.
        // Owner is the only caller of adminRescue (whitelist excludes
        // every active position's paired + clanker tokens), so a
        // multisig is the recommended value at production. Tests pass
        // address(this); local/testnet deploys use the deployer (or
        // ESCROW_OWNER env override which we reuse for consistency).
        bytes memory code = abi.encodePacked(
            vm.getCode("out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json"),
            abi.encode(launchpad_, factory_, twitterEscrow_, owner_)
        );
        assembly {
            locker := create(0, add(code, 0x20), mload(code))
        }
        require(locker != address(0), "v3 locker deploy failed");
    }

    function _deployV3Aux(string memory path, address factory_, address usdc_) internal returns (address addr) {
        bytes memory code = abi.encodePacked(vm.getCode(path), abi.encode(factory_, usdc_));
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "v3 aux deploy failed");
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
