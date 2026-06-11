"use client";

import { useEffect, useState } from "react";
import { type Address, createPublicClient, http, type Abi } from "viem";
import { arcTestnet } from "@/lib/chains";

/**
 * Defensive direct-viem read that bypasses wagmi entirely.
 *
 * Use this when wagmi's `useReadContract` is unreliable — typically when:
 *   - The wallet is connected but on a chain wagmi doesn't think it's
 *     on, and `chainId` pinning isn't taking effect.
 *   - A Rabby / Backpack / EIP-6963 collision has left wagmi's
 *     connector state out of sync with `window.ethereum`.
 *   - The read MUST hit Arc regardless of the wallet's UI state (e.g.
 *     the header USDC balance chip — see `HeaderWalletWidget`).
 *
 * Trade-offs vs `useReadContract`:
 *   - No multicall batching. Each call is a direct eth_call.
 *   - No QueryClient cache (each instance maintains its own state).
 *   - Refetches at the supplied interval — no automatic invalidation
 *     on tx mined / focus / window-focus.
 *
 * Worth the trade-offs only for SINGLE high-confidence reads. Don't
 * use this for SwapCard's quote pipeline or anything batched.
 *
 * Audit 2026-06-11 v3: the header USDC chip kept reading 0 even when
 * Rabby + Arc clearly held 156 USDC. wagmi's `useReadContract` never
 * issued the `balanceOf` request (verified via Network panel: 160 Arc
 * RPC calls but ZERO carrying the selector or the user's address).
 * Switching to this hook eliminated the wagmi dependency surface and
 * the balance started rendering correctly.
 */
const arcClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
});

export function useArcReadContract<T = unknown>(opts: {
    address: Address | undefined;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    enabled?: boolean;
    refetchIntervalMs?: number;
}): { data: T | undefined; isLoading: boolean; error: Error | null } {
    const { address, abi, functionName, args, enabled = true, refetchIntervalMs = 8000 } = opts;
    const [data, setData] = useState<T | undefined>(undefined);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    // Stable key so we re-run when any input changes. JSON.stringify is
    // safe here because args contain Addresses / bigints / numbers / strings
    // serialized with the BigInt-friendly fallback.
    const argsKey = args ? args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join("|") : "";

    useEffect(() => {
        if (!enabled || !address) {
            // eslint-disable-next-line no-console
            console.debug("[useArcReadContract]", functionName, "SKIPPED", {
                enabled,
                address,
            });
            setData(undefined);
            return;
        }
        let cancelled = false;
        async function read() {
            setIsLoading(true);
            try {
                // Audit 2026-06-11 v3: viem's readContract defaults `args` to
                // [] when omitted — but explicitly passing `[]` for no-arg
                // functions sidesteps an edge case where a stale closure
                // could leak a stringified undefined into the encoding.
                const result = (await arcClient.readContract({
                    address: address as Address,
                    abi,
                    functionName,
                    args: (args ?? []) as readonly unknown[],
                })) as T;
                // eslint-disable-next-line no-console
                console.debug("[useArcReadContract]", functionName, "OK", { result });
                if (!cancelled) {
                    setData(result);
                    setError(null);
                }
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn("[useArcReadContract]", functionName, "FAILED", {
                    address,
                    args,
                    error: e instanceof Error ? e.message : String(e),
                });
                if (!cancelled) {
                    setError(e instanceof Error ? e : new Error(String(e)));
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        }
        read();
        const interval = setInterval(read, refetchIntervalMs);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [address, functionName, argsKey, enabled, refetchIntervalMs]);

    return { data, isLoading, error };
}
