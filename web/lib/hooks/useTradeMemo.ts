"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import type { Hex } from "viem";
import { isAddress } from "viem";
import { encodeMemoData, memoIdFor } from "@/lib/memo";

/**
 * Reads attribution context from the URL and returns a memo payload
 * the trade panels can attach to a buy/sell.
 *
 *   - ?ref=0xabc...           → referrer wallet
 *   - ?ref=@handle             → Twitter handle (stripped of @)
 *   - ?campaign=spring2026     → campaign id
 *
 * Multiple keys can co-exist; the memoId tracks the primary (ref >
 * campaign), the memoData payload carries everything as a small JSON
 * blob so the off-chain indexer can pull both apart later.
 *
 * Returns `null` when nothing is attached so the trade path stays on
 * the bare writeContract code path (no extra gas, no Memo event).
 */
export interface TradeMemo {
    id: Hex;
    data: Hex;
}

export function useTradeMemo(): TradeMemo | null {
    const params = useSearchParams();

    return useMemo<TradeMemo | null>(() => {
        const ref = (params?.get("ref") ?? "").trim();
        const campaign = (params?.get("campaign") ?? "").trim();
        if (!ref && !campaign) return null;

        const payload: Record<string, string> = {};
        let primaryKind: "ref" | "campaign" | "tw" = "campaign";
        let primaryValue = campaign;

        if (ref) {
            if (ref.startsWith("@") || /^[A-Za-z0-9_]{1,15}$/.test(ref)) {
                const handle = ref.replace(/^@/, "").toLowerCase();
                payload.tw = handle;
                primaryKind = "tw";
                primaryValue = handle;
            } else if (isAddress(ref)) {
                payload.ref = ref.toLowerCase();
                primaryKind = "ref";
                primaryValue = ref.toLowerCase();
            }
        }
        if (campaign) {
            payload.campaign = campaign;
            if (!ref) {
                primaryKind = "campaign";
                primaryValue = campaign;
            }
        }

        if (!primaryValue) return null;

        return {
            id: memoIdFor(primaryKind, primaryValue),
            data: encodeMemoData(payload),
        };
    }, [params]);
}
