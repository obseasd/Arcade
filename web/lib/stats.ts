import { Address, createPublicClient, decodeEventLog, http, keccak256, parseAbiItem, toHex } from "viem";
import { ADDRESSES } from "./constants";
import { getLaunchpadAddressList } from "./launchpadGenerations";

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

// Stats scan is dominated by eth_getLogs across 50+ predecessor
// contracts over a 500k-block window. Alchemy free tier caps
// eth_getLogs at 10 BLOCKS per call (the 2026-06-14 diagnostic) which
// makes the scan unusable on Alchemy: every window returns
// InvalidRequestRpcError and `truncated=true` lands on every cron
// row, with all metrics stuck at 0.
//
// Use a server-side env override to point at a getLogs-friendly RPC
// (Arc public, thirdweb, dedicated node) - falls back to the public
// Arc RPC explicitly so we never accidentally run the stats scan on
// Alchemy regardless of how NEXT_PUBLIC_ARC_RPC_URL is set.
const ARC_RPC =
    process.env.ARC_STATS_RPC_URL ?? "https://rpc.testnet.arc.network";

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
    "0x4774F5C79201A4f5b62a0d23064233a8b6382581", // v3 factory
    "0x0C0a9c3B994dD87203c7e24c8e141f8F87945eE2", // v3 locker
    "0xb7D8795FbAC9CA2AE8067f876d3633bc96d86477", // v3 router
    "0x55ff22A36Cb8f42F3efeFB26E30E5b0876FD4587", // v3 quoter
    "0x7dfd779d77843Ef781b5346Aa86B985dCdF9757b", // v3 NPM
    "0x4Ad8cEC259671903dEfcE38518FCc905B773e73e", // v3 zap
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

// USDC-gas estimate: txCount * AVG_TX_GAS_USED * AVG_GAS_PRICE_WEI / DIV.
// Documented openly on the /stats page as an estimate until a real
// gasUsed * effectiveGasPrice scan via tx receipts ships.
//
// Pre-fix numbers (gasPrice=1 gwei, div=1e12) returned <1 micro-USDC
// per tx which rendered $0.00 on the dashboard even when the protocol
// had clearly burned real gas. Bumped gasPrice to 1000 gwei (1e12 wei)
// which matches observed Arc testnet contract-interaction costs of
// ~$0.10-$0.30 per tx for a 150k-gas trade. The divisor stays at
// 1e12 (wei -> 6-decimal USDC roughly assuming USDC is the native
// gas asset on Arc).
const AVG_TX_GAS_USED = 200_000n;
const AVG_GAS_PRICE_WEI = 1_000_000_000_000n; // 1000 gwei
const GAS_TO_USDC_DIVISOR = 10n ** 12n; // wei -> 6-decimal USDC

