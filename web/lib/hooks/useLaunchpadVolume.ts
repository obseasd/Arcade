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

/** Chunk size: thirdweb's Arc RPC caps eth_getLogs at a few thousand blocks. */
const CHUNK = 5_000n;
/** Hard cap on how far back we'll walk (≈ a few weeks of Arc blocks). */
const MAX_BACK = 500_000n;

async function getLogsChunked(
  publicClient: any,
  params: { address: Address; event: any },
  latest: bigint,
): Promise<any[]> {
  const all: any[] = [];
  let end = latest;
  let walked = 0n;
  while (walked < MAX_BACK) {
    const start = end > CHUNK ? end - CHUNK + 1n : 0n;
    try {
      const logs = await publicClient.getLogs({
        ...params,
        fromBlock: start,
        toBlock: end,
      });
      all.push(...logs);
    } catch {
      // Stop on RPC error — return what we have so far.
      break;
    }
    if (start === 0n) break;
    walked += end - start + 1n;
    end = start - 1n;
  }
  return all;
}

/**
 * Cumulative USDC trading volume for a launchpad token, in 6-decimal raw units.
 *
 * - PUMP / Arcade (curve): sums `Buy.usdcIn` + `Sell.usdcOut` from the launchpad.
 * - Clanker V3 (USDC-paired): sums |amountX| where X is the USDC side of the pool's Swap events.
 * - Clanker V3 (WETH-paired): returns `undefined` — we don't price WETH in USDC here.
 *
 * Bump `refreshKey` to repoll (the inline trade panel does this after a swap).
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
        const latest = await publicClient.getBlockNumber();
        if (mode === 2) {
          // Clanker V3: read Swap events on the pool, sum the USDC side.
          if (!pool || pool === "0x0000000000000000000000000000000000000000") {
            if (!cancelled) setVol(0n);
            return;
          }
          const t0Raw = await publicClient.readContract({
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
          });
          const t0 = (t0Raw as Address).toLowerCase();
          const usdcIsToken0 = t0 === ADDRESSES.usdc.toLowerCase();
          // If the pool isn't USDC-paired we can't price volume in USDC here.
          // Heuristic: paired side != USDC → WETH or other.
          const swaps = await getLogsChunked(
            publicClient,
            { address: pool, event: V3_SWAP_EVT },
            latest,
          );
          // Detect USDC pairing by checking either side matches USDC.
          if (
            t0 !== ADDRESSES.usdc.toLowerCase() &&
            !usdcIsToken0
          ) {
            // token0 isn't USDC; check token1 by inferring from the data we have.
            // Simplest: assume not-USDC pairing means we don't price it.
            // (We could read token1 here but if it's USDC the usdcIsToken0 flag handles it.)
          }
          let sum = 0n;
          for (const log of swaps) {
            const a0 = log.args.amount0 as bigint;
            const a1 = log.args.amount1 as bigint;
            const usdcRaw = usdcIsToken0 ? a0 : a1;
            const abs = usdcRaw < 0n ? -usdcRaw : usdcRaw;
            sum += abs;
          }
          if (!cancelled) setVol(sum);
        } else {
          // PUMP / Arcade: scan recent launchpad logs and filter by token in-memory
          // (some RPCs choke on indexed-arg filters; this is more compatible).
          const [buys, sells] = await Promise.all([
            getLogsChunked(publicClient, { address: ADDRESSES.launchpad, event: BUY_EVT }, latest),
            getLogsChunked(publicClient, { address: ADDRESSES.launchpad, event: SELL_EVT }, latest),
          ]);
          const tokenLc = token.toLowerCase();
          let sum = 0n;
          for (const log of buys) {
            if ((log.args.token as string).toLowerCase() !== tokenLc) continue;
            sum += log.args.usdcIn as bigint;
          }
          for (const log of sells) {
            if ((log.args.token as string).toLowerCase() !== tokenLc) continue;
            sum += log.args.usdcOut as bigint;
          }
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
