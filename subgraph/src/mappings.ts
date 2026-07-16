import { BigInt, BigDecimal, Address, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Buy, Sell, TokenCreated, Migrated } from "../generated/Launchpad/Launchpad";
import { PoolCreated } from "../generated/V3Factory/V3Factory";
import { Swap } from "../generated/templates/V3Pool/V3Pool";
import { V3Pool } from "../generated/templates";
import { Trade, Pool, Trader, Token, Global } from "../generated/schema";

/**
 * Charts + stats + referral mappings. Price math is a VERBATIM port of the
 * client useTokenCandles / price.ts (kept in lockstep for chart parity).
 * Beyond charts, we also track: the TRADER per trade (referral + unique-wallet
 * stat), per-Trader running volume, token lifecycle (Token), and a Global
 * running-totals singleton for O(1) /stats reads.
 *
 * graph-node does NOT reliably init module-level constants that call functions
 * (Address.fromString / BigInt.fromString / .pow) -- so every such value is
 * built LOCALLY inside a function.
 */

// 0x3600...0000 -- Arc's native USDC. VERIFY/CHANGE for mainnet.
function usdcAddress(): Address {
  return Address.fromString("0x3600000000000000000000000000000000000000");
}

function priceFromNewPriceQ64(priceQ64: BigInt): BigDecimal {
  const tenPow24 = BigInt.fromString("1000000000000000000000000"); // 10^24
  const twoPow64 = BigInt.fromI32(2).pow(64); // 2^64
  const priceE24 = priceQ64.times(tenPow24).div(twoPow64);
  return priceE24.toBigDecimal().div(BigDecimal.fromString("1000000000000")); // /1e12
}

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

/** |raw| / 1e6 (human USDC). */
function usdcVolume(raw: BigInt): BigDecimal {
  const zero = BigInt.fromI32(0);
  const abs = raw.lt(zero) ? raw.neg() : raw;
  return abs.toBigDecimal().div(BigDecimal.fromString("1000000")); // /1e6
}

function tradeId(txHash: string, logIndex: BigInt): string {
  return txHash + "-" + logIndex.toString();
}

/** The Global running-totals singleton (id = "global"), created on first use. */
function loadGlobal(): Global {
  let g = Global.load("global");
  if (g == null) {
    g = new Global("global");
    g.totalVolumeUsdc = BigDecimal.fromString("0");
    g.tradeCount = 0;
    g.tokenCount = 0;
    g.graduatedCount = 0;
    g.uniqueTraders = 0;
  }
  return g;
}

/**
 * Common trade path: writes the Trade, upserts the Trader running volume, and
 * bumps the Global totals. Called by all three trade handlers.
 */
function recordTrade(
  event: ethereum.Event,
  token: Bytes,
  trader: Bytes,
  source: string,
  pool: Bytes | null,
  price: BigDecimal,
  volumeUsdc: BigDecimal,
  isBuy: boolean,
): void {
  const blockTime = event.block.timestamp.toI32();

  const t = new Trade(tradeId(event.transaction.hash.toHexString(), event.logIndex));
  t.token = token;
  t.trader = trader;
  t.source = source;
  t.pool = pool;
  t.price = price;
  t.volumeUsdc = volumeUsdc;
  t.isBuy = isBuy;
  t.blockTime = blockTime;
  t.blockNumber = event.block.number;
  t.logIndex = event.logIndex.toI32();
  t.save();

  const g = loadGlobal();
  g.tradeCount = g.tradeCount + 1;
  g.totalVolumeUsdc = g.totalVolumeUsdc.plus(volumeUsdc);

  const traderId = trader.toHexString();
  let tr = Trader.load(traderId);
  if (tr == null) {
    tr = new Trader(traderId);
    tr.firstSeenAt = blockTime;
    tr.totalVolumeUsdc = BigDecimal.fromString("0");
    tr.tradeCount = 0;
    g.uniqueTraders = g.uniqueTraders + 1;
  }
  tr.totalVolumeUsdc = tr.totalVolumeUsdc.plus(volumeUsdc);
  tr.tradeCount = tr.tradeCount + 1;
  tr.save();

  g.save();
}

// ---- Curve / launchpad ----

export function handleBuy(event: Buy): void {
  recordTrade(
    event,
    event.params.token,
    event.params.buyer,
    "curve",
    null,
    priceFromNewPriceQ64(event.params.newPriceQ64),
    usdcVolume(event.params.usdcIn),
    true,
  );
}

export function handleSell(event: Sell): void {
  recordTrade(
    event,
    event.params.token,
    event.params.seller,
    "curve",
    null,
    priceFromNewPriceQ64(event.params.newPriceQ64),
    usdcVolume(event.params.usdcOut),
    false,
  );
}

export function handleTokenCreated(event: TokenCreated): void {
  const tok = new Token(event.params.token.toHexString());
  tok.creator = event.params.creator;
  tok.mode = event.params.mode;
  tok.createdAt = event.block.timestamp.toI32();
  tok.migrated = false;
  tok.save();

  const g = loadGlobal();
  g.tokenCount = g.tokenCount + 1;
  g.save();
}

export function handleMigrated(event: Migrated): void {
  const id = event.params.token.toHexString();
  let tok = Token.load(id);
  if (tok == null) {
    // Migrated seen before TokenCreated (shouldn't happen, but be safe).
    tok = new Token(id);
    tok.creator = Address.zero();
    tok.mode = 0;
    tok.createdAt = event.block.timestamp.toI32();
  }
  tok.migrated = true;
  tok.migratedAt = event.block.timestamp.toI32();
  tok.migratedPair = event.params.pair;
  tok.save();

  const g = loadGlobal();
  g.graduatedCount = g.graduatedCount + 1;
  g.save();
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

  V3Pool.create(event.params.pool);
}

export function handleSwap(event: Swap): void {
  const p = Pool.load(event.address.toHexString());
  if (p == null) return; // not a tracked USDC pool

  const usdcRaw = p.usdcIsToken0 ? event.params.amount0 : event.params.amount1;
  recordTrade(
    event,
    p.token,
    event.params.recipient, // the wallet receiving the swap output = the trader
    "v3",
    event.address,
    priceFromSqrtX96(event.params.sqrtPriceX96, p.usdcIsToken0),
    usdcVolume(usdcRaw),
    usdcRaw.gt(BigInt.fromI32(0)),
  );
}
