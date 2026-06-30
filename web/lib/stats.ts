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
    // gen 9 (2026-06-21, pre-Path-B live stack — superseded by the 2026-06-30
    // Path B redeploy; keep counting so the page does not drop this gen's
    // tokens / volume / wallets after the cutover).
    "0x7337789D6F0f731BCBE6CE6a44334F548Bba56b9", // launchpad
    "0xfD1c54B13C30AE50a7e5642D7d7040AF6CB23bd8", // twitter escrow
    "0x1acc719F43AaB36b29Df6F9B8ecd02D8704c4D29", // v3 factory
    "0x8434cAeC1e6074aE6d98d5744b485C7F5f19F6A7", // v3 locker
    "0xB6a722667D1a61170B15A3d82ece155D3516db19", // v3 router
    "0xD428D8975804ffE2AFD82E8Ff02273d6a3E89f6B", // v3 quoter
    "0xB3FDAEE3c1Bc3e08D4b4B9e5bBC3708c1b99AabD", // v3 NPM
    "0x629da8bAD9DE632990c70Ad907cbfa65bc214187", // v3 zap
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
    // Multicall3 canonical address — wires viem's client.multicall()
    // so the V3/V2 volume scanners can batch hundreds of token0/token1
    // reads into a single HTTP roundtrip instead of fanning out to
    // unbatched eth_calls (which the cron's 60s budget can't survive).
    contracts: {
        multicall3: {
            address:
                "0xcA11bde05977b3631167028862bE2a173976CA11" as Address,
            blockCreated: 0,
        },
    },
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

    // Audit 2026-06-18 H-06: previous list was missing AutoCompounder,
    // Orbs limit-order stack, V2 Zap, LockedVault, the V4 prototype
    // surfaces and the V2 Zap helper. Each missing entry meant any tx
    // touching only that contract was invisible to txCount and
    // uniqueWallets. Now any address keyed on ADDRESSES whose contract
    // emits logs that a user originated is in the scan, gated on
    // !== zeroAddress so an unconfigured optional surface (e.g.
    // pre-deploy V4 prototype) does not crash the scan.
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
        ADDRESSES.v2Zap,
        ADDRESSES.autoCompounder,
        ADDRESSES.orbsTwap,
        ADDRESSES.orbsExchangeV2,
        ADDRESSES.orbsLens,
        ADDRESSES.lockedVault,
        ...(ADDRESSES.twitterEscrow ? [ADDRESSES.twitterEscrow] : []),
        ...(ADDRESSES.v4Launchpad ? [ADDRESSES.v4Launchpad] : []),
        ...(ADDRESSES.arcadeHook ? [ADDRESSES.arcadeHook] : []),
        ...(ADDRESSES.v4PoolManager ? [ADDRESSES.v4PoolManager] : []),
        ...(ADDRESSES.v4Hook ? [ADDRESSES.v4Hook] : []),
        ...(ADDRESSES.v4StateView ? [ADDRESSES.v4StateView] : []),
        ...(ADDRESSES.v4Quoter ? [ADDRESSES.v4Quoter] : []),
        ...(ADDRESSES.v4Router ? [ADDRESSES.v4Router] : []),
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
            // Audit 2026-06-18 H-03: previous code unconditionally added
            // topics[1] to seenWallets, but for the dominant event
            // signatures on Arcade (Buy/Sell/V2-Swap/V3-Swap/V4
            // CurveBuy/CurveSell/TokenCreated/TokenLaunched) topics[1]
            // is the TOKEN or POOL or ROUTER, not the user wallet. The
            // result was a structurally wrong "unique wallets" headline:
            // V2/V3 swaps collapsed to one router address each,
            // launchpad activity attributed to the token contracts.
            // walletTopicForEvent maps the well-known event signature
            // hashes to the correct topic slot; unknown signatures fall
            // back to topics[1] for legacy compat but log nothing into
            // the dashboard's headline if no signature mapped — better
            // to under-count than to mis-count.
            const userAddr = extractWalletFromLog(log.topics);
            if (userAddr) seenWallets.add(userAddr);
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
    // V3 swap volume — see sumV3SwapVolume for the address-less
    // strategy. This now catches Rubicon V3 / Arcade V3 / Synthra /
    // any other V3-fork pool that routes USDC, including ones whose
    // PoolCreated event lives outside the 500k-block scan window
    // (the factory-enumeration version we shipped first silently
    // missed all of them, which is why the dashboard reported $265
    // even after the user ran sustained USDC↔SeedETH trades).
    const v3 = await sumV3SwapVolume(client, fromBlock, head);
    // V2 swap volume — same address-less strategy as V3.
    const v2 = await sumV2SwapVolume(client, fromBlock, head);
    // V4 ArcadeHook bonding-curve volume — audit H-04. Scoped to the
    // arcadeHook address only (cheap, no fan-out).
    const hook = await sumHookVolume(client, ADDRESSES.arcadeHook, fromBlock, head);
    // Audit M-01: a failed sub-scanner sets truncated=true so the
    // dashboard's "Heads-up" banner surfaces the partial-data state.
    if (!v3.complete || !v2.complete || !hook.complete) truncated = true;
    const volumeUsdcMicros =
        volumeResults.reduce((acc, n) => acc + n, 0n) +
        v3.volume +
        v2.volume +
        hook.volume;
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
 * Map a log's topic[0] (event signature hash) to the topic slot that
 * holds the user wallet address, then extract that address. Returns
 * null when the event has no user-wallet topic (PairCreated,
 * PoolCreated, Memo events, ...). Bytes32 → address conversion drops
 * the leading 24 hex chars (12 zero bytes).
 *
 * Audit 2026-06-18 H-03: replaces the previous "always use topics[1]"
 * heuristic that mis-attributed every router-emitted Swap to the
 * router address and every launchpad Buy/Sell to the token address.
 */
