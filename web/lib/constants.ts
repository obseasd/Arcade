import { Address, isAddress, zeroAddress } from "viem";

function safeAddress(v: string | undefined): Address {
  return v && isAddress(v) ? (v as Address) : zeroAddress;
}

export const ADDRESSES = {
  usdc: safeAddress(process.env.NEXT_PUBLIC_USDC_ADDRESS),
  factory: safeAddress(process.env.NEXT_PUBLIC_V2_FACTORY_ADDRESS),
  router: safeAddress(process.env.NEXT_PUBLIC_V2_ROUTER_ADDRESS),
  /** ArcadeV2Zap: single-asset add-liquidity helper. Optional - the Single
   *  Asset tab in /positions/add is hidden when this is zeroAddress. */
  v2Zap: safeAddress(process.env.NEXT_PUBLIC_V2_ZAP_ADDRESS),
  launchpad: safeAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS),
  multiSwap: safeAddress(process.env.NEXT_PUBLIC_MULTISWAP_ADDRESS),
  // Uniswap V3 fork (CLANKER_V3 locked-LP tokens)
  v3Factory: safeAddress(process.env.NEXT_PUBLIC_V3_FACTORY_ADDRESS),
  v3Router: safeAddress(process.env.NEXT_PUBLIC_V3_ROUTER_ADDRESS),
  v3Quoter: safeAddress(process.env.NEXT_PUBLIC_V3_QUOTER_ADDRESS),
  v3Locker: safeAddress(process.env.NEXT_PUBLIC_V3_LOCKER_ADDRESS),
  /** ArcadeV3PositionManager (Uniswap V3 NPM rebrand). Optional - the V3
   *  branch of /positions/add is gated when zeroAddress. */
  v3PositionManager: safeAddress(process.env.NEXT_PUBLIC_V3_NPM_ADDRESS),
  tokenVault: safeAddress(process.env.NEXT_PUBLIC_TOKEN_VAULT_ADDRESS),
  /** WETH on Arc, used as the paired token for POOL_WETH Clanker launches. */
  weth: safeAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS),
  /** ArcadeTwitterEscrow: holds Clanker LP fees attributed to a Twitter @handle. */
  twitterEscrow: safeAddress(process.env.NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS),
  // --- Uniswap V4 prototype (ArcadeV4Launchpad + ArcadeAntiSniperHook) ---
  // Original 2-step (createLaunch then initializePool) flow, behind
  // NEXT_PUBLIC_V4_ENABLED. Superseded by the ArcadeHook production stack
  // below but kept for the existing /launchpad/v4 prototype pages.
  v4PoolManager: safeAddress(process.env.NEXT_PUBLIC_V4_POOL_MANAGER_ADDRESS),
  v4Launchpad: safeAddress(process.env.NEXT_PUBLIC_V4_LAUNCHPAD_ADDRESS),
  v4Hook: safeAddress(process.env.NEXT_PUBLIC_V4_HOOK_ADDRESS),
  v4StateView: safeAddress(process.env.NEXT_PUBLIC_V4_STATE_VIEW_ADDRESS),
  v4Quoter: safeAddress(process.env.NEXT_PUBLIC_V4_QUOTER_ADDRESS),
  v4Router: safeAddress(process.env.NEXT_PUBLIC_V4_ROUTER_ADDRESS),
  // --- ArcadeHook production stack (V4 Phase 2, behind NEXT_PUBLIC_V4_HOOK_ENABLED) ---
  // Unified hook subsuming launchpad + V2 stack + V3 locker. Uses atomic
  // createLaunch + direct hook.buy/hook.sell during Curving phase.
  /** ArcadeHook: production V4 hook for the bonding-curve launchpad. */
  arcadeHook: safeAddress(process.env.NEXT_PUBLIC_ARCADE_HOOK_ADDRESS),
  /** LockedVault: immutable holder of ERC-6909 graduation-seed LP receipts. */
  lockedVault: safeAddress(process.env.NEXT_PUBLIC_LOCKED_VAULT_ADDRESS),
  // --- Orbs TWAP / dLIMIT stack (limit orders, Arc testnet) ---
  /** TWAP main contract. Receives ask() calls, holds the order book. */
  orbsTwap: safeAddress(process.env.NEXT_PUBLIC_ORBS_TWAP_ADDRESS),
  /** ExchangeV2 adapter wrapping ArcadeV2Router. Used by takers at fill time. */
  orbsExchangeV2: safeAddress(process.env.NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS),
  /** Lens read-only helper for the frontend. */
  orbsLens: safeAddress(process.env.NEXT_PUBLIC_ORBS_LENS_ADDRESS),
} as const;

/** True iff Orbs limit orders are wired in this env. Gates the Limit tab. */
export const LIMIT_ORDERS_ENABLED: boolean =
  !!process.env.NEXT_PUBLIC_ORBS_TWAP_ADDRESS &&
  !!process.env.NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS;

/** True iff the V4 prototype stack is enabled in this env. Gates the
 *  /launchpad/v4 wizard pages. Independent of the ArcadeHook production
 *  flag below so the two surfaces can coexist during the migration window. */
export const V4_ENABLED: boolean =
  process.env.NEXT_PUBLIC_V4_ENABLED === "1" || process.env.NEXT_PUBLIC_V4_ENABLED === "true";

/** True iff the ArcadeHook production stack is wired. Gates the new V4
 *  surfaces that target the unified ArcadeHook contract (atomic createLaunch
 *  + hook.buy / hook.sell). Requires both the hook address AND the locked
 *  vault to be set, since the deploy script always provisions them as a pair. */
export const V4_HOOK_ENABLED: boolean =
  !!process.env.NEXT_PUBLIC_ARCADE_HOOK_ADDRESS &&
  !!process.env.NEXT_PUBLIC_LOCKED_VAULT_ADDRESS;

/** V4 pool params used for every Arcade launch (1% fee tier). */
export const V4_POOL_FEE = 10_000;
export const V4_TICK_SPACING = 200;

/** V3 fee tier used for all CLANKER_V3 pools (1%). */
export const V3_FEE = 10_000;

/** Hard cap on inputs to the multi-token swap UI. The on-chain contract
 * caps at MAX_INPUTS=8; the UI uses a lower cap (5) for ergonomic reasons. */
export const MULTISWAP_MAX_INPUTS = 5;

export const USDC_DECIMALS = 6;
export const LAUNCHPAD_TOKEN_DECIMALS = 18;
export const LAUNCHPAD_TOTAL_SUPPLY = 1_000_000_000n; // 1B fixed supply
export const TRADE_FEE_BPS = 100; // 1% total - split 0.5% platform + 0.5% creator
export const CREATION_FEE_USDC = 3_000_000n; // 3 USDC (6 decimals)

/** Featured token addresses surfaced at the top of the launchpad list. Set via
 * `NEXT_PUBLIC_FEATURED_TOKENS` (comma-separated lowercase addresses). Empty by
 * default — admin-curated promotion only. */
export const FEATURED_TOKENS: ReadonlySet<string> = new Set(
  (process.env.NEXT_PUBLIC_FEATURED_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
);

export enum LaunchMode {
  PUMP = 0, // 50% Arcade / 50% creator(s), bonding curve -> V2 burn
  CLANKER = 1, // 70% Arcade / 30% creator(s), bonding curve -> V2 burn
  CLANKER_V3 = 2, // no curve: full supply locked single-sided in V3, creator earns 80% LP fees
}
