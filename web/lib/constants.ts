import { Address, isAddress, zeroAddress } from "viem";

function safeAddress(v: string | undefined): Address {
  return v && isAddress(v) ? (v as Address) : zeroAddress;
}

export const ADDRESSES = {
  usdc: safeAddress(process.env.NEXT_PUBLIC_USDC_ADDRESS),
  factory: safeAddress(process.env.NEXT_PUBLIC_V2_FACTORY_ADDRESS),
  router: safeAddress(process.env.NEXT_PUBLIC_V2_ROUTER_ADDRESS),
  launchpad: safeAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS),
  multiSwap: safeAddress(process.env.NEXT_PUBLIC_MULTISWAP_ADDRESS),
  // Uniswap V3 fork (CLANKER_V3 locked-LP tokens)
  v3Factory: safeAddress(process.env.NEXT_PUBLIC_V3_FACTORY_ADDRESS),
  v3Router: safeAddress(process.env.NEXT_PUBLIC_V3_ROUTER_ADDRESS),
  v3Quoter: safeAddress(process.env.NEXT_PUBLIC_V3_QUOTER_ADDRESS),
  v3Locker: safeAddress(process.env.NEXT_PUBLIC_V3_LOCKER_ADDRESS),
  tokenVault: safeAddress(process.env.NEXT_PUBLIC_TOKEN_VAULT_ADDRESS),
  /** WETH on Arc, used as the paired token for POOL_WETH Clanker launches. */
  weth: safeAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS),
  /** ArcadeTwitterEscrow: holds Clanker LP fees attributed to a Twitter @handle. */
  twitterEscrow: safeAddress(process.env.NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS),
} as const;

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
