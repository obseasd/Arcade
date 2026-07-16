import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    isAddress,
    getAddress,
    encodeAbiParameters,
    parseAbiParameters,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES } from "@/lib/constants";
import { ORBS_TWAP_ABI } from "@/lib/abis/orbsTwap";
import { ROUTER_ABI } from "@/lib/abis/dex";
import {
    CCTP_BUY_RECEIVER_ABI,
    MESSAGE_TRANSMITTER_V2_ABI,
    CCTP_V2_MESSAGE_TRANSMITTER,
    fetchAttestationDetailed,
    mintRecipientFromMessage,
    parseCctpV2Message,
} from "@/lib/cctp";
import { buildOrbsBid, clearsFloor } from "@/lib/keeper/orbsRoute";
import {
    getActiveOrbsOrders,
    upsertOrbsOrder,
    markOrbsBid,
    markOrbsFilled,
    markOrbsClosed,
    markOrbsError,
    getOpenBridgeIntents,
    markBridgeRelaying,
    markBridgeRelayed,
    markBridgeConsumed,
    markBridgeRetryOrFail,
    markBridgeExpired,
    expireAgedPendingIntents,
    pruneTerminalIntents,
    tryAcquireKeeperLease,
    releaseKeeperLease,
    insertKeeperEvent,
    type KeeperOrbsOrder,
} from "@/lib/keeperPersistence";
import { isDbConfigured } from "@/lib/db";

