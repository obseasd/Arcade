// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ArcadeHook} from "../v4src/ArcadeHook.sol";
import {ArcadeV4SwapRouter} from "../v4src/ArcadeV4SwapRouter.sol";
import {LockedVault} from "../v4src/LockedVault.sol";

// Upstream v4-core.
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";

// Upstream v4-periphery lens contracts. Used by the frontend / ArcLens indexer
// to query pool state cheaply.
import {StateView} from "v4-periphery/lens/StateView.sol";
import {V4Quoter} from "v4-periphery/lens/V4Quoter.sol";

/**
 * @title DeployV4
 * @notice Full V4 deploy targeting ArcadeHook (Phase 2). Replaces the earlier
 *         AntiSniper-only prototype script (`feat(v4)` series Jun 2026).
 *
 *         The bitmap baked into the mined hook address MUST match
 *         ArcadeHook.getHookPermissions() exactly: 10 bits set =
 *         BEFORE_INIT + AFTER_INIT + BEFORE_ADD + AFTER_ADD +
 *         BEFORE_REMOVE + BEFORE_SWAP + AFTER_SWAP +
 *         BEFORE_SWAP_RETURNS_DELTA + AFTER_SWAP_RETURNS_DELTA +
 *         AFTER_ADD_LIQUIDITY_RETURNS_DELTA, hex = 0x3ECE.
 *
 *         Search depth: 1 / 2^10 of addresses match, so 200k attempts gives a
 *         ~99.9999% chance of finding one and leaves a large safety margin.
 *
 *         Required env:
 *           PRIVATE_KEY            deployer key, funded with the chain's gas
 *           ARC_USDC_ADDRESS       canonical USDC ERC20 on the target chain
 *
 *         Optional env:
 *           TREASURY_ADDRESS       fee + skim recipient    (defaults: deployer)
 *           TWITTER_ESCROW_ADDRESS escrow for creator fees (defaults: zero)
 *           OWNER_ADDRESS          Ownable2Step initial owner (defaults: deployer)
 *           POOL_MANAGER           reuse an existing PoolManager  (defaults: deploy fresh)
 *           LOCKED_VAULT           reuse an existing LockedVault  (defaults: deploy fresh)
 *
 *         Mainnet usage:
 *           FOUNDRY_PROFILE=v4 \
 *           PRIVATE_KEY=0x... \
 *           ARC_USDC_ADDRESS=0x... \
 *           TREASURY_ADDRESS=0x... \
 *           TWITTER_ESCROW_ADDRESS=0x... \
 *           OWNER_ADDRESS=0xMultisig... \
 *           forge script v4script/DeployV4.s.sol \
 *               --rpc-url arc_mainnet --broadcast --verify
 *
 *         Testnet usage (Arc testnet, defaults):
 *           FOUNDRY_PROFILE=v4 \
 *           PRIVATE_KEY=0x... \
 *           ARC_USDC_ADDRESS=0x... \
 *           forge script v4script/DeployV4.s.sol \
 *               --rpc-url arc_testnet --broadcast
 *
 *         Post-deploy checklist (manual):
 *           - Verify the hook on the block explorer with the constructor args
 *             printed below.
 *           - Wire frontend `ADDRESSES.arcadeHook` and `ADDRESSES.lockedVault`.
 *           - If TWITTER_ESCROW_ADDRESS was zero, call escrow.authorise(hook)
 *             when the escrow is deployed and `hook.setTwitterEscrow(escrow)`
 *             on the hook side.
 *           - Update DeployV4 frontend log: `web/lib/constants.ts`.
 */