// Block window per eth_getLogs call. Arc public RPC empirically returns
// silently-empty windows past ~10k blocks when address-mode filtering is
// combined with the cumulative predecessor-contract list (~50 addresses).
// 5k keeps every call deep inside the cap so truncated=true stops landing
// on every snapshot - the symptom we hit in stats_snapshots showing 0/0/0
// across every cron tick.
const BLOCK_WINDOW = 5_000n;
// Hard cap on total blocks we scan in one snapshot. Dropped from 5M to
// 500k after the Arc public RPC started returning empty windows on
// wide scans, which made every snapshot land with truncated=true and
// every metric at zero. 500k blocks at ~0.5s block time covers about
// the last 70 hours of activity — enough to keep the cron's hourly
// deltas honest while leaving the older history to the Postgres
// time-series that survives the rolling window. The Ponder indexer
// roadmap replaces this scan entirely with a precise sum and lets us
// raise (or drop) the cap freely.
const MAX_TOTAL_BLOCKS = 500_000n;

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

    // 2026-06-17 fix: V3 stack was missing from the contracts list, so
    // every swap routed via the V3 router (every Clanker V3 trade) and
    // every concentrated-LP mint/burn/collect was invisible to the
    // tx-count + unique-wallets totals. Same gap on the factory /
    // quoter / NPM / Zap. Volume on V3 swaps is still missing because
    // sumLaunchpadVolume only reads Buy/Sell events on the launchpad —
    // a precise V3 volume scan ships with the indexer roadmap. This
    // patch at least restores the headline counts.
    const contracts: Address[] = [
        ADDRESSES.router,
        ADDRESSES.factory,
        ADDRESSES.launchpad,
        ADDRESSES.multiSwap,
        ADDRESSES.v3Router,
        ADDRESSES.v3Factory,
        ADDRESSES.v3Quoter,
        ADDRESSES.v3PositionManager,
        ADDRESSES.v3Locker,
        ADDRESSES.v3Zap,
        ADDRESSES.tokenVault,
        ...(ADDRESSES.twitterEscrow ? [ADDRESSES.twitterEscrow] : []),
        ...(ADDRESSES.v4Launchpad ? [ADDRESSES.v4Launchpad] : []),
        ...(ADDRESSES.arcadeHook ? [ADDRESSES.arcadeHook] : []),
        ...(ADDRESSES.v4PoolManager ? [ADDRESSES.v4PoolManager] : []),
        ...PREDECESSOR_CONTRACTS,
    ].filter((a): a is Address => !!a && a !== "0x0000000000000000000000000000000000000000");

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

    // Token counts: best-effort via the well-known TokenCreated topic on
    // each launchpad. Sum across every generation in the shared
    // generations list so the cumulative count keeps growing past a
    // redeploy. Source of truth is lib/launchpadGenerations.ts — adding
    // a new generation there propagates to both this scan AND the
    // client-side useLaunchpadTokens hook in one edit.
    const allLaunchpads = getLaunchpadAddressList();
    const launchpadCounts = await Promise.all(
        allLaunchpads.map((a) => countLaunchpadEvents(client, a, fromBlock, head)),
    );
    const tokensLaunched = launchpadCounts.reduce((a, b) => a + b, 0);

    // Cumulative volume: sum every Buy.usdcIn + every Sell.usdcOut across
    // every launchpad generation. Adds a meaningful "how much value
    // flowed through Arcade" number to the dashboard instead of leaving
    // volume hidden until the indexer ships. Failures per window are
    // silently dropped (0) so a single flaky RPC range doesn't tank the
    // whole page — the truncated flag picks it up.
    const volumeResults = await Promise.all(
        allLaunchpads.map((a) => sumLaunchpadVolume(client, a, fromBlock, head)),
    );
    // V3 swap volume comes through the pool side (router emits no
    // Swap), so we enumerate USDC-touching pools from every V3 factory
    // we ship and sum the absolute USDC delta per Swap event. Adds
    // every concentrated-LP trade — including the user's own /swap
    // USDC<->CL flow that was invisible before this hook.
    const v3FactoryAddrs: Address[] = [
        ADDRESSES.v3Factory,
        "0x4774F5C79201A4f5b62a0d23064233a8b6382581", // gen 8 v3 factory
    ].filter(
        (a): a is Address =>
            !!a && a !== "0x0000000000000000000000000000000000000000",
    );
    const v3VolumeUsdcMicros = await sumV3SwapVolume(
        client,
        v3FactoryAddrs,
        fromBlock,
        head,
    );
    const volumeUsdcMicros =
        volumeResults.reduce((acc, n) => acc + n, 0n) + v3VolumeUsdcMicros;
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
// Volume scan uses the canonical event ABI so the topic hash is
// derived once at module load. The hardcoded hashes in the prior
// implementation matched a different event signature on at least one
// generation (the inflated 14B figure on /stats was 1.4e25 raw - 6 to
// 7 orders of magnitude above the launchpad's lifetime budget). Going
// through parseAbiItem + decodeEventLog kills the chance of a topic-
// mismatch landing token-decimal amounts into the USDC accumulator.
const BUY_EVT_ABI = parseAbiItem(
    "event Buy(address indexed token, address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 newPriceQ64)",
);
const SELL_EVT_ABI = parseAbiItem(
    "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 newPriceQ64)",
);
const BUY_TOPIC = keccak256(
    toHex("Buy(address,address,uint256,uint256,uint256)"),
);
const SELL_TOPIC = keccak256(
    toHex("Sell(address,address,uint256,uint256,uint256)"),
);

