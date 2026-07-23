import { createPublicClient, fallback, http } from "viem";

/**
 * Server-side Arc RPC client with a FALLBACK across endpoints. The default
 * arc.network RPC is heavily rate-limited ("request limit reached") from Vercel's
 * shared IPs, so viem falls over to the thirdweb Arc RPC (separate limit) when it
 * throttles. Override/extend with a comma-separated ARC_RPC_URLS env (put a
 * dedicated/higher-limit RPC first for production). Use this for ALL server-side
 * reads (claim, balance, reconcile) so no single endpoint's limit breaks them.
 */

export const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
} as const;

const RPC_URLS = (
    process.env.ARC_RPC_URLS ??
    "https://rpc.testnet.arc.network,https://5042002.rpc.thirdweb.com"
)
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

// A read-optimised client for simple eth_call reads (balanceOf, a getter). The
// default arc.network primary rate-limits from Vercel IPs, and its lenient 15s x2
// retry means ONE throttled read can blow a 30s function budget (observed as
// intermittent 504s on the claim preview). This orders a higher-throughput
// endpoint FIRST (thirdweb by default; override with ARC_READ_RPC_URLS) with
// fast-fail retries so a stalled primary fails over in a few seconds, not 30.
const READ_RPC_URLS = (
    process.env.ARC_READ_RPC_URLS ??
    "https://5042002.rpc.thirdweb.com,https://rpc.testnet.arc.network"
)
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

export function serverReadClient() {
    return createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(
            // No per-transport retry (a throttled Arc RPC HANGS rather than erroring
            // fast, so retries just stack timeouts); a short timeout fails over to
            // the next endpoint quickly. Two endpoints => ~7s worst case.
            READ_RPC_URLS.map((u) => http(u, { retryCount: 0, timeout: 3_500 })),
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
            READ_RPC_URLS.map((u) =>
                http(u, {
                    batch: { batchSize: 90, wait: 8 },
                    retryCount: 0,
                    timeout: 6_000,
                }),
            ),
            { retryCount: 0 },
        ),
    });
}
