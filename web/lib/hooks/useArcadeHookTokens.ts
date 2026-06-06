"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, parseAbiItem } from "viem";
import { CHUNK_SMALL, MAX_BACK_BLOCKS, scanLogsChunked } from "@/lib/eventScan";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import {
    ARCADE_HOOK_ABI,
    ARCADE_HOOK_MODE,
    ARCADE_HOOK_STATUS,
    type ArcadeHookMode,
    type ArcadeHookStatus,
} from "@/lib/abis/arcadeHook";
import { ADDRESSES, V4_HOOK_ENABLED } from "@/lib/constants";
import { useWatchEvent } from "./useWatchEvent";

/**
 * Indexer hook for ArcadeHook launches. Returns one entry per token registered
 * by `hook.createLaunch`, with curve state + mode + snipe + metadata URI.
 *
 * Read strategy:
 *   - `tokensCount()` + `allTokens(i)` for the append-only registry
 *   - `getCurveState(poolIdOf(token))` for status + reserves + mode
 *   - `snipeConfigs(token)` for the per-token sniper decay window
 *   - ERC20 `name` / `symbol` directly from the token
 *   - One-shot getLogs scan for `TokenLaunched(metadataURI, ...)` so the UI
 *     can render token cards with their off-chain metadata. Bounded by the
 *     same 50k-block chunk strategy the V2 indexer uses; once the ArcLens
 *     Ponder indexer is live (Milestone 3) this hook can be deprecated.
 *
 * Gated behind `V4_HOOK_ENABLED` so it's a no-op when the address is unset.
 */

const TOKEN_LAUNCHED_EVT = parseAbiItem(
    "event TokenLaunched(address indexed token, address indexed creator, uint8 mode, string name, string symbol, string metadataURI)",
);

const GRADUATED_EVT = parseAbiItem(
    "event Graduated(bytes32 indexed poolId, uint256 finalUsdcReserve, uint256 tokensInLP)",
);

// CHUNK + MAX_BACK live in @/lib/eventScan now.

export interface ArcadeHookTokenInfo {
    address: Address;
    poolId: `0x${string}`;
    creator: Address;
    creator2: Address;
    creator2Bps: number;
    mode: ArcadeHookMode;
    status: ArcadeHookStatus;
    /** Curve progress: tokensSold raw (18 dp). */
    tokensSold: bigint;
    /** USDC accumulated by the curve (6 dp). */
    realUsdcReserve: bigint;
    /** Sniper config copied from snipeConfigs(token). */
    snipeStartBps: number;
    snipeDecaySeconds: number;
    snipeLaunchedAt: bigint;
    /** Per-event metadataURI (ipfs:// or data:). */
    metadataURI: string;
    name?: string;
    symbol?: string;
}

interface EventCache {
    metadata: Map<string, string>;
}

