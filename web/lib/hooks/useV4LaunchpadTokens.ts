"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, parseAbiItem } from "viem";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { V4_LAUNCHPAD_ABI } from "@/lib/abis/v4Launchpad";
import { ADDRESSES, V4_ENABLED } from "@/lib/constants";
import { useWatchEvent } from "./useWatchEvent";

/**
 * V4-specific indexer hook. Mirrors `useLaunchpadTokens` for the V2/V3
 * launchpad but reads from `ArcadeV4Launchpad`. Returns one entry per launch
 * created on the V4 launchpad. Cold-path is a chunked RPC log scan for the
 * `TokenLaunched` and `PoolInitialized` events (we need the metadata URI +
 * pool-init status, neither of which is part of the on-chain Launch struct).
 *
 * Same 50k-500k block cap as the V2 indexer - good enough for testing and
 * the early launches; the real all-time-history play is the Ponder indexer
 * tracked in `project_arcade_indexer_roadmap`.
 *
 * Gated behind `V4_ENABLED` so the hook is a no-op when the flag is off.
 */

const TOKEN_LAUNCHED_EVT = parseAbiItem(
    "event TokenLaunched(address indexed token, address indexed creator, uint16 snipeStartBps, uint32 snipeDecaySeconds, uint64 launchedAt, uint16 creatorBps, string name, string symbol, string metadataURI)",
);

const POOL_INITIALIZED_EVT = parseAbiItem(
    "event PoolInitialized(address indexed token, address indexed pool, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, int256 liquidityDelta)",
);

const CHUNK = 1_000n;
const MAX_BACK = 500_000n;

export interface V4LaunchpadTokenInfo {
    address: Address;
    creator: Address;
    snipeStartBps: number;
    snipeDecaySeconds: number;
    creatorBps: number;
    launchedAt: bigint;
    /** True once `initializePool` has fired the `PoolInitialized` event. */
    poolInitialized: boolean;
    /** Q64.96 sqrtPrice the pool started at (only when poolInitialized). */
    sqrtPriceX96?: bigint;
    /** Per-event metadataURI (ipfs:// or data:). */
    metadataURI: string;
    /** ERC20 metadata fetched directly from the token. */
    name?: string;
    symbol?: string;
}

interface EventCache {
    metadata: Map<string, string>;
    initialised: Map<string, bigint>;
}

