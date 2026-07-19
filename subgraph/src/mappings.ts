import { BigInt, BigDecimal, Address, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Buy, Sell, TokenCreated, Migrated } from "../generated/Launchpad/Launchpad";
import { PoolCreated } from "../generated/V3Factory/V3Factory";
import { Swap } from "../generated/templates/V3Pool/V3Pool";
import { Transfer } from "../generated/templates/ArcadeToken/ERC20";
import { V3Pool, ArcadeToken } from "../generated/templates";
import {
  LaunchCreated,
  TokenLaunched,
  CurveBuy,
  CurveSell,
  Graduated,
  RoyaltyPaid,
  AntiSnipeApplied,
  FeeAttributedToHandle,
  FeeHarvested,
} from "../generated/ArcadeHookV4/ArcadeHook";
import { Credited, Claimed } from "../generated/TwitterEscrowV4/ArcadeTwitterEscrowV4";
import { Swap as V4Swap } from "../generated/PoolManagerV4/PoolManagerV4";
import {
  Trade,
  Pool,
  PoolDayData,
  GlobalDayData,
  Trader,
  Token,
  TokenBalance,
  TokenDayData,
  Global,
  Creator,
  V4Pool,
  HandleAttribution,
  EscrowSlot,
  FeeStats,
} from "../generated/schema";

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
 * Credit a trade's USDC volume to the creator of the traded token, for the
 * /stats "top creators" breakdown. Only launchpad tokens have a Token entity
 * (created in handleTokenCreated), so a swap on a non-launchpad V3 pool finds
 * no Token and is skipped -- creator fees only accrue on launchpad tokens. The
 * Creator row is upserted (defensively; the creator always exists by then).
 *
 * `pool` is the V3 pool the swap came from, or null for a curve trade. The
 * graduated-volume bucket (where the 0.05% creator pool-fee accrues) is
 * credited ONLY when the swap came from the token's OFFICIAL graduated pool
 * (tok.migratedPair) -- NOT any permissionless V3 pool a third party may have
 * created for the token, which would otherwise let anyone inflate a creator's
 * fee number by spinning up a fake USDC pool. Curve volume is never graduated.
 */
function creditCreator(token: Bytes, volumeUsdc: BigDecimal, blockTime: i32, pool: Bytes | null): void {
  const tok = Token.load(token.toHexString());
  if (tok == null) return; // not a launchpad token
  const creatorAddr = tok.creator;
  // A zero creator (only set by the defensive Migrated-before-Created branch)
  // is not a real wallet -- don't create a "0x0" creator row.
  if (creatorAddr.equals(Address.zero())) return;

  // Graduated iff this swap is on the token's official migrated pool.
  let graduated = false;
  if (pool !== null && tok.migrated) {
    const mp = tok.migratedPair;
    if (mp !== null && (mp as Bytes).equals(pool as Bytes)) {
      graduated = true;
    }
  }

  const cid = creatorAddr.toHexString();
  let c = Creator.load(cid);
  if (c == null) {
    c = new Creator(cid);
    c.tokenCount = 0;
    c.tradeCount = 0;
    c.totalVolumeUsdc = BigDecimal.fromString("0");
    c.graduatedVolumeUsdc = BigDecimal.fromString("0");
    c.firstSeenAt = blockTime;
    c.lastTradeAt = blockTime;
  }
  c.tradeCount = c.tradeCount + 1;
  c.totalVolumeUsdc = c.totalVolumeUsdc.plus(volumeUsdc);
  if (graduated) {
    c.graduatedVolumeUsdc = c.graduatedVolumeUsdc.plus(volumeUsdc);
  }
  c.lastTradeAt = blockTime;
  c.save();
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

  // Attribute this trade's volume to the token's creator (launchpad tokens
  // only; skipped for non-launchpad pools). `pool` lets creditCreator credit
  // graduated volume ONLY for the token's official migrated pool.
  creditCreator(token, volumeUsdc, blockTime, pool);

  // Per-token running aggregates + daily bucket (launchpad tokens only).
  bumpTokenAggregates(token, price, volumeUsdc, isBuy, blockTime);

  // Protocol-wide daily bucket (all sources) for the Explore hero sparklines.
  // Fee estimate by venue: V3 uses the pool's tier; V2 0.30%; everything else
  // (curve / v4 / v4curve) ~1%. This is a display estimate, not the exact
  // distributed fee (which for V4 only lands on harvest via RoyaltyPaid).
  const feeUsdc = volumeUsdc.times(feeRateForSource(source, pool));
  bumpGlobalDay(volumeUsdc, feeUsdc, blockTime);

  g.save();
}

