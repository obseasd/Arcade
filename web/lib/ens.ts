"use client";

import { useEffect, useState } from "react";
import { Address, isAddress } from "viem";
import { normalize } from "viem/ens";

/**
 * Client-side ENS hooks that route through our own /api/ens/* endpoints
 * instead of hitting public L1 RPCs from the browser. Why: ad-blockers
 * (uBlock, Brave Shields, AdGuard) ship filter lists that block known web3
 * endpoints — llamarpc, publicnode, cloudflare-eth, ankr, etc. — at the
 * network layer, so any direct fetch from the browser silently fails for
 * a meaningful slice of users. Same-origin /api/ens/forward + /reverse
 * are invisible to those filter lists, and the Next.js server can use
 * any RPC it wants without exposing the endpoint to the client.
 *
 * Debounce + normalize happen on the client; the server handles RPC
 * fallback + caching.
 */

export interface EnsForwardResult {
    address: Address | null;
    loading: boolean;
}

async function fetchForward(name: string): Promise<Address | null> {
    try {
        const r = await fetch(`/api/ens/forward?name=${encodeURIComponent(name)}`);
        if (!r.ok) return null;
        const j = (await r.json()) as { address: string | null };
        if (j.address && isAddress(j.address)) return j.address as Address;
        return null;
    } catch {
        return null;
    }
}

async function fetchReverse(address: Address): Promise<string | null> {
    try {
        const r = await fetch(`/api/ens/reverse?address=${address}`);
        if (!r.ok) return null;
        const j = (await r.json()) as { name: string | null };
        return j.name;
    } catch {
        return null;
    }
}

export function useEnsForward(input: string): EnsForwardResult {
    const [debounced, setDebounced] = useState(input);
    useEffect(() => {
        const t = window.setTimeout(() => setDebounced(input), 250);
        return () => window.clearTimeout(t);
    }, [input]);

    const [address, setAddress] = useState<Address | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const value = debounced.trim();
        if (!value || isAddress(value) || !value.includes(".")) {
            setAddress(null);
            setLoading(false);
            return;
        }
        let normalized: string;
        try {
            normalized = normalize(value);
        } catch {
            setAddress(null);
            setLoading(false);
            return;
        }
        setLoading(true);
        fetchForward(normalized).then((addr) => {
            if (cancelled) return;
            setAddress(addr);
            setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [debounced]);

    return { address, loading };
}

export function useEnsReverseVerified(address: Address | null | undefined): string | null {
    const [name, setName] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (!address) {
            setName(null);
            return;
        }
        fetchReverse(address).then((n) => {
            if (cancelled) return;
            setName(n);
        });
        return () => {
            cancelled = true;
        };
    }, [address]);

    return name;
}
