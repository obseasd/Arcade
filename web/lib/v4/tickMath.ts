// 1:1 TS port of Uniswap V4 TickMath. Used by the V4 launch wizard to convert
// between ticks and sqrtPrices when sizing liquidityDelta for initializePool.
// Mirrors contracts/lib/v4-core/src/libraries/TickMath.sol exactly so the
// numbers we compute off-chain match what PoolManager will compute on-chain.

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_PRICE = 4_295_128_739n;
export const MAX_SQRT_PRICE = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

const MASK_256 = (1n << 256n) - 1n;
const UINT256_MAX = MASK_256;

function bigintAbs(x: bigint): bigint {
    return x < 0n ? -x : x;
}

function mulHi128(a: bigint, b: bigint): bigint {
    // ((a * b) >> 128) within 256-bit modular arithmetic, matching Solidity's
    // unchecked semantics. price values fit in 256 bits at every step.
    return ((a * b) & MASK_256) >> 128n;
}

export function getSqrtPriceAtTick(tick: number): bigint {
    const absTick = BigInt(Math.abs(tick));
    if (absTick > BigInt(MAX_TICK)) {
        throw new Error(`InvalidTick: ${tick}`);
    }

    let price: bigint;
    if ((absTick & 0x1n) !== 0n) {
        price = 0xfffcb933bd6fad37aa2d162d1a594001n;
    } else {
        price = 1n << 128n;
    }

    if ((absTick & 0x2n) !== 0n) price = mulHi128(price, 0xfff97272373d413259a46990580e213an);
    if ((absTick & 0x4n) !== 0n) price = mulHi128(price, 0xfff2e50f5f656932ef12357cf3c7fdccn);
    if ((absTick & 0x8n) !== 0n) price = mulHi128(price, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
    if ((absTick & 0x10n) !== 0n) price = mulHi128(price, 0xffcb9843d60f6159c9db58835c926644n);
    if ((absTick & 0x20n) !== 0n) price = mulHi128(price, 0xff973b41fa98c081472e6896dfb254c0n);
    if ((absTick & 0x40n) !== 0n) price = mulHi128(price, 0xff2ea16466c96a3843ec78b326b52861n);
    if ((absTick & 0x80n) !== 0n) price = mulHi128(price, 0xfe5dee046a99a2a811c461f1969c3053n);
    if ((absTick & 0x100n) !== 0n) price = mulHi128(price, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
    if ((absTick & 0x200n) !== 0n) price = mulHi128(price, 0xf987a7253ac413176f2b074cf7815e54n);
    if ((absTick & 0x400n) !== 0n) price = mulHi128(price, 0xf3392b0822b70005940c7a398e4b70f3n);
    if ((absTick & 0x800n) !== 0n) price = mulHi128(price, 0xe7159475a2c29b7443b29c7fa6e889d9n);
    if ((absTick & 0x1000n) !== 0n) price = mulHi128(price, 0xd097f3bdfd2022b8845ad8f792aa5825n);
    if ((absTick & 0x2000n) !== 0n) price = mulHi128(price, 0xa9f746462d870fdf8a65dc1f90e061e5n);
    if ((absTick & 0x4000n) !== 0n) price = mulHi128(price, 0x70d869a156d2a1b890bb3df62baf32f7n);
    if ((absTick & 0x8000n) !== 0n) price = mulHi128(price, 0x31be135f97d08fd981231505542fcfa6n);
    if ((absTick & 0x10000n) !== 0n) price = mulHi128(price, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
    if ((absTick & 0x20000n) !== 0n) price = mulHi128(price, 0x5d6af8dedb81196699c329225ee604n);
    if ((absTick & 0x40000n) !== 0n) price = mulHi128(price, 0x2216e584f5fa1ea926041bedfe98n);
    if ((absTick & 0x80000n) !== 0n) price = mulHi128(price, 0x48a170391f7dc42444e8fa2n);

    if (tick > 0) {
        // Solidity: price = type(uint256).max / price
        price = UINT256_MAX / price;
    }

    // Q128.128 -> Q128.96, rounded UP.
    const sqrtPriceX96 = (price + ((1n << 32n) - 1n)) >> 32n;
    return sqrtPriceX96;
}

export function getTickAtSqrtPrice(sqrtPriceX96: bigint): number {
    if (sqrtPriceX96 < MIN_SQRT_PRICE || sqrtPriceX96 >= MAX_SQRT_PRICE) {
        throw new Error(`InvalidSqrtPrice: ${sqrtPriceX96}`);
    }
    // Binary-search via the canonical algorithm. We use the simpler / slower
    // log-based search because we only run this off-chain.
    // Reference: same approximation as v4-core's getTickAtSqrtPrice.
    const price = sqrtPriceX96 << 32n;

    let r = price;
    let msb = 0n;
    {
        let x = r;
        while (x >= (1n << 128n)) {
            x >>= 128n;
            msb += 128n;
        }
        while (x >= (1n << 64n)) {
            x >>= 64n;
            msb += 64n;
        }
        while (x >= (1n << 32n)) {
            x >>= 32n;
            msb += 32n;
        }
        while (x >= (1n << 16n)) {
            x >>= 16n;
            msb += 16n;
        }
        while (x >= (1n << 8n)) {
            x >>= 8n;
            msb += 8n;
        }
        while (x >= (1n << 4n)) {
            x >>= 4n;
            msb += 4n;
        }
        while (x >= (1n << 2n)) {
            x >>= 2n;
            msb += 2n;
        }
        if (x >= 2n) msb += 1n;
    }

    if (msb >= 128n) r = price >> (msb - 127n);
    else r = price << (127n - msb);

    let log_2 = (msb - 128n) << 64n;

    for (let i = 63n; i >= 50n; i--) {
        r = (r * r) >> 127n;
        const f = r >> 128n;
        log_2 |= f << i;
        if (i > 50n) r >>= f;
    }

    const log_sqrt10001 = log_2 * 255_738_958_999_603_826_347_141n;

    const tickLow = Number(
        BigInt.asIntN(24, (log_sqrt10001 - 3_402_992_956_809_132_418_596_140_100_660_247_210n) >> 128n),
    );
    const tickHi = Number(
        BigInt.asIntN(24, (log_sqrt10001 + 291_339_464_771_989_622_907_027_621_153_398_088_495n) >> 128n),
    );

    if (tickLow === tickHi) return tickLow;
    return getSqrtPriceAtTick(tickHi) <= sqrtPriceX96 ? tickHi : tickLow;
}

export function maxUsableTick(tickSpacing: number): number {
    return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
}

export function minUsableTick(tickSpacing: number): number {
    return -maxUsableTick(tickSpacing);
}

/**
 * Snap a tick down to the nearest multiple of tickSpacing (floor toward
 * -infinity for negative ticks). Mirrors `_floorTick` in ArcadeV4Launchpad.
 */
export function floorTick(tick: number, tickSpacing: number): number {
    let compressed = Math.trunc(tick / tickSpacing);
    if (tick < 0 && tick % tickSpacing !== 0) compressed--;
    return compressed * tickSpacing;
}

/**
 * The single-sided position bounds the launchpad will use. Mirrors
 * `_singleSidedRange` + `previewPosition` in ArcadeV4Launchpad.
 */
export function singleSidedRange(
    tokenIsCurrency0: boolean,
    currentTick: number,
    tickSpacing: number,
): { tickLower: number; tickUpper: number } {
    const maxUsable = maxUsableTick(tickSpacing);
    const minUsable = -maxUsable;
    if (tokenIsCurrency0) {
        return { tickLower: floorTick(currentTick, tickSpacing) + tickSpacing, tickUpper: maxUsable };
    }
    return { tickLower: minUsable, tickUpper: floorTick(currentTick, tickSpacing) };
}

// silence unused-var lint on imports of bigintAbs we may still need later
void bigintAbs;