/** Swap-fee rate (as a fraction) for a trade, by venue. */
function feeRateForSource(source: string, pool: Bytes | null): BigDecimal {
  if (source == "v3" && pool !== null) {
    const p = Pool.load((pool as Bytes).toHexString());
    if (p != null) {
      // feeTier is hundredths of a bip: 3000 => 0.30% => /1e6.
      return BigDecimal.fromString(p.feeTier.toString()).div(BigDecimal.fromString("1000000"));
    }
  }
  if (source == "v2") return BigDecimal.fromString("0.003");
  return BigDecimal.fromString("0.01"); // curve / v4 / v4curve
}

/** Upsert the protocol-wide daily bucket. */
function bumpGlobalDay(volumeUsdc: BigDecimal, feeUsdc: BigDecimal, blockTime: i32): void {
  const dayStart = dayStartOf(blockTime);
  const id = dayStart.toString();
  let d = GlobalDayData.load(id);
  if (d == null) {
    d = new GlobalDayData(id);
    d.date = dayStart;
    d.volumeUsdc = BigDecimal.fromString("0");
    d.feesUsdc = BigDecimal.fromString("0");
    d.tradeCount = 0;
  }
  d.volumeUsdc = d.volumeUsdc.plus(volumeUsdc);
  d.feesUsdc = d.feesUsdc.plus(feeUsdc);
  d.tradeCount = d.tradeCount + 1;
  d.save();
}

/** Upsert a per-pool daily bucket (Explore per-row 1D volume / daily fees). */
function bumpPoolDay(pool: Bytes, volumeUsdc: BigDecimal, feeUsdc: BigDecimal, blockTime: i32): void {
  const dayStart = dayStartOf(blockTime);
  const id = pool.toHexString() + "-" + dayStart.toString();
  let d = PoolDayData.load(id);
  if (d == null) {
    d = new PoolDayData(id);
    d.pool = pool;
    d.date = dayStart;
    d.volumeUsdc = BigDecimal.fromString("0");
    d.feesUsdc = BigDecimal.fromString("0");
    d.tradeCount = 0;
  }
  d.volumeUsdc = d.volumeUsdc.plus(volumeUsdc);
  d.feesUsdc = d.feesUsdc.plus(feeUsdc);
  d.tradeCount = d.tradeCount + 1;
  d.save();
}

/** Initialise the non-null aggregate fields on a freshly-created Token. Called
 *  at every `new Token(...)` site so the schema's non-null constraints hold. */
function initTokenAggregates(tok: Token): void {
  tok.totalVolumeUsdc = BigDecimal.fromString("0");
  tok.tradeCount = 0;
  tok.feesUsdc = BigDecimal.fromString("0");
  tok.lastPriceUsdc = BigDecimal.fromString("0");
  tok.usdcLiquidity = BigDecimal.fromString("0");
  tok.holderCount = 0;
}

/** The day-start epoch (UTC midnight) for a block timestamp. */
function dayStartOf(blockTime: i32): i32 {
  return (blockTime / 86400) * 86400;
}

/** Load or create the per-token daily bucket, seeding OHLC at `price`. */
function loadTokenDay(token: Bytes, blockTime: i32, price: BigDecimal): TokenDayData {
  const dayStart = dayStartOf(blockTime);
  const dayId = token.toHexString() + "-" + dayStart.toString();
  let d = TokenDayData.load(dayId);
  if (d == null) {
    d = new TokenDayData(dayId);
    d.token = token;
    d.date = dayStart;
    d.volumeUsdc = BigDecimal.fromString("0");
    d.feesUsdc = BigDecimal.fromString("0");
    d.tradeCount = 0;
    d.open = price;
    d.high = price;
    d.low = price;
    d.close = price;
  }
  return d;
}

/** Update a launchpad token's running volume/trade-count/last-price/liquidity
 *  and its daily bucket. No-op for a non-launchpad token (no Token row). */