contract DeployV4 is Script {
    // Permission bitmap mining: search the salt space for a CREATE2 address
    // whose low 14 bits encode exactly the ArcadeHook permission set.
    uint160 internal constant PERM_MASK = (1 << 14) - 1;
    /// @dev Matches `ArcadeHook.getHookPermissions()` byte-for-byte. If the
    ///      hook flag set ever changes, regenerate this constant from
    ///      `ArcadeHook.getHookPermissions()` and re-mine.
    uint160 internal constant TARGET_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG;
    uint256 internal constant MAX_ATTEMPTS = 500_000;

    /// @notice Arc mainnet. On this chain a canonical Uniswap V4 PoolManager
    ///         already exists; deploying our own would fragment liquidity and
    ///         be invisible to Uniswap's interface + aggregators.
    uint256 internal constant ARC_MAINNET_CHAINID = 5042;

    /// @notice Foundry routes `new Contract{salt: s}(...)` through this
    ///         canonical deterministic deployer rather than msg.sender. We
    ///         must use this address (not vm.addr(pk)) when predicting the
    ///         CREATE2 result or salt-mining produces a salt whose actual
    ///         deploy address does not match the prediction (Phase 2 Round 5+
    ///         field-bug discovered on Arc testnet, Jun 2026).
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        // 1. Resolve env.
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address usdc = vm.envAddress("ARC_USDC_ADDRESS");
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);
        address twitterEscrow = vm.envOr("TWITTER_ESCROW_ADDRESS", address(0));
        address owner = vm.envOr("OWNER_ADDRESS", deployer);
        address existingPM = vm.envOr("POOL_MANAGER", address(0));
        address existingVault = vm.envOr("LOCKED_VAULT", address(0));

        require(usdc != address(0), "ARC_USDC_ADDRESS required");

        // Compile-time invariant check: the bitmap MUST match what the hook
        // claims via getHookPermissions(). A mismatch here would mine an
        // address that the PoolManager rejects on every callback.
        require(TARGET_FLAGS == 0x3ECE, "TARGET_FLAGS drift from 0x3ECE");

        vm.startBroadcast(pk);

        // 2. PoolManager: reuse if provided, otherwise deploy fresh. Arc
        //    MAINNET hosts a CANONICAL PoolManager
        //    (0x8366a39cc670b4001a1121b8f6a443a643e40951); deploying our own
        //    there would produce a private pool invisible to Uniswap's
        //    interface and every aggregator, with fragmented liquidity. Guard
        //    against forgetting the env var on mainnet.
        PoolManager pm;
        if (existingPM == address(0)) {
            require(
                block.chainid != ARC_MAINNET_CHAINID,
                "POOL_MANAGER env required on Arc mainnet (use the canonical PoolManager, do not deploy a private one)"
            );
            pm = new PoolManager(owner);
            console2.log("PoolManager (new):", address(pm));
        } else {
            // A typo'd address would deploy a hook wired to nothing. Refuse a
            // codeless "PoolManager".
            require(existingPM.code.length > 0, "POOL_MANAGER has no code");
            pm = PoolManager(existingPM);
            console2.log("PoolManager (existing):", address(pm));
        }
        address poolManager = address(pm);

        // 3. LockedVault: immutable recipient for ERC-6909 LP claims. One
        //    vault can host claims from many ArcadeHook deployments; we
        //    reuse if the caller specifies one.
        LockedVault vault;
        if (existingVault == address(0)) {
            vault = new LockedVault();
            console2.log("LockedVault (new):", address(vault));
        } else {
            vault = LockedVault(existingVault);
            console2.log("LockedVault (existing):", address(vault));
        }

        // 4. Mine a CREATE2 salt so the deployed hook address encodes the
        //    permission bitmap. The hook constructor bakes in its
        //    dependencies, so the creation-code hash depends on EVERYTHING
        //    we resolved above.
        bytes memory hookCreationCode = abi.encodePacked(
            type(ArcadeHook).creationCode,
            abi.encode(
                IPoolManager(poolManager), Currency.wrap(usdc), address(vault), treasury, twitterEscrow, owner
            )
        );
        bytes32 codeHash = keccak256(hookCreationCode);

        bytes32 salt;
        address predicted;
        uint256 attempts;
        for (uint256 i = 0; i < MAX_ATTEMPTS; ++i) {
            bytes32 s = bytes32(i);
            // CREATE2_DEPLOYER not deployer: foundry routes the
            // `new ArcadeHook{salt: s}(...)` through the canonical
            // deterministic deployer.
            address a = vm.computeCreate2Address(s, codeHash, CREATE2_DEPLOYER);
            if (uint160(a) & PERM_MASK == TARGET_FLAGS) {
                salt = s;
                predicted = a;
                attempts = i;
                break;
            }
        }
        require(predicted != address(0), "salt-mining exhausted MAX_ATTEMPTS");

        // 5. Deploy ArcadeHook at the mined CREATE2 address.
        ArcadeHook hook = new ArcadeHook{salt: salt}(
            IPoolManager(poolManager), Currency.wrap(usdc), address(vault), treasury, twitterEscrow, owner
        );
        require(address(hook) == predicted, "deployed hook != predicted");
        // REAL drift guard (the `TARGET_FLAGS == 0x3ECE` require above is a
        // tautology). ArcadeHook skips Hooks.validateHookAddress, so nothing
        // ELSE enforces that the mined address bits equal the permissions the
        // hook actually declares. Assert both here so a getHookPermissions()
        // edit that isn't mirrored into TARGET_FLAGS fails the deploy instead
        // of silently shipping a hook the PoolManager mis-dispatches (a missing
        // *_RETURNS_DELTA bit = the fee/skim silently does nothing).
        require(hook.getHookPermissions() == TARGET_FLAGS, "hook perms != TARGET_FLAGS");
        require(uint160(address(hook)) & PERM_MASK == TARGET_FLAGS, "hook addr bits != TARGET_FLAGS");

        // 6. Lens contracts. StateView + V4Quoter are the read-side primitives
        //    the frontend and the ArcLens Ponder schema use. They are stateless
        //    and depend only on the PoolManager address, so one set of lenses
        //    serves every hook deployed against a given PoolManager.
        StateView stateView = new StateView(IPoolManager(poolManager));
        V4Quoter quoter = new V4Quoter(IPoolManager(poolManager));

        // 7. Thin EOA -> PoolManager swap router. Existing helper from the
        //    prototype, reused unchanged because the V4 swap surface itself
        //    is hook-agnostic at this layer.
        ArcadeV4SwapRouter swapRouter = new ArcadeV4SwapRouter(IPoolManager(poolManager));

        vm.stopBroadcast();

        // 8. Print full deploy summary so the operator can verify + copy into
        //    the frontend's web/lib/constants.ts.
        console2.log("=========================================");
        console2.log("Arcade V4 deploy complete");
        console2.log("=========================================");
        console2.log("Deployer:           ", deployer);
        console2.log("USDC:               ", usdc);
        console2.log("Treasury:           ", treasury);
        console2.log("TwitterEscrow:      ", twitterEscrow);
        console2.log("Owner:              ", owner);
        console2.log("PoolManager:        ", poolManager);
        console2.log("LockedVault:        ", address(vault));
        console2.log("ArcadeHook:         ", address(hook));
        console2.log("StateView (lens):   ", address(stateView));
        console2.log("V4Quoter (lens):    ", address(quoter));
        console2.log("V4SwapRouter:       ", address(swapRouter));
        console2.log("Hook salt (uint):   ", uint256(salt));
        console2.log("Salt attempts:      ", attempts);
        console2.log("Hook perm bitmap:   0x3ECE");
        console2.log("=========================================");
        console2.log("Frontend wiring:");
        console2.log("  ADDRESSES.arcadeHook   =", address(hook));
        console2.log("  ADDRESSES.lockedVault  =", address(vault));
        console2.log("  ADDRESSES.v4PoolManager=", poolManager);
        console2.log("  ADDRESSES.v4StateView  =", address(stateView));
        console2.log("  ADDRESSES.v4Quoter     =", address(quoter));
        console2.log("  ADDRESSES.v4SwapRouter =", address(swapRouter));
        console2.log("=========================================");
    }
}
