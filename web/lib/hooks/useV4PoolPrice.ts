"use client";

import { Address, zeroAddress } from "viem";
import { useReadContract } from "wagmi";

import { ADDRESSES } from "@/lib/constants";

/**
 * Spot USDC-per-token price of a V4 launch pool, read from the canonical pool
 * state (StateView.getSlot0). Unlike the subgraph's lastPriceUsdc (which is 0
 * until the first trade), this returns the SEED price immediately at launch, so
 * a freshly-launched CLANKER shows its real market cap right away. Verbatim of
 * the subgraph priceFromSqrtX96 math, kept in lockstep.
 */

const HOOK_POOLID_ABI = [
    {
        type: "function",
        name: "poolIdOf",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bytes32" }],
    },
] as const;

const STATE_VIEW_ABI = [
    {
        type: "function",
        name: "getSlot0",
        stateMutability: "view",
        inputs: [{ name: "poolId", type: "bytes32" }],
        outputs: [
            { name: "sqrtPriceX96", type: "uint160" },
            { name: "tick", type: "int24" },
            { name: "protocolFee", type: "uint24" },
            { name: "lpFee", type: "uint24" },
        ],
    },
] as const;

/** USDC is currency0 iff its address sorts below the token's (V4 orders by addr). */
function usdcIsCurrency0(token: Address): boolean {
    return BigInt(ADDRESSES.usdc) < BigInt(token);
}

/** Verbatim of subgraph priceFromSqrtX96: USDC(6dp)-per-token(18dp), human. */
function priceFromSqrtX96(sqrtPriceX96: bigint, usdcIsToken0: boolean): number {
    if (sqrtPriceX96 === 0n) return 0;
    const tenPow24 = 10n ** 24n;
    const q192 = 2n ** 192n;
    const num = sqrtPriceX96 * sqrtPriceX96;
    if (num === 0n) return 0;
    const ratioE24 = usdcIsToken0 ? (q192 * tenPow24) / num : (num * tenPow24) / q192;
    return Number(ratioE24) / 1e12;
}

/** Live spot price (USDC per token) for a V4 launch token, or undefined. */
export function useV4PoolPrice(token: Address | undefined): number | undefined {
    const hook = ADDRESSES.arcadeHook as Address;
    const stateView = ADDRESSES.v4StateView as Address;
    const enabled =
        !!token &&
        hook !== zeroAddress &&
        stateView !== zeroAddress;

    const poolIdQ = useReadContract({
        address: hook,
        abi: HOOK_POOLID_ABI,
        functionName: "poolIdOf",
        args: token ? [token] : undefined,
        query: { enabled },
    });
    const poolId = poolIdQ.data as `0x${string}` | undefined;
    const hasPool = !!poolId && !/^0x0*$/.test(poolId);

    const slot0Q = useReadContract({
        address: stateView,
        abi: STATE_VIEW_ABI,
        functionName: "getSlot0",
        args: poolId ? [poolId] : undefined,
        query: { enabled: enabled && hasPool, refetchInterval: 15_000 },
    });

    const slot0 = slot0Q.data as readonly [bigint, number, number, number] | undefined;
    if (!slot0 || !token) return undefined;
    const price = priceFromSqrtX96(slot0[0], usdcIsCurrency0(token));
    return price > 0 ? price : undefined;
}
