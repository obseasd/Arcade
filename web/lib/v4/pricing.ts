// Derives the V4 pool's starting sqrtPriceX96 from a human-friendly target
// FDV in USDC. The pool price convention is `currency1 / currency0`, so the
// exact formula depends on which currency the launch token ends up at.

import type { Address } from "viem";
import { LAUNCHPAD_TOKEN_DECIMALS, LAUNCHPAD_TOTAL_SUPPLY, USDC_DECIMALS } from "../constants";

/**
 * Integer square root, Newton's method on bigints. Returns floor(sqrt(n)) for
 * any non-negative n. Used to convert a Q192 price into a Q96 sqrtPrice
 * without floating-point loss.
 */
export function bigintSqrt(n: bigint): bigint {
    if (n < 0n) throw new Error("bigintSqrt: negative input");
    if (n < 2n) return n;
    let x0 = n;
    let x1 = (n >> 1n) + 1n;
    while (x1 < x0) {
        x0 = x1;
        x1 = (x1 + n / x1) >> 1n;
    }
    return x0;
}

/**
 * Compute sqrtPriceX96 for a V4 pool that pairs `tokenAddr` with USDC at a
 * target fully-diluted valuation of `fdvUsdc` US dollars. The convention
 * matches what `PoolManager.initialize` expects: `price = currency1 / currency0`,
 * encoded as Q64.96.
 *
 * @param fdvUsdc    Target FDV in whole USDC (e.g. 100_000 = $100k FDV).
 * @param tokenAddr  Launch token address (we infer currency sort from it).
 * @param usdcAddr   USDC address on this chain.
 */
export function sqrtPriceFromFdv(
    fdvUsdc: number,
    tokenAddr: Address,
    usdcAddr: Address,
): { sqrtPriceX96: bigint; tokenIsCurrency0: boolean } {
    if (!Number.isFinite(fdvUsdc) || fdvUsdc <= 0) {
        throw new Error("sqrtPriceFromFdv: fdvUsdc must be positive");
    }
    const tokenLower = BigInt(tokenAddr) < BigInt(usdcAddr);
    const tokenIsCurrency0 = tokenLower;

    const tokenSupplyRaw = LAUNCHPAD_TOTAL_SUPPLY * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);
    // Convert FDV to USDC base units. fdvUsdc may be fractional in principle
    // but we keep it whole for simplicity here.
    const fdvRaw = BigInt(Math.round(fdvUsdc)) * 10n ** BigInt(USDC_DECIMALS);
    const Q192 = 1n << 192n;

    // Price as Q192. We need sqrt(priceQ192) which equals sqrt(price) * 2^96
    // = sqrtPriceX96.
    let priceQ192: bigint;
    if (tokenIsCurrency0) {
        // currency0=TOKEN, currency1=USDC.
        // priceFloat = USDC / TOKEN = fdvRaw / tokenSupplyRaw
        priceQ192 = (fdvRaw * Q192) / tokenSupplyRaw;
    } else {
        // currency0=USDC, currency1=TOKEN.
        // priceFloat = TOKEN / USDC = tokenSupplyRaw / fdvRaw
        priceQ192 = (tokenSupplyRaw * Q192) / fdvRaw;
    }
    return { sqrtPriceX96: bigintSqrt(priceQ192), tokenIsCurrency0 };
}
