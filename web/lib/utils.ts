import { clsx, type ClassValue } from "clsx";
import { formatUnits } from "viem";
import { twMerge } from "tailwind-merge";
import { USDC_DECIMALS } from "@/lib/constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatAddress(addr: string, head = 4, tail = 4): string {
  if (!addr || addr.length < head + tail + 2) return addr;
  return `${addr.slice(0, 2 + head)}…${addr.slice(-tail)}`;
}

export function formatUSDC(value: bigint, decimals = 6, fractionDigits = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, fractionDigits);
  const sign = negative ? "-" : "";
  return `${sign}${whole.toLocaleString("en-US")}${fractionDigits > 0 ? `.${fracStr}` : ""}`;
}

export function formatToken(value: bigint, decimals = 18, fractionDigits = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, fractionDigits).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr.length > 0
    ? `${sign}${whole.toLocaleString("en-US")}.${fracStr}`
    : `${sign}${whole.toLocaleString("en-US")}`;
}

/**
 * Pretty-print an LP-token balance with whatever precision is required to keep
 * it from rendering as "0". V2 first-LP mints are sqrt(amount0 * amount1) -
 * MINIMUM_LIQUIDITY scaled to 18 decimals; for a small testnet seed (10 USDC +
 * 3 ETH) the resulting LP is ~5.6e-6, which the old toLocaleString({
 * maximumFractionDigits: 4 }) collapses to "0". Switches to scientific past
 * 1e-7 so very small balances stay legible.
 */
export function formatLpBalance(raw: bigint, decimals = 18): string {
  if (raw === 0n) return "0";
  const n = Number(raw) / Number(10n ** BigInt(decimals));
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (n >= 0.0001) return n.toFixed(6);
  if (n >= 0.000_000_1) return n.toFixed(10);
  return n.toExponential(2);
}

/**
 * "Time since" pretty-printer. Default is the short form ("12s", "3m", "1h",
 * "2d"); pass `suffix: "ago"` for the explicit "12s ago" / "3m ago" variant
 * used in the bridge history. Deduped from 3 inline copies across
 * my-tokens/page, HeaderWalletWidget, BridgeHistory.
 */
export function formatAgo(ts: number, options?: { suffix?: string }): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const suffix = options?.suffix ? ` ${options.suffix}` : "";
  if (seconds < 60) return `${seconds}s${suffix}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${suffix}`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${suffix}`;
  return `${Math.floor(seconds / 86400)}d${suffix}`;
}

/**
 * "Time remaining" pretty-printer for countdowns. Returns "0s" past
 * deadline, else compact units (s / m / Hh Mm). Deduped from 5 inline
 * copies across V4 hook + V4 launchpad pages and cards.
 */
export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Parse a human-typed market-cap string ("1.5M", "250k", "1.2B", "1500") into
 * a Number, or undefined if the input isn't parseable. Strips currency / comma
 * formatting first. Deduped from 2 inline copies in the LP simulator.
 */
export function parseMcap(raw: string): number | undefined {
  const s = raw.trim().toUpperCase().replace(/[$,_\s]/g, "");
  if (!s) return undefined;
  const m = s.match(/^(\d*\.?\d+)([KMB])?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return undefined;
  const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
  return n * mult;
}

/**
 * Pretty-print a USDC-denominated bigint as "$X.XX" / "$X.XXk" / "$X.XXM".
 * Returns the em-dash placeholder for 0 and "<$0.01" for sub-cent values.
 * Decimals default to USDC's 6; pass 18 for wei-scaled gas estimates.
 * Deduped from 2 inline copies in /explore + /pool/[address].
 */
export function formatUsd(raw: bigint, decimals = USDC_DECIMALS): string {
  if (raw === 0n) return "—";
  const usd = Number(formatUnits(raw, decimals));
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(2)}k`;
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
