// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title ArcadeV4Curve
 * @notice Pure curve math for the V4 ArcadeHook. Same constant-product shape as
 *         the V2 launchpad bonding curve, but as of 2026-07-17 the V4 curve is
 *         re-CALIBRATED and DIVERGES from V2 (see the constants block): it
 *         graduates opening the AMM at ~$60k FDV with price continuity, where V2
 *         keeps its 800M / ~$125k curve.
 *
 *         All values are integers, USDC has 6 decimals, launch tokens have 18.
 *         The library is stateless: callers pass in `tokensSold` and
 *         `realUsdcReserve`, the library returns the new state contribution and
 *         the caller persists it.
 *
 * @dev    Vectors are pinned INLINE in `v4test/ArcadeV4Curve.t.sol` (recomputed
 *         on any recalibration), NOT read from `curve-vectors.json`, which stays
 *         pinned to the V2 curve. Do not "sync" the two.
 *
 *         Rounding policy (from V4_HOOK_SPEC.md Section 4.3):
 *         - All `K / x` divisions floor by default.
 *         - The cap-path `capUsdcReserve` rounds UP when modulus is non-zero
 *           so the cap is reachable.
 *         - The cap-path `actualGross` rounds UP via ceil division so the
 *           user always covers the cap.
 *         - Round-trip invariant: buy(X) -> sell(received) must yield strictly
 *           less than X USDC. Tested in roundTripVectors.
 */
