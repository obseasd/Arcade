import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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

export function parseUSDC(value: string, decimals = 6): bigint {
  if (!value) return 0n;
  const [whole, frac = ""] = value.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
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
