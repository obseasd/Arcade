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

// A getLogs-optimised client. eth_getLogs must be paged in <=10k-block windows
// (Arc RPC cap), and doing dozens of those against the rate-limited arc.network
// primary times the function out. This orders a higher-throughput endpoint FIRST
// (thirdweb by default; override with ARC_LOGS_RPC_URLS) with fast-fail retries,
// so a many-window scan finishes well within the function budget.
const LOGS_RPC_URLS = (
    process.env.ARC_LOGS_RPC_URLS ??
    "https://5042002.rpc.thirdweb.com,https://rpc.testnet.arc.network"
)
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

export function serverLogsClient() {
    return createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(
            LOGS_RPC_URLS.map((u) => http(u, { retryCount: 1, retryDelay: 300, timeout: 8_000 })),
            { retryCount: 1, retryDelay: 200 },
        ),
    });
}
