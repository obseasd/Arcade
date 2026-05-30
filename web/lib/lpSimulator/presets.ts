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
];

export const DEFAULT_PRESET_ID = "standard";

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}
