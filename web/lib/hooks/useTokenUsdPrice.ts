"use client";

import { Address } from "viem";
import { useReadContract } from "wagmi";
import { FACTORY_ABI, PAIR_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";

/**
 * Returns the USD value (as a JS number) of `amountRaw` units of `token`,
 * derived from the USDC pool's pre-trade reserve ratio. For USDC itself the
 * value is trivially `amountRaw / 1e6`. For tokens with no USDC pool, returns
 * `undefined`.
 */
export function useUsdValue(
  token: Address | undefined,
  amountRaw: bigint,
  decimals: number,
): { usd: number | undefined; spotUsdPerToken: number | undefined; isAvailable: boolean } {
  const isUsdc = !!token && token.toLowerCase() === ADDRESSES.usdc.toLowerCase();

  // Pair address (only if not USDC)
  const pairQ = useReadContract({
    address: ADDRESSES.factory,
    abi: FACTORY_ABI,
    functionName: "getPair",
    args: token && !isUsdc ? [ADDRESSES.usdc, token] : undefined,
    query: { enabled: !!token && !isUsdc },
  });
  const pair = pairQ.data as Address | undefined;
  const hasPair = !!pair && pair !== "0x0000000000000000000000000000000000000000";

  const reservesQ = useReadContract({
    address: pair,
    abi: PAIR_ABI,
    functionName: "getReserves",
    query: { enabled: hasPair },
  });
  const token0Q = useReadContract({
    address: pair,
    abi: PAIR_ABI,
    functionName: "token0",
    query: { enabled: hasPair },
  });

  if (isUsdc) {
    return {
      usd: Number(amountRaw) / 1e6,
      spotUsdPerToken: 1,
      isAvailable: true,
    };
  }

  if (!hasPair || !reservesQ.data || !token0Q.data) {
    return { usd: undefined, spotUsdPerToken: undefined, isAvailable: false };
  }

  const [r0, r1] = reservesQ.data as readonly [bigint, bigint, number];
  const t0 = token0Q.data as Address;
  const isToken0 = t0.toLowerCase() === token?.toLowerCase();
  const tokenReserve = isToken0 ? r0 : r1;
  const usdcReserve = isToken0 ? r1 : r0;
  if (tokenReserve === 0n) {
    return { usd: undefined, spotUsdPerToken: undefined, isAvailable: false };
  }
  // spotUsdPerWholeToken = (usdcReserve / 10^6) / (tokenReserve / 10^decimals)
  //                     = usdcReserve * 10^(decimals - 6) / tokenReserve
  const spot =
    (Number(usdcReserve) * Math.pow(10, decimals - USDC_DECIMALS)) / Number(tokenReserve);
  // For raw amount → USD: amountRaw * usdcReserve / tokenReserve gives raw USDC (6 dp).
  const usdRaw6dp = (amountRaw * usdcReserve) / tokenReserve;
  const usd = Number(usdRaw6dp) / 1e6;
  return { usd, spotUsdPerToken: spot, isAvailable: true };
}
