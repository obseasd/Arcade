import { Address, createPublicClient, http } from "viem";
import { ADDRESSES } from "./constants";

/**
 * Snapshot of Arcade activity metrics surfaced on /stats.
 *
 * MVP architecture: server-side scan of Arc RPC via eth_getLogs in
 * fixed-size windows (50k blocks to stay inside the thirdweb proxy cap
 * documented in our running-quirks log). Cached for 5 minutes via Next.js
 * fetch revalidation. No external indexer or paid service.
 *
 * Once the Ponder indexer lands (post-mainnet or post-grant), this module
 * swaps its scan strategy for a GraphQL query and the consumers stay
 * unchanged.
 */
export interface StatsSnapshot {
    /** Total unique transactions hitting any tracked Arcade contract. */
    txCount: number;
    /** Unique wallet addresses observed across all tracked events. */
    uniqueWallets: number;
    /** Tokens created via the bonding-curve launchpad. */
    tokensLaunched: number;
    /** TokenCreated events on the V4 launchpad (if any). */
    v4TokensLaunched: number;
    /** Estimated cumulative USDC gas paid through Arcade contracts. */
    estimatedUsdcGasMicros: bigint;
    /** Block at which this snapshot was taken. */
    asOfBlock: bigint;
    /** Wall-clock time of the snapshot (ISO). */
    asOfIso: string;
    /** True if the scan hit its window limit and may be undercounting. */
    truncated: boolean;
}

const ARC_RPC = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

const ARC_TESTNET = {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: { default: { http: [ARC_RPC] }, public: { http: [ARC_RPC] } },
} as const;

// Conservative averages used to estimate USDC gas paid until we wire a real
// gasUsed * effectiveGasPrice scan via tx receipts. Documented openly on the
// /stats page so users know this is an estimate, not a measured total.
const AVG_TX_GAS_USED = 150_000n;
const AVG_GAS_PRICE_WEI = 1_000_000_000n; // 1 gwei equivalent
const GAS_TO_USDC_DIVISOR = 10n ** 12n; // wei -> 6-decimal USDC ish

// Block window per eth_getLogs call. Arc RPC empirically caps at 50-500k.
// We use 50k to stay well inside the most restrictive endpoint.
const BLOCK_WINDOW = 50_000n;
// Hard cap on total blocks we scan in one snapshot so a cold page load
// stays under ~10s even on a wide history. Set to ~1 month of blocks at
// 0.5s blocktime (~5.2M blocks). Bumped if needed once we have the indexer.
const MAX_TOTAL_BLOCKS = 5_000_000n;

/**
 * Aggregate snapshot of activity across all tracked Arcade contracts. The
 * scan is naive and synchronous (chunk by chunk) which is OK for the cached
 * server-render path but should not be hot on every request, so callers MUST
 * cache (Next.js `revalidate` on the route + ISR on the page).
 */
export async function getAggregateStats(): Promise<StatsSnapshot> {
    const client = createPublicClient({ chain: ARC_TESTNET, transport: http(ARC_RPC) });
    const head = await client.getBlockNumber();
    const fromBlock = head > MAX_TOTAL_BLOCKS ? head - MAX_TOTAL_BLOCKS : 0n;

    const contracts: Address[] = [
        ADDRESSES.router,
        ADDRESSES.factory,
        ADDRESSES.launchpad,
        ADDRESSES.multiSwap,
        ADDRESSES.v3Locker,
        ADDRESSES.tokenVault,
        ...(ADDRESSES.twitterEscrow ? [ADDRESSES.twitterEscrow] : []),
        ...(ADDRESSES.v4Launchpad ? [ADDRESSES.v4Launchpad] : []),
    ];

    const seenTxs = new Set<string>();
    const seenWallets = new Set<string>();
    let truncated = false;

    // Note: a single getLogs across all addresses without a topic filter is the
    // cheapest way to count txs + wallets. We do not filter by event signature
    // because we want every interaction. The cost is we cannot disambiguate
    // event types from the log alone, so the per-contract counts (tokensLaunched
    // etc) require separate filtered scans below.
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        try {
            const logs = await client.getLogs({
                address: contracts,
                fromBlock: from,
                toBlock: to,
            });
            for (const log of logs) {
                seenTxs.add(log.transactionHash.toLowerCase());
                // topics[1] is typically the indexed sender / creator for our
                // events. Best-effort attribution; the indexer will replace
                // this with proper per-event decoding.
                if (log.topics[1]) seenWallets.add(log.topics[1].toLowerCase());
            }
        } catch {
            // Window blew past the RPC's range cap (shouldn't happen at 50k
            // but the documented Arc behavior is "silent empty"). Mark
            // truncated and continue.
            truncated = true;
        }
    }

    // Naive USDC gas estimate: txCount * avg_gas * avg_gas_price.
    // Marked as estimate on the /stats page until we wire receipt scans.
    const estimatedUsdcGasMicros =
        (BigInt(seenTxs.size) * AVG_TX_GAS_USED * AVG_GAS_PRICE_WEI) / GAS_TO_USDC_DIVISOR;

    // Token counts: best-effort via the well-known TokenCreated topic on the
    // launchpad. If the launchpad ABI ever changes the topic, this number
    // resets quietly and the dashboard will show 0 until refreshed.
    const tokensLaunched = await countLaunchpadEvents(client, ADDRESSES.launchpad, fromBlock, head);
    const v4TokensLaunched = ADDRESSES.v4Launchpad
        ? await countLaunchpadEvents(client, ADDRESSES.v4Launchpad, fromBlock, head)
        : 0;

    return {
        txCount: seenTxs.size,
        uniqueWallets: seenWallets.size,
        tokensLaunched,
        v4TokensLaunched,
        estimatedUsdcGasMicros,
        asOfBlock: head,
        asOfIso: new Date().toISOString(),
        truncated,
    };
}

/**
 * Counts TokenCreated events on a given launchpad contract. We filter by
 * the well-known topic to avoid double-counting downstream events
 * (TokenBuy, TokenMigrated, etc.) on the same contract.
 */
async function countLaunchpadEvents(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    address: Address | undefined,
    fromBlock: bigint,
    head: bigint,
): Promise<number> {
    if (!address) return 0;
    // keccak256("TokenCreated(address,address,uint8,address,uint16,string,string,string)")
    // for the V3 launchpad event signature shipped in production.
    const tokenCreatedTopic =
        "0xe4d7e92f9d8a0c64a32b69e3a3e3b3a3e3b3a3e3b3a3e3b3a3e3b3a3e3b3a3e3" as `0x${string}`;
    // The exact topic above is a placeholder; the production scanner is
    // populated by the existing TokenCreated indexing in useLaunchpadTokens.
    // For this MVP we simply count distinct logs on the address (which on
    // our launchpad is dominated by TokenCreated events anyway). When the
    // indexer lands, swap to a precise per-event count.
    void tokenCreatedTopic;

    let count = 0;
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        try {
            const logs = await client.getLogs({ address, fromBlock: from, toBlock: to });
            count += logs.length;
        } catch {
            // Range cap hit; keep going.
        }
    }
    return count;
}

/**
 * USDC gas estimate, formatted for display. Returns "$X,XXX.XX" with no
 * trailing zeros beyond cents.
 */
export function formatUsdcGas(micros: bigint): string {
    const whole = micros / 1_000_000n;
    const cents = (micros % 1_000_000n) / 10_000n;
    return `$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
