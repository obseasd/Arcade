import { BigInt, BigDecimal, Address, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { Buy, Sell, TokenCreated, Migrated } from "../generated/Launchpad/Launchpad";
import { PoolCreated } from "../generated/V3Factory/V3Factory";
import { Swap } from "../generated/templates/V3Pool/V3Pool";
import { V3Pool } from "../generated/templates";
import {
  LaunchCreated,
  CurveBuy,
  CurveSell,
  Graduated,
  RoyaltyPaid,
  AntiSnipeApplied,
  FeeAttributedToHandle,
} from "../generated/ArcadeHookV4/ArcadeHook";
import { Credited, Claimed } from "../generated/TwitterEscrowV4/ArcadeTwitterEscrowV4";
import {
  Trade,
  Pool,
  Trader,
  Token,
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
  const blockTime = event.block.timestamp.toI32();
  const tok = new Token(event.params.token.toHexString());
  tok.creator = event.params.creator;
  tok.mode = event.params.mode;
  tok.createdAt = blockTime;
  tok.migrated = false;
  tok.save();

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

function loadFeeStats(): FeeStats {
  let f = FeeStats.load("v4");
  if (f == null) {
    f = new FeeStats("v4");
    f.creatorFeesUsdc = BigDecimal.fromString("0");
    f.treasuryFeesUsdc = BigDecimal.fromString("0");
    f.antiSnipeUsdc = BigDecimal.fromString("0");
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
  const tid = token.toHexString();
  let tok = Token.load(tid);
  if (tok == null) {
    tok = new Token(tid);
    tok.creator = creator;
    tok.mode = mode;
    tok.createdAt = event.block.timestamp.toI32();
    tok.migrated = false;
    tok.save();

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
  const f = loadFeeStats();
  f.creatorFeesUsdc = f.creatorFeesUsdc.plus(usdcVolume(event.params.creatorAmount));
  f.treasuryFeesUsdc = f.treasuryFeesUsdc.plus(usdcVolume(event.params.treasuryAmount));
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
