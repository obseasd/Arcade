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
    /** TokenCreated events on the V4 prototype launchpad (if any). */
    v4TokensLaunched: number;
    /** TokenLaunched events on the production ArcadeHook (V4 Phase 2). */
    v4HookLaunches: number;
    /** Cumulative USDC volume across all launchpad Buy + Sell events, in
     *  6-decimal raw units (divide by 1e6 for display dollars). */
    volumeUsdcMicros: bigint;
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

/**
 * Predecessor contract addresses from every prior generation we want to keep
 * counting toward Arcade's cumulative footprint after a fresh deploy. Without
 * this the /stats page resets to zero every time we redeploy, which buries
 * the testnet history Circle / partners look at.
 *
 * Add new generations at the TOP of each array (newest first) when bumping
 * the live stack. The address-mode getLogs accepts up to ~100 addresses per
 * call; we're well under that with 8 generations * 5 contracts each.
 */
const PREDECESSOR_CONTRACTS: Address[] = [
    // gen 8 (2026-06-11, audit v2 + cooldown-fix prep deploy)
    "0xD863e3475E00550FBe0Abf4F1127B673E65C86a4", // launchpad
    "0xc7321283D18C4cABcD5Eda4489845336A9F5c3ed", // twitter escrow
    // gen 7 (2026-06-09, audit-3 batch)
    "0x62aC6A355D092267a93a1Ffb13B7D1c121A5c0e8",
    "0xD63609d130698489603AC07dFDa338D958765808",
    "0x8afb163909BC0C96eD77D5dB3f01840B9227CA39",
    "0x4dddAdA3Cc38D331897C5F74F955A1194F5A8C64",
    "0xB501C21cE40b7559e33be0e9FBcD94D86Ece2c26",
    "0xBD13aB926DE7c82BA56727ea34F11FC4420A09E4",
    "0x8bE45CF7e5fEE5bf3388B5B95Ff944cbb6F8c82A",
    "0x5950b3B54C8e81F1d94e92BDEc5F3C73Ea59156a",
    // gen 6 (2026-06-08)
    "0xB15282e3a0c67989013c7bdc6cd6f4Fa0CdbaAd6",
    "0x4BE6f9207451e1e94C9cAEC1Dfbb44E2E4793457",
    "0xE420484fAd6d20493Cc300B10ACeB6C8c0806a6D",
    "0xa66b9F1D7FF2F083145E92Fd6d20E5676913A728",
    "0xDE23177fd69dF8ac2AB5DB1E8b2cef8f291Ac740",
    "0xC571b19785F90a7D5d6E8925FAD0Cd0B3b3b40bf",
    "0xEE10F32d7e92208Fcdf5410E401eEa7960578f91",
    "0x4ecEba4b966a32b42d8c4037308819a2D95b0920",
    // gen 5 (2026-06-07)
    "0xF441D73C69f00bf2A11019024A80D46a06bE2BdC",
    "0xeB5B83697285ac0Bd9dcd1e1d815076528188C63",
    "0xce9D0FC54574D32646eeC57eB38D82bc02B78901",
    "0x4A019876a5fCC057204d343e27Cb15f48D5c9431",
    "0x2eBE99fF479a2ac3100b9FC8AB7F3e6911b2C20a",
    "0xB89481c7e062c069497F5DbFf1349f92AE06060f",
    "0x9dED034Cdd1a80E9D07A68Db34f21B6b47d29aA6",
    "0xE1c9fF6D064c30234Eb6F071A619cdBd0675124b",
    // gen 4 (2026-06-01)
    "0xb621925D1aa0f1c2BeC6612Add5290F04F6c3168",
    "0x72581607da354b0F2EC438D59E9266B12aF73C90",
    "0x2991528022D6856125c6504D356457E77059659D",
    "0x5a6Ee52737d3CD5af7e32ed42b02e27FAaD504f4",
    "0xCaDA87cC272899666E42dD051A5156995e90d8D2",
    "0x2A8721C3Ed768c2561214040b8a3Ae6372c63c7A",
    "0xB381442bAB733eD07C77626dCC2Ca4A338763843",
    "0xc20F1Cc590f505a576bf8Bc5Fef7698f1b900Faa",
];

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
        ...(ADDRESSES.arcadeHook ? [ADDRESSES.arcadeHook] : []),
        ...(ADDRESSES.v4PoolManager ? [ADDRESSES.v4PoolManager] : []),
        ...PREDECESSOR_CONTRACTS,
    ];

    const seenTxs = new Set<string>();
    const seenWallets = new Set<string>();
    let truncated = false;

    // Note: a single getLogs across all addresses without a topic filter is the
    // cheapest way to count txs + wallets. We do not filter by event signature
    // because we want every interaction. The cost is we cannot disambiguate
    // event types from the log alone, so the per-contract counts (tokensLaunched
    // etc) require separate filtered scans below.
    //
    // Windows are scanned in parallel via Promise.all: every getLogs is
    // independent (different block range, same topic filter) so we can
    // pipeline the RPC roundtrips. Wall time drops from N*latency to
    // ~max(latency). The seen* Sets are mutated AFTER all windows
    // resolved, so there's no race on iteration order.
    const windows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        windows.push({ from, to });
    }
    const windowResults = await Promise.all(
        windows.map(async ({ from, to }) => {
            try {
                return await client.getLogs({
                    address: contracts,
                    fromBlock: from,
                    toBlock: to,
                });
            } catch {
                // Window blew past the RPC's range cap (shouldn't happen at
                // 50k but the documented Arc behavior is "silent empty").
                truncated = true;
                return [];
            }
        }),
    );
    for (const logs of windowResults) {
        for (const log of logs) {
            seenTxs.add(log.transactionHash.toLowerCase());
            // topics[1] is typically the indexed sender / creator for our
            // events. Best-effort attribution; the indexer will replace
            // this with proper per-event decoding.
            if (log.topics[1]) seenWallets.add(log.topics[1].toLowerCase());
        }
    }

    // Naive USDC gas estimate: txCount * avg_gas * avg_gas_price.
    // Marked as estimate on the /stats page until we wire receipt scans.
    const estimatedUsdcGasMicros =
        (BigInt(seenTxs.size) * AVG_TX_GAS_USED * AVG_GAS_PRICE_WEI) / GAS_TO_USDC_DIVISOR;

    // Token counts: best-effort via the well-known TokenCreated topic on the
    // launchpad. Sum across the current launchpad + every prior generation so
    // the cumulative count keeps growing past a redeploy.
    const PRIOR_LAUNCHPADS: Address[] = [
        "0xD863e3475E00550FBe0Abf4F1127B673E65C86a4", // gen 8 (2026-06-11)
        "0x62aC6A355D092267a93a1Ffb13B7D1c121A5c0e8", // gen 7
        "0xB15282e3a0c67989013c7bdc6cd6f4Fa0CdbaAd6", // gen 6
        "0xF441D73C69f00bf2A11019024A80D46a06bE2BdC", // gen 5
        "0xb621925D1aa0f1c2BeC6612Add5290F04F6c3168", // gen 4
    ];
    const launchpadCounts = await Promise.all([
        countLaunchpadEvents(client, ADDRESSES.launchpad, fromBlock, head),
        ...PRIOR_LAUNCHPADS.map((a) => countLaunchpadEvents(client, a, fromBlock, head)),
    ]);
    const tokensLaunched = launchpadCounts.reduce((a, b) => a + b, 0);

    // Cumulative volume: sum every Buy.usdcIn + every Sell.usdcOut across
    // the current launchpad AND every prior generation. Adds a meaningful
    // "how much value flowed through Arcade" number to the dashboard
    // instead of leaving volume hidden until the indexer ships. Failures
    // per window are silently dropped (0) so a single flaky RPC range
    // doesn't tank the whole page - the truncated flag picks it up.
    const volumeResults = await Promise.all([
        sumLaunchpadVolume(client, ADDRESSES.launchpad, fromBlock, head),
        ...PRIOR_LAUNCHPADS.map((a) => sumLaunchpadVolume(client, a, fromBlock, head)),
    ]);
    const volumeUsdcMicros = volumeResults.reduce((acc, n) => acc + n, 0n);
    const v4TokensLaunched = ADDRESSES.v4Launchpad
        ? await countLaunchpadEvents(client, ADDRESSES.v4Launchpad, fromBlock, head)
        : 0;
    // ArcadeHook emits TokenLaunched(token, creator, mode, name, symbol,
    // metadataURI) on every createLaunch. Count via the well-known topic for
    // a precise number (the V2 fallback "count all logs" would also include
    // CurveBuy/CurveSell on the same address and over-count).
    const v4HookLaunches = ADDRESSES.arcadeHook
        ? await countHookLaunches(client, ADDRESSES.arcadeHook, fromBlock, head)
        : 0;

    return {
        txCount: seenTxs.size,
        uniqueWallets: seenWallets.size,
        tokensLaunched,
        v4TokensLaunched,
        v4HookLaunches,
        volumeUsdcMicros,
        estimatedUsdcGasMicros,
        asOfBlock: head,
        asOfIso: new Date().toISOString(),
        truncated,
    };
}