function extractWalletFromLog(topics: readonly string[]): string | null {
    const t0 = topics[0]?.toLowerCase();
    if (!t0) return null;
    // topic-slot mapping for every event signature we explicitly track.
    // Slot 0 means "no user wallet on this event, skip".
    const slot = walletTopicSlot().get(t0);
    if (slot === undefined) {
        // Unknown signature: skip rather than land a token / pool /
        // router address into the unique-wallets set.
        return null;
    }
    if (slot === 0) return null;
    const raw = topics[slot]?.toLowerCase();
    if (!raw || raw.length !== 66) return null;
    // bytes32 → address: keep the low 20 bytes (40 hex chars).
    return "0x" + raw.slice(26);
}

// Lazy map of event signature hash → topic slot holding the user
// wallet. Defined as a function so the topic-constant declarations
// below (BUY_TOPIC, SELL_TOPIC, ...) can stay near the other event-
// signature constants in the file without forcing a TDZ on the
// module-load order. The map is built once on first call.
// Slot 0 means the event has no user wallet (skip).
let _walletTopicSlot: Map<string, number> | null = null;
function walletTopicSlot(): Map<string, number> {
    if (_walletTopicSlot) return _walletTopicSlot;
    _walletTopicSlot = new Map<string, number>([
        [BUY_TOPIC.toLowerCase(), 2],            // Buy(token, buyer, ...)
        [SELL_TOPIC.toLowerCase(), 2],           // Sell(token, seller, ...)
        [SWAP_TOPIC.toLowerCase(), 2],           // V3 Swap(sender=router, recipient=user, ...)
        [V2_SWAP_TOPIC.toLowerCase(), 2],        // V2 Swap(sender=router, ..., to=user)
        [HOOK_CURVE_BUY_TOPIC.toLowerCase(), 2], // CurveBuy(poolId, buyer, ...)
        [HOOK_CURVE_SELL_TOPIC.toLowerCase(), 2],// CurveSell(poolId, seller, ...)
        // TokenCreated(token, creator, mode, paired, royaltyBps, ...) — topic[2] = creator
        ["0x12902ddf3a68b76ea3ba6ef278e7fd7c3b59e05cb7e64bd406bb21bb1ddd8d23", 2],
        // TokenLaunched(token, creator, mode, name, symbol, metadataURI) — topic[2] = creator
        ["0xefc07ba8ee8f7015e511a8f24566606d5aaa4200644aeb0584d888fba8a7dd53", 2],
        // PoolCreated / PairCreated emit token addresses only — skip.
        [POOL_CREATED_TOPIC.toLowerCase(), 0],
        [PAIR_CREATED_TOPIC.toLowerCase(), 0],
    ]);
    return _walletTopicSlot;
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

// V2 pair Swap event. Unlike V3 the amounts are uint256 (not int256)
// and split into separate in/out fields per side, but the principle is
// the same: pair-side emit, router silent, USDC volume = whichever side
// is the USDC leg of the pair. PairCreated lets us enumerate pairs off
// the factory the same way.
const PAIR_CREATED_TOPIC = keccak256(
    toHex("PairCreated(address,address,address,uint256)"),
);
const V2_SWAP_EVT_ABI = parseAbiItem(
    "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
const V2_SWAP_TOPIC = keccak256(
    toHex("Swap(address,uint256,uint256,uint256,uint256,address)"),
);

// V4 ArcadeHook bonding-curve events. Phase 2 of the V4 rollout, hidden
// behind NEXT_PUBLIC_V4_HOOK_ENABLED in the front-end but the hook
// itself can emit independently of any UI flag once deployed. The hook
// emits its own CurveBuy/CurveSell events from the bonding curve phase,
// distinct from a Uniswap V4 PoolManager Swap. PoolId is an alias for
// bytes32 on-chain so the event signature uses bytes32 directly.
//
// Audit 2026-06-18 H-04: previously the V4 hook stack was counted only
// at tx-level (via its presence in the contracts array) but the dollar
// flow through CurveBuy/CurveSell was entirely dropped from the
// cumulative volume figure.
const HOOK_CURVE_BUY_EVT_ABI = parseAbiItem(
    "event CurveBuy(bytes32 indexed poolId, address indexed buyer, uint256 grossUsdcIn, uint256 tokensOut)",
);
const HOOK_CURVE_SELL_EVT_ABI = parseAbiItem(
    "event CurveSell(bytes32 indexed poolId, address indexed seller, uint256 tokensIn, uint256 usdcOut)",
);
const HOOK_CURVE_BUY_TOPIC = keccak256(
    toHex("CurveBuy(bytes32,address,uint256,uint256)"),
);
const HOOK_CURVE_SELL_TOPIC = keccak256(
    toHex("CurveSell(bytes32,address,uint256,uint256)"),
);

// Sanity ceiling per individual event - any single Buy/Sell larger
// than this is treated as decoding noise and dropped. The launchpad
// graduates at 20k USDC so a single Buy of more than ~1M USDC is
// already a physical impossibility on the curve; the threshold is
// permissive to leave room for migration-time large transfers but
// strict enough that an 18-decimal token amount (1e21+) never lands.
//
// Audit 2026-06-18 H-02: this ceiling is now scoped to the LAUNCHPAD
// scanner only (where the 20k USDC graduation cap makes >>1M USDC per
// event physically impossible). The V3/V2/V4-hook scanners do their
// own decoder-correctness check (topic[0] match + log-data length)
// instead, and large legitimate trades (>$10M USDC, plausible on
// mainnet for institutional flow / treasury rebalances) now reach the
// accumulator instead of silently dropping.
const MAX_SANE_EVENT_MICROS = 10_000_000_000_000n; // 10M USDC in micros

// Audit 2026-06-19: per-SWAP outlier ceiling for the address-less V3/V2
// scanners. Removing the ceiling in H-02 let occasional outlier swaps
// inflate a single cron snapshot to absurd values (an observed
// $914,488 spike from one large/mis-scaled WUSDC swap), which the
// MAX-over-snapshots persistence then pinned as the public headline.
// A single swap above this on Arc TESTNET is a bot outlier, not
// organic protocol volume, so we drop it from the dashboard total.
// NOTE: this is a testnet-grade filter — RAISE or remove it for
// mainnet where a single >$100k swap can be legitimate.
const MAX_SANE_SWAP_MICROS = 100_000_000_000n; // 100k USDC in micros

// Per-pool decimals normalization. Arc has multiple USDC-equivalent
// tokens that route the same dollar:
//   - USDC (0x3600..., 6 dec, native Arc gas token)
//   - WUSDC (0x911b..., 18 dec, used by Synthra + UnitFlow V3 pools)
// Both are USDC at the dollar level; their raw amounts differ by 10^12.
// To get USDC parity in the accumulator we treat WUSDC as USDC-side and
// scale 18-dec amounts down by 1e12.
//
// Audit 2026-06-18 H-01: previously only native USDC was recognised as
// the USDC side, so every Synthra/UnitFlow pool (which route through
// WUSDC) was missed entirely AND a naive fix that just added WUSDC to
// the equality check would have blown the MAX_SANE ceiling because
// 18-dec amounts are 10^12 larger.
const WUSDC_SCALE_DIVISOR = 10n ** 12n; // 18-dec WUSDC -> 6-dec USDC micros

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
 * router doesn't emit a Swap event so we go through the pool side.
 *
 * Strategy: address-LESS getLogs filtered by the Swap topic, then
 * lazy-resolve each unique pool's token0/token1 via multicall to
 * decide whether USDC is on side 0 or 1. This bypasses the
 * factory-enumeration approach we used first — which silently
 * missed pools created OUTSIDE the 500k-block scan window (the user
 * trades USDC↔SeedETH through Rubicon V3 pools deployed long ago,
 * none of whose PoolCreated events live in the recent window) AND
 * pools created by V3 forks we don't know about (Rubicon V3,
 * Synthra, UnitFlow, etc).
 *
 * Trade-off: address-less getLogs returns a lot more events to
 * decode, but Arc's public RPC handles a 5k-block window with this
 * pattern cleanly and the cron only runs once an hour. The hot
 * upgrade path stays the indexer.
 *
 * Multi-hop swaps emit one Swap per leg, so a USDC→A→USDC arb is
 * double-counted. That matches the dashboard semantic ("USDC
 * routed"), which is what we want here.
 */
/** Result of one of the address-less swap scanners. `complete=false`
 *  signals that at least one getLogs window failed and the dashboard
 *  should set `truncated=true`. */
interface SwapScanResult {
    volume: bigint;
    complete: boolean;
}

/** Per-pool USDC-side metadata: which side (0/1) holds a
 *  USDC-equivalent token, and the divisor needed to bring its raw
 *  amount into 6-dec USDC micros (1n for native USDC, 10^12n for
 *  WUSDC). Audit H-01. */
type UsdcSideMeta = { side: 0 | 1; divisor: bigint };

async function sumV3SwapVolume(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    fromBlock: bigint,
    head: bigint,
): Promise<SwapScanResult> {
    const usdc = ADDRESSES.usdc.toLowerCase();
    const wusdc = ADDRESSES.wusdc.toLowerCase();

    // 1. Scan ALL Swap events by topic across the window (no address
    //    filter). Each log's `address` IS the pool, so we collect a
    //    de-duped set of pools touched in the scan window.
    let complete = true;
    const swapWindows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        swapWindows.push({ from, to });
    }
    const allWindows = await Promise.all(
        swapWindows.map(async ({ from, to }) => {
            try {
                return (await client.getLogs({
                    topics: [SWAP_TOPIC],
                    fromBlock: from,
                    toBlock: to,
                })) as Array<{ address: string; topics: string[]; data: string }>;
            } catch (err) {
                // Audit M-01: surface window failures via the
                // `complete` flag so the outer cron can stamp
                // truncated=true on the snapshot. Previously these
                // failures dropped events silently.
                complete = false;
                console.warn(
                    `[stats v3] getLogs ${from}..${to} failed:`,
                    (err as Error)?.message ?? err,
                );
                return [];
            }
        }),
    );
    const allLogs = allWindows.flat();
    console.log(`[stats v3] scanned ${allLogs.length} Swap events`);
    if (allLogs.length === 0) return { volume: 0n, complete };

    const poolAddrs = Array.from(
        new Set(allLogs.map((l) => l.address.toLowerCase())),
    );
    console.log(`[stats v3] ${poolAddrs.length} unique pools`);

    // 2. For every pool seen, read token0 + token1 via multicall3.
    //    Unbatched readContract fan-out blew past the cron's 60s
    //    budget on Arc's public RPC; multicall coalesces all reads
    //    into one HTTP roundtrip per chunk. Chunk size of 500 keeps
    //    the calldata under the gas cap on Arc's multicall3.
    const CHUNK = 500;
    const usdcPools = new Map<string, UsdcSideMeta>();
    for (let i = 0; i < poolAddrs.length; i += CHUNK) {
        const slice = poolAddrs.slice(i, i + CHUNK);
        const contracts = slice.flatMap((p) => [
            {
                address: p as Address,
                abi: [
                    parseAbiItem("function token0() view returns (address)"),
                ],
                functionName: "token0" as const,
            },
            {
                address: p as Address,
                abi: [
                    parseAbiItem("function token1() view returns (address)"),
                ],
                functionName: "token1" as const,
            },
        ]);
        let results: Array<{ status: "success" | "failure"; result?: Address }> = [];
        try {
            results = (await client.multicall({
                contracts: contracts as never,
                allowFailure: true,
            })) as never;
        } catch (err) {
            complete = false;
            console.warn(
                `[stats v3] multicall chunk ${i} failed:`,
                (err as Error)?.message ?? err,
            );
            continue;
        }
        for (let j = 0; j < slice.length; j++) {
            const r0 = results[j * 2];
            const r1 = results[j * 2 + 1];
            const t0 =
                r0?.status === "success"
                    ? (r0.result as Address | undefined)?.toLowerCase()
                    : undefined;
            const t1 =
                r1?.status === "success"
                    ? (r1.result as Address | undefined)?.toLowerCase()
                    : undefined;
            // Audit H-01: recognise both native USDC (6-dec) AND
            // WUSDC (18-dec) as USDC-equivalent sides. WUSDC amounts
            // need scaling down by 10^12 to reach micros parity.
            if (t0 === usdc) usdcPools.set(slice[j], { side: 0, divisor: 1n });
            else if (t1 === usdc) usdcPools.set(slice[j], { side: 1, divisor: 1n });
            else if (t0 === wusdc) usdcPools.set(slice[j], { side: 0, divisor: WUSDC_SCALE_DIVISOR });
            else if (t1 === wusdc) usdcPools.set(slice[j], { side: 1, divisor: WUSDC_SCALE_DIVISOR });
        }
    }
    console.log(`[stats v3] ${usdcPools.size} USDC-touching pools`);
    if (usdcPools.size === 0) return { volume: 0n, complete };

    // 3. Sum |USDC side amount| across the swap logs we already pulled.
    //    Audit H-02: replace the dollar ceiling with a decoder-
    //    correctness check (topic[0] match + decoded args present).
    //    Legitimate large trades on mainnet (>$10M USDC institutional
    //    flow / treasury rebalances) reach the accumulator instead
    //    of being silently dropped.
    let total = 0n;
    let droppedCount = 0;
    for (const log of allLogs) {
        const meta = usdcPools.get(log.address.toLowerCase());
        if (meta === undefined) continue;
        // Topic-correctness gate: only decode events whose topic[0]
        // matches the V3 Swap signature we built the ABI against.
        // Skips events whose topic happened to collide with our scan
        // filter and would otherwise produce garbage args.
        const topic0 = (log.topics as readonly string[])[0];
        if (topic0?.toLowerCase() !== SWAP_TOPIC.toLowerCase()) {
            droppedCount++;
            continue;
        }
        try {
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
            const raw = meta.side === 0 ? args.amount0 : args.amount1;
            const abs = raw < 0n ? -raw : raw;
            const scaled = abs / meta.divisor;
            // Audit 2026-06-19: drop single-swap outliers above the
            // testnet ceiling so one bot/mis-scaled WUSDC swap can't
            // spike the public volume (see MAX_SANE_SWAP_MICROS).
            if (scaled > 0n && scaled < MAX_SANE_SWAP_MICROS) {
                total += scaled;
            } else if (scaled >= MAX_SANE_SWAP_MICROS) {
                droppedCount++;
            }
        } catch {
            droppedCount++;
        }
    }
    if (droppedCount > 0) {
        console.log(`[stats v3] dropped ${droppedCount} events (decode mismatch or >$100k outlier)`);
    }
    return { volume: total, complete };
}

/**
 * Sums |USDC delta| across every V2 pair swap that touches USDC. Same
 * shape as sumV3SwapVolume but using V2's uint256 in/out fields instead
 * of V3's signed int256.
 *
 *   1. Enumerate USDC-touching pairs from PairCreated events on every
 *      known factory generation. Decoded args give us pair address +
 *      token0 + token1; we keep only the USDC-paired ones.
 *   2. Scan Swap events across the filtered set in a single multi-
 *      address getLogs per window. USDC volume per swap = the
 *      USDC-side in + the USDC-side out — they're never both non-zero
 *      on a Uniswap V2 swap but adding works either way.
 *
 * Direct V2 router swaps (not via the launchpad) were entirely
 * uncounted before this — only launchpad Buy/Sell events made it
 * through. Cumulative volume now includes USDC↔ANYTHING on every V2
 * pair Arcade ever spun up.
 */
async function sumV2SwapVolume(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    fromBlock: bigint,
    head: bigint,
): Promise<SwapScanResult> {
    const usdc = ADDRESSES.usdc.toLowerCase();
    const wusdc = ADDRESSES.wusdc.toLowerCase();

    // Mirror sumV3SwapVolume's address-less strategy: scan Swap events
    // chain-wide, lazy-resolve each unique pair's token0/token1, sum
    // USDC sides. Factory-bound enumeration silently dropped pairs
    // whose PairCreated event sat outside the 500k-block window,
    // which is most of them on Arc testnet.
    let complete = true;
    const swapWindows: Array<{ from: bigint; to: bigint }> = [];
    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        swapWindows.push({ from, to });
    }
    const allWindows = await Promise.all(
        swapWindows.map(async ({ from, to }) => {
            try {
                return (await client.getLogs({
                    topics: [V2_SWAP_TOPIC],
                    fromBlock: from,
                    toBlock: to,
                })) as Array<{ address: string; topics: string[]; data: string }>;
            } catch (err) {
                complete = false;
                console.warn(
                    `[stats v2] getLogs ${from}..${to} failed:`,
                    (err as Error)?.message ?? err,
                );
                return [];
            }
        }),
    );
    const allLogs = allWindows.flat();
    console.log(`[stats v2] scanned ${allLogs.length} Swap events`);
    if (allLogs.length === 0) return { volume: 0n, complete };

    const pairAddrs = Array.from(
        new Set(allLogs.map((l) => l.address.toLowerCase())),
    );
    console.log(`[stats v2] ${pairAddrs.length} unique pairs`);

    const CHUNK = 500;
    const usdcPairs = new Map<string, UsdcSideMeta>();
    for (let i = 0; i < pairAddrs.length; i += CHUNK) {
        const slice = pairAddrs.slice(i, i + CHUNK);
        const contracts = slice.flatMap((p) => [
            {
                address: p as Address,
                abi: [
                    parseAbiItem("function token0() view returns (address)"),
                ],
                functionName: "token0" as const,
            },
            {
                address: p as Address,
                abi: [
                    parseAbiItem("function token1() view returns (address)"),
                ],
                functionName: "token1" as const,
            },
        ]);
        let results: Array<{ status: "success" | "failure"; result?: Address }> = [];
        try {
            results = (await client.multicall({
                contracts: contracts as never,
                allowFailure: true,
            })) as never;
        } catch (err) {
            complete = false;
            console.warn(
                `[stats v2] multicall chunk ${i} failed:`,
                (err as Error)?.message ?? err,
            );
            continue;
        }
        for (let j = 0; j < slice.length; j++) {
            const r0 = results[j * 2];
            const r1 = results[j * 2 + 1];
            const t0 =
                r0?.status === "success"
                    ? (r0.result as Address | undefined)?.toLowerCase()
                    : undefined;
            const t1 =
                r1?.status === "success"
                    ? (r1.result as Address | undefined)?.toLowerCase()
                    : undefined;
            // Audit H-01: same USDC + WUSDC detection as sumV3SwapVolume.
            if (t0 === usdc) usdcPairs.set(slice[j], { side: 0, divisor: 1n });
            else if (t1 === usdc) usdcPairs.set(slice[j], { side: 1, divisor: 1n });
            else if (t0 === wusdc) usdcPairs.set(slice[j], { side: 0, divisor: WUSDC_SCALE_DIVISOR });
            else if (t1 === wusdc) usdcPairs.set(slice[j], { side: 1, divisor: WUSDC_SCALE_DIVISOR });
        }
    }
    console.log(`[stats v2] ${usdcPairs.size} USDC-touching pairs`);
    if (usdcPairs.size === 0) return { volume: 0n, complete };

    let total = 0n;
    let droppedCount = 0;
    for (const log of allLogs) {
        const meta = usdcPairs.get(log.address.toLowerCase());
        if (meta === undefined) continue;
        // Audit H-02: topic-correctness gate replaces the dollar ceiling.
        const topic0 = (log.topics as readonly string[])[0];
        if (topic0?.toLowerCase() !== V2_SWAP_TOPIC.toLowerCase()) {
            droppedCount++;
            continue;
        }
        try {
            const decoded = decodeEventLog({
                abi: [V2_SWAP_EVT_ABI],
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                data: (log as any).data,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                topics: (log as any).topics,
            });
            const args = decoded.args as unknown as {
                amount0In: bigint;
                amount1In: bigint;
                amount0Out: bigint;
                amount1Out: bigint;
            };
            const rawUsdcVol =
                meta.side === 0
                    ? args.amount0In + args.amount0Out
                    : args.amount1In + args.amount1Out;
            const scaled = rawUsdcVol / meta.divisor;
            // Audit 2026-06-19: same testnet outlier ceiling as V3.
            if (scaled > 0n && scaled < MAX_SANE_SWAP_MICROS) {
                total += scaled;
            } else if (scaled >= MAX_SANE_SWAP_MICROS) {
                droppedCount++;
            }
        } catch {
            droppedCount++;
        }
    }
    if (droppedCount > 0) {
        console.log(`[stats v2] dropped ${droppedCount} events (decode mismatch or >$100k outlier)`);
    }
    return { volume: total, complete };
}

