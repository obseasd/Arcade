/**
 * Canonical event signatures shared across hooks. Centralises the
 * parseAbiItem calls that previously lived in 4+ files (useLaunchpadVolume,
 * useTokenCandles, useTokenTrades, web/app/launchpad/[address]/page.tsx).
 *
 * Any rename or arg change in a contract event ripples through one edit
 * here instead of N edits across the hooks.
 */

import { parseAbiItem } from "viem";

/** Launchpad bonding-curve buy. Emitted by Arcade + Clanker launchpads. */
export const BUY_EVT = parseAbiItem(
    "event Buy(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 newPriceQ64)",
);

/** Launchpad bonding-curve sell. */
export const SELL_EVT = parseAbiItem(
    "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 newPriceQ64)",
);

/** V3 pool Swap. Used for post-migration price + volume scans. */
export const V3_SWAP_EVT = parseAbiItem(
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

/** Launchpad token creation. ArcadeLaunchpad event. */
export const TOKEN_CREATED_EVT = parseAbiItem(
    "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);

/** ArcadeHook V4 launch event. */
export const TOKEN_LAUNCHED_EVT = parseAbiItem(
    "event TokenLaunched(address indexed token, address indexed creator, uint8 mode, string name, string symbol, string metadataURI)",
);

/** ArcadeHook curve-graduation event. */
export const GRADUATED_EVT = parseAbiItem(
    "event Graduated(bytes32 indexed poolId, uint256 finalUsdcReserve, uint256 tokensInLP)",
);

/** Locker recipient payout. Used by the creator earnings dashboard. */
export const RECIPIENT_PAID_EVT = parseAbiItem(
    "event RecipientPaid(uint256 indexed positionId, uint256 indexed slotIndex, address indexed token, address recipient, uint256 amount)",
);
