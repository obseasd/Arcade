import { createPublicClient, fallback, http } from "viem";

/**
 * Server-side Arc RPC client with a FALLBACK across endpoints. The default
 * arc.network RPC is heavily rate-limited ("request limit reached") from Vercel's
 * shared IPs, so viem falls over to the thirdweb Arc RPC (separate limit) when it
 * throttles. Override/extend with a comma-separated ARC_RPC_URLS env (put a
 * dedicated/higher-limit RPC first for production). Use this for ALL server-side
 * reads (claim, balance, reconcile) so no single endpoint's limit breaks them.
 */

const IS_MAINNET = (process.env.NEXT_PUBLIC_ARC_ENV ?? "").toLowerCase() === "mainnet";

export const ARC_CHAIN = IS_MAINNET
    ? ({
        id: 5042,
        name: "Arc",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
        rpcUrls: { default: { http: [process.env.ARC_MAINNET_RPC_URL ?? "https://5042.rpc.thirdweb.com"] } },
    } as const)
    : ({
        id: 5042002,
        name: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
        rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
    } as const);

// Ordered by the 2026-08-14 benchmark: drpc.org + arcscan serve 40 concurrent
// reads with ZERO rate-limiting; the public rpc.testnet.arc.network 429s ~35%
// of a burst (and harder from Vercel's shared IPs). Reliable endpoints FIRST,
// public as last-resort backup. Override with ARC_READ_RPC_URLS to prepend the
// Canteen server-token RPC (no rate limit) in production.
const DEFAULT_TESTNET_RPCS =
    "https://arc-testnet.drpc.org,https://testnet.arcscan.app/api/eth-rpc,https://rpc.testnet.arc.network";
const DEFAULT_MAINNET_RPCS =
    process.env.ARC_MAINNET_RPC_URL ?? "https://5042.rpc.thirdweb.com";
const DEFAULT_ARC_RPCS = IS_MAINNET ? DEFAULT_MAINNET_RPCS : DEFAULT_TESTNET_RPCS;

const RPC_URLS = (process.env.ARC_RPC_URLS ?? DEFAULT_ARC_RPCS)
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

export function serverPublicClient() {
    return createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(
            RPC_URLS.map((u) => http(u, { retryCount: 2, retryDelay: 600, timeout: 15_000 })),
            { retryCount: 1, retryDelay: 300 },
        ),
    });
}

// A read-optimised client for eth_call reads (balanceOf, a getter) AND getLogs.
// arc.network rate-limits Vercel IPs, so the fallback fans out to drpc + arcscan
// (both getLogs-to-10k, no token, separate limits) before arc.network. thirdweb
// is gone (it capped getLogs at 1000). Override with ARC_READ_RPC_URLS to
// prepend the Canteen server-token RPC (no rate limit) in production.
const READ_RPC_URLS = (process.env.ARC_READ_RPC_URLS ?? DEFAULT_ARC_RPCS)
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

/** Pick transport options per Arc RPC host. drpc.org rejects JSON-RPC batches
 *  (HTTP 500) and arcscan caps a batch at 5 entries; the public RPC and a
 *  Canteen/dedicated node take the full 90-entry batch. `batched` gates whether
 *  we batch at all (the quote fan-out benefits; single reads don't need it). */
function arcHttp(url: string, batched: boolean, timeout: number) {
    const h = url.toLowerCase();
    // drpc.org (500s a batch) and the Canteen node (413 "batch exceeds
    // MaxBatchSize", benchmarked) don't take JSON-RPC batches -> single calls
    // only. Both are rate-limit-free so the un-batched fan-out still lands.
    if (h.includes("drpc.org") || h.includes("thecanteenapp.com")) return http(url, { retryCount: 0, timeout });
    if (h.includes("arcscan")) {
        return http(url, batched ? { batch: { batchSize: 5, wait: 8 }, retryCount: 0, timeout } : { retryCount: 0, timeout });
    }
    return http(url, batched ? { batch: { batchSize: 90, wait: 8 }, retryCount: 0, timeout } : { retryCount: 0, timeout });
}

export function serverReadClient() {
    return createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(
            // No per-transport retry (a throttled Arc RPC HANGS rather than erroring
            // fast, so retries just stack timeouts); a short timeout fails over to
            // the next endpoint quickly. Reliable endpoints (drpc/arcscan) are first.
            READ_RPC_URLS.map((u) => arcHttp(u, false, 3_500)),
            { retryCount: 0 },
        ),
    });
}

/**
 * Client for the swap-route quote fan-out (/api/routes/quote). Seven providers,
 * each issuing several quoter reads, used to be ~30 SEPARATE round trips from
 * the BROWSER: subject to the browser's per-host connection cap, to ad-blockers,
 * and to the user's own latency to the RPC. Measured at 20s for a single pair.
 *
 * Here they collapse into a handful of JSON-RPC BATCH posts from a server that
 * sits next to the RPC. Batching happens at the HTTP layer, not via multicall3,
 * so each call keeps its own result and its own revert data: semantics are
 * identical to issuing them one by one, only the transport changes. Arc caps a
 * batch at 100 entries (v0.7.2), hence batchSize 90.
 */
export function serverQuoteClient() {
    return createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(
            // Per-host batch config: drpc takes single calls (it 500s a batch but
            // never rate-limits, so the fan-out still lands), arcscan batches 5,
            // the public/Canteen node batches 90. drpc/arcscan are first.
            READ_RPC_URLS.map((u) => arcHttp(u, true, 6_000)),
            { retryCount: 0 },
        ),
    });
}
