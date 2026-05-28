"use client";

import { useEffect, useState } from "react";
import { Address, parseAbiItem } from "viem";
import { usePublicClient } from "wagmi";
import { ADDRESSES } from "@/lib/constants";

const BUY_EVT = parseAbiItem(
  "event Buy(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 newPriceQ64)",
);
const SELL_EVT = parseAbiItem(
  "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 newPriceQ64)",
);
const V3_SWAP_EVT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

/**
 * Cumulative USDC trading volume for a launchpad token, in 6-decimal raw units.
 *
 * - PUMP / Arcade (curve): sums `Buy.usdcIn` + `Sell.usdcOut` from the launchpad.
 * - Clanker V3 (USDC-paired): sums |amountX| where X is the USDC side of the pool's Swap events.
 * - Clanker V3 (WETH-paired): returns `undefined` — we don't price WETH in USDC here.
 *
 * Reads the full block range; on Arc testnet that's cheap. Refreshes when
 * `refreshKey` changes (caller bumps it after a buy/sell to repoll).
 */
export function useLaunchpadVolume(args: {
  token: Address | undefined;
  mode: number | undefined;
  pool?: Address | undefined;
  refreshKey?: number;
}): bigint | undefined {
  const { token, mode, pool, refreshKey } = args;
  const publicClient = usePublicClient();
  const [vol, setVol] = useState<bigint | undefined>(undefined);

  useEffect(() => {
    if (!publicClient || !token || mode === undefined) {
      setVol(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (mode === 2) {
          // Clanker V3: read Swap events on the pool, sum the USDC side.
          if (!pool || pool === "0x0000000000000000000000000000000000000000") {
            if (!cancelled) setVol(0n);
            return;
          }
          const [t0Raw, swaps] = await Promise.all([
            publicClient.readContract({
              address: pool,
              abi: [
                {
                  type: "function",
                  name: "token0",
                  stateMutability: "view",
                  inputs: [],
                  outputs: [{ type: "address" }],
                },
              ] as const,
              functionName: "token0",
            }),
            publicClient.getLogs({
              address: pool,
              event: V3_SWAP_EVT,
              fromBlock: 0n,
              toBlock: "latest",
            }),
          ]);
          const t0 = (t0Raw as Address).toLowerCase();
          const usdcIsToken0 = t0 === ADDRESSES.usdc.toLowerCase();
          if (t0 !== ADDRESSES.usdc.toLowerCase() && !usdcIsToken0) {
            // WETH-paired: we can't price it in USDC here.
            if (!cancelled) setVol(undefined);
            return;
          }
          let sum = 0n;
          for (const log of swaps) {
            const a0 = log.args.amount0 as bigint;
            const a1 = log.args.amount1 as bigint;
            const usdcRaw = usdcIsToken0 ? a0 : a1;
            sum += usdcRaw < 0n ? -usdcRaw : usdcRaw;
          }
          if (!cancelled) setVol(sum);
        } else {
          // PUMP / Arcade: sum Buy.usdcIn + Sell.usdcOut on the launchpad.
          const [buys, sells] = await Promise.all([
            publicClient.getLogs({
              address: ADDRESSES.launchpad,
              event: BUY_EVT,
              args: { token },
              fromBlock: 0n,
              toBlock: "latest",
            }),
            publicClient.getLogs({
              address: ADDRESSES.launchpad,
              event: SELL_EVT,
              args: { token },
              fromBlock: 0n,
              toBlock: "latest",
            }),
          ]);
          let sum = 0n;
          for (const log of buys) sum += log.args.usdcIn as bigint;
          for (const log of sells) sum += log.args.usdcOut as bigint;
          if (!cancelled) setVol(sum);
        }
      } catch {
        if (!cancelled) setVol(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, mode, pool, refreshKey]);

  return vol;
}