/**
 * Counts ArcadeHook's TokenLaunched events specifically. We filter by the
 * keccak topic of the event signature so other ArcadeHook events
 * (CurveBuy / CurveSell / Graduated / RoyaltyPaid) do not inflate the launch
 * counter. Returns 0 on RPC failure rather than throwing, since the metric
 * being conservatively low is preferable to the stats page failing.
 */
async function countHookLaunches(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    address: Address,
    fromBlock: bigint,
    head: bigint,
): Promise<number> {
    // Canonical keccak of TokenLaunched(address,address,uint8,string,string,string)
    // verified against contracts/v4src/ArcadeHook.sol:240. Pre-2026-06-06 this
    // was a placeholder + a void; the page over-counted by including every log
    // emitted on the address. Now we filter by topic for a precise count.
    const TOKEN_LAUNCHED_TOPIC =
        "0xefc07ba8ee8f7015e511a8f24566606d5aaa4200644aeb0584d888fba8a7dd53" as `0x${string}`;

    // Parallel chunked scan (same shape as the txs/wallets pass above).
    const windows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        windows.push({ from, to });
    }
    const counts = await Promise.all(
        windows.map(async ({ from, to }) => {
            try {
                const logs = await client.getLogs({
                    address,
                    fromBlock: from,
                    toBlock: to,
                    topics: [TOKEN_LAUNCHED_TOPIC],
                });
                return logs.length;
            } catch {
                return 0;
            }
        }),
    );
    return counts.reduce((a, b) => a + b, 0);
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
    // Canonical keccak of TokenCreated(address,address,uint8,address,uint16,
    // string,string,string) per contracts/src/launchpad/interfaces/IArcadeLaunchpad.sol:37.
    // Topic filtering replaces the prior count-all-logs heuristic which
    // over-counted by including TokenBuy / TokenMigrated / etc events on the
    // same address.
    const TOKEN_CREATED_TOPIC =
        "0x12902ddf3a68b76ea3ba6ef278e7fd7c3b59e05cb7e64bd406bb21bb1ddd8d23" as `0x${string}`;

    // Parallel chunked scan (same shape as the V4 launches counter above).
    const windows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        windows.push({ from, to });
    }
    const counts = await Promise.all(
        windows.map(async ({ from, to }) => {
            try {
                const logs = await client.getLogs({
                    address,
                    fromBlock: from,
                    toBlock: to,
                    topics: [TOKEN_CREATED_TOPIC],
                });
                return logs.length;
            } catch {
                return 0;
            }
        }),
    );
    return counts.reduce((a, b) => a + b, 0);
}