/**
 * Sum the USDC volume of every ArcadeHook CurveBuy + CurveSell event
 * across the scan window. Address-bound to ADDRESSES.arcadeHook so the
 * scan stays cheap even on a wide window (vs. the V3/V2 address-less
 * scans which fan over every pool on Arc).
 *
 * Audit 2026-06-18 H-04: previously the V4 hook stack was counted only
 * at tx-count level (presence in the `contracts` array) but the dollar
 * flow through the bonding-curve phase was entirely dropped from the
 * volume figure. CurveBuy emits `grossUsdcIn` (6-dec USDC micros) and
 * CurveSell emits `usdcOut` — both already in micros so no scaling
 * needed.
 *
 * Returns 0n with complete=true when arcadeHook is not configured
 * (predominant testnet state), so the caller never has to gate this.
 */
async function sumHookVolume(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    address: Address | undefined,
    fromBlock: bigint,
    head: bigint,
): Promise<SwapScanResult> {
    if (!address || address === "0x0000000000000000000000000000000000000000") {
        return { volume: 0n, complete: true };
    }
    let complete = true;
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
                    // OR CurveBuy and CurveSell in topic slot 0.
                    topics: [[HOOK_CURVE_BUY_TOPIC, HOOK_CURVE_SELL_TOPIC]],
                });
                let acc = 0n;
                for (const log of logs) {
                    try {
                        const topic0 = (log as { topics: readonly string[] }).topics[0];
                        const isBuy = topic0?.toLowerCase() === HOOK_CURVE_BUY_TOPIC.toLowerCase();
                        const decoded = decodeEventLog({
                            abi: [isBuy ? HOOK_CURVE_BUY_EVT_ABI : HOOK_CURVE_SELL_EVT_ABI],
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            data: (log as any).data,
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            topics: (log as any).topics,
                        });
                        const args = decoded.args as unknown as {
                            grossUsdcIn?: bigint;
                            usdcOut?: bigint;
                        };
                        const usdcAmount = isBuy ? args.grossUsdcIn : args.usdcOut;
                        // Audit 2026-06-19: same testnet outlier ceiling.
                        if (
                            typeof usdcAmount === "bigint" &&
                            usdcAmount > 0n &&
                            usdcAmount < MAX_SANE_SWAP_MICROS
                        ) {
                            acc += usdcAmount;
                        }
                    } catch {
                        /* decode mismatch, skip */
                    }
                }
                return acc;
            } catch (err) {
                complete = false;
                console.warn(
                    `[stats hook] getLogs ${from}..${to} failed:`,
                    (err as Error)?.message ?? err,
                );
                return 0n;
            }
        }),
    );
    return { volume: sums.reduce((a, b) => a + b, 0n), complete };
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