function bumpTokenAggregates(
  token: Bytes,
  price: BigDecimal,
  volumeUsdc: BigDecimal,
  isBuy: boolean,
  blockTime: i32,
): void {
  const tok = Token.load(token.toHexString());
  if (tok == null) return;
  tok.totalVolumeUsdc = tok.totalVolumeUsdc.plus(volumeUsdc);
  tok.tradeCount = tok.tradeCount + 1;
  tok.lastPriceUsdc = price;
  let liq = isBuy ? tok.usdcLiquidity.plus(volumeUsdc) : tok.usdcLiquidity.minus(volumeUsdc);
  if (liq.lt(BigDecimal.fromString("0"))) liq = BigDecimal.fromString("0");
  tok.usdcLiquidity = liq;
  tok.save();

  const d = loadTokenDay(token, blockTime, price);
  d.volumeUsdc = d.volumeUsdc.plus(volumeUsdc);
  d.tradeCount = d.tradeCount + 1;
  d.close = price;
  if (price.gt(d.high)) d.high = price;
  if (price.lt(d.low)) d.low = price;
  d.save();
}

/** Credit swap fees (USDC) to a launchpad token + its daily bucket. */
function creditTokenFees(token: Bytes, feeUsdc: BigDecimal, blockTime: i32): void {
  const tok = Token.load(token.toHexString());
  if (tok == null) return;
  tok.feesUsdc = tok.feesUsdc.plus(feeUsdc);
  tok.save();

  const d = loadTokenDay(token, blockTime, tok.lastPriceUsdc);
  d.feesUsdc = d.feesUsdc.plus(feeUsdc);
  d.save();
}

/** ERC20 Transfer handler (ArcadeToken template): maintain per-holder balances
 *  + the token's live holder count. Mints (from 0) and burns (to 0) move supply
 *  in/out without counting the zero address as a holder. */
export function handleTransfer(event: Transfer): void {
  const token = event.address;
  const value = event.params.value;
  const blockTime = event.block.timestamp.toI32();
  const zero = Address.zero();

  const tok = Token.load(token.toHexString());
  let holderDelta = 0;

  // Sender: subtract (unless mint from zero).
  if (!event.params.from.equals(zero)) {
    const fromId = token.toHexString() + "-" + event.params.from.toHexString();
    let fromBal = TokenBalance.load(fromId);
    if (fromBal == null) {
      fromBal = new TokenBalance(fromId);
      fromBal.token = token;
      fromBal.holder = event.params.from;
      fromBal.balanceRaw = BigInt.fromI32(0);
    }
    const wasPositive = fromBal.balanceRaw.gt(BigInt.fromI32(0));
    fromBal.balanceRaw = fromBal.balanceRaw.minus(value);
    if (fromBal.balanceRaw.lt(BigInt.fromI32(0))) fromBal.balanceRaw = BigInt.fromI32(0);
    if (wasPositive && fromBal.balanceRaw.equals(BigInt.fromI32(0))) holderDelta -= 1;
    fromBal.lastUpdate = blockTime;
    fromBal.save();
  }

  // Recipient: add (unless burn to zero).
  if (!event.params.to.equals(zero)) {
    const toId = token.toHexString() + "-" + event.params.to.toHexString();
    let toBal = TokenBalance.load(toId);
    if (toBal == null) {
      toBal = new TokenBalance(toId);
      toBal.token = token;
      toBal.holder = event.params.to;
      toBal.balanceRaw = BigInt.fromI32(0);
    }
    const wasZero = toBal.balanceRaw.equals(BigInt.fromI32(0));
    toBal.balanceRaw = toBal.balanceRaw.plus(value);
    if (wasZero && toBal.balanceRaw.gt(BigInt.fromI32(0))) holderDelta += 1;
    toBal.lastUpdate = blockTime;
    toBal.save();
  }

  if (tok != null && holderDelta != 0) {
    tok.holderCount = tok.holderCount + holderDelta;
    if (tok.holderCount < 0) tok.holderCount = 0;
    tok.save();
  }
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
  const blockTime = event.block.timestamp.toI32();
  const tok = new Token(event.params.token.toHexString());
  tok.creator = event.params.creator;
  tok.mode = event.params.mode;
  tok.createdAt = blockTime;
  tok.migrated = false;
  tok.name = event.params.name;
  tok.symbol = event.params.symbol;
  tok.metadataURI = event.params.metadataURI;
  initTokenAggregates(tok);
  tok.save();

  // Spawn the ERC20 Transfer listener so holders index from launch.
  ArcadeToken.create(event.params.token);

  const g = loadGlobal();
  g.tokenCount = g.tokenCount + 1;
  g.save();

  // Upsert the Creator row and bump their launch count. Volume is credited
  // later, per trade, in creditCreator.
  const creatorAddr = event.params.creator;
  if (!creatorAddr.equals(Address.zero())) {
    const cid = creatorAddr.toHexString();
    let c = Creator.load(cid);
    if (c == null) {
      c = new Creator(cid);
      c.tokenCount = 0;
      c.tradeCount = 0;
      c.totalVolumeUsdc = BigDecimal.fromString("0");
      c.graduatedVolumeUsdc = BigDecimal.fromString("0");
      c.firstSeenAt = blockTime;
      // 0 = "never traded" sentinel (the non-null schema forces a value).
      // creditCreator stamps the real block time on the first trade.
      c.lastTradeAt = 0;
    }
    c.tokenCount = c.tokenCount + 1;
    c.save();
  }
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
    initTokenAggregates(tok);
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
  p.feeTier = event.params.fee;
  p.save();

  V3Pool.create(event.params.pool);
}

