// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {ArcadeV4Curve} from "./ArcadeV4Curve.sol";
import {ArcadeV4Math} from "./ArcadeV4Math.sol";
import {ArcadeHook, IArcadeTwitterEscrowV3Min} from "../ArcadeHook.sol";

/// @title ArcadeHookLib
/// @notice EXTERNAL library carrying the ArcadeHook fee-routing + LP
///         seeding/settlement code so the immutable ArcadeHook stays under the
///         EIP-170 24576-byte deploy limit (Arc enforces it). Deployed once and
///         delegatecalled: because a Solidity `public`/`external` library
///         function invoked on the caller's storage runs via DELEGATECALL,
///         `address(this)`, `msg.sender` and the whole storage layout stay the
///         HOOK's inside these functions. Storage mappings are passed by
///         reference (slot pointers) so the moved code reads/writes exactly the
///         hook state it did when inlined. Every function is a faithful,
///         behaviour-preserving move of what used to live in ArcadeHook.sol
///         (verified by the unchanged v4 test suite).
///
/// @dev    Events are re-declared here so they are emitted (from the hook's
///         address, under delegatecall) with byte-identical topics/data.
library ArcadeHookLib {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    /// @dev Mirrors ArcadeHook.POST_GRAD_CREATOR_BPS (80% creator / 20% treasury).
    uint16 internal constant POST_GRAD_CREATOR_BPS = 8_000;

    // --- Events (mirrors of ArcadeHook's; emitted from the hook via delegatecall) ---
    event RoyaltyPaid(
        PoolId indexed poolId,
        address indexed creator,
        uint256 creatorAmount,
        uint256 treasuryAmount,
        address currency
    );
    event AntiSnipeApplied(PoolId indexed poolId, address indexed sniper, uint256 amount, uint16 bps);
    event EscrowCreditFailed(uint256 indexed positionId, uint8 slot, uint256 amount);
    event FeeHarvested(bytes32 indexed positionKey, uint256 amount0, uint256 amount1);
    event TokenCredited(address indexed token, address indexed recipient, uint256 amount);
    event Graduated(PoolId indexed poolId, uint256 finalUsdcReserve, uint256 tokensInLP);

    error ZeroAmount();

    // -------------------------------------------------------------------
    // Internal money-movement helpers (inlined into the public entrypoints)
    // -------------------------------------------------------------------

    /// @dev Best-effort PoolManager.take. If the recipient rejects the transfer
    ///      the funds are taken to the hook instead and credited as a pending
    ///      pull-payment. CSEC-001.
    function _safeTake(
        IPoolManager pm,
        mapping(address => mapping(address => uint256)) storage pending,
        Currency currency,
        address to,
        uint256 amount
    ) internal {
        if (amount == 0 || to == address(0)) return;
        try pm.take(currency, to, amount) {
            return;
        } catch {
            // Fall through: take to the hook, credit the recipient.
        }
        pm.take(currency, address(this), amount);
        address tokenAddr = Currency.unwrap(currency);
        pending[tokenAddr][to] += amount;
        emit TokenCredited(tokenAddr, to, amount);
    }

    /// @dev Pay `amount` of `currency` to the PoolManager, balancing a
    ///      modifyLiquidity delta.
    function _settleSide(IPoolManager pm, Currency currency, uint256 amount) internal {
        if (amount == 0) return;
        pm.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(pm), amount);
        pm.settle();
    }

    /// @dev The pool's current "mcap tick": slot0 tick sign-normalised so it
    ///      RISES with market cap regardless of USDC's currency ordering.
    function _mcapTick(IPoolManager pm, PoolId poolId, bool usdcIsCurrency0) internal view returns (int24) {
        (, int24 tick,,) = pm.getSlot0(poolId);
        return usdcIsCurrency0 ? -tick : tick;
    }

    /// @dev Canonical PoolKey for a launch. Sorts currencies (v4 invariant), sets
    ///      the hook to this contract, fee = the stored per-token pool fee.
    function _buildKey(Currency usdc, uint24 poolFee, address launchToken)
        internal
        view
        returns (PoolKey memory key)
    {
        address usdcAddr = Currency.unwrap(usdc);
        (Currency c0, Currency c1) = usdcAddr < launchToken
            ? (usdc, Currency.wrap(launchToken))
            : (Currency.wrap(launchToken), usdc);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: poolFee,
            tickSpacing: 200,
            hooks: IHooks(address(this))
        });
    }

    // -------------------------------------------------------------------
    // Fee routing (called from before/afterSwap and the CLANKER harvest)
    // -------------------------------------------------------------------

    /// @dev Route anti-sniper auction proceeds to the launch CREATOR. No-op when
    ///      the skim is zero. Blocklist-safe via _safeTake.
    function payAntiSnipe(
        IPoolManager pm,
        mapping(PoolId => ArcadeHook.FeeOwner) storage feeOwners,
        mapping(address => mapping(address => uint256)) storage pending,
        PoolId poolId,
        Currency currency,
        uint256 snipeSkim,
        uint256 amount
    ) public {
        if (snipeSkim == 0) return;
        _safeTake(pm, pending, currency, feeOwners[poolId].creator, snipeSkim);
        emit AntiSnipeApplied(poolId, msg.sender, snipeSkim, uint16((snipeSkim * 10_000) / amount));
    }

    /// @dev Split `fee` (already computed, in `feeCurrency`) 80/20 creator/treasury
    ///      and route it via _safeTake. The creator cut flows through the optional
    ///      creator2 split (CLANKER only) and the Twitter-escrow slot when wired,
    ///      falling back to a direct creator take if the escrow reverts. Every
    ///      take is blocklist-safe (CSEC-001). `allowEscrow` gates the escrow
    ///      route (true for USDC fees, false for a CLANKER collect's token side).
    function distributeFee(
        IPoolManager pm,
        mapping(PoolId => ArcadeHook.FeeOwner) storage feeOwners,
        mapping(address => mapping(address => uint256)) storage pending,
        address treasury,
        PoolId poolId,
        Currency feeCurrency,
        uint256 fee,
        uint8 mode,
        bool allowEscrow
    ) public {
        if (fee == 0) return;
        ArcadeHook.FeeOwner memory fo = feeOwners[poolId];
        uint256 creatorCut = (fee * POST_GRAD_CREATOR_BPS) / 10_000;
        uint256 treasuryCut = fee - creatorCut;

        // Optional creator2 split (CLANKER only, when configured).
        if (fo.creator2 != address(0) && fo.creator2Bps > 0 && mode == uint8(1)) {
            uint256 creator2Cut = (creatorCut * fo.creator2Bps) / 10_000;
            if (creator2Cut > 0) {
                _safeTake(pm, pending, feeCurrency, fo.creator2, creator2Cut);
                creatorCut -= creator2Cut;
            }
        }

        // Route the creator cut. Twitter-escrow slot if the launch attributed
        // fees to a handle (USDC only), else direct to the creator.
        if (creatorCut > 0) {
            if (allowEscrow && fo.twitterEscrow != address(0)) {
                address feeTokenAddr = Currency.unwrap(feeCurrency);
                uint256 positionId = uint256(PoolId.unwrap(poolId));
                // Deliver the USDC to the escrow FIRST, then credit the slot.
                _safeTake(pm, pending, feeCurrency, fo.twitterEscrow, creatorCut);
                try IArcadeTwitterEscrowV3Min(fo.twitterEscrow).creditSlot(
                    positionId, fo.slotIndex, feeTokenAddr, creatorCut
                ) {
                    // credited to the handle slot
                } catch {
                    emit EscrowCreditFailed(positionId, fo.slotIndex, creatorCut);
                }
            } else {
                _safeTake(pm, pending, feeCurrency, fo.creator, creatorCut);
            }
        }
        if (treasuryCut > 0) _safeTake(pm, pending, feeCurrency, treasury, treasuryCut);

        emit RoyaltyPaid(poolId, fo.creator, creatorCut, treasuryCut, Currency.unwrap(feeCurrency));
    }

    /// @dev Best-effort USDC payout from the hook's own balance (curve fee /
    ///      migration fee path). Credits a pending pull if the transfer fails.
    function safePayUsdc(
        Currency usdc,
        mapping(address => mapping(address => uint256)) storage pending,
        address to,
        uint256 amount
    ) public {
        if (amount == 0 || to == address(0)) return;
        address usdcAddr = Currency.unwrap(usdc);
        try IERC20(usdcAddr).transfer(to, amount) returns (bool ok) {
            if (ok) return;
        } catch {
            // fall through to credit
        }
        pending[usdcAddr][to] += amount;
        emit TokenCredited(usdcAddr, to, amount);
    }

    // -------------------------------------------------------------------
    // LP seeding / graduation / settlement
    // -------------------------------------------------------------------

    /// @dev CLANKER direct launch: initialise the V4 pool at the starting market
    ///      cap and seed the FULL supply as a SINGLE-SIDED locked position.
    function launchDirect(
        IPoolManager pm,
        Currency usdc,
        mapping(address => ArcadeHook.ClankerPos) storage clankerPos,
        address token,
        PoolKey memory key,
        PoolId poolId,
        uint256 startMcap
    ) public {
        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(usdc);
        uint256 supply = ArcadeV4Curve.TOTAL_SUPPLY;

        (uint256 amount0, uint256 amount1) = usdcIsCurrency0 ? (startMcap, supply) : (supply, startMcap);
        uint160 startSqrt = ArcadeV4Math.sqrtPriceX96FromAmounts(amount0, amount1);
        pm.initialize(key, startSqrt);

        int24 spacing = key.tickSpacing;
        int24 aligned = ArcadeV4Math.seedEdgeTick(startSqrt, spacing, usdcIsCurrency0);
        (int24 minT, int24 maxT) = ArcadeV4Math.fullRange(spacing);

        uint64 nowTs = uint64(block.timestamp);
        if (usdcIsCurrency0) {
            clankerPos[token] =
                ArcadeHook.ClankerPos({tickLower: minT, tickUpper: aligned, seeded: true, launchedAt: nowTs});
        } else {
            clankerPos[token] =
                ArcadeHook.ClankerPos({tickLower: aligned, tickUpper: maxT, seeded: true, launchedAt: nowTs});
        }

        pm.unlock(abi.encode(uint8(1), token, supply, uint256(0), aligned));

        emit Graduated(poolId, 0, supply);
    }

    /// @dev Atomic curve -> AMM migration. Frozen sequence per V4_HOOK_SPEC.md
    ///      Section 5. `state` and `key` come from the calling hook (the curve
    ///      buy that filled the curve); the mappings are the hook's own storage.
    function graduate(
        IPoolManager pm,
        Currency usdc,
        address treasury,
        mapping(address => mapping(address => uint256)) storage pending,
        mapping(PoolId => ArcadeHook.FeeObs) storage feeObs,
        mapping(address => ArcadeHook.SnipeConfig) storage snipeConfigs,
        ArcadeHook.CurveState storage state,
        PoolKey memory key,
        address token
    ) public {
        state.status = uint8(1); // GraduationStarted

        uint256 totalUsdc = state.realUsdcReserve;
        uint256 lpUsdc = ArcadeV4Curve.graduationLiquidityUsdc(totalUsdc);
        if (lpUsdc == 0) revert ZeroAmount();
        uint256 lpTokens = ArcadeV4Curve.MIGRATION_LP_TOKENS;

        // Migration fee off the top -> treasury (pull-payment safe).
        safePayUsdc(usdc, pending, treasury, ArcadeV4Curve.MIGRATION_FEE);

        bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(usdc);
        (uint256 amount0, uint256 amount1) = usdcIsCurrency0 ? (lpUsdc, lpTokens) : (lpTokens, lpUsdc);

        uint160 sqrtPriceX96 = ArcadeV4Math.sqrtPriceX96FromAmounts(amount0, amount1);
        pm.initialize(key, sqrtPriceX96);

        pm.unlock(abi.encode(uint8(0), token, amount0, amount1, int24(0)));

        state.status = uint8(2); // Graduated

        // Start the anti-sniper decay clock NOW (only if a config exists).
        if (snipeConfigs[token].startBps > 0) {
            snipeConfigs[token].launchedAt = uint64(block.timestamp);
        }

        // Seed the PUMP fee oracle at the graduation price.
        PoolId pid = key.toId();
        int24 gmt = _mcapTick(pm, pid, usdcIsCurrency0);
        feeObs[pid] = ArcadeHook.FeeObs({
            emaTickE3: int64(int256(gmt) * 1_000),
            gradMcapTick: gmt,
            lastTs: uint32(block.timestamp),
            init: true
        });

        emit Graduated(pid, totalUsdc, lpTokens);
    }

    /// @dev The IUnlockCallback body. `kind` selects graduation (0), CLANKER
    ///      single-sided seed (1) or CLANKER fee harvest (2). Runs under
    ///      delegatecall so `address(this)` is the hook that PoolManager unlocked.
    function unlockCallback(
        IPoolManager pm,
        Currency usdc,
        address treasury,
        bytes calldata data,
        mapping(address => ArcadeHook.ClankerPos) storage clankerPos,
        mapping(PoolId => ArcadeHook.CurveState) storage curveStates,
        mapping(PoolId => ArcadeHook.FeeOwner) storage feeOwners,
        mapping(address => uint24) storage poolFeeOf,
        mapping(address => mapping(address => uint256)) storage pending
    ) public returns (bytes memory) {
        (uint8 kind, address token, uint256 amount0, uint256 amount1, int24 startTick) =
            abi.decode(data, (uint8, address, uint256, uint256, int24));

        PoolKey memory key = _buildKey(usdc, poolFeeOf[token], token);
        int24 spacing = key.tickSpacing;

        // kind 2 = CLANKER fee harvest.
        if (kind == 2) {
            ArcadeHook.ClankerPos memory pos = clankerPos[token];
            (, BalanceDelta feesAccrued) = pm.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: pos.tickLower,
                    tickUpper: pos.tickUpper,
                    liquidityDelta: 0,
                    salt: bytes32(0)
                }),
                ""
            );
            PoolId poolId = key.toId();
            uint8 mode = curveStates[poolId].mode;
            bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(usdc);
            uint256 fee0 = feesAccrued.amount0() > 0 ? uint256(uint128(feesAccrued.amount0())) : 0;
            uint256 fee1 = feesAccrued.amount1() > 0 ? uint256(uint128(feesAccrued.amount1())) : 0;
            if (usdcIsCurrency0) {
                distributeFee(pm, feeOwners, pending, treasury, poolId, key.currency0, fee0, mode, true); // USDC
                distributeFee(pm, feeOwners, pending, treasury, poolId, key.currency1, fee1, mode, false); // token
            } else {
                distributeFee(pm, feeOwners, pending, treasury, poolId, key.currency0, fee0, mode, false); // token
                distributeFee(pm, feeOwners, pending, treasury, poolId, key.currency1, fee1, mode, true); // USDC
            }
            emit FeeHarvested(PoolId.unwrap(poolId), fee0, fee1);
            return "";
        }

        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;

        if (kind == 0) {
            // Graduation: full-range two-sided position at the reserve ratio.
            (tickLower, tickUpper) = ArcadeV4Math.fullRange(spacing);
            uint160 sqrtPriceX96 = ArcadeV4Math.sqrtPriceX96FromAmounts(amount0, amount1);
            liquidity = ArcadeV4Math.liquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1);
        } else {
            // CLANKER direct: SINGLE-SIDED position of the full supply (amount0).
            bool usdcIsCurrency0 = Currency.unwrap(key.currency0) == Currency.unwrap(usdc);
            uint256 supply = amount0;
            (int24 minT, int24 maxT) = ArcadeV4Math.fullRange(spacing);
            if (usdcIsCurrency0) {
                tickLower = minT;
                tickUpper = startTick;
                liquidity = ArcadeV4Math.liquidityForAmount1(tickLower, tickUpper, supply);
            } else {
                tickLower = startTick;
                tickUpper = maxT;
                liquidity = ArcadeV4Math.liquidityForAmount0(tickLower, tickUpper, supply);
            }
        }

        (BalanceDelta callerDelta,) = pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        int128 d0 = callerDelta.amount0();
        int128 d1 = callerDelta.amount1();
        if (d0 < 0) _settleSide(pm, key.currency0, uint256(uint128(-d0)));
        if (d1 < 0) _settleSide(pm, key.currency1, uint256(uint128(-d1)));

        return "";
    }
}