/**
 * Sum every Buy(usdcIn) + Sell(usdcOut) on a launchpad in 6-decimal raw
 * units. We index Buy / Sell topics specifically rather than scanning all
 * logs because a launchpad emits many event shapes (TokenCreated,
 * TokenMigrated, RoyaltyPaid, ...) and we only want the USDC amounts that
 * represent real trading flow. Returns 0 on RPC failure rather than
 * throwing so a flaky window doesn't tank the whole snapshot.
 *
 * Event layouts (from contracts/src/launchpad/ArcadeLaunchpad.sol):
 *   Buy (token indexed, buyer indexed, usdcIn, tokensOut, newPriceQ64)
 *   Sell(token indexed, seller indexed, tokensIn, usdcOut, newPriceQ64)
 * Data layout: 3 unindexed uint256, each 32 bytes. For Buy the FIRST data
 * slot is usdcIn; for Sell the SECOND data slot is usdcOut.
 */
async function sumLaunchpadVolume(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    address: Address | undefined,
    fromBlock: bigint,
    head: bigint,
): Promise<bigint> {
    if (!address) return 0n;
    // keccak256("Buy(address,address,uint256,uint256,uint256)")
    const BUY_TOPIC =
        "0xfc5c39e94d05fae6a3a91da11b7b94f5b29d4d9fa45a13b18d8c1d27f7e74948" as `0x${string}`;
    // keccak256("Sell(address,address,uint256,uint256,uint256)")
    const SELL_TOPIC =
        "0xb33d2162aead99dab59e77a7e6266de8b8932b95c1571d83ed4d3a8c1c6f3b16" as `0x${string}`;
    const windows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        windows.push({ from, to });
    }
    const sums = await Promise.all(
        windows.map(async ({ from, to }) => {
            try {
                const logs = await client.getLogs({
                    address,
                    fromBlock: from,
                    toBlock: to,
                    // viem accepts a single array of topics where each slot
                    // becomes a "topics[i] in [...]" constraint. We OR Buy
                    // OR Sell in slot 0.
                    topics: [[BUY_TOPIC, SELL_TOPIC]],
                });
                let acc = 0n;
                for (const log of logs) {
                    const data = (log as { data?: string }).data ?? "0x";
                    // data is 0x + 3*32 bytes = 192 hex chars after 0x.
                    if (data.length < 2 + 192) continue;
                    const isBuy = (log as { topics: readonly string[] }).topics[0] === BUY_TOPIC;
                    // Buy: usdcIn = first uint256 (offset 0..64 hex chars after 0x)
                    // Sell: usdcOut = second uint256 (offset 64..128)
                    const slotStart = isBuy ? 2 : 2 + 64;
                    const slotEnd = slotStart + 64;
                    try {
                        acc += BigInt("0x" + data.slice(slotStart, slotEnd));
                    } catch {
                        // malformed slot, skip
                    }
                }
                return acc;
            } catch {
                return 0n;
            }
        }),
    );
    return sums.reduce((a, b) => a + b, 0n);
}

/**
 * Format a 6-decimal raw USDC amount as a display dollar string.
 * Used for both the gas-paid hero number and the cumulative-volume card.
 */
export function formatUsdcGas(micros: bigint): string {
    const whole = micros / 1_000_000n;
    const cents = (micros % 1_000_000n) / 10_000n;
    return `$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}