export function handleSwap(event: Swap): void {
  const p = Pool.load(event.address.toHexString());
  if (p == null) return; // not a tracked USDC pool

  const usdcRaw = p.usdcIsToken0 ? event.params.amount0 : event.params.amount1;
  const volumeUsdc = usdcVolume(usdcRaw);
  recordTrade(
    event,
    p.token,
    event.params.recipient, // the wallet receiving the swap output = the trader
    "v3",
    event.address,
    priceFromSqrtX96(event.params.sqrtPriceX96, p.usdcIsToken0),
    volumeUsdc,
    usdcRaw.gt(BigInt.fromI32(0)),
  );

  // Per-pool daily bucket for the Explore per-row 1D volume / daily fees / APR.
  const feeRate = BigDecimal.fromString(p.feeTier.toString()).div(BigDecimal.fromString("1000000"));
  bumpPoolDay(event.address, volumeUsdc, volumeUsdc.times(feeRate), event.block.timestamp.toI32());
}

// ===========================================================================
// V4 ArcadeHook (new fee-model launchpad). Events key by PoolId; V4Pool maps
// a PoolId back to its token so curve trades feed the same Trade/Token/Creator
// entities as V2/V3. Price is USDC(6dp)-per-token(18dp): raw6 * 1e12 / raw18.
// ===========================================================================

function priceV4(usdcRaw: BigInt, tokenRaw: BigInt): BigDecimal {
  if (tokenRaw.isZero()) return BigDecimal.fromString("0");
  const scale = BigDecimal.fromString("1000000000000"); // 1e12 (18dp - 6dp)
  return usdcRaw.toBigDecimal().times(scale).div(tokenRaw.toBigDecimal());
}

/// V4 orders currencies by numeric address, so USDC is currency0 iff its address
/// sorts below the launch token's. Both are 20-byte big-endian; compare from the
/// most-significant byte. (No string `<` in AssemblyScript, so compare bytes.)
function usdcIsCurrency0(token: Bytes): boolean {
  const u = usdcAddress();
  for (let i = 0; i < 20; i++) {
    const a = u[i];
    const b = token[i];
    if (a != b) return a < b;
  }
  return false; // equal addresses are impossible (token is never USDC)
}

/// Trades on a V4 pool AFTER it leaves the curve: PUMP post-graduation and every
/// CLANKER swap (CLANKER is a V4 pool from birth). The PoolManager is shared, so
/// skip any pool not in our V4Pool registry. The emitted amounts are the
/// SWAPPER's balance delta (v4-core emits `pool.swap`'s delta, NOT the pool's
/// despite the NatSpec): a negative USDC delta means the trader paid USDC = BUY.
/// Price comes from sqrtPriceX96 and is direction-independent.
export function handleV4Swap(event: V4Swap): void {
  const pool = V4Pool.load(event.params.id.toHexString());
  if (pool == null) return; // not one of our launches

  const usdcC0 = usdcIsCurrency0(pool.token);
  const usdcRaw = usdcC0 ? event.params.amount0 : event.params.amount1;
  // `event.params.sender` is the V4 router (it calls poolManager.swap in the
  // unlock callback), identical for every trade. `transaction.from` is the EOA
  // that submitted the swap = the real trader, which is what the UI feed and
  // per-wallet volume should attribute to.
  recordTrade(
    event,
    pool.token,
    event.transaction.from,
    "v4",
    event.address,
    priceFromSqrtX96(event.params.sqrtPriceX96, usdcC0),
    usdcVolume(usdcRaw), // abs
    usdcRaw.lt(BigInt.fromI32(0)), // trader paid USDC in = buy
  );
}