/**
 * Unified keeper cron — one process settles three user features that
 * otherwise never complete on testnet (and would not on mainnet either
 * without a keeper):
 *
 *   Leg A — Orbs TWAP: bid + fill open order chunks. A single-chunk order
 *           is a LIMIT order (fill only when price clears the floor); a
 *           multi-chunk order is a DCA schedule (loose floor => every
 *           chunk fills on its interval). Identical settlement code.
 *   Leg B — CCTP bridge-and-buy: relay the attested message so the buy
 *           auto-completes on Arc. Safe to relay from any wallet: the
 *           receiver takes the beneficiary from the ATTESTED message.
 *
 * Signs with a DEDICATED keeper wallet (KEEPER_OPERATOR_PRIVATE_KEY),
 * separate from the compounder operator so the two crons never collide
 * on a shared nonce. Auth reuses COMPOUNDER_CRON_SECRET (the established
 * shared-bearer precedent; the twitter cron already does this).
 *
 * Trigger: external HTTP POST (cron-job.org), same as the compounder.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Orbs bids/fills CANNOT be batched through Multicall3: TWAP records
// msg.sender as the winning taker and ExchangeV2 gates on allowed[taker],
// so every bid/fill must be a direct tx from the allowlisted keeper
// wallet. They run sequentially (await receipt) to keep the nonce clean.
// Capped so one slow tick cannot blow the 60s function ceiling: ~8 txs ×
// ~5s = 40s, with slack for the reads + leg B.
const MAX_ORBS_ACTIONS_PER_RUN = 8;
const MAX_BRIDGE_RELAYS_PER_RUN = 5;

// Discovery scan cap. On testnet the book is tiny; a cursor-based scan
// backed by the indexer replaces this full pass at mainnet scale.
const MAX_BOOK_SCAN = 200;

// Keeper slippage tolerance between the bid-time quote and the fill-time
// reserves, in Orbs PERCENT_BASE units (100000 = 100%). This is a HAIRCUT
// on the keeper's committed output: verifyBid subtracts it before checking
// the maker floor, and performFill requires the actual output to clear
// committed*(1-haircut). So it must be SMALLER than the maker's floor
// discount, or no chunk clears at a flat price (a DCA/limit floor is set
// as market*(1-floorDiscount); the fill band is floorDiscount - haircut).
// 0.5% covers realistic 30s (bidDelay) drift on Arc; the DCA UI sets its
// floor discount well above this (default 5%) so chunks keep filling.
const SLIPPAGE_PERCENT = 500;

// Taker fee in dstToken. 0 on testnet: the keeper subsidises its own gas
// rather than skimming the maker's output. Mainnet can raise this (or use
// the Taker fee-swap-to-gas helper) once economics matter.
const DST_FEE = 0n;

// Router deadline buffer for the swap encoded at bid time; must survive
// until the fill tick (~1 minute later). 1h is ample.
const SWAP_DEADLINE_SECS = 3_600n;

// A bridge intent that keeps failing to relay is parked as 'failed' after
// this many attempts so the keeper stops paying gas on a doomed message.
const BRIDGE_MAX_ATTEMPTS = 6;

// A pending intent whose burn never appears on Iris after this long is
// expired, so a spammed/mistyped burn hash cannot occupy the poll budget
// for long (CCTP fast-transfer attests in minutes; 3h is far past that yet
// short enough that junk cannot hold the oldest-first slots for a day).
const BRIDGE_PENDING_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// The single-run lease covers a full tick (maxDuration=60s) plus slack, so a
// slow run's lease outlives its execution; it self-expires if the run crashes.
const LEASE_SECONDS = 90;

const RPC_TIMEOUT_MS = 3_000;
// A submitted tx must not hang the whole run to the 60s Vercel ceiling (and
// starve leg B). Cap the receipt wait; a timeout is treated as "unknown, move
// on" -- the on-chain state is re-read next tick, so no double-action results.
const RECEIPT_TIMEOUT_MS = 20_000;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n; // 100 gwei
const MIN_OPERATOR_BALANCE_WEI = 1_000_000n; // 1 USDC (6 decimals)

const ARC_RPC_LIST: readonly string[] = (() => {
    const out: string[] = [];
    const dedicated = process.env.NEXT_PUBLIC_ARC_RPC_URL;
    if (dedicated) out.push(dedicated);
    out.push("https://rpc.testnet.arc.network");
    out.push("https://5042002.rpc.thirdweb.com");
    return out;
})();

const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
        default: { http: ARC_RPC_LIST },
        public: { http: ARC_RPC_LIST },
    },
} as const;

// Orbs status sentinels (TWAP.sol): 1 = canceled, 2 = completed; any
// larger value is the order's deadline timestamp (open until now passes it).
const STATUS_CANCELED = 1;
const STATUS_COMPLETED = 2;

// Minimal ExchangeV2 read used only for the allowlist precheck. getAmountOut
// reverts TakerNotAllowed(taker) before decoding bidData when the taker is
// not allowlisted.
const EXCHANGE_V2_ABI = [
    {
        type: "function",
        stateMutability: "view",
        name: "getAmountOut",
        inputs: [
            { name: "srcToken", type: "address" },
            { name: "dstToken", type: "address" },
            { name: "amountIn", type: "uint256" },
            { name: "askData", type: "bytes" },
            { name: "bidData", type: "bytes" },
            { name: "taker", type: "address" },
        ],
        outputs: [{ name: "dstAmountOut", type: "uint256" }],
    },
    // MUST be in the ABI: without it viem cannot decode the revert and the
    // precheck's error-name match fails (a denied keeper reads as allowed).
    {
        type: "error",
        name: "TakerNotAllowed",
        inputs: [{ name: "taker", type: "address" }],
    },
] as const;
// The 4-byte selector of TakerNotAllowed(address), matched as a belt in
// case a provider surfaces the raw signature instead of the decoded name.
const TAKER_NOT_ALLOWED_SELECTOR = "0x8435d2bb";
// A well-formed (uint256, bytes) blob so the allowed-taker branch decodes
// cleanly; the denied branch reverts before ever reaching the decode.
const PROBE_BID_DATA = encodeAbiParameters(
    parseAbiParameters("uint256 amountOut, bytes swapData"),
    [0n, "0x"],
);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let cancel: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<null>((resolve) => {
        cancel = setTimeout(() => resolve(null), ms);
    });
    try {
        const v = await Promise.race([p, timer]);
        if (cancel) clearTimeout(cancel);
        return v;
    } catch {
        if (cancel) clearTimeout(cancel);
        return null;
    }
}

interface RunSummary {
    orbs: { scanned: number; bid: number; filled: number; closed: number; skipped: number; failed: number };
    cctp: { scanned: number; relayed: number; skipped: number; failed: number };
    notes: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PublicClient = ReturnType<typeof createPublicClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WalletClient = ReturnType<typeof createWalletClient>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OnchainOrder = any;

export async function POST(req: NextRequest) {
    // Accept a DEDICATED KEEPER_CRON_SECRET (preferred) OR the shared
    // COMPOUNDER_CRON_SECRET (backward-compat). The dedicated var lets an
    // operator wire the keeper trigger with a fresh secret WITHOUT knowing or
    // rotating the shared bearer the compounder/twitter crons also use (which,
    // if set "Sensitive" on Vercel, is write-only and unrecoverable).
    const secrets = [
        process.env.KEEPER_CRON_SECRET,
        process.env.COMPOUNDER_CRON_SECRET,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);
    if (secrets.length === 0) {
        return NextResponse.json(
            { error: "KEEPER_CRON_SECRET (or COMPOUNDER_CRON_SECRET) not configured" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    // Match against any configured secret; per-secret length guard keeps the
    // comparison from short-circuiting on length alone.
    const ok =
        !!auth &&
        secrets.some((s) => {
            const expected = `Bearer ${s}`;
            return auth.length === expected.length && auth === expected;
        });
    if (!ok) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isDbConfigured()) {
        return NextResponse.json(
            { ran: false, reason: "Postgres not configured" },
            { status: 200 },
        );
    }

    const twap = ADDRESSES.orbsTwap as Address | undefined;
    const exchange = ADDRESSES.orbsExchangeV2 as Address | undefined;
    const router = ADDRESSES.router as Address | undefined;
    const usdc = ADDRESSES.usdc as Address | undefined;
    if (
        !twap || !isAddress(twap) ||
        !exchange || !isAddress(exchange) ||
        !router || !isAddress(router) ||
        !usdc || !isAddress(usdc)
    ) {
        return NextResponse.json(
            { ran: false, reason: "Orbs/router/USDC addresses not configured" },
            { status: 200 },
        );
    }

    const keeperKey = process.env.KEEPER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!keeperKey || !/^0x[0-9a-fA-F]{64}$/.test(keeperKey)) {
        return NextResponse.json(
            { ran: false, reason: "KEEPER_OPERATOR_PRIVATE_KEY missing or malformed" },
            { status: 200 },
        );
    }

    const account = privateKeyToAccount(keeperKey);
    const publicClient = createPublicClient({ chain: ARC_CHAIN, transport: http() });
    const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() });

    // Low-balance circuit breaker: the keeper pays Arc gas for every bid,
    // fill and relay. Below the floor, bail with 503 so the cron caller
    // surfaces the alarm instead of half-completing on an empty float.
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < MIN_OPERATOR_BALANCE_WEI) {
        return NextResponse.json(
            {
                ran: false,
                reason: "Keeper balance below threshold — refill USDC",
                balance: balance.toString(),
                threshold: MIN_OPERATOR_BALANCE_WEI.toString(),
            },
            { status: 503 },
        );
    }

    // Single-run lease: refuse to run two overlapping ticks against the same
    // wallet (nonce races) / the same intent (double-relay). The lease
    // self-expires so a crashed run never wedges the keeper. A per-run token
    // scopes the release so an overrunning run cannot clobber a successor.
    const runToken = crypto.randomUUID();
    const gotLease = await tryAcquireKeeperLease(LEASE_SECONDS, runToken);
    if (!gotLease) {
        return NextResponse.json(
            { ran: false, reason: "another keeper run holds the lease" },
            { status: 200 },
        );
    }

    const summary: RunSummary = {
        orbs: { scanned: 0, bid: 0, filled: 0, closed: 0, skipped: 0, failed: 0 },
        cctp: { scanned: 0, relayed: 0, skipped: 0, failed: 0 },
        notes: [],
    };

    // Everything after acquiring the lease runs in try/finally so a throw
    // (e.g. a flaky getBlock) always releases it rather than wedging the
    // keeper until the 90s self-expiry.
    try {
        // Use the chain's clock for every on-chain timing comparison so the
        // keeper agrees with the contract's block.timestamp, not the server's.
        const latestBlock = await publicClient.getBlock();
        const now = Number(latestBlock.timestamp);

        // ---- Leg A: Orbs TWAP ----
        try {
            await runOrbsLeg(
                { twap, exchange, router, usdc, now },
                publicClient,
                walletClient,
                account.address,
                summary,
            );
        } catch (err) {
            summary.notes.push(`orbs-leg error=${errMsg(err)}`);
        }

        // ---- Leg B: CCTP bridge-and-buy relay ----
        try {
            await runCctpLeg(publicClient, walletClient, account.address, now, summary);
        } catch (err) {
            summary.notes.push(`cctp-leg error=${errMsg(err)}`);
        }
    } finally {
        await releaseKeeperLease(runToken).catch(() => {});
    }

    return NextResponse.json({ ran: true, ...summary }, { status: 200 });
}

// ===================================================================
// Leg A — Orbs TWAP settlement
// ===================================================================

interface OrbsCfg {
    twap: Address;
    exchange: Address;
    router: Address;
    usdc: Address;
    now: number;
}

async function runOrbsLeg(
    cfg: OrbsCfg,
    publicClient: PublicClient,
    walletClient: WalletClient,
    keeper: Address,
    summary: RunSummary,
) {
    // Precheck: the keeper wallet MUST be allowlisted on ExchangeV2
    // (constructor-only, no setter). getAmountOut reverts TakerNotAllowed
    // for a non-allowlisted taker BEFORE decoding, so a cheap probe tells us
    // whether the KEEPER_SETUP.md redeploy was done. If not, skip leg A
    // entirely rather than burn gas reverting every bid this tick.
    const allowProbe = await withTimeout(
        publicClient
            .readContract({
                address: cfg.exchange,
                abi: EXCHANGE_V2_ABI,
                functionName: "getAmountOut",
                args: [ZERO as Address, ZERO as Address, 0n, "0x", PROBE_BID_DATA, keeper],
            })
            .then(() => true)
            .catch((e: unknown) => {
                const m = errMsg(e);
                return m.includes("TakerNotAllowed") ||
                    m.toLowerCase().includes(TAKER_NOT_ALLOWED_SELECTOR)
                    ? "denied"
                    : true;
            }),
        RPC_TIMEOUT_MS,
    );
    if (allowProbe === "denied") {
        summary.notes.push(
            "keeper wallet not allowlisted on ExchangeV2 — skipping leg A (redeploy per KEEPER_SETUP.md)",
        );
        return;
    }

    // 1. Discover any new orders past the highest id we already track.
    await discoverNewOrders(cfg, publicClient);

    // 2. Process the active set. Each tick performs at most
    //    MAX_ORBS_ACTIONS_PER_RUN direct txs (bids + fills combined).
    const active = await getActiveOrbsOrders(64);
    let actions = 0;

    for (const tracked of active) {
        if (actions >= MAX_ORBS_ACTIONS_PER_RUN) break;
        summary.orbs.scanned++;

        // Read the live order — the on-chain state is the source of truth.
        const order = (await withTimeout(
            publicClient.readContract({
                address: cfg.twap,
                abi: ORBS_TWAP_ABI,
                functionName: "order",
                args: [BigInt(tracked.orderId)],
            }) as Promise<OnchainOrder>,
            RPC_TIMEOUT_MS,
        )) as OnchainOrder | null;
        if (!order) {
            summary.orbs.skipped++;
            continue;
        }

        const statusField = Number(order.status);
        // Terminal on-chain states.
        if (statusField === STATUS_CANCELED) {
            await markOrbsClosed(tracked.orderId, "canceled");
            summary.orbs.closed++;
            continue;
        }
        if (statusField === STATUS_COMPLETED) {
            await markOrbsClosed(tracked.orderId, "completed");
            summary.orbs.closed++;
            continue;
        }
        // statusField is the deadline; expired orders are dead weight.
        if (statusField <= cfg.now) {
            await markOrbsClosed(tracked.orderId, "canceled");
            summary.orbs.closed++;
            continue;
        }

        const did = await settleOrbsOrder(
            cfg,
            tracked,
            order,
            publicClient,
            walletClient,
            keeper,
            summary,
        );
        if (did) actions++;
    }
}

/**
 * Full-book discovery, capped. Reads length(), and for every id beyond
 * what we already track reads the order and upserts the active ones.
 * O(new orders) per tick. A cursor + indexer replaces this at scale.
 */