// Uniswap V3 pool / factory event topics. We use the pool-side Swap
// (not the router) because the router doesn't emit one — every V3 trade
// boils down to a pool.Swap. PoolCreated lets us enumerate pools off
// the factory so we don't have to scan every Swap on the network and
// then filter (Arc has more V3 stacks than just Arcade).
const POOL_CREATED_TOPIC = keccak256(
    toHex("PoolCreated(address,address,uint24,int24,address)"),
);
const SWAP_EVT_ABI = parseAbiItem(
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const SWAP_TOPIC = keccak256(
    toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"),
);
// Sanity ceiling per individual event - any single Buy/Sell larger
// than this is treated as decoding noise and dropped. The launchpad
// graduates at 20k USDC so a single Buy of more than ~1M USDC is
// already a physical impossibility on the curve; the threshold is
// permissive to leave room for migration-time large transfers but
// strict enough that an 18-decimal token amount (1e21+) never lands.
const MAX_SANE_EVENT_MICROS = 10_000_000_000_000n; // 10M USDC in micros

async function sumLaunchpadVolume(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    address: Address | undefined,
    fromBlock: bigint,
    head: bigint,
): Promise<bigint> {
    if (!address) return 0n;
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
                    try {
                        const topic0 = (log as { topics: readonly string[] }).topics[0];
                        const isBuy = topic0 === BUY_TOPIC;
                        const decoded = decodeEventLog({
                            abi: [isBuy ? BUY_EVT_ABI : SELL_EVT_ABI],
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            data: (log as any).data,
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            topics: (log as any).topics,
                        });
                        // decoded.args is a discriminated tuple of either
                        // the Buy or Sell shape; widen through unknown
                        // before reading the side-specific field so TS
                        // accepts the runtime branch we already gated on
                        // isBuy.
                        const args = decoded.args as unknown as {
                            usdcIn?: bigint;
                            usdcOut?: bigint;
                        };
                        const usdcAmount = isBuy ? args.usdcIn : args.usdcOut;
                        // Guard against decoding noise / wrong-signature
                        // events still slipping through. USDC has 6
                        // decimals on Arc; values above MAX_SANE = 10M
                        // USDC are 18-decimal token amounts misrouted
                        // into the USDC accumulator.
                        if (
                            typeof usdcAmount === "bigint" &&
                            usdcAmount > 0n &&
                            usdcAmount < MAX_SANE_EVENT_MICROS
                        ) {
                            acc += usdcAmount;
                        }
                    } catch {
                        // decode failure - signature mismatch on a prior
                        // generation, malformed log. Drop silently so a
                        // single bad event does not poison the window.
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
 * Sums |USDC delta| across every V3 pool swap that touches USDC. The
 * router doesn't emit a Swap event so we go through the pool side:
 *
 *   1. Enumerate Arcade V3 pools from PoolCreated events on each
 *      known factory (current + every historical generation we still
 *      want to count). The decoded args give us pool address +
 *      token0 + token1, which lets us pre-filter to USDC-touching
 *      pools without an extra RPC.
 *   2. Scan Swap events across the filtered pool set in one
 *      multi-address getLogs per block window. Each Swap log carries
 *      signed amount0 / amount1; we read whichever side is USDC for
 *      that pool, take its absolute value, and sum.
 *
 * Single-tx swaps emit one Swap; multi-hop swaps emit one per leg, so
 * a USDC->A->USDC arb would double-count. That's fine here: the
 * dashboard is reporting "USDC routed", not "round-trip USDC". A more
 * precise per-trade accounting lands with the Ponder indexer.
 *
 * Empty array of factories (none configured in env) returns 0 so the
 * caller doesn't have to guard.
 */
async function sumV3SwapVolume(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    factories: Address[],
    fromBlock: bigint,
    head: bigint,
): Promise<bigint> {
    if (factories.length === 0) return 0n;
    const usdc = ADDRESSES.usdc.toLowerCase();

    // 1. Enumerate USDC-touching pools from every factory in parallel.
    const factoryWindows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        factoryWindows.push({ from, to });
    }
    /** Map<lowercased pool address, 0 if USDC = token0, 1 if USDC = token1>. */
    const usdcPools = new Map<string, 0 | 1>();
    await Promise.all(
        factories.flatMap((factory) =>
            factoryWindows.map(async ({ from, to }) => {
                try {
                    const logs = await client.getLogs({
                        address: factory,
                        topics: [POOL_CREATED_TOPIC],
                        fromBlock: from,
                        toBlock: to,
                    });
                    for (const log of logs) {
                        try {
                            const decoded = decodeEventLog({
                                abi: [
                                    parseAbiItem(
                                        "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
                                    ),
                                ],
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                data: (log as any).data,
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                topics: (log as any).topics,
                            });
                            const args = decoded.args as unknown as {
                                token0: Address;
                                token1: Address;
                                pool: Address;
                            };
                            const t0 = args.token0.toLowerCase();
                            const t1 = args.token1.toLowerCase();
                            if (t0 === usdc)
                                usdcPools.set(args.pool.toLowerCase(), 0);
                            else if (t1 === usdc)
                                usdcPools.set(args.pool.toLowerCase(), 1);
                        } catch {
                            /* decode noise, skip */
                        }
                    }
                } catch {
                    /* window failed, skip */
                }
            }),
        ),
    );

    if (usdcPools.size === 0) return 0n;
    const poolAddrs = Array.from(usdcPools.keys()) as Address[];

    // 2. Scan Swap events across the USDC-touching pools.
    const swapWindows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        swapWindows.push({ from, to });
    }
    const sums = await Promise.all(
        swapWindows.map(async ({ from, to }) => {
            try {
                const logs = await client.getLogs({
                    address: poolAddrs,
                    topics: [SWAP_TOPIC],
                    fromBlock: from,
                    toBlock: to,
                });
                let acc = 0n;
                for (const log of logs) {
                    try {
                        const usdcSide = usdcPools.get(
                            (log as { address: string }).address.toLowerCase(),
                        );
                        if (usdcSide === undefined) continue;
                        const decoded = decodeEventLog({
                            abi: [SWAP_EVT_ABI],
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            data: (log as any).data,
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            topics: (log as any).topics,
                        });
                        const args = decoded.args as unknown as {
                            amount0: bigint;
                            amount1: bigint;
                        };
                        const raw = usdcSide === 0 ? args.amount0 : args.amount1;
                        const abs = raw < 0n ? -raw : raw;
                        if (abs > 0n && abs < MAX_SANE_EVENT_MICROS) {
                            acc += abs;
                        }
                    } catch {
                        /* decode failure, skip */
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
