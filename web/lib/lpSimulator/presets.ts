import type { SimulatorConfig } from "./math";

export interface PresetDef {
  id: string;
  label: string;
  description: string;
  config: SimulatorConfig;
}

const ZERO_ALLOC = { airdropPct: 0, vaultPct: 0, presalePct: 0 } as const;

/**
 * Match the launchpad's actual POOL_TYPE configurations (Standard, Legacy, Deep,
 * WETH) so users can preview how each behaves before they hit the launch form.
 * Numbers are illustrative — the on-chain LP ranges are encoded in the locker.
 */
export const PRESETS: PresetDef[] = [
  {
    id: "legacy",
    label: "Legacy (Single Position)",
    description: "One wide range. Smoother but less granular price discovery.",
    config: {
      totalSupply: 1_000_000_000,
      startingMcap: 30_000,
      feeBps: 100,
      ...ZERO_ALLOC,
      positions: [{ lowerMcap: 30_000, upperMcap: 1_500_000_000, pctOfPool: 1 }],
    },
  },
  {
    id: "standard",
    label: "Standard ($35k)",
    description: "3 positions, USDC-paired. Default pump-style launch.",
    config: {
      totalSupply: 1_000_000_000,
      startingMcap: 35_000,
      feeBps: 100,
      ...ZERO_ALLOC,
      positions: [
        { lowerMcap: 35_000, upperMcap: 500_000, pctOfPool: 0.45 },
        { lowerMcap: 500_000, upperMcap: 50_000_000, pctOfPool: 0.40 },
        { lowerMcap: 50_000_000, upperMcap: 1_500_000_000, pctOfPool: 0.15 },
      ],
    },
  },
  {
    id: "deep",
    label: "Deep ($50k)",
    description: "Higher starting cap with thicker mid-range liquidity.",
    config: {
      totalSupply: 1_000_000_000,
      startingMcap: 50_000,
      feeBps: 100,
      ...ZERO_ALLOC,
      positions: [
        { lowerMcap: 50_000, upperMcap: 750_000, pctOfPool: 0.40 },
        { lowerMcap: 750_000, upperMcap: 75_000_000, pctOfPool: 0.45 },
        { lowerMcap: 75_000_000, upperMcap: 2_000_000_000, pctOfPool: 0.15 },
      ],
    },
  },
  {
    // Uniswap V4 launches use ONE single-sided position locked from just
    // above the starting tick all the way to MAX_TICK. The full pool supply
    // (after the optional creator allocation deduction) sits in that one
    // range. There's no choice of multiple bands - the locker bakes it in.
    //
    // Anti-sniper tax decay isn't modeled in the math layer (it's a hook,
    // not a position shape), but the description below tells the user what
    // to expect during the first N minutes after launch.
    id: "v4-single-sided",
    label: "V4 Single-Sided",
    description:
      "V4 anti-sniper launch: full supply in ONE position from launch price up. Creator allocation up to 10%; the rest locks single-sided. Early buys pay a decaying snipe tax (configured on the wizard, not here).",
    config: {
      totalSupply: 1_000_000_000,
      startingMcap: 50_000,
      feeBps: 100,
      // Creator allocation goes out of the pool (modeled as vault carve-out so
      // the chart shows fewer tokens in the bonding range). Default 0%; the
      // user can tweak via the sidebar to see the impact on price discovery.
      airdropPct: 0,
      vaultPct: 0,
      presalePct: 0,
      positions: [
        // tickUpper = MAX_TICK (~887272), expressed as mcap. Picked at $10B
        // so the chart axis stays readable; a real V4 position extends to
        // ~e^(MAX_TICK * 1e-4) * startingMcap which dwarfs the screen.
        { lowerMcap: 50_000, upperMcap: 10_000_000_000, pctOfPool: 1 },
      ],
    },
  },
];

export const DEFAULT_PRESET_ID = "standard";

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}
