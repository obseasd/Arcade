import { Address, isAddress, zeroAddress } from "viem";

function safeAddress(v: string | undefined): Address {
  // Trim whitespace + drop strict EIP-55 checksum validation. Without
  // .trim(), an env var pasted with a trailing newline / leading space
  // / invisible unicode in the Vercel dashboard fails `isAddress` and
  // safeAddress silently falls back to zeroAddress - so every approve /
  // contract write in the app targets the zero address (the failed
  // launch creation fee approve at tx 0x4229b9... is exactly this).
  // {strict: false} keeps the check on hex shape only (length + 0x +
  // hex chars), not on EIP-55 mixed-case casing - we don't gain
  // anything by enforcing checksums on env input we control, and the
  // strict default in viem 2.21+ rejects lowercase addresses that
  // would otherwise be valid.
  if (!v) return zeroAddress;
  const trimmed = v.trim();
  return isAddress(trimmed, { strict: false }) ? (trimmed as Address) : zeroAddress;
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
  /** ArcadeAutoCompounder: V3 LP custody vault that auto-collects fees and
   *  either pushes them to the depositor wallet (RECEIVE mode) or
   *  re-deposits them into the position (COMPOUND mode). Optional — the
   *  Auto-management section on /positions is hidden when zeroAddress. */
  autoCompounder: safeAddress(process.env.NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS),
  /** ArcadeIdentityIssuer: on-chain tier verifier wrapping the ERC-8004
   *  Identity Registry. Audit 2026-06-18 H-09 fix. When zeroAddress, the
   *  Identity mint UI falls back to direct Registry.mint (client-side
   *  tier gate only). Set this once the Issuer is deployed and the
   *  Registry has been re-configured to accept calls only from the
   *  Issuer. */
  identityIssuer: safeAddress(process.env.NEXT_PUBLIC_ARCADE_IDENTITY_ISSUER_ADDRESS),
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
  /** CCTP V2 "bridge and buy" landing contract on Arc (ArcadeCctpBuyReceiver).
   *  Curve -> AMM (frontend-chosen venue: V2 router OR V3 router+fee for ETH)
   *  -> refund. Also skims the fast-transfer bridge fee: it pins the ALL-IN
   *  cost to 0.05% of the burned amount by reading Circle's own `feeExecuted`
   *  and `finalityThresholdExecuted` off the ATTESTED message, so standard
   *  transfers stay free and we never exceed the advertised 0.05%.
   *  Redeployed 2026-07-15: the previous build (0x9E87B0) was the PRE-fix
   *  bytecode -- it still hard-transferred the fee to the immutable treasury
   *  (a blacklist there would have made every in-flight transfer permanently
   *  unmintable, since destinationCaller is pinned and there is no rescue) and
   *  still used `<` length checks (so receiveAndForward accepted a BUY message
   *  and anyone could front-run a user's buy to cancel it for the price of
   *  gas). pendingFees/claimFees/pfBefore/exact-lengths existed only in source
   *  for four commits. This build also adds the attested buyDeadline.
   *  Env-overridable. */
  cctpBuyReceiver: (process.env.NEXT_PUBLIC_CCTP_BUY_RECEIVER ??
    "0x939440Dd711499f26e101261cB956AA80E6B6fA2") as Address,
  /** ArcadeIncentiveDistributor: escrow-backed liquidity-incentive campaigns
   *  (Merkl-style) — the on-chain backend for /swap/incentivize. Deployed
   *  2026-07-11; env-overridable. When zeroAddress the incentivize form falls
   *  back to its "contact ops" placeholder. */
  incentiveDistributor: (process.env.NEXT_PUBLIC_INCENTIVE_DISTRIBUTOR ??
    "0xa8fA80926A9145160A7e6Cb811E5B538F1305698") as Address,
  /** Every receiver we have deployed, newest first, WITH the buy-message size
   *  that generation produced. A burn commits its mintRecipient on the SOURCE
   *  chain, so a transfer in flight when we redeploy still names the OLD
   *  receiver, and destinationCaller is pinned to it -- nobody else can rescue
   *  it. The Iris gates and the claim router therefore both have to recognise
   *  historical receivers.
   *
   *  The size is NOT constant across generations, which is the whole reason
   *  this carries a length instead of just an address: hookData grew 96 -> 128
   *  -> 192 bytes as the buy route gained the best-venue router and then the V3
   *  leg, and message length is exactly 376 + hookDataLen. An earlier version
   *  of this comment claimed "the entrypoints are identical across versions",
   *  which was simply false: an allowlist keyed on address alone admitted those
   *  messages past the gates and then failed to route them, which is worse than
   *  rejecting them early.
   *
   *  `forwardBytes` is 0 where that generation predates receiveAndForward (it
   *  shipped with 0x9E87), so a plain fee-forward claim can only ever name the
   *  current receiver anyway.
   *  APPEND on every redeploy; never remove an entry. */
  cctpBuyReceivers: [
    // Each entry's buyBytes is HOOK_DATA_OFFSET(376) + that build's
    // HOOK_DATA_LEN, read from the commit that deployed it. Audit 2026-07-15:
    // the first version of this table was SHIFTED BY ONE GENERATION (0x6654 got
    // 0xad17's 504, 0xad17 got 0xca001f's 472) and omitted 0xca001f entirely --
    // real sizes bound to the wrong addresses, which is worse than a wrong
    // guess because each value looks defensible. Verified pairing:
    //   8ee2776 -> 0xca001f, LEN  96 -> 472
    //   968ebb9 -> 0xad17aa, LEN 128 -> 504
    //   95cda63 -> 0x6654C0, LEN 192 -> 568
    //   597c90c -> 0x9E87B0, LEN 192 -> 568
    //   (r4)    -> 0x939440, LEN 224 -> 600  (+buyDeadline)
    { address: "0x939440Dd711499f26e101261cB956AA80E6B6fA2", buyBytes: 600, forwardBytes: 408 },
    { address: "0x9E87B0732BAA1aB0e001A220b505720971ED3621", buyBytes: 568, forwardBytes: 408 },
    { address: "0x6654C0763DBC49f3943c18478e3d32c209B2D427", buyBytes: 568, forwardBytes: 0 },
    { address: "0xad17aadea14248c25d405f5e85aee45a729e9f76", buyBytes: 504, forwardBytes: 0 },
    { address: "0xca001f73e117494711386e0e6e77ef7b984eae15", buyBytes: 472, forwardBytes: 0 },
  ] as readonly { address: Address; buyBytes: number; forwardBytes: number }[],
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
  /** Community USDT on Arc testnet — 18 decimals (NOT the canonical
   *  6-decimal Tether mainnet shape). User-confirmed deployment with
   *  ~232k holders. Verify integration math against the real on-chain
   *  decimals before relying on quotes. */
  usdt: "0x175CdB1D338945f0D851A741ccF787D343E57952" as Address,
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
  // --- UnitFlow (Uniswap V3 fork on Arc testnet) ---
  // Standard Uniswap V3 interfaces with name rebrand (UnitFlowV3*).
  // ACTIVE deployment (the previous 0xb0bCabE... factory has NO pools —
  // it is an unused duplicate. Use 0xAb6A... as the live one).
  // All V3 pools route through WUSDC (0x911b...) instead of native USDC
  // (0x3600...), so USDC↔X swaps require a wrap step via UniversalRouter
  // — handled in the UnitFlow provider's executor branch.
  /** UnitFlow V3 Factory (active, has pools). */
  unitflowFactory: "0xAb6A8AAb7d490007634ef59d424b5d89688a1971" as Address,
  /** UnitFlow V3 SwapRouter02 (bound to active factory). */
  unitflowRouter: "0xB0Ba24f9C49D933523219e92528E7e5db93e9AFc" as Address,
  /** UnitFlow V3 QuoterV2 (bound to active factory). */
  unitflowQuoter: "0x121aeB6DEf00F6F67665008CaC1C19805886ed1a" as Address,
  /** UnitFlow V3 NonfungiblePositionManager (NPM). */
  unitflowNpm: "0x0553682bc188b850acd31CBd3500Dcd0aa35372B" as Address,
  /** UnitFlow UniversalRouter — required for USDC↔X swaps that need a
   *  WRAP_ETH + V3_SWAP + SWEEP command stream. */
  unitflowUniversalRouter: "0xEaF3195bE51861632cd32850973C9515DA48e76F" as Address,
  /** WUSDC (Wrapped USDC, 18 dec) — UnitFlow + Synthra pools route
   *  through this instead of the native 6-dec USDC. */
  wusdc: "0x911b4000D3422F482F4062a913885f7b035382Df" as Address,
  // --- XyloNet (StableSwap with V2-style router on Arc testnet) ---
  // Curve-style invariant inside the pool but Uniswap-V2-shaped router
  // (swapExactTokensForTokens + getAmountsOut + path[] addressing).
  // Accepts native USDC directly — NO wrap step required, unlike
  // Synthra/UnitFlow. Currently only supports the stablecoin matrix
  // (USDC, EURC, USYC). No USDT, no cirBTC pools.
  /** XyloRouter (V2-style ABI fronting the StableSwap pool). */
  xyloRouter: "0x73742278c31a76dbb0d2587d03ef92e6e2141023" as Address,
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
