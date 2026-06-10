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
  /** ArcadeV3Zap: single-asset zap into a max-range V3 position. Optional -
   *  the Single Asset tab on /positions/add v3 surfaces only when this is
   *  set. Mirrors Hyperswap's max-range-only constraint (full-range
   *  positions split half-and-half by value, narrow ranges need a closed
   *  form). */
  v3Zap: safeAddress(process.env.NEXT_PUBLIC_V3_ZAP_ADDRESS),
  tokenVault: safeAddress(process.env.NEXT_PUBLIC_TOKEN_VAULT_ADDRESS),
  /** WETH on Arc, used as the paired token for POOL_WETH Clanker launches. */
  weth: safeAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS),
  /** SeedETH (testnet ERC20 symbol "ETH"). Lives across V2 factory
   *  generations as a plain ERC20; pin it in token pickers so the user can
   *  pair it without pasting the address. Optional — keep zeroAddress on
   *  mainnet so the picker doesn't show a phantom ETH chip. */
  seedEth: safeAddress(process.env.NEXT_PUBLIC_SEED_ETH_ADDRESS),
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
  // --- Canonical Circle tokens on Arc testnet (well-known, hardcoded) ---
  /** Circle Euro stablecoin on Arc testnet. 6 decimals like USDC. */
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Address,
  /** Circle-wrapped BTC ("cirBTC") on Arc testnet. 8 decimals. */
  cirBtc: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF" as Address,
  // --- Synthra (Uniswap V3 fork on Arc testnet, alternate swap route) ---
  /** Synthra V3 Factory (canonical Uniswap V3 ABI). */
  synthraFactory: "0x0fB6EEDA6e90E90797083861A75D15752a27f59c" as Address,
  /** Synthra SwapRouter02 (Uniswap V3 swap router). */
  synthraRouter: "0xA545bCB1Bd7985c59ea162aB1748A0803434C31b" as Address,
  /** Synthra QuoterV2 (gives exact-in / exact-out quotes per pool). */
  synthraQuoter: "0x3Ce954107b1A675826B33bF23060Dd655e3758fE" as Address,
  /** Synthra UniversalRouter (used by their app for routed swaps). */
  synthraUniversalRouter: "0xbf4479C07Dc6fdc6dAa764A0ccA06969e894275F" as Address,
  /** Synthra Wrapped USDC (their canonical "ETH-equivalent" — 18 dec). */
  synthraWusdc: "0x911b4000D3422F482F4062a913885f7b035382Df" as Address,
  // --- UnitFlow (Uniswap V3 + V4 fork on Arc testnet) ---
  // Standard Uniswap V3 interfaces with name rebrand (UnitFlowV3*).
  // POOL_INIT_CODE_HASH differs from canonical so do NOT reuse Synthra's.
  /** UnitFlow V3 Factory. */
  unitflowFactory: "0xb0bCabE107e9e37b34900667fa4ded4Df7e910CB" as Address,
  /** UnitFlow V3 SwapRouter. */
  unitflowRouter: "0x75eDe46A468Eb600C10982e6FdCeADCB37a40930" as Address,
  /** UnitFlow V3 QuoterV2. */
  unitflowQuoter: "0x09ea20bC7Fbb42C202b2Fa108365ccB15165Dc53" as Address,
  /** UnitFlow V3 NonfungiblePositionManager (NPM). */
  unitflowNpm: "0xf8ecf496D9c31Cbf2aEa4DEc32471851A5c95181" as Address,
  // XyloNet addresses pending — ForgeLabs has not published their
  // StableSwap contracts; the docs site marks GitHub as "Soon". When
  // addresses land, add xylonetFactory / xylonetRouter / xylonetPool
  // here and wire a provider mirroring synthraV3.
} as const;

/** Synthra V3 routing fee tiers (Uniswap V3 standard: 0.01% / 0.05% / 0.3% / 1%). */
export const SYNTHRA_V3_FEES = [100, 500, 3_000, 10_000] as const;

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
export const V4_TICK_SPACING = 200;

/** V3 fee tier used for all CLANKER_V3 pools (1%). */
export const V3_FEE = 10_000;

/** Hard cap on inputs to the multi-token swap UI. The on-chain contract
 * caps at MAX_INPUTS=8; the UI uses a lower cap (5) for ergonomic reasons. */
export const MULTISWAP_MAX_INPUTS = 5;

export const USDC_DECIMALS = 6;
export const LAUNCHPAD_TOKEN_DECIMALS = 18;
export const LAUNCHPAD_TOTAL_SUPPLY = 1_000_000_000n; // 1B fixed supply
export const CREATION_FEE_USDC = 3_000_000n; // 3 USDC (6 decimals)

/**
 * Bonding-curve protocol constants. Single source of truth for the
 * frontend - mirrors contracts/v4src/libraries/ArcadeV4Curve.sol and
 * contracts/src/launchpad/ArcadeLaunchpad.sol.
 *
 * Audit ARCH-002: these were previously hard-coded across 6+ files
 * under 5 different local names (`CURVE_SUPPLY`, `ARC_HOOK_CURVE_SUPPLY`,
 * `GRAD_USDC`, `ARC_HOOK_GRAD_USDC`, `V4_GRAD_USDC`,
 * `MIGRATION_TARGET_FALLBACK`). Drift between files would show one
 * progress bar at 80% on the same token another shows at 64%. Update
 * here and every page picks it up.
 *
 * - `LAUNCHPAD_CURVE_SUPPLY`: tokens allocated to the bonding curve
 *   itself (separate from the 200M-token migration-LP allocation).
 *   Sold-out at 800M raised.
 * - `LAUNCHPAD_GRADUATION_USDC`: USDC raised threshold that triggers
 *   migration to V2 LP (V2/V3 launches) or to a single-sided V4
 *   position (V4 hook launches).
 */
export const LAUNCHPAD_CURVE_SUPPLY = 800_000_000n * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);
export const LAUNCHPAD_GRADUATION_USDC = 20_000n * 10n ** BigInt(USDC_DECIMALS);

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