library ArcadeV4Curve {
    // -------------------------------------------------------------------
    // Constants (mirror src/launchpad/ArcadeLaunchpad.sol)
    // -------------------------------------------------------------------

    /// @notice Curve constants CALIBRATED 2026-07-17 for a graduation that opens
    ///         the AMM at ~$60k FDV with (near-)PRICE-CONTINUITY -- pump.fun's
    ///         method. The trick: VIRTUAL_TOKEN_RESERVE is set LARGER than
    ///         TOTAL_SUPPLY, so at graduation the virtual tokens remaining
    ///         (V_T - CURVE_SUPPLY = 329M) exceed the real tokens seeded into the
    ///         LP (TOTAL - CURVE_SUPPLY = 194M) by ~the amount that offsets the
    ///         virtual USDC reserve. Seeding all 194M migration tokens with the
    ///         real raise then lands on the curve's final marginal price to
    ///         within ~0.76% -- and on the SAFE side (the AMM opens slightly
    ///         BELOW marginal, so late curve buyers take a <1% markdown rather
    ///         than the first AMM buyer getting a free profit). The residual is
    ///         MIGRATION_FEE (2,500) overshooting exact continuity by ~90 USDC;
    ///         negligible vs the ~43% cliff naive seeding had. Open FDV ~$60k,
    ///         start FDV $5k. A PURE constant calibration: no graduation-logic
    ///         change, no token burn.
    ///
    ///         The V4 curve DIVERGES from the V2 production launchpad (which keeps
    ///         its own 800M / $125k constants); the V4 hook is the successor.
    ///         Only ~194M + 806M = 1B tokens are ever minted; the 135M excess in
    ///         VIRTUAL_TOKEN_RESERVE is a formula-only virtual reserve, never
    ///         minted (exactly like pump.fun's ~270M virtual tokens).
    uint256 internal constant VIRTUAL_USDC_RESERVE = 5_800e6;
    uint256 internal constant VIRTUAL_TOKEN_RESERVE = 1_135_000_000e18;
    uint256 internal constant CURVE_SUPPLY = 806_000_000e18;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 internal constant MIGRATION_LP_TOKENS = TOTAL_SUPPLY - CURVE_SUPPLY; // 194M
    uint256 internal constant K_CONSTANT = VIRTUAL_USDC_RESERVE * VIRTUAL_TOKEN_RESERVE;
    uint256 internal constant TRADE_FEE_BPS = 100; // 1%
    uint256 internal constant FEE_DENOMINATOR = 10_000;
    uint256 internal constant MIGRATION_FEE = 2_500e6; // 2,500 USDC
    /// @notice The realUsdcReserve value (approx) at graduation. Informational:
    ///         graduation is triggered by tokensSold >= CURVE_SUPPLY, not by
    ///         this. At CURVE_SUPPLY = 806M the curve raises ~14,209 USDC.
    uint256 internal constant GRADUATION_USDC = 14_209e6;

    // -------------------------------------------------------------------
    // Return structs
    // -------------------------------------------------------------------

    struct BuyResult {
        /// @notice Launch tokens delivered to the buyer (18 dp).
        uint256 tokensOut;
        /// @notice USDC the curve actually consumes for this buy. May be less
        ///         than `grossUsdcIn` when the buy hits the graduation cap and
        ///         the residual is refunded.
        uint256 actualGross;
        /// @notice Curve fee taken from `actualGross` (1% of actualGross).
        uint256 fee;
        /// @notice Refund to the buyer when `actualGross < grossUsdcIn`.
        uint256 refund;
    }

    struct SellResult {
        /// @notice USDC withdrawn from `realUsdcReserve` (before fee).
        uint256 grossOut;
        /// @notice USDC paid to the seller after curve fee.
        uint256 usdcOut;
        /// @notice Curve fee taken from `grossOut` (1% of grossOut).
        uint256 fee;
    }

    // -------------------------------------------------------------------
    // Per-launch parameterization (creator allocations)
    // -------------------------------------------------------------------

    /// @notice Per-launch curve parameters. The library is intrinsically stated
    ///         by the constants above; a launch that carves out a creator
    ///         ALLOCATION scales the WHOLE curve down by the market fraction
    ///         Mt/T (Mt = TOTAL_SUPPLY - allocation) so both price-continuity and
    ///         the graduation FDV are preserved:
    ///           - start price virtualUsdc/virtualToken == Vu/Vt (unchanged);
    ///           - final marginal price virtualUsdc*virtualToken/(virtualToken -
    ///             curveSupply)^2 is invariant under the common scale;
    ///           - the AMM seed price (lpUsdc - migrationFee)/migrationLpTokens
    ///             scales numerator and denominator by the same Mt/T.
    ///         `virtualUsdc * virtualToken` is the per-launch K. At allocation 0
    ///         these equal the library constants EXACTLY (see {defaultParams}),
    ///         which is the zero-regression guarantee.
    struct CurveParams {
        uint256 virtualUsdc;
        uint256 virtualToken;
        uint256 curveSupply;
        uint256 migrationLpTokens;
        uint256 migrationFee;
    }

    /// @notice Default (allocation-0) curve params: exactly the library
    ///         constants. Used by the constant-signature wrappers so existing
    ///         call sites and pinned vectors are byte-for-byte unchanged.
    function defaultParams() internal pure returns (CurveParams memory) {
        return CurveParams({
            virtualUsdc: VIRTUAL_USDC_RESERVE,
            virtualToken: VIRTUAL_TOKEN_RESERVE,
            curveSupply: CURVE_SUPPLY,
            migrationLpTokens: MIGRATION_LP_TOKENS,
            migrationFee: MIGRATION_FEE
        });
    }

    /// @notice Curve params for a creator allocation of `allocBps` (0..9000) of
    ///         TOTAL_SUPPLY. A = T*allocBps/10000, Mt = T - A. Every reserve /
    ///         supply / fee is scaled by Mt/T, and the curve + LP seed then use
    ///         exactly Mt tokens (curveSupply' + migrationLpTokens' == Mt), so
    ///         the caller can place the remaining A wei to the creator with the
    ///         invariant curveSupply' + migrationLpTokens' + A == T. allocBps==0
    ///         reproduces {defaultParams} / the constants EXACTLY (T*Sc/T == Sc,
    ///         Vu*T/T == Vu, ... all divide evenly).
    function paramsForAllocation(uint256 allocBps) internal pure returns (CurveParams memory p) {
        uint256 t = TOTAL_SUPPLY;
        uint256 a = (t * allocBps) / FEE_DENOMINATOR;
        uint256 mt = t - a;
        uint256 curveSupply_ = (mt * CURVE_SUPPLY) / t;
        p = CurveParams({
            virtualUsdc: (VIRTUAL_USDC_RESERVE * mt) / t,
            virtualToken: (VIRTUAL_TOKEN_RESERVE * mt) / t,
            curveSupply: curveSupply_,
            migrationLpTokens: mt - curveSupply_, // Mt - curveSupply' (exact)
            migrationFee: (MIGRATION_FEE * mt) / t
        });
    }

    // -------------------------------------------------------------------
    // Buy
    // -------------------------------------------------------------------

    /**
     * @notice Simulate a curve buy. Returns the math result without mutating
     *         anything. Mirrors the V2 launchpad's `_computeBuy` exactly.
     *
     * @param tokensSold       Current `state.tokensSold` (18 dp).
     * @param realUsdcReserve  Current `state.realUsdcReserve` (6 dp).
     * @param grossUsdcIn      USDC the buyer is willing to spend (6 dp).
     *
     *         Caller MUST then apply:
     *           state.tokensSold       += result.tokensOut
     *           state.realUsdcReserve  += result.actualGross - result.fee
     *         and refund `result.refund` USDC to the buyer if non-zero.
     *
     *         When `tokensSold + result.tokensOut == CURVE_SUPPLY` the curve
     *         is graduated and the caller MUST trigger the graduation routine
     *         on the SAME tx.
     */
    function simulateBuy(uint256 tokensSold, uint256 realUsdcReserve, uint256 grossUsdcIn)
        internal
        pure
        returns (BuyResult memory r)
    {
        return simulateBuy(defaultParams(), tokensSold, realUsdcReserve, grossUsdcIn);
    }

    /// @notice Parameterized curve buy. Identical shape to the constant version
    ///         above; every constant is replaced by its per-launch value from
    ///         `p` (K = p.virtualUsdc * p.virtualToken). Same rounding policy
    ///         (floors, cap-path ceil bumps). At `p == defaultParams()` this is
    ///         byte-for-byte the legacy behaviour.
    function simulateBuy(
        CurveParams memory p,
        uint256 tokensSold,
        uint256 realUsdcReserve,
        uint256 grossUsdcIn
    ) internal pure returns (BuyResult memory r) {
        if (grossUsdcIn == 0) return r;
        if (tokensSold >= p.curveSupply) return r; // curve already at cap

        uint256 k = p.virtualUsdc * p.virtualToken;

        uint256 fee = (grossUsdcIn * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        uint256 netIn = grossUsdcIn - fee;

        uint256 currentUsdc = p.virtualUsdc + realUsdcReserve;
        uint256 currentTokens = p.virtualToken - tokensSold;

        uint256 newUsdcReserve = currentUsdc + netIn;
        uint256 newTokenReserve = k / newUsdcReserve; // floor
        uint256 desiredOut = currentTokens - newTokenReserve;

        uint256 maxOut = p.curveSupply - tokensSold;

        if (desiredOut <= maxOut) {
            r.tokensOut = desiredOut;
            r.actualGross = grossUsdcIn;
            r.fee = fee;
            r.refund = 0;
            return r;
        }

        // Cap path: this buy crosses curveSupply. Tighten to the exact tokens
        // remaining and compute the precise USDC the curve will accept; the
        // rest is refunded.
        uint256 capTokenReserve = currentTokens - maxOut;
        uint256 capUsdcReserve = k / capTokenReserve; // floor
        if (k % capTokenReserve != 0) {
            // Bump by 1 wei to ensure the cap is REACHABLE (the floor on its
            // own would leave the curve a hair short of capacity).
            capUsdcReserve += 1;
        }
        uint256 actualNet = capUsdcReserve - currentUsdc;
        // ceil(actualNet * 10_000 / (10_000 - 100)) ensures the user pays a
        // tax that covers the cap rather than rounding down to a fee that
        // would let the curve be undercharged by 1 wei.
        uint256 numerator = actualNet * FEE_DENOMINATOR;
        uint256 denominator = FEE_DENOMINATOR - TRADE_FEE_BPS;
        uint256 actualGross = (numerator + denominator - 1) / denominator;
        if (actualGross > grossUsdcIn) {
            // Pathological: rounding pushed cost above the user's input. Clip
            // to the input. The cap will be ALMOST-reached; final dust drops
            // on the floor and the next buy clears it.
            actualGross = grossUsdcIn;
        }
        uint256 actualFee = (actualGross * TRADE_FEE_BPS) / FEE_DENOMINATOR;

        r.tokensOut = maxOut;
        r.actualGross = actualGross;
        r.fee = actualFee;
        r.refund = grossUsdcIn - actualGross;
    }

    // -------------------------------------------------------------------
    // Sell
    // -------------------------------------------------------------------

    /**
     * @notice Simulate a curve sell. Returns the math result without mutating
     *         anything. Mirrors the V2 launchpad's `_computeSell` exactly.
     *
     * @param tokensSold       Current `state.tokensSold` (18 dp).
     * @param realUsdcReserve  Current `state.realUsdcReserve` (6 dp).
     * @param tokensIn         Launch tokens the seller is sending in (18 dp).
     *
     *         Caller MUST then apply:
     *           state.tokensSold       -= tokensIn
     *           state.realUsdcReserve  -= result.grossOut
     *         and pay `result.usdcOut` USDC to the seller.
     */
    function simulateSell(uint256 tokensSold, uint256 realUsdcReserve, uint256 tokensIn)
        internal
        pure
        returns (SellResult memory r)
    {
        return simulateSell(defaultParams(), tokensSold, realUsdcReserve, tokensIn);
    }

    /// @notice Parameterized curve sell. Same shape as the constant version;
    ///         constants replaced by `p` (K = p.virtualUsdc * p.virtualToken).
    function simulateSell(
        CurveParams memory p,
        uint256 tokensSold,
        uint256 realUsdcReserve,
        uint256 tokensIn
    ) internal pure returns (SellResult memory r) {
        if (tokensIn == 0) return r;
        if (tokensIn > tokensSold) {
            // Defensive: cannot sell more than the curve has issued.
            tokensIn = tokensSold;
        }

        uint256 k = p.virtualUsdc * p.virtualToken;
        uint256 currentUsdc = p.virtualUsdc + realUsdcReserve;
        uint256 currentTokens = p.virtualToken - tokensSold;

        uint256 newTokenReserve = currentTokens + tokensIn;
        uint256 newUsdcReserve = k / newTokenReserve; // floor
        // V2 production behavior: this subtraction is unchecked and would
        // revert on underflow when floor rounding produces newUsdcReserve >
        // currentUsdc (degenerate dust sells deep in the curve). V4 must NOT
        // revert from a hook callback because it would brick the user's swap
        // through no fault of their own. No-op instead.
        if (newUsdcReserve >= currentUsdc) return r;
        uint256 grossOut = currentUsdc - newUsdcReserve;
        if (grossOut > realUsdcReserve) {
            // Dust safeguard: floor rounding on K/newTokenReserve can produce a
            // grossOut that exceeds the actually-collected USDC by a few wei.
            // Clip to the real reserve so we never overpay.
            grossOut = realUsdcReserve;
        }

        uint256 fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR;
        r.grossOut = grossOut;
        r.usdcOut = grossOut - fee;
        r.fee = fee;
    }

    // -------------------------------------------------------------------
    // Convenience views
    // -------------------------------------------------------------------

    /**
     * @notice Spot price = quote / base, expressed as USDC (6 dp) per 10**18
     *         of launch token. Useful for UI display and quotes; NOT used by
     *         the curve math itself, which always derives from K.
     */
    function spotPrice(uint256 tokensSold, uint256 realUsdcReserve) internal pure returns (uint256) {
        return spotPrice(defaultParams(), tokensSold, realUsdcReserve);
    }

    /// @notice Parameterized spot price.
    function spotPrice(CurveParams memory p, uint256 tokensSold, uint256 realUsdcReserve)
        internal
        pure
        returns (uint256)
    {
        uint256 currentUsdc = p.virtualUsdc + realUsdcReserve;
        uint256 currentTokens = p.virtualToken - tokensSold;
        if (currentTokens == 0) return 0;
        return (currentUsdc * 1e18) / currentTokens;
    }

    /**
     * @notice True when the curve has graduated (sold all of CURVE_SUPPLY).
     *         Callers MUST use this rather than checking `realUsdcReserve >=
     *         GRADUATION_USDC` directly, because the cap path leaves a few
     *         wei of headroom in `realUsdcReserve` on graduation.
     */
    function isGraduated(uint256 tokensSold) internal pure returns (bool) {
        return tokensSold >= CURVE_SUPPLY;
    }

    /// @notice Parameterized graduation check: tokensSold >= p.curveSupply.
    function isGraduated(CurveParams memory p, uint256 tokensSold) internal pure returns (bool) {
        return tokensSold >= p.curveSupply;
    }

    /**
     * @notice USDC available to seed the V2/V4 graduation pool. Equals
     *         realUsdcReserve - MIGRATION_FEE at graduation; the fee is taken
     *         off the top before the LP is funded.
     */
    function graduationLiquidityUsdc(uint256 realUsdcReserveAtGrad) internal pure returns (uint256) {
        return graduationLiquidityUsdc(defaultParams(), realUsdcReserveAtGrad);
    }

    /// @notice Parameterized: USDC available to seed the pool = reserve minus the
    ///         per-launch migration fee.
    function graduationLiquidityUsdc(CurveParams memory p, uint256 realUsdcReserveAtGrad)
        internal
        pure
        returns (uint256)
    {
        if (realUsdcReserveAtGrad < p.migrationFee) return 0;
        return realUsdcReserveAtGrad - p.migrationFee;
    }
}
