// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ArcadeV4Launchpad} from "../v4src/ArcadeV4Launchpad.sol";
import {ArcadeAntiSniperHook} from "../v4src/ArcadeAntiSniperHook.sol";
import {ArcadeV4SwapRouter} from "../v4src/ArcadeV4SwapRouter.sol";
import {ILaunchpadSnipe} from "../v4src/interfaces/IArcadeV4Launchpad.sol";

// Upstream v4-core.
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

// Upstream v4-periphery lens contracts (used by the indexer + UI).
import {StateView} from "v4-periphery/lens/StateView.sol";
import {V4Quoter} from "v4-periphery/lens/V4Quoter.sol";

/**
 * @title DeployV4
 * @notice Full-stack V4 deploy for Arc testnet (or any chain without a
 *         canonical Uniswap V4 deployment).
 *
 *         Steps:
 *           1. Deploy `PoolManager`.
 *           2. Deploy our `ArcadeV4Launchpad` (HOOK = 0 placeholder).
 *           3. CREATE2-mine + deploy the anti-sniper hook so its address
 *              encodes BEFORE_SWAP + AFTER_SWAP permission bits.
 *           4. Call `launchpad.setHook(hookAddr)` to lock the wiring.
 *           5. Deploy `StateView` and `V4Quoter` lens contracts for the
 *              frontend / indexer.
 *
 *         NOT deployed here:
 *           - `PositionManager` (v4-periphery) - we don't need it because
 *             the launchpad owns 100 % of the LP position via its unlock
 *             callback and never transfers it.
 *           - `Permit2` - same reason.
 *           - `V4Router` / `UniversalRouter` - the frontend can either go
 *             direct to `PoolManager.swap` via our own thin router (TODO)
 *             or use V4Router once Uniswap ships it on Arc.
 *
 *         Required env:
 *           PRIVATE_KEY       = deployer key, funded with USDC for gas.
 *           ARC_USDC_ADDRESS  = real USDC ERC20 on the target chain.
 *           TREASURY_ADDRESS  = receives creation fees + hook skims (defaults
 *                               to deployer).
 *           POOL_MANAGER      = OPTIONAL pre-existing PoolManager. If set,
 *                               step 1 is skipped and we wire everything else
 *                               to this address. Useful for redeploying just
 *                               the Arcade contracts against an existing V4.
 *
 *         Usage:
 *           FOUNDRY_PROFILE=v4 \
 *           PRIVATE_KEY=0x... \
 *           ARC_USDC_ADDRESS=0x... \
 *           TREASURY_ADDRESS=0x... \
 *           forge script v4script/DeployV4.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployV4 is Script {
    uint160 internal constant PERM_MASK = (1 << 14) - 1;
    /// @dev Matches `ArcadeAntiSniperHook.getHookPermissions()`. RETURNS_DELTA
    ///      bits are mandatory - without them the pool manager discards the
    ///      delta we return after pm.take, leaving an unsettled hook delta
    ///      that DOSes every taxed swap.
    uint160 internal constant TARGET_FLAGS = Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    uint256 internal constant MAX_ATTEMPTS = 200_000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address existingPM = vm.envOr("POOL_MANAGER", address(0));

        require(usdc != address(0), "ARC_USDC_ADDRESS must be set");

        vm.startBroadcast(pk);

        // Step 1: PoolManager. Either reuse an existing one or deploy fresh.
        PoolManager pm;
        if (existingPM == address(0)) {
            pm = new PoolManager(deployer);
        } else {
            pm = PoolManager(existingPM);
        }
        address poolManager = address(pm);

        // Step 2: launchpad with HOOK = 0.
        ArcadeV4Launchpad launchpad = new ArcadeV4Launchpad(
            IERC20(usdc),
            IPoolManager(poolManager),
            treasury
        );

        // Step 3: mine a salt so the hook CREATE2 address has the right
        // permission bits. The hook constructor's bytecode includes the
        // launchpad address, so codeHash depends on the launchpad we just
        // deployed.
        bytes memory hookCreationCode = abi.encodePacked(
            type(ArcadeAntiSniperHook).creationCode,
            abi.encode(
                IPoolManager(poolManager),
                ILaunchpadSnipe(address(launchpad)),
                Currency.wrap(usdc),
                treasury
            )
        );
        bytes32 codeHash = keccak256(hookCreationCode);

        bytes32 salt;
        address predicted;
        uint256 attempts;
        for (uint256 i = 0; i < MAX_ATTEMPTS; ++i) {
            bytes32 s = bytes32(i);
            address a = vm.computeCreate2Address(s, codeHash, deployer);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                salt = s;
                predicted = a;
                attempts = i;
                break;
            }
        }
        require(predicted != address(0), "salt-mining exhausted MAX_ATTEMPTS");

        ArcadeAntiSniperHook hook = new ArcadeAntiSniperHook{salt: salt}(
            IPoolManager(poolManager),
            ILaunchpadSnipe(address(launchpad)),
            Currency.wrap(usdc),
            treasury
        );
        require(address(hook) == predicted, "deployed hook addr != predicted");

        // Step 4: lock the wiring.
        launchpad.setHook(address(hook));

        // Step 5: lens contracts + thin swap router.
        StateView stateView = new StateView(IPoolManager(poolManager));
        V4Quoter quoter = new V4Quoter(IPoolManager(poolManager));
        ArcadeV4SwapRouter swapRouter = new ArcadeV4SwapRouter(IPoolManager(poolManager));

        vm.stopBroadcast();

        console2.log("Chain:           V4 testnet");
        console2.log("Deployer:        ", deployer);
        console2.log("USDC:            ", usdc);
        console2.log("Treasury:        ", treasury);
        console2.log("PoolManager:     ", poolManager);
        console2.log("Launchpad:       ", address(launchpad));
        console2.log("Hook:            ", address(hook));
        console2.log("StateView:       ", address(stateView));
        console2.log("V4Quoter:        ", address(quoter));
        console2.log("V4SwapRouter:    ", address(swapRouter));
        console2.log("Hook salt (uint):", uint256(salt));
        console2.log("Salt attempts:   ", attempts);
    }
}
