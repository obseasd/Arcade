import { BigInt, BigDecimal, Address } from "@graphprotocol/graph-ts";
import { Buy, Sell } from "../generated/Launchpad/Launchpad";
import { PoolCreated } from "../generated/V3Factory/V3Factory";
import { Swap } from "../generated/templates/V3Pool/V3Pool";
import { V3Pool } from "../generated/templates";
import { Trade, Pool } from "../generated/schema";

/**
 * Price + trade mappings. The math is a VERBATIM port of the client's
 * useTokenCandles / the Ponder indexer's price.ts, expressed in graph-ts
 * BigInt/BigDecimal so the resulting numbers match at display precision. Any
 * change here MUST stay in lockstep with those (the chart parity depends on it).
 *
 * Bucketize is NOT reimplemented here -- the frontend queries `trades` and
 * bucketizes in TS. This mapping only stores the raw priced trades.
 */

// NOTE: graph-node does NOT reliably initialise module-level constants that
// call functions (Address.fromString / BigInt.fromString / .pow) -- doing so
// throws "Attempted to read past end of string content bytes chunk" at handler
// time. So every such value is built LOCALLY inside a function below. The
// per-event cost of rebuilding a few BigInts is negligible.

// 0x3600...0000 -- Arc's native USDC. VERIFY/CHANGE for mainnet.
function usdcAddress(): Address {
  return Address.fromString("0x3600000000000000000000000000000000000000");
}

/**
 * Curve price. Mirrors priceFromNewPriceQ64:
 *   priceE24 = (priceQ64 * 10^24) >> 64  (integer)
 *   price    = priceE24 / 1e24 * 1e12  ==  priceE24 / 1e12
 */
function priceFromNewPriceQ64(priceQ64: BigInt): BigDecimal {
  const tenPow24 = BigInt.fromString("1000000000000000000000000"); // 10^24
  const twoPow64 = BigInt.fromI32(2).pow(64); // 2^64
  const priceE24 = priceQ64.times(tenPow24).div(twoPow64);
  return priceE24.toBigDecimal().div(BigDecimal.fromString("1000000000000")); // /1e12
}

/**
 * V3 pool price. Mirrors priceFromSqrtX96:
 *   num      = sqrtPriceX96^2
 *   ratioE24 = usdcIsToken0 ? (2^192 * 10^24)/num : (num * 10^24)/2^192  (int)
 *   price    = ratioE24 / 1e12
 */
function priceFromSqrtX96(sqrtPriceX96: BigInt, usdcIsToken0: boolean): BigDecimal {
  const tenPow24 = BigInt.fromString("1000000000000000000000000"); // 10^24
  const q192 = BigInt.fromI32(2).pow(192); // 2^192
  const num = sqrtPriceX96.times(sqrtPriceX96);
  let ratioE24: BigInt;
  if (usdcIsToken0) {
    ratioE24 = q192.times(tenPow24).div(num);
  } else {
    ratioE24 = num.times(tenPow24).div(q192);
  }
  return ratioE24.toBigDecimal().div(BigDecimal.fromString("1000000000000")); // /1e12
}

/** |raw| / 1e6 (human USDC). Mirrors usdcVolumeFromRaw. */
function usdcVolume(raw: BigInt): BigDecimal {
  const zero = BigInt.fromI32(0);
  const abs = raw.lt(zero) ? raw.neg() : raw;
  return abs.toBigDecimal().div(BigDecimal.fromString("1000000")); // /1e6
}

function tradeId(txHash: string, logIndex: BigInt): string {
  return txHash + "-" + logIndex.toString();
}

// ---- Curve / launchpad ----

export function handleBuy(event: Buy): void {
  const t = new Trade(tradeId(event.transaction.hash.toHexString(), event.logIndex));
  t.token = event.params.token;
  t.source = "curve";
  t.pool = null;
  t.price = priceFromNewPriceQ64(event.params.newPriceQ64);
  t.volumeUsdc = usdcVolume(event.params.usdcIn);
  t.isBuy = true;
  t.blockTime = event.block.timestamp.toI32();
  t.blockNumber = event.block.number;
  t.logIndex = event.logIndex.toI32();
  t.save();
}

export function handleSell(event: Sell): void {
  const t = new Trade(tradeId(event.transaction.hash.toHexString(), event.logIndex));
  t.token = event.params.token;
  t.source = "curve";
  t.pool = null;
  t.price = priceFromNewPriceQ64(event.params.newPriceQ64);
  t.volumeUsdc = usdcVolume(event.params.usdcOut);
  t.isBuy = false;
  t.blockTime = event.block.timestamp.toI32();
  t.blockNumber = event.block.number;
  t.logIndex = event.logIndex.toI32();
  t.save();
}

// ---- V3 pools ----

export function handlePoolCreated(event: PoolCreated): void {
  const token0 = event.params.token0;
  const token1 = event.params.token1;
  const usdc = usdcAddress();
  const usdcIsToken0 = token0.equals(usdc);
  const usdcIsToken1 = token1.equals(usdc);
  if (!usdcIsToken0 && !usdcIsToken1) return; // not a USDC pool

  const p = new Pool(event.params.pool.toHexString());
  p.token0 = token0;
  p.token1 = token1;
  p.token = usdcIsToken0 ? token1 : token0;
  p.usdcIsToken0 = usdcIsToken0;
  p.save();

  // Spawn the template so this pool's Swaps get indexed.
  V3Pool.create(event.params.pool);
}

export function handleSwap(event: Swap): void {
  const p = Pool.load(event.address.toHexString());
  if (p == null) return; // not a tracked USDC pool

  const usdcRaw = p.usdcIsToken0 ? event.params.amount0 : event.params.amount1;

  const t = new Trade(tradeId(event.transaction.hash.toHexString(), event.logIndex));
  t.token = p.token;
  t.source = "v3";
  t.pool = event.address;
  t.price = priceFromSqrtX96(event.params.sqrtPriceX96, p.usdcIsToken0);
  t.volumeUsdc = usdcVolume(usdcRaw);
  t.isBuy = usdcRaw.gt(BigInt.fromI32(0));
  t.blockTime = event.block.timestamp.toI32();
  t.blockNumber = event.block.number;
  t.logIndex = event.logIndex.toI32();
  t.save();
}