async function discoverNewOrders(cfg: OrbsCfg, publicClient: PublicClient) {
    const length = (await withTimeout(
        publicClient.readContract({
            address: cfg.twap,
            abi: ORBS_TWAP_ABI,
            functionName: "length",
        }) as Promise<bigint>,
        RPC_TIMEOUT_MS,
    )) as bigint | null;
    if (length === null) return;

    const total = Number(length);
    const scanFrom = Math.max(0, total - MAX_BOOK_SCAN);
    // Track which ids we already have so re-discovery is cheap. We only
    // need to insert unseen ones; upsert is idempotent so re-inserting a
    // known active order just refreshes its counters.
    const known = new Set(
        (await getActiveOrbsOrders(1024)).map((o) => o.orderId),
    );

    for (let id = scanFrom; id < total; id++) {
        if (known.has(String(id))) continue;
        const order = (await withTimeout(
            publicClient.readContract({
                address: cfg.twap,
                abi: ORBS_TWAP_ABI,
                functionName: "order",
                args: [BigInt(id)],
            }) as Promise<OnchainOrder>,
            RPC_TIMEOUT_MS,
        )) as OnchainOrder | null;
        if (!order) continue;

        const statusField = Number(order.status);
        if (statusField === STATUS_CANCELED || statusField === STATUS_COMPLETED) continue;
        if (statusField <= cfg.now) continue; // already expired

        // Only track orders routed through OUR ExchangeV2 (or any-exchange,
        // exchange == 0). Anything pinned to a different adapter we cannot
        // fill (the keeper is only allowlisted on ours).
        const askExchange = getAddr(order.ask.exchange);
        if (
            askExchange !== ZERO &&
            askExchange.toLowerCase() !== cfg.exchange.toLowerCase()
        ) {
            continue;
        }

        const srcAmount = BigInt(order.ask.srcAmount);
        const srcBidAmount = BigInt(order.ask.srcBidAmount);
        const chunksTotal =
            srcBidAmount > 0n ? Number((srcAmount + srcBidAmount - 1n) / srcBidAmount) : 1;
        const srcFilled = BigInt(order.srcFilledAmount);
        const chunksFilled =
            srcBidAmount > 0n ? Number(srcFilled / srcBidAmount) : 0;

        await upsertOrbsOrder({
            orderId: String(id),
            makerAddress: getAddr(order.maker),
            srcToken: getAddr(order.ask.srcToken),
            dstToken: getAddr(order.ask.dstToken),
            kind: chunksTotal > 1 ? "dca" : "limit",
            chunksTotal,
            chunksFilled,
            bidDelaySecs: Number(order.ask.bidDelay),
        });
    }
}

