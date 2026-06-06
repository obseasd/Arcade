/**
 * V3-style concentrated-liquidity math for single-sided token launches.
 *
 * Model assumptions (matches CLANKER_V3 single-sided LP):
 *   - Pool starts at sqrtP(startingMcap / totalSupply), all liquidity above.
 *   - Each position [pLow, pHigh] holds only token (no quote) at start.
 *   - As buyers spend quote token, price moves up through positions; the LP
 *     loses tokens and gains quote.
 *
 * All "prices" in this module are in quote/token (eg USDC per token). Market
 * cap = price * totalSupply.
 */

export interface PositionInput {
  /** Lower bound expressed as market cap in quote (eg $30_000). */
  lowerMcap: number;
  /** Upper bound expressed as market cap in quote. */
  upperMcap: number;
  /** Fraction of the pool supply allocated to this position (0..1). */
  pctOfPool: number;
}

export interface SimulatorConfig {
  /** Total token supply (eg 1e9 for 1B). */
  totalSupply: number;
  /** Starting market cap in quote (the pool's initial price * totalSupply). */
  startingMcap: number;
  /** Allocations that bypass the pool (airdrop/vault/presale) as fractions. */
  airdropPct: number;
  vaultPct: number;
  presalePct: number;
  /** Static LP fee in basis points (eg 100 = 1%). */
  feeBps: number;
  positions: PositionInput[];
}

export interface ResolvedPosition {
  lowerPrice: number;
  upperPrice: number;
  /** Token supply held by this position at the lower bound. */
  tokens: number;
  /** V3 virtual liquidity constant. */
  liquidity: number;
  /** UI tag carried through for chart coloring (the position's display index). */
  index: number;
}

export interface PoolState {
  positions: ResolvedPosition[];
  /** Current sqrt-price in quote/token (sqrt(price)). */
  sqrtPrice: number;
  /** Tokens consumed from positions so far. */
  tokensSold: number;
  /** Total quote spent moving the pool to its current price. */
  quoteSpent: number;
  /** Sum of pool-supply tokens initially placed in positions. */
  poolSupply: number;
  totalSupply: number;
}

/** Fraction of totalSupply that lives in the LP, after off-pool allocations. */
export function poolFraction(c: SimulatorConfig): number {
  return Math.max(0, 1 - c.airdropPct - c.vaultPct - c.presalePct);
}

/**
 * Build the initial pool state from a config. Each position's tokens =
 * pctOfPool * poolSupply; liquidity = tokens / (1/sqrt(pLow) - 1/sqrt(pHigh)).
 */
export function buildPool(c: SimulatorConfig): PoolState {
  const poolSupply = c.totalSupply * poolFraction(c);
  const startingPrice = c.startingMcap / c.totalSupply;
  const positions: ResolvedPosition[] = c.positions
    .map((p, index) => {
      const lowerPrice = Math.max(p.lowerMcap, 1) / c.totalSupply;
      const upperPrice = Math.max(p.upperMcap, p.lowerMcap + 1) / c.totalSupply;
      const tokens = poolSupply * Math.max(0, p.pctOfPool);
      const denom = 1 / Math.sqrt(lowerPrice) - 1 / Math.sqrt(upperPrice);
      const liquidity = denom > 0 ? tokens / denom : 0;
      return { lowerPrice, upperPrice, tokens, liquidity, index };
    })
    .sort((a, b) => a.lowerPrice - b.lowerPrice);
  return {
    positions,
    sqrtPrice: Math.sqrt(startingPrice),
    tokensSold: 0,
    quoteSpent: 0,
    poolSupply,
    totalSupply: c.totalSupply,
  };
}

/**
 * Spend `quoteIn` of the quote token to move the pool price up. Returns the
 * tokens received, the gross quote spent, the LP fee retained, and whether the
 * buy was clamped because liquidity ran out (price hit the top of the highest
 * position).
 *
 * Real V3 swaps deduct the LP fee from the input before applying the price
 * impact (the fee accrues to the LP, the rest moves price). We model the same
 * thing: `effectiveIn = quoteIn * (1 - feeBps/10000)` drives the curve walk;
 * `quoteUsed` returned is the gross amount the user paid.
 */
export function simulateBuy(
  state: PoolState,
  quoteIn: number,
  feeBps = 0,
): { tokensOut: number; quoteUsed: number; feePaid: number; clamped: boolean; newState: PoolState } {
  const feeRate = feeBps / 10_000;
  let remaining = quoteIn * (1 - feeRate);
  const grossRemainingStart = quoteIn;
  let tokensOut = 0;
  let sqrtP = state.sqrtPrice;
  const positions = state.positions;

  for (const pos of positions) {
    if (remaining <= 0) break;
    const sqrtLow = Math.sqrt(pos.lowerPrice);
    const sqrtHigh = Math.sqrt(pos.upperPrice);
    // Skip positions entirely below the current price (already depleted).
    if (sqrtHigh <= sqrtP) continue;
    // If price is below the position, jump up to its lower bound for free
    // (this models the gap between positions where no liquidity exists).
    const sqrtStart = Math.max(sqrtP, sqrtLow);
    // Max quote that can be absorbed in this position before hitting sqrtHigh.
    const quoteToTop = pos.liquidity * (sqrtHigh - sqrtStart);
    if (remaining >= quoteToTop) {
      // Fully consume this position.
      const tokens = pos.liquidity * (1 / sqrtStart - 1 / sqrtHigh);
      tokensOut += tokens;
      remaining -= quoteToTop;
      sqrtP = sqrtHigh;
    } else {
      // Partial consumption; solve for the new sqrt-price.
      const sqrtEnd = sqrtStart + remaining / pos.liquidity;
      const tokens = pos.liquidity * (1 / sqrtStart - 1 / sqrtEnd);
      tokensOut += tokens;
      sqrtP = sqrtEnd;
      remaining = 0;
      break;
    }
  }

  // Net input actually swapped (may be less than effective input if clamped).
  const netUsed = grossRemainingStart * (1 - feeRate) - remaining;
  // Gross gets scaled in proportion: same fraction was consumed of both sides.
  const consumedFraction =
    grossRemainingStart * (1 - feeRate) > 0
      ? netUsed / (grossRemainingStart * (1 - feeRate))
      : 0;
  const quoteUsed = grossRemainingStart * consumedFraction;
  const feePaid = quoteUsed * feeRate;
  return {
    tokensOut,
    quoteUsed,
    feePaid,
    clamped: remaining > 0,
    newState: {
      ...state,
      sqrtPrice: sqrtP,
      tokensSold: state.tokensSold + tokensOut,
      quoteSpent: state.quoteSpent + quoteUsed,
    },
  };
}