function loadFeeStats(): FeeStats {
  let f = FeeStats.load("v4");
  if (f == null) {
    f = new FeeStats("v4");
    f.creatorFeesUsdc = BigDecimal.fromString("0");
    f.treasuryFeesUsdc = BigDecimal.fromString("0");
    f.antiSnipeUsdc = BigDecimal.fromString("0");
    f.clankerHarvests = BigInt.fromI32(0);
  }
  return f;
}

export function handleLaunchCreatedV4(event: LaunchCreated): void {
  const poolIdHex = event.params.poolId.toHexString();
  const token = event.params.token;
  const creator = event.params.creator;
  const mode = event.params.mode;

  // PoolId -> token map for the curve/graduation/handle handlers.
  let p = V4Pool.load(poolIdHex);
  if (p == null) p = new V4Pool(poolIdHex);
  p.token = token;
  p.creator = creator;
  p.mode = mode;
  p.save();

  // Token lifecycle row (shared with V2/V3 stats).
  // Token row is normally created by handleTokenLaunchedV4 (emitted just before
  // LaunchCreated in the same tx, so it runs first). This is a defensive
  // fallback if that event is ever missed -- it creates WITHOUT metadata.
  const tid = token.toHexString();
  let tok = Token.load(tid);
  if (tok == null) {
    tok = new Token(tid);
    tok.creator = creator;
    tok.mode = mode;
    tok.createdAt = event.block.timestamp.toI32();
    tok.migrated = false;
    initTokenAggregates(tok);
    tok.save();

    ArcadeToken.create(token);

    const g = loadGlobal();
    g.tokenCount = g.tokenCount + 1;
    g.save();

    const cid = creator.toHexString();
    let c = Creator.load(cid);
    if (c == null) {
      c = new Creator(cid);
      c.tokenCount = 0;
      c.tradeCount = 0;
      c.totalVolumeUsdc = BigDecimal.fromString("0");
      c.graduatedVolumeUsdc = BigDecimal.fromString("0");
      c.firstSeenAt = event.block.timestamp.toI32();
      c.lastTradeAt = event.block.timestamp.toI32();
    }
    c.tokenCount = c.tokenCount + 1;
    c.save();
  }
}

/**
 * V4 token metadata + lifecycle. TokenLaunched is emitted just BEFORE
 * LaunchCreated in the same createLaunch tx, so this is the canonical creator of
 * the V4 Token row (it carries name/symbol/metadataURI + creator + mode). It
 * bumps the global/creator counts and spawns the Transfer listener; the later
 * LaunchCreated handler then only adds the PoolId->token map.
 */
export function handleTokenLaunchedV4(event: TokenLaunched): void {
  const blockTime = event.block.timestamp.toI32();
  const tid = event.params.token.toHexString();
  let tok = Token.load(tid);
  const isNew = tok == null;
  if (tok == null) {
    tok = new Token(tid);
    tok.createdAt = blockTime;
    tok.migrated = false;
    initTokenAggregates(tok);
    ArcadeToken.create(event.params.token);
  }
  tok.creator = event.params.creator;
  tok.mode = event.params.mode;
  tok.name = event.params.name;
  tok.symbol = event.params.symbol;
  tok.metadataURI = event.params.metadataURI;
  tok.save();

  if (isNew) {
    const g = loadGlobal();
    g.tokenCount = g.tokenCount + 1;
    g.save();

    if (!event.params.creator.equals(Address.zero())) {
      const cid = event.params.creator.toHexString();
      let c = Creator.load(cid);
      if (c == null) {
        c = new Creator(cid);
        c.tokenCount = 0;
        c.tradeCount = 0;
        c.totalVolumeUsdc = BigDecimal.fromString("0");
        c.graduatedVolumeUsdc = BigDecimal.fromString("0");
        c.firstSeenAt = blockTime;
        c.lastTradeAt = 0;
      }
      c.tokenCount = c.tokenCount + 1;
      c.save();
    }
  }
}

export function handleCurveBuyV4(event: CurveBuy): void {
  const p = V4Pool.load(event.params.poolId.toHexString());
  if (p == null) return;
  recordTrade(
    event,
    p.token,
    event.params.buyer,
    "v4curve",
    null,
    priceV4(event.params.grossUsdcIn, event.params.tokensOut),
    usdcVolume(event.params.grossUsdcIn),
    true,
  );
}

export function handleCurveSellV4(event: CurveSell): void {
  const p = V4Pool.load(event.params.poolId.toHexString());
  if (p == null) return;
  recordTrade(
    event,
    p.token,
    event.params.seller,
    "v4curve",
    null,
    priceV4(event.params.usdcOut, event.params.tokensIn),
    usdcVolume(event.params.usdcOut),
    false,
  );
}

