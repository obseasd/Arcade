import { Address, isAddress, zeroAddress } from "viem";

function safeAddress(v: string | undefined): Address {
  return v && isAddress(v) ? (v as Address) : zeroAddress;
}

export const ADDRESSES = {
  usdc: safeAddress(process.env.NEXT_PUBLIC_USDC_ADDRESS),
  factory: safeAddress(process.env.NEXT_PUBLIC_V2_FACTORY_ADDRESS),
  router: safeAddress(process.env.NEXT_PUBLIC_V2_ROUTER_ADDRESS),
  launchpad: safeAddress(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS),
} as const;

export const USDC_DECIMALS = 6;
export const LAUNCHPAD_TOKEN_DECIMALS = 18;
export const LAUNCHPAD_TOTAL_SUPPLY = 1_000_000_000n; // 1B fixed supply
export const TRADE_FEE_BPS = 100; // 1% total — split 0.5% platform + 0.5% creator
export const CREATION_FEE_USDC = 2_000_000n; // 2 USDC (6 decimals)

export enum LaunchMode {
  PUMP = 0, // 50% Arcade / 50% creator(s)
  CLANKER = 1, // 70% Arcade / 30% creator(s), supports a secondary creator address
}