/** Tokens initially placed in [pLow, p] for a position with liquidity L. */
function tokensInRange(L: number, sqrtLow: number, sqrtEnd: number): number {
  if (sqrtEnd <= sqrtLow) return 0;
  return L * (1 / sqrtLow - 1 / sqrtEnd);
}

/**
 * Sample the supply distribution across the (logarithmic) market-cap range.
 * For each bucket [mcLo, mcHi], returns the supply each position contributes
 * (as a fraction of totalSupply), so the chart can stack them.
 *
 * The returned array has `buckets` entries; each entry is a record keyed by
 * `pos${index}` plus the bucket center mcap, and a `mcap` field for the x.
 */
export function sampleDistribution(
  c: SimulatorConfig,
  buckets = 80,
): Array<Record<string, number>> {
  const pool = buildPool(c);
  if (pool.positions.length === 0) return [];
  const minMcap = Math.max(
    c.startingMcap * 0.9,
    Math.min(...c.positions.map((p) => p.lowerMcap)) * 0.9,
  );
  const maxMcap = Math.max(...c.positions.map((p) => p.upperMcap)) * 1.05;
  const logMin = Math.log10(Math.max(minMcap, 1));
  const logMax = Math.log10(Math.max(maxMcap, minMcap * 10));
  const step = (logMax - logMin) / buckets;

  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < buckets; i++) {
    const mcapLo = Math.pow(10, logMin + i * step);
    const mcapHi = Math.pow(10, logMin + (i + 1) * step);
    const priceLo = mcapLo / c.totalSupply;
    const priceHi = mcapHi / c.totalSupply;
    const sqrtLoB = Math.sqrt(priceLo);
    const sqrtHiB = Math.sqrt(priceHi);
    const row: Record<string, number> = { mcap: (mcapLo + mcapHi) / 2 };
    for (const pos of pool.positions) {
      const sqrtPosLo = Math.sqrt(pos.lowerPrice);
      const sqrtPosHi = Math.sqrt(pos.upperPrice);
      const sLo = Math.max(sqrtLoB, sqrtPosLo);
      const sHi = Math.min(sqrtHiB, sqrtPosHi);
      if (sHi <= sLo) {
        row[`pos${pos.index}`] = 0;
      } else {
        const tokens = tokensInRange(pos.liquidity, sLo, sHi);
        row[`pos${pos.index}`] = tokens / c.totalSupply;
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * For the cumulative-sold line on the chart: at each MC bucket, what % of the
 * pool supply has been sold if the price reaches that MC?
 */
export function sampleCumulativeSold(c: SimulatorConfig, buckets = 80): Array<{ mcap: number; sold: number }> {
  const pool = buildPool(c);
  if (pool.positions.length === 0) return [];
  const minMcap = Math.max(
    c.startingMcap * 0.9,
    Math.min(...c.positions.map((p) => p.lowerMcap)) * 0.9,
  );
  const maxMcap = Math.max(...c.positions.map((p) => p.upperMcap)) * 1.05;
  const logMin = Math.log10(Math.max(minMcap, 1));
  const logMax = Math.log10(Math.max(maxMcap, minMcap * 10));
  const step = (logMax - logMin) / buckets;
  const totalPoolTokens = pool.positions.reduce((acc, p) => acc + p.tokens, 0);

  const out: Array<{ mcap: number; sold: number }> = [];
  for (let i = 0; i < buckets; i++) {
    const mcap = Math.pow(10, logMin + (i + 1) * step);
    const price = mcap / c.totalSupply;
    const sqrtP = Math.sqrt(price);
    let sold = 0;
    for (const pos of pool.positions) {
      const sqrtLo = Math.sqrt(pos.lowerPrice);
      const sqrtHi = Math.sqrt(pos.upperPrice);
      const sqrtEnd = Math.min(sqrtP, sqrtHi);
      sold += tokensInRange(pos.liquidity, sqrtLo, sqrtEnd);
    }
    out.push({ mcap, sold: totalPoolTokens > 0 ? sold / totalPoolTokens : 0 });
  }
  return out;
}

/** mcapToTick / tickToMcap (Uniswap V3): tick = log(price) / log(1.0001). */
function mcapToTick(mcap: number, totalSupply: number): number {
  const price = mcap / totalSupply;
  return Math.floor(Math.log(price) / Math.log(1.0001));
}
function tickToMcap(tick: number, totalSupply: number): number {
  return Math.pow(1.0001, tick) * totalSupply;
}