/**
 * Decide and execute ONE action for an order: fill if we hold a matured
 * winning bid, else bid if the price clears the floor. Returns true iff a
 * tx was sent.
 */
async function settleOrbsOrder(
    cfg: OrbsCfg,
    tracked: KeeperOrbsOrder,
    order: OnchainOrder,
    publicClient: PublicClient,
    walletClient: WalletClient,
    keeper: Address,
    summary: RunSummary,
): Promise<boolean> {
    const id = BigInt(tracked.orderId);
    const srcAmount = BigInt(order.ask.srcAmount);
    const srcBidAmount = BigInt(order.ask.srcBidAmount);
    const srcFilled = BigInt(order.srcFilledAmount);
    const chunkIn = bigMin(srcBidAmount, srcAmount - srcFilled);
    if (chunkIn <= 0n) {
        summary.orbs.skipped++;
        return false;
    }

    const dstMinAmount = BigInt(order.ask.dstMinAmount);
    // Per-chunk floor scales with the (possibly smaller) final chunk.
    const chunkFloor =
        srcBidAmount > 0n ? (dstMinAmount * chunkIn) / srcBidAmount : dstMinAmount;

    const bidTaker = getAddr(order.bid.taker);
    const bidTime = Number(order.bid.time);
    const bidDelay = Number(order.ask.bidDelay);
    const fillDelay = Number(order.ask.fillDelay);
    const filledTime = Number(order.filledTime);
    const srcToken = getAddr(order.ask.srcToken);
    const dstToken = getAddr(order.ask.dstToken);

    const STALE_BID_SECONDS = 600; // TWAP.STALE_BID_SECONDS
    const weHoldBid = bidTaker !== ZERO && bidTaker.toLowerCase() === keeper.toLowerCase();
    const ourBidStale = weHoldBid && cfg.now > bidTime + STALE_BID_SECONDS;

    // --- Case 1: we hold the winning bid ---
    if (weHoldBid) {
        // Not matured yet: WAIT for it. Re-bidding our own live bid would
        // revert "low bid" (verifyBid requires >101% over the current bid),
        // so we must NOT fall through to Case 2 here.
        if (cfg.now <= bidTime + bidDelay) {
            summary.orbs.skipped++;
            return false;
        }
        // Matured: only send fill if it would actually succeed. The bid's
        // dst floor was fixed at bid time; if the pool drifted adverse
        // beyond the haircut, the fill reverts (TWAP.sol performFill "min
        // out"). Simulating first avoids a gas-burn loop that would retry
        // the same reverting fill every tick. If the bid has since gone
        // stale we fall through to re-bid at the current (lower) quote,
        // which verifyBid accepts once past STALE_BID_SECONDS.
        const fillOk = await withTimeout(
            publicClient.simulateContract({
                address: cfg.twap,
                abi: ORBS_TWAP_ABI,
                functionName: "fill",
                args: [id],
                account: keeper,
            }).then(() => true).catch(() => false),
            RPC_TIMEOUT_MS,
        );
        if (fillOk === true) {
            try {
                const hash = await walletClient.writeContract({
                    address: cfg.twap,
                    abi: ORBS_TWAP_ABI,
                    functionName: "fill",
                    args: [id],
                    chain: ARC_CHAIN,
                    account: keeper,
                    maxFeePerGas: MAX_FEE_PER_GAS_WEI,
                });
                await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
                const newFilled = srcFilled + chunkIn;
                const chunksFilled =
                    srcBidAmount > 0n ? Number(newFilled / srcBidAmount) : 1;
                await markOrbsFilled(tracked.orderId, chunksFilled);
                await insertKeeperEvent({
                    leg: "orbs",
                    eventType: "fill",
                    refId: tracked.orderId,
                    txHash: hash,
                    detail: { chunkIn: chunkIn.toString(), chunkFloor: chunkFloor.toString() },
                });
                summary.orbs.filled++;
                return true;
            } catch (err) {
                await markOrbsError(tracked.orderId, errMsg(err));
                summary.orbs.failed++;
                return true; // a tx attempt was spent
            }
        }
        // Fill would revert. If our bid is not yet stale, wait (no gas burn).
        // If it IS stale, fall through and re-bid at the current price.
        if (!ourBidStale) {
            summary.orbs.skipped++;
            return false;
        }
    }

    // If someone else holds a live (non-stale) winning bid, stand back.
    if (
        bidTaker !== ZERO &&
        bidTaker.toLowerCase() !== keeper.toLowerCase() &&
        cfg.now <= bidTime + STALE_BID_SECONDS
    ) {
        summary.orbs.skipped++;
        return false;
    }

    // --- Case 2: biddable => quote and BID if it clears the floor ---
    // Respect the inter-chunk fill delay (TWAP.verifyBid requires
    // now > filledTime + fillDelay).
    if (cfg.now <= filledTime + fillDelay) {
        summary.orbs.skipped++;
        return false;
    }

    // Direct src->dst V2 path (Arcade graduated pairs are USDC-quoted,
    // paired directly). A pair with no route quotes 0 and is skipped.
    const path = [srcToken, dstToken] as Address[];
    const amounts = (await withTimeout(
        publicClient.readContract({
            address: cfg.router,
            abi: ROUTER_ABI,
            functionName: "getAmountsOut",
            args: [chunkIn, path],
        }) as Promise<readonly bigint[]>,
        RPC_TIMEOUT_MS,
    )) as readonly bigint[] | null;
    if (!amounts || amounts.length < 2) {
        summary.orbs.skipped++;
        return false;
    }
    const quotedOut = amounts[amounts.length - 1];

    if (
        !clearsFloor({
            quotedOut,
            chunkFloor,
            slippagePercent: SLIPPAGE_PERCENT,
            dstFee: DST_FEE,
        })
    ) {
        // Limit not met yet (or DCA floor set too tight). Not an error.
        summary.orbs.skipped++;
        return false;
    }

    let plan;
    try {
        plan = buildOrbsBid({
            path,
            chunkIn,
            quotedOut,
            chunkFloor,
            exchange: cfg.exchange,
            router: cfg.router,
            slippagePercent: SLIPPAGE_PERCENT,
            dstFee: DST_FEE,
            deadline: BigInt(cfg.now) + SWAP_DEADLINE_SECS,
        });
    } catch {
        summary.orbs.skipped++;
        return false;
    }

    try {
        const hash = await walletClient.writeContract({
            address: cfg.twap,
            abi: ORBS_TWAP_ABI,
            functionName: "bid",
            args: [id, cfg.exchange, plan.dstFee, plan.slippagePercent, plan.bidData],
            chain: ARC_CHAIN,
            account: keeper,
            maxFeePerGas: MAX_FEE_PER_GAS_WEI,
        });
        await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        await markOrbsBid(tracked.orderId, hash);
        await insertKeeperEvent({
            leg: "orbs",
            eventType: "bid",
            refId: tracked.orderId,
            txHash: hash,
            detail: {
                quotedOut: quotedOut.toString(),
                chunkFloor: chunkFloor.toString(),
                slippagePercent: SLIPPAGE_PERCENT,
            },
        });
        summary.orbs.bid++;
        return true;
    } catch (err) {
        await markOrbsError(tracked.orderId, errMsg(err));
        summary.orbs.failed++;
        return true;
    }
}