export function useArcadeHookTokens(): {
    tokens: ArcadeHookTokenInfo[];
    isLoading: boolean;
} {
    const publicClient = usePublicClient();
    const enabled = V4_HOOK_ENABLED && ADDRESSES.arcadeHook !== ("0x0000000000000000000000000000000000000000" as Address);

    const countQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "tokensCount",
        query: { enabled },
    });
    const count = Number((countQ.data as bigint | undefined) ?? 0n);

    const refetchAll = useCallback(() => {
        if (!enabled) return;
        countQ.refetch();
    }, [countQ, enabled]);

    // New launches grow the count; graduations flip status on an existing
    // entry but the next getCurveState read picks that up automatically.
    useWatchEvent({
        address: enabled ? ADDRESSES.arcadeHook : undefined,
        event: TOKEN_LAUNCHED_EVT,
        onLogs: refetchAll,
    });
    useWatchEvent({
        address: enabled ? ADDRESSES.arcadeHook : undefined,
        event: GRADUATED_EVT,
        onLogs: refetchAll,
    });

    // 1. Resolve every token address from the append-only registry.
    const addrCalls = useReadContracts({
        contracts: Array.from({ length: count }, (_, i) => ({
            address: ADDRESSES.arcadeHook,
            abi: ARCADE_HOOK_ABI,
            functionName: "allTokens" as const,
            args: [BigInt(i)] as const,
        })),
        query: { enabled: enabled && count > 0 },
    });

    const addresses = useMemo(
        () =>
            (addrCalls.data ?? []).flatMap((r) =>
                r.status === "success" ? [r.result as unknown as Address] : [],
            ),
        [addrCalls.data],
    );

    // 2. Per-token reads: poolIdOf + erc20 name/symbol + snipeConfigs.
    //    We can't read getCurveState yet because that needs poolId which is
    //    one of the results of THIS batch. Stage the calls.
    const metaCalls = useReadContracts({
        contracts: addresses.flatMap((addr) => [
            {
                address: ADDRESSES.arcadeHook,
                abi: ARCADE_HOOK_ABI,
                functionName: "poolIdOf" as const,
                args: [addr] as const,
            },
            { address: addr, abi: erc20Abi, functionName: "name" as const },
            { address: addr, abi: erc20Abi, functionName: "symbol" as const },
            {
                address: ADDRESSES.arcadeHook,
                abi: ARCADE_HOOK_ABI,
                functionName: "snipeConfigs" as const,
                args: [addr] as const,
            },
        ]),
        query: { enabled: enabled && addresses.length > 0 },
    });

    // 3. Extract poolIds, then batch getCurveState reads.
    const poolIds = useMemo(() => {
        if (!metaCalls.data) return [] as `0x${string}`[];
        return addresses.map((_, i) => {
            const v = metaCalls.data[4 * i]?.result as `0x${string}` | undefined;
            return v ?? ("0x" + "00".repeat(32) as `0x${string}`);
        });
    }, [addresses, metaCalls.data]);

    const stateCalls = useReadContracts({
        contracts: poolIds.map((poolId) => ({
            address: ADDRESSES.arcadeHook,
            abi: ARCADE_HOOK_ABI,
            functionName: "getCurveState" as const,
            args: [poolId] as const,
        })),
        query: { enabled: enabled && poolIds.length > 0 },
    });

    // 4. Event-driven metadata cache. Scan once per addresses-length change.
    const [cache, setCache] = useState<EventCache>({ metadata: new Map() });

    useEffect(() => {
        if (!enabled || !publicClient || addresses.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const latest = await publicClient.getBlockNumber();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const launchLogs = await scanLogsChunked<any>(
                    publicClient,
                    { address: ADDRESSES.arcadeHook, event: TOKEN_LAUNCHED_EVT },
                    latest,
                    { chunk: CHUNK_SMALL, maxBack: MAX_BACK_BLOCKS, label: "hook.TokenLaunched" },
                );
                const metadata = new Map<string, string>();
                for (const log of launchLogs) {
                    const tokenAddr = (log.args.token as string).toLowerCase();
                    const uri = (log.args.metadataURI as string) ?? "";
                    if (!metadata.has(tokenAddr)) metadata.set(tokenAddr, uri);
                }
                if (!cancelled) setCache({ metadata });
            } catch {
                /* swallow - UI renders empty metadata in this case */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [publicClient, addresses.length, enabled]);

    const tokens: ArcadeHookTokenInfo[] = useMemo(() => {
        if (!metaCalls.data || !stateCalls.data) return [];
        return addresses.map((addr, i) => {
            const name = metaCalls.data[4 * i + 1]?.result as string | undefined;
            const symbol = metaCalls.data[4 * i + 2]?.result as string | undefined;
            // snipeConfigs returns (startBps, decaySeconds, launchedAt). When
            // there is no snipe configured these are all zero, which is fine
            // for the UI's "no snipe tax" pill.
            const snipe = metaCalls.data[4 * i + 3]?.result as
                | readonly [number, number, bigint]
                | undefined;
            const curve = stateCalls.data[i]?.result as
                | {
                      virtualUsdcReserve: bigint;
                      realUsdcReserve: bigint;
                      tokensSold: bigint;
                      mode: number;
                      status: number;
                      creator: Address;
                      creator2: Address;
                      creator2Bps: number;
                  }
                | undefined;

            const lower = addr.toLowerCase();
            return {
                address: addr,
                poolId: poolIds[i] ?? ("0x" + "00".repeat(32) as `0x${string}`),
                creator: curve?.creator ?? ("0x0" as Address),
                creator2: curve?.creator2 ?? ("0x0" as Address),
                creator2Bps: Number(curve?.creator2Bps ?? 0),
                mode: ((curve?.mode ?? 0) as ArcadeHookMode),
                status: ((curve?.status ?? 0) as ArcadeHookStatus),
                tokensSold: curve?.tokensSold ?? 0n,
                realUsdcReserve: curve?.realUsdcReserve ?? 0n,
                snipeStartBps: Number(snipe?.[0] ?? 0),
                snipeDecaySeconds: Number(snipe?.[1] ?? 0),
                snipeLaunchedAt: snipe?.[2] ?? 0n,
                metadataURI: cache.metadata.get(lower) ?? "",
                name,
                symbol,
            };
        });
    }, [addresses, metaCalls.data, stateCalls.data, poolIds, cache]);

    return {
        tokens,
        isLoading: enabled
            ? countQ.isLoading ||
              addrCalls.isLoading ||
              metaCalls.isLoading ||
              stateCalls.isLoading
            : false,
    };
}

/**
 * Convenience read of a single token's curve state. Used by the buy/sell UI
 * to decide which entrypoint to call (hook.buy during Curving, the canonical
 * V4 router post-Graduated).
 */
export function useArcadeHookCurveState(token: Address | undefined): {
    status: ArcadeHookStatus | undefined;
    tokensSold: bigint;
    realUsdcReserve: bigint;
    mode: ArcadeHookMode | undefined;
    isLoading: boolean;
} {
    const enabled = V4_HOOK_ENABLED && !!token;
    const poolIdQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "poolIdOf",
        args: token ? [token] : undefined,
        query: { enabled },
    });
    const stateQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "getCurveState",
        args: poolIdQ.data ? [poolIdQ.data as `0x${string}`] : undefined,
        query: { enabled: enabled && !!poolIdQ.data },
    });
    const curve = stateQ.data as
        | {
              tokensSold: bigint;
              realUsdcReserve: bigint;
              mode: number;
              status: number;
          }
        | undefined;
    return {
        status: curve ? (curve.status as ArcadeHookStatus) : undefined,
        tokensSold: curve?.tokensSold ?? 0n,
        realUsdcReserve: curve?.realUsdcReserve ?? 0n,
        mode: curve ? (curve.mode as ArcadeHookMode) : undefined,
        isLoading: poolIdQ.isLoading || stateQ.isLoading,
    };
}

// Re-export the constants so consumers don't need a second import.
export { ARCADE_HOOK_MODE, ARCADE_HOOK_STATUS };