export function handleGraduatedV4(event: Graduated): void {
  const p = V4Pool.load(event.params.poolId.toHexString());
  if (p == null) return;
  const tok = Token.load(p.token.toHexString());
  if (tok == null) return;
  if (!tok.migrated) {
    tok.migrated = true;
    tok.migratedAt = event.block.timestamp.toI32();
    tok.save();
    const g = loadGlobal();
    g.graduatedCount = g.graduatedCount + 1;
    g.save();
  }
}

export function handleRoyaltyPaidV4(event: RoyaltyPaid): void {
  // A CLANKER harvest emits RoyaltyPaid for BOTH currencies; the token side
  // carries an 18dp launch-token amount that would corrupt the 6dp USDC tally.
  // Only fold the USDC side into the fee stats.
  if (!event.params.currency.equals(usdcAddress())) return;
  const creatorFee = usdcVolume(event.params.creatorAmount);
  const treasuryFee = usdcVolume(event.params.treasuryAmount);
  const f = loadFeeStats();
  f.creatorFeesUsdc = f.creatorFeesUsdc.plus(creatorFee);
  f.treasuryFeesUsdc = f.treasuryFeesUsdc.plus(treasuryFee);
  f.save();

  // Per-token fee total (creator + treasury) + its daily bucket.
  const p = V4Pool.load(event.params.poolId.toHexString());
  if (p != null) {
    creditTokenFees(p.token, creatorFee.plus(treasuryFee), event.block.timestamp.toI32());
  }
}

export function handleFeeHarvestedV4(event: FeeHarvested): void {
  // A CLANKER collectFees ran; the USDC value is captured via the paired
  // RoyaltyPaid (USDC side). Record the harvest count for ops visibility.
  const f = loadFeeStats();
  f.clankerHarvests = f.clankerHarvests.plus(BigInt.fromI32(1));
  f.save();
}

export function handleAntiSnipeV4(event: AntiSnipeApplied): void {
  const f = loadFeeStats();
  f.antiSnipeUsdc = f.antiSnipeUsdc.plus(usdcVolume(event.params.amount));
  f.save();
}

export function handleFeeAttributedV4(event: FeeAttributedToHandle): void {
  const poolIdHex = event.params.poolId.toHexString();
  let h = HandleAttribution.load(poolIdHex);
  if (h == null) h = new HandleAttribution(poolIdHex);
  const p = V4Pool.load(poolIdHex);
  h.token = p == null ? Address.zero() : p.token;
  h.handle = event.params.handle;
  h.escrow = event.params.escrow;
  h.createdAt = event.block.timestamp.toI32();
  h.save();
}

// ---- Twitter escrow: per-slot claimable balance ----

function escrowSlotId(positionId: BigInt, slotIndex: BigInt, token: Address): string {
  return positionId.toHexString() + "-" + slotIndex.toString() + "-" + token.toHexString();
}

export function handleEscrowCredited(event: Credited): void {
  const id = escrowSlotId(event.params.positionId, event.params.slotIndex, event.params.token);
  let s = EscrowSlot.load(id);
  if (s == null) {
    s = new EscrowSlot(id);
    s.positionId = event.params.positionId;
    s.slotIndex = event.params.slotIndex;
    s.token = event.params.token;
    s.credited = BigDecimal.fromString("0");
    s.claimed = BigDecimal.fromString("0");
    s.balance = BigDecimal.fromString("0");
  }
  const amt = usdcVolume(event.params.amount);
  s.credited = s.credited.plus(amt);
  s.balance = s.balance.plus(amt);
  s.lastUpdate = event.block.timestamp.toI32();
  s.save();
}

export function handleEscrowClaimed(event: Claimed): void {
  const id = escrowSlotId(event.params.positionId, event.params.slotIndex, event.params.token);
  let s = EscrowSlot.load(id);
  if (s == null) {
    s = new EscrowSlot(id);
    s.positionId = event.params.positionId;
    s.slotIndex = event.params.slotIndex;
    s.token = event.params.token;
    s.credited = BigDecimal.fromString("0");
    s.claimed = BigDecimal.fromString("0");
    s.balance = BigDecimal.fromString("0");
  }
  // A claim sweeps the whole slot balance to zero.
  s.claimed = s.claimed.plus(usdcVolume(event.params.amount));
  s.balance = BigDecimal.fromString("0");
  s.lastUpdate = event.block.timestamp.toI32();
  s.save();
}