export function useV4LaunchpadTokens(): {
    tokens: V4LaunchpadTokenInfo[];
    isLoading: boolean;
} {
    const publicClient = usePublicClient();
    const enabled = V4_ENABLED && ADDRESSES.v4Launchpad !== ("0x0000000000000000000000000000000000000000" as Address);

    const countQ = useReadContract({
        address: ADDRESSES.v4Launchpad,
        abi: V4_LAUNCHPAD_ABI,
        functionName: "tokensCount",
        query: { enabled },
    });
    const count = Number((countQ.data as bigint | undefined) ?? 0n);

    const refetchAll = useCallback(() => {
        if (!enabled) return;
        countQ.refetch();
    }, [countQ, enabled]);

    // Watch both events: new launches grow the count, pool inits flip the
    // poolInitialized flag for an existing entry.
    useWatchEvent({
        address: enabled ? ADDRESSES.v4Launchpad : undefined,
        event: TOKEN_LAUNCHED_EVT,
        onLogs: refetchAll,
    });
    useWatchEvent({
        address: enabled ? ADDRESSES.v4Launchpad : undefined,
        event: POOL_INITIALIZED_EVT,
        onLogs: refetchAll,
    });

    // Pull every token address from the launchpad's append-only registry.
    const addrCalls = useReadContracts({
        contracts: Array.from({ length: count }, (_, i) => ({
            address: ADDRESSES.v4Launchpad,
            abi: V4_LAUNCHPAD_ABI,
            functionName: "allTokens" as const,
            args: [BigInt(i)] as const,
        })),
        query: { enabled: enabled && count > 0 },
    });

    const addresses = useMemo(
        () =>
            (addrCalls.data ?? [])
                .map((r) => (r.status === "success" ? (r.result as unknown as Address) : undefined))
                .filter(Boolean) as Address[],
        [addrCalls.data],
    );

    // Per-token batch reads: full Launch struct via getLaunch(token) + name/symbol.
    const stateCalls = useReadContracts({
        contracts: addresses.flatMap((addr) => [
            {
                address: ADDRESSES.v4Launchpad,
                abi: V4_LAUNCHPAD_ABI,
                functionName: "getLaunch" as const,
                args: [addr] as const,
            },
            { address: addr, abi: erc20Abi, functionName: "name" as const },
            { address: addr, abi: erc20Abi, functionName: "symbol" as const },
        ]),
        query: { enabled: enabled && addresses.length > 0 },
    });

    // Event-driven side state: metadata URIs (from TokenLaunched) + pool init
    // status (from PoolInitialized). We scan once per addresses-size change.
    const [cache, setCache] = useState<EventCache>({
        metadata: new Map(),
        initialised: new Map(),
    });

    useEffect(() => {
        if (!enabled || !publicClient || addresses.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                const latest = await publicClient.getBlockNumber();
                const metadata = new Map<string, string>();
                const initialised = new Map<string, bigint>();
                let end = latest;
                let walked = 0n;
                while (walked < MAX_BACK) {
                    const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
                    try {
                        const [launchLogs, initLogs] = await Promise.all([
                            publicClient.getLogs({
                                address: ADDRESSES.v4Launchpad,
                                event: TOKEN_LAUNCHED_EVT,
                                fromBlock: start,
                                toBlock: end,
                            }),
                            publicClient.getLogs({
                                address: ADDRESSES.v4Launchpad,
                                event: POOL_INITIALIZED_EVT,
                                fromBlock: start,
                                toBlock: end,
                            }),
                        ]);
                        for (const log of launchLogs) {
                            const tokenAddr = (log.args.token as string).toLowerCase();
                            const uri = (log.args.metadataURI as string) ?? "";
                            if (!metadata.has(tokenAddr)) metadata.set(tokenAddr, uri);
                        }
                        for (const log of initLogs) {
                            const tokenAddr = (log.args.token as string).toLowerCase();
                            const sqrt = (log.args.sqrtPriceX96 as bigint) ?? 0n;
                            if (!initialised.has(tokenAddr)) initialised.set(tokenAddr, sqrt);
                        }
                    } catch {
                        // RPC sometimes caps individual chunks - bail out and
                        // use what we collected so far.
                        break;
                    }
                    if (start === 0n) break;
                    walked += end - start + 1n;
                    end = start - 1n;
                }
                if (!cancelled) setCache({ metadata, initialised });
            } catch {
                /* swallow - UI shows tokens with empty metadata in this case */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [publicClient, addresses.length, enabled]);

    const tokens: V4LaunchpadTokenInfo[] = useMemo(() => {
        if (!stateCalls.data) return [];
        return addresses.map((addr, i) => {
            // getLaunch returns a Launch tuple: {token, creator, poolKey,
            // snipeStartBps, snipeDecaySeconds, launchedAt, creatorBps}.
            // viem decodes named tuple components, so we read by name.
            const launch = stateCalls.data[3 * i]?.result as
                | {
                      creator: Address;
                      snipeStartBps: number;
                      snipeDecaySeconds: number;
                      launchedAt: bigint;
                      creatorBps: number;
                  }
                | undefined;
            const name = stateCalls.data[3 * i + 1]?.result as string | undefined;
            const symbol = stateCalls.data[3 * i + 2]?.result as string | undefined;

            const lower = addr.toLowerCase();
            const sqrt = cache.initialised.get(lower);

            return {
                address: addr,
                creator: launch?.creator ?? ("0x0" as Address),
                snipeStartBps: Number(launch?.snipeStartBps ?? 0),
                snipeDecaySeconds: Number(launch?.snipeDecaySeconds ?? 0),
                creatorBps: Number(launch?.creatorBps ?? 0),
                launchedAt: launch?.launchedAt ?? 0n,
                poolInitialized: cache.initialised.has(lower),
                sqrtPriceX96: sqrt,
                metadataURI: cache.metadata.get(lower) ?? "",
                name,
                symbol,
            };
        });
    }, [addresses, stateCalls.data, cache]);

    return {
        tokens,
        isLoading: enabled
            ? countQ.isLoading || addrCalls.isLoading || stateCalls.isLoading
            : false,
    };
}