// ===================================================================
// Leg B — CCTP bridge-and-buy relay
// ===================================================================

async function runCctpLeg(
    publicClient: PublicClient,
    walletClient: WalletClient,
    keeper: Address,
    now: number,
    summary: RunSummary,
) {
    // Bulk-expire aged pending intents in ONE statement (not one-at-a-time as
    // they surface in the poll window) so an unauthenticated flood cannot hold
    // the oldest-first slots longer than the age window, and prune old terminal
    // rows so junk cannot grow the table without bound.
    await expireAgedPendingIntents(Math.floor(BRIDGE_PENDING_MAX_AGE_MS / 1000)).catch(() => {});
    await pruneTerminalIntents(24 * 60 * 60).catch(() => {});

    const intents = await getOpenBridgeIntents(MAX_BRIDGE_RELAYS_PER_RUN * 3);
    let relays = 0;

    // The set of receivers we recognise (current + historical), so the
    // keeper only ever calls one of ours.
    const knownReceivers = new Set<string>();
    const current = ADDRESSES.cctpBuyReceiver as string | undefined;
    if (current && isAddress(current)) knownReceivers.add(current.toLowerCase());
    for (const r of ADDRESSES.cctpBuyReceivers ?? []) {
        const addr = typeof r === "string" ? r : r?.address;
        if (addr && isAddress(addr)) knownReceivers.add(addr.toLowerCase());
    }

    for (const intent of intents) {
        if (relays >= MAX_BRIDGE_RELAYS_PER_RUN) break;
        summary.cctp.scanned++;

        const res = await fetchAttestationDetailed(intent.srcDomain, intent.burnTxHash);
        if (res.kind === "missing") {
            // Burn not indexed. Expire it if it has been pending far longer
            // than any real fast-transfer would take (anti-spam), else wait.
            const ageMs = now * 1000 - new Date(intent.createdAt).getTime();
            if (ageMs > BRIDGE_PENDING_MAX_AGE_MS) {
                await markBridgeExpired(intent.id);
            }
            summary.cctp.skipped++;
            continue;
        }
        if (res.kind === "pending" || res.kind === "transient") {
            // Not ready yet (or Iris hiccup). Leave it pending for a later tick.
            summary.cctp.skipped++;
            continue;
        }

        // res.kind === "complete": we have the signed message + attestation.
        const { message, attestation } = res.payload;
        const receiver = mintRecipientFromMessage(message);
        if (!receiver || !knownReceivers.has(receiver.toLowerCase())) {
            // The message does not target a receiver we control, and never
            // will (the attested message is immutable). This is a terminal
            // state -> EXPIRE it, not retry. markBridgeRetryOrFail would keep
            // it 'pending' forever here (attempts is still 0 because we never
            // called markBridgeRelaying), letting a spammer's completed
            // non-receiver burn permanently occupy the oldest-first poll slot.
            await markBridgeExpired(intent.id);
            summary.cctp.skipped++;
            continue;
        }

        // Idempotency guard (leg B has no on-chain re-read like leg A): if the
        // message's CCTP nonce is already consumed on-chain -- relayed by a
        // prior tick whose receipt timed out, by a concurrent run, or by the
        // user's manual claim -- the receiveMessage would revert on the spent
        // nonce. Detect it and mark the intent done, so a COMPLETED bridge is
        // never re-tried and mis-reported as 'failed'.
        const parsed = parseCctpV2Message(message);
        if (parsed) {
            const used = (await withTimeout(
                publicClient.readContract({
                    address: CCTP_V2_MESSAGE_TRANSMITTER,
                    abi: MESSAGE_TRANSMITTER_V2_ABI,
                    functionName: "usedNonces",
                    args: [parsed.nonceHash],
                }) as Promise<bigint>,
                RPC_TIMEOUT_MS,
            )) as bigint | null;
            if (used !== null && used !== 0n) {
                await markBridgeConsumed(intent.id);
                summary.cctp.skipped++;
                continue;
            }
        }

        await markBridgeRelaying(intent.id);
        try {
            const hash = await walletClient.writeContract({
                address: receiver,
                abi: CCTP_BUY_RECEIVER_ABI,
                functionName: intent.intentKind === "forward" ? "receiveAndForward" : "receiveAndBuy",
                args: [message, attestation],
                chain: ARC_CHAIN,
                account: keeper,
                maxFeePerGas: MAX_FEE_PER_GAS_WEI,
            });
            await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
            await markBridgeRelayed(intent.id, hash);
            await insertKeeperEvent({
                leg: "cctp",
                eventType: "relay",
                refId: intent.id,
                txHash: hash,
                detail: { srcDomain: intent.srcDomain, kind: intent.intentKind },
            });
            summary.cctp.relayed++;
            relays++;
        } catch (err) {
            await markBridgeRetryOrFail(intent.id, errMsg(err), BRIDGE_MAX_ATTEMPTS);
            summary.cctp.failed++;
            relays++;
        }
    }

    void keeper;
    void now;
}

// ===================================================================
// helpers
// ===================================================================

const ZERO = "0x0000000000000000000000000000000000000000";

function getAddr(v: unknown): Address {
    try {
        return getAddress(String(v));
    } catch {
        return ZERO as Address;
    }
}

function bigMin(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
