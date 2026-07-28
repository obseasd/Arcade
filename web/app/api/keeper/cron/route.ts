import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    fallback,
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
import {
    CCTP_BUY_RECEIVER_ABI,
    MESSAGE_TRANSMITTER_V2_ABI,
    CCTP_V2_MESSAGE_TRANSMITTER,
    fetchAttestationDetailed,
    mintRecipientFromMessage,
    parseCctpV2Message,
} from "@/lib/cctp";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { V3_QUOTER_ABI } from "@/lib/abis/v3";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { buildOrbsBid, clearsFloor } from "@/lib/keeper/orbsRoute";
import { pickBestVenue, v2DirectVenue, type DirectVenueCandidate } from "@/lib/keeper/directVenues";
import {
    getActiveOrbsOrders,
    upsertOrbsOrder,
    markOrbsBid,
    markOrbsFilled,
    markOrbsClosed,
    markOrbsError,
    incrementOrbsBidFail,
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
    getKeeperCursor,
    setKeeperCursor,
    type KeeperOrbsOrder,
} from "@/lib/keeperPersistence";
import { isDbConfigured } from "@/lib/db";

/**
 * Unified keeper cron - one process settles three user features that
 * otherwise never complete on testnet (and would not on mainnet either
 * without a keeper):
 *
 *   Leg A - Orbs TWAP: bid + fill open order chunks. A single-chunk order
 *           is a LIMIT order (fill only when price clears the floor); a
 *           multi-chunk order is a DCA schedule (loose floor => every
 *           chunk fills on its interval). Identical settlement code.
 *   Leg B - CCTP bridge-and-buy: relay the attested message so the buy
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
// After this many stale-bid re-bids whose fill still reverts (a dstToken that
// delivers less than getAmountsOut quotes: fee-on-transfer / returns-false), the
// keeper backs off the order instead of re-bidding it every staleness window (a
// gas drain + action-budget DoS). A legit order fills within 1-2 re-bids and its
// counter resets on fill, so only genuinely-unfillable orders hit the cap.
const MAX_REBID_FAILS = 3;
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

// --- Leg C: V3 fee-protocol sync ---
// topic0 of PoolCreated(address,address,uint24,int24,address). The pool address
// is the SECOND data word (not indexed); token0/token1/fee are the indexed args.
const POOL_CREATED_TOPIC0 = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const FEE_MANAGER_ABI = [
    {
        type: "function",
        stateMutability: "nonpayable",
        name: "sync",
        inputs: [{ name: "pool", type: "address" }],
        outputs: [],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "isLaunchPool",
        inputs: [{ name: "pool", type: "address" }],
        outputs: [{ type: "bool" }],
    },
] as const;
const POOL_SLOT0_ABI = [
    {
        type: "function",
        stateMutability: "view",
        name: "slot0",
        inputs: [],
        outputs: [
            { type: "uint160" },
            { type: "int24" },
            { type: "uint16" },
            { type: "uint16" },
            { type: "uint16" },
            { type: "uint8" },
            { type: "bool" },
        ],
    },
] as const;
const FEE_SYNC_CURSOR = "v3_pool_created";
// FEE_SYNC_WINDOW is env-aware and defined after ARC_IS_MAINNET below (the
// thirdweb RPC caps getLogs at 1000, but testnet scans over arc.network which
// handles 10k -- a 10k window keeps the whole trailing lookback to ~2 getLogs
// per run so the leg stays well under the Vercel ceiling).
const MAX_FEE_SYNC_WINDOWS_PER_RUN = 25; // enough windows for the 1k mainnet case
const MAX_FEE_SYNCS_PER_RUN = 6; // bound the txs per tick
// Always re-scan at least this many trailing blocks each run, on top of the
// forward cursor. The cursor is forward-only, so a pool whose sync transiently
// failed (shared-wallet nonce clash, RPC hiccup) or that landed in a scan gap
// would otherwise be skipped FOREVER once the cursor advanced past it. Re-
// scanning a recent window makes leg C self-healing: the slot0/isLaunchPool
// pre-check skips pools already in their target state, so it's cheap and
// idempotent, and an unsynced pool keeps getting retried until it lands.
// ~20k blocks ~= a few hours at Arc's cadence; covers a pool that has aged out
// of the immediate cursor window (e.g. one created ~10k blocks / ~80min ago).
const FEE_SYNC_SAFETY_LOOKBACK = 20_000n;

const RPC_TIMEOUT_MS = 3_000;
// A submitted tx must not hang the whole run to the 60s Vercel ceiling (and
// starve leg B). Cap the receipt wait; a timeout is treated as "unknown, move
// on" -- the on-chain state is re-read next tick, so no double-action results.
const RECEIPT_TIMEOUT_MS = 20_000;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n; // 100 gwei
const MIN_OPERATOR_BALANCE_WEI = 1_000_000n; // 1 USDC (6 decimals)

// Soft mainnet switch: the keeper reads NEXT_PUBLIC_ARC_ENV like the frontend
// (lib/chains.ts) so flipping that one var moves it to chainId 5042 + mainnet
// RPCs. Addresses already re-point via the NEXT_PUBLIC_* address envs.
const ARC_IS_MAINNET = (process.env.NEXT_PUBLIC_ARC_ENV ?? "").toLowerCase() === "mainnet";

const ARC_RPC_LIST: readonly string[] = (() => {
    const out: string[] = [];
    const dedicated = process.env.NEXT_PUBLIC_ARC_RPC_URL;
    if (dedicated) out.push(dedicated);
    if (ARC_IS_MAINNET) {
        out.push("https://5042.rpc.thirdweb.com");
    } else {
        out.push("https://rpc.testnet.arc.network");
        out.push("https://5042002.rpc.thirdweb.com");
    }
    return out;
})();

// RPC list for the fee-sync getLogs scan, arc.network FIRST. The keeper's
// default RPC ([0] of ARC_RPC_LIST = a dedicated NEXT_PUBLIC_ARC_RPC_URL, or
// thirdweb) starved leg C: thirdweb caps getLogs at 1000 blocks and is slow,
// and trying it first for every window pushed the run past Vercel's 60s ceiling
// (which then leaked the keeper lease and bailed every subsequent run). Hitting
// arc.network first (fast, wide-range) keeps the scan snappy; the rest remain
// as backstops via the fallback transport.
const FEE_SYNC_LOG_RPCS: readonly string[] = ARC_IS_MAINNET
    ? ARC_RPC_LIST
    : [
          "https://rpc.testnet.arc.network",
          ...ARC_RPC_LIST.filter((u) => u !== "https://rpc.testnet.arc.network"),
      ];

// getLogs window sized to the scan RPC's cap. Testnet scans over arc.network
// (10k OK) so a 10k window covers the ~20k trailing lookback in ~2 getLogs per
// run -- critical: 25 windows of 1k each from Vercel took the run past the 60s
// ceiling and leaked the keeper lease. Mainnet's only listed RPC is thirdweb
// (hard 1000-block getLogs cap), so it must stay at 1000 there.
const FEE_SYNC_WINDOW = ARC_IS_MAINNET ? 1_000n : 10_000n;

const ARC_CHAIN = {
    id: ARC_IS_MAINNET ? 5042 : 5042002,
    name: ARC_IS_MAINNET ? "Arc" : "Arc Testnet",
    network: ARC_IS_MAINNET ? "arc-mainnet" : "arc-testnet",
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
// ExchangeMulti public getter: is this router allow-listed to execute fills?
// getAmountOut (verifyBid) does NOT check the router, only swap (performFill)
// does, so the keeper reads this itself to avoid bidding a router it cannot then
// fill on (which would strand the order in a re-bid loop).
const ALLOWED_ROUTER_ABI = [
    {
        type: "function",
        stateMutability: "view",
        name: "allowedRouter",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;
// A well-formed (uint256, bytes) blob so the allowed-taker branch decodes
// cleanly; the denied branch reverts before ever reaching the decode.
const PROBE_BID_DATA = encodeAbiParameters(
    parseAbiParameters("uint256 amountOut, bytes swapData"),
    [0n, "0x"],
);
// ExchangeMulti decodes (uint256, address, bytes); a matching well-formed blob
// so the allowed branch decodes cleanly and only a denied taker reverts.
const MULTI_PROBE_BID_DATA = encodeAbiParameters(
    parseAbiParameters("uint256 amountOut, address router, bytes swapData"),
    [0n, "0x0000000000000000000000000000000000000000", "0x"],
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
    fees: { scanned: number; synced: number; skipped: number; failed: number };
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
    // Constant-time match against any configured secret. The length check
    // gates timingSafeEqual (which throws on unequal-length buffers) and is
    // itself not secret-dependent (the "Bearer " prefix + a fixed-width hex
    // secret), so it leaks nothing. Avoids the byte-by-byte short-circuit of
    // `===` on a security-critical gate that signs on-chain txs.
    const ok =
        !!auth &&
        secrets.some((s) => {
            const expected = `Bearer ${s}`;
            if (auth.length !== expected.length) return false;
            return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
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
    // ExchangeMulti (optional): the trusted multi-router adapter. When present,
    // orders pinned to it settle on the best allow-listed direct venue (Arcade V2
    // + XyloNet today). Orders pinned to the legacy ExchangeV2 keep the single-V2
    // path. XyloNet router is a second V2-style venue that also takes native USDC.
    // NOTE: safeAddress() returns the ZERO address (not undefined) for an unset
    // env, so we MUST treat zero as "unset" here -- otherwise cfg.exchangeMulti =
    // 0x0 would make legacy any-exchange (ask.exchange==0) orders match it and bid
    // with exchange=0x0, which TWAP.bid rejects ("params") in a gas-burn loop.
    const exchangeMulti = liveAddress(ADDRESSES.orbsExchangeMulti);
    const xyloRouter = liveAddress(ADDRESSES.xyloRouter);
    // Arcade V3 as a third ExchangeMulti venue (single-pool direct fills). Its
    // quoter fans out fee tiers; the router flat-arg exactInputSingle matches
    // buildVenueSwapData. launchpad (optional) lets the keeper replicate the V3
    // router's anti-sniper skim so the quote matches execution on sniped tokens.
    const v3Router = liveAddress(ADDRESSES.v3Router);
    const v3Quoter = liveAddress(ADDRESSES.v3Quoter);
    const launchpad = liveAddress(ADDRESSES.launchpad);
    // Leg C: fee-protocol sync. Dormant unless the manager + factory are wired.
    const feeProtocolManager = liveAddress(ADDRESSES.feeProtocolManager);
    const v3Factory = liveAddress(ADDRESSES.v3Factory);

    const keeperKey = process.env.KEEPER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!keeperKey || !/^0x[0-9a-fA-F]{64}$/.test(keeperKey)) {
        return NextResponse.json(
            { ran: false, reason: "KEEPER_OPERATOR_PRIVATE_KEY missing or malformed" },
            { status: 200 },
        );
    }

    // Neon compute gate. The cron fires every 5 min, and EVERY run touches
    // Postgres (the keeper lease, the Orbs mirror, bridge intents), which pins
    // Neon awake 24/7 and burns its whole compute allowance. We only do the
    // DB-touching work every KEEPER_DB_INTERVAL_MIN minutes (default 10), so Neon
    // can auto-suspend between and the compute bill drops proportionally. The
    // cost is latency: a fillable limit order / DCA tranche / CCTP relay waits up
    // to that interval instead of 5 min. Set KEEPER_DB_INTERVAL_MIN=5 to restore
    // 5-min cadence (max Neon cost), or 15 for max savings. Because the cron
    // always fires on a multiple of 5, `minute % interval < 5` selects exactly
    // one run per interval (e.g. 10 -> :00,:10,:20…; 15 -> :00,:15,:30,:45).
    const dbIntervalMin = (() => {
        const v = Number(process.env.KEEPER_DB_INTERVAL_MIN ?? "10");
        return Number.isFinite(v) && v >= 5 ? Math.floor(v) : 10;
    })();
    if (new Date().getMinutes() % dbIntervalMin >= 5) {
        return NextResponse.json(
            { ran: false, reason: "db-suspend window (Neon compute gate)", dbIntervalMin },
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
                reason: "Keeper balance below threshold - refill USDC",
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
        fees: { scanned: 0, synced: 0, skipped: 0, failed: 0 },
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
                { twap, exchange, exchangeMulti, router, xyloRouter, v3Router, v3Quoter, launchpad, usdc, now },
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

        // ---- Leg C: V3 fee-protocol sync (dormant unless the manager is wired) ----
        if (feeProtocolManager && v3Factory) {
            try {
                await runFeeSyncLeg(
                    { feeProtocolManager, v3Factory, headBlock: BigInt(latestBlock.number) },
                    publicClient,
                    walletClient,
                    account.address,
                    summary,
                );
            } catch (err) {
                summary.notes.push(`fees-leg error=${errMsg(err)}`);
            }
        }
    } finally {
        await releaseKeeperLease(runToken).catch(() => {});
    }

    return NextResponse.json({ ran: true, ...summary }, { status: 200 });
}

// ===================================================================
// Leg A - Orbs TWAP settlement
// ===================================================================

interface OrbsCfg {
    twap: Address;
    /** Legacy single-router ExchangeV2 adapter (always present). */
    exchange: Address;
    /** Trusted multi-router ExchangeMulti adapter (optional). */
    exchangeMulti?: Address;
    /** Arcade V2 router. */
    router: Address;
    /** XyloNet V2-style router (optional second direct venue for ExchangeMulti). */
    xyloRouter?: Address;
    /** Arcade V3 SwapRouter (optional third direct venue for ExchangeMulti). */
    v3Router?: Address;
    /** Arcade V3 QuoterV2 (needed to price the V3 venue). */
    v3Quoter?: Address;
    /** Launchpad (optional) - read to replicate the V3 anti-sniper skim. */
    launchpad?: Address;
    usdc: Address;
    now: number;
}

/**
 * Cheap read probe: is `keeper` allow-listed as a taker on `adapter`? Both
 * ExchangeV2 and ExchangeMulti revert TakerNotAllowed(taker) BEFORE decoding
 * bidData, so a denied keeper is detected without a well-formed payload; an
 * allowed keeper either returns or reverts on the (intentionally minimal) decode
 * - either way NOT TakerNotAllowed, so we read it as allowed. `probeBidData`
 * must match the adapter's decode shape for the allowed branch not to false-deny.
 */
async function probeAllowed(
    publicClient: PublicClient,
    adapter: Address,
    probeBidData: Hex,
    keeper: Address,
): Promise<boolean> {
    const res = await withTimeout(
        publicClient
            .readContract({
                address: adapter,
                abi: EXCHANGE_V2_ABI,
                functionName: "getAmountOut",
                args: [ZERO as Address, ZERO as Address, 0n, "0x", probeBidData, keeper],
            })
            .then(() => "allowed" as const)
            .catch((e: unknown) => {
                const m = errMsg(e);
                return m.includes("TakerNotAllowed") ||
                    m.toLowerCase().includes(TAKER_NOT_ALLOWED_SELECTOR)
                    ? ("denied" as const)
                    : ("allowed" as const);
            }),
        RPC_TIMEOUT_MS,
    );
    return res === "allowed";
}

async function runOrbsLeg(
    cfg: OrbsCfg,
    publicClient: PublicClient,
    walletClient: WalletClient,
    keeper: Address,
    summary: RunSummary,
) {
    // Precheck: the keeper wallet MUST be allowlisted on the adapter it fills
    // through. getAmountOut reverts TakerNotAllowed for a non-allowlisted taker
    // BEFORE decoding, so a cheap probe tells us whether the setup is done. We
    // probe BOTH adapters (V2 always, Multi if configured) and settle each order
    // only on an adapter the keeper is allowed on. If neither is usable, skip.
    const v2Allowed = await probeAllowed(publicClient, cfg.exchange, PROBE_BID_DATA, keeper);
    const multiAllowed = cfg.exchangeMulti
        ? await probeAllowed(publicClient, cfg.exchangeMulti, MULTI_PROBE_BID_DATA, keeper)
        : false;
    if (!v2Allowed && !multiAllowed) {
        summary.notes.push(
            "keeper wallet not allowlisted on any Orbs adapter - skipping leg A (redeploy/allowlist per KEEPER_SETUP.md)",
        );
        return;
    }

    // Which routers ExchangeMulti will accept at fill time. Read once per tick so
    // the keeper only quotes/bids a router it can actually fill on (getAmountOut
    // does not check the router; swap does). A router missing here is skipped
    // rather than bid-then-stuck. Only relevant when the multi adapter is usable.
    const allowedRouters = new Set<string>();
    if (cfg.exchangeMulti && multiAllowed) {
        for (const r of [cfg.router, cfg.xyloRouter, cfg.v3Router]) {
            if (!r) continue;
            const ok = await withTimeout(
                publicClient
                    .readContract({
                        address: cfg.exchangeMulti,
                        abi: ALLOWED_ROUTER_ABI,
                        functionName: "allowedRouter",
                        args: [r],
                    })
                    .then((v) => v === true)
                    .catch(() => false),
                RPC_TIMEOUT_MS,
            );
            if (ok) allowedRouters.add(r.toLowerCase());
        }
        if (allowedRouters.size === 0) {
            summary.notes.push(
                "ExchangeMulti has no allow-listed router (call setRouterAllowed) - multi orders will not settle",
            );
        }
    }
    const allow = { v2: v2Allowed, multi: multiAllowed, routers: allowedRouters };

    // 1. Discover any new orders past the highest id we already track.
    await discoverNewOrders(cfg, publicClient);

    // 2. Process the active set. Each tick performs at most
    //    MAX_ORBS_ACTIONS_PER_RUN direct txs (bids + fills combined).
    const active = await getActiveOrbsOrders(64);
    let actions = 0;

    for (const tracked of active) {
        if (actions >= MAX_ORBS_ACTIONS_PER_RUN) break;
        summary.orbs.scanned++;

        // Read the live order - the on-chain state is the source of truth.
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
            allow,
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

        // Only track orders routed through an adapter WE can fill: the legacy
        // ExchangeV2, the ExchangeMulti (if configured), or any-exchange
        // (exchange == 0, legacy). Anything pinned to a different adapter we
        // cannot fill (the keeper is only allowlisted on ours).
        const askExchange = getAddr(order.ask.exchange);
        const fillable =
            askExchange === ZERO ||
            askExchange.toLowerCase() === cfg.exchange.toLowerCase() ||
            (!!cfg.exchangeMulti && askExchange.toLowerCase() === cfg.exchangeMulti.toLowerCase());
        if (!fillable) continue;

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
    allow: { v2: boolean; multi: boolean; routers: Set<string> },
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
        // Our winning bid could not fill and went stale: this is a re-bid. Back
        // off an order whose fill keeps reverting despite clearsFloor (a dstToken
        // delivering less than getAmountsOut quotes). A legit order fills within a
        // re-bid or two and its counter resets on fill; only an unfillable one
        // reaches the cap, so we stop re-bidding it (no gas, no action-budget DoS).
        if (tracked.bidFailCount >= MAX_REBID_FAILS) {
            summary.orbs.skipped++;
            return false;
        }
        await incrementOrbsBidFail(tracked.orderId);
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

    // Pick the settlement adapter FROM THE ORDER: an order pinned to
    // ExchangeMulti settles on the best allow-listed direct venue; anything else
    // (legacy ExchangeV2, or the legacy any-exchange==0) settles on the single
    // trusted V2 adapter, exactly as before. The keeper must be allow-listed on
    // whichever it uses (checked once per tick in `allow`).
    const askExchange = getAddr(order.ask.exchange);
    const useMulti =
        !!cfg.exchangeMulti &&
        askExchange.toLowerCase() === cfg.exchangeMulti.toLowerCase();
    const settleExchange = useMulti ? (cfg.exchangeMulti as Address) : cfg.exchange;
    if (useMulti ? !allow.multi : !allow.v2) {
        // Keeper not allow-listed on the adapter this order needs.
        summary.orbs.skipped++;
        return false;
    }

    // Build direct-venue candidates. Each is quoted at EXACTLY chunkIn on the
    // EXACT single-hop route it will execute, so quote == execute (no multi-hop /
    // partial-fill reconstruction gap -- the B-1/B-2/B-3 class that forced the
    // revert). ExchangeV2 orders see only the Arcade V2 venue; ExchangeMulti
    // orders additionally see XyloNet (a second native-USDC V2-style router).
    // Extending to more DEXes = push a candidate here + setRouterAllowed on-chain.
    // For an ExchangeMulti order a candidate's router must be allow-listed on the
    // adapter (else the fill would revert RouterNotAllowed); the legacy ExchangeV2
    // adapter wraps cfg.router immutably, so its single venue is always eligible.
    const routerEligible = (r: Address) =>
        !useMulti || allow.routers.has(r.toLowerCase());

    const candidates: DirectVenueCandidate[] = [];
    if (routerEligible(cfg.router)) {
        const arcadeOut = await getAmountsOutLast(publicClient, cfg.router, chunkIn, [
            srcToken,
            dstToken,
        ]);
        if (arcadeOut !== null) {
            candidates.push({
                label: "arcade-v2",
                quotedOut: arcadeOut,
                venue: v2DirectVenue(cfg.router, srcToken, dstToken),
            });
        }
    }
    if (useMulti && cfg.xyloRouter && routerEligible(cfg.xyloRouter)) {
        const xyloOut = await getAmountsOutLast(publicClient, cfg.xyloRouter, chunkIn, [
            srcToken,
            dstToken,
        ]);
        if (xyloOut !== null) {
            candidates.push({
                label: "xylonet",
                quotedOut: xyloOut,
                venue: v2DirectVenue(cfg.xyloRouter, srcToken, dstToken),
            });
        }
    }
    if (useMulti && cfg.v3Router && routerEligible(cfg.v3Router)) {
        const v3 = await quoteV3BestDirect(publicClient, cfg, srcToken, dstToken, chunkIn);
        if (v3) {
            candidates.push({
                label: "arcade-v3",
                quotedOut: v3.quotedOut,
                venue: {
                    kind: "v3",
                    router: cfg.v3Router,
                    tokenIn: srcToken,
                    tokenOut: dstToken,
                    fee: v3.tier,
                },
            });
        }
    }
    const best = pickBestVenue(candidates);
    if (!best) {
        // No wired venue has a direct pool for this pair. Not an error.
        summary.orbs.skipped++;
        return false;
    }
    const quotedOut = best.quotedOut;

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
            venue: best.venue,
            chunkIn,
            quotedOut,
            chunkFloor,
            exchange: settleExchange,
            slippagePercent: SLIPPAGE_PERCENT,
            dstFee: DST_FEE,
            deadline: BigInt(cfg.now) + SWAP_DEADLINE_SECS,
            encoding: useMulti ? "exchangeMulti" : "exchangeV2",
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
            args: [id, settleExchange, plan.dstFee, plan.slippagePercent, plan.bidData],
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
// Leg B - CCTP bridge-and-buy relay
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

        const relayFn = intent.intentKind === "forward" ? "receiveAndForward" : "receiveAndBuy";
        // Simulate before spending gas. intent.intentKind comes from the
        // unauthenticated /api/bridge/intent POST, so a wrong label (or a message
        // whose length does not match the chosen entrypoint) reverts BadMessage.
        // Without this, a spammer's mislabeled-but-real burn burns up to
        // BRIDGE_MAX_ATTEMPTS reverting relays. The receiver derives the
        // beneficiary from the ATTESTED message, so simulating changes no trust
        // assumption; it only skips a doomed send.
        const relayOk = await withTimeout(
            publicClient
                .simulateContract({
                    address: receiver,
                    abi: CCTP_BUY_RECEIVER_ABI,
                    functionName: relayFn,
                    args: [message, attestation],
                    account: keeper,
                })
                .then(() => true)
                .catch(() => false),
            RPC_TIMEOUT_MS,
        );
        if (relayOk !== true) {
            await markBridgeRetryOrFail(intent.id, "relay simulation reverted", BRIDGE_MAX_ATTEMPTS);
            summary.cctp.failed++;
            relays++;
            continue;
        }

        await markBridgeRelaying(intent.id);
        try {
            const hash = await walletClient.writeContract({
                address: receiver,
                abi: CCTP_BUY_RECEIVER_ABI,
                functionName: relayFn,
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
// Leg C - V3 fee-protocol sync
// ===================================================================

interface FeeSyncCfg {
    feeProtocolManager: Address;
    v3Factory: Address;
    headBlock: bigint;
}

/**
 * Enable the V3 protocol fee on new ORDINARY pools automatically by calling the
 * FeeProtocolManager's convergent `sync(pool)`, and heal any launch pool the
 * launchpad's atomic forceZero missed. Scans PoolCreated forward from a persisted
 * cursor. sync is idempotent (launch -> 0, ordinary -> tier default), so a
 * pre-check skips pools already in their target state to avoid wasted txs, and
 * the cursor only advances when the run drained under the per-tick tx cap.
 */
async function runFeeSyncLeg(
    cfg: FeeSyncCfg,
    publicClient: PublicClient,
    walletClient: WalletClient,
    keeper: Address,
    summary: RunSummary,
) {
    const head = cfg.headBlock;
    const cursor =
        (await getKeeperCursor(FEE_SYNC_CURSOR).catch(() => null)) ??
        (head > FEE_SYNC_WINDOW ? head - FEE_SYNC_WINDOW : 0n);
    // Floor the scan start at a trailing safety window so recently-created or
    // previously-failed pools are always re-checked (self-healing, see the
    // FEE_SYNC_SAFETY_LOOKBACK note). from = min(cursor, head - lookback).
    const safetyFloor = head > FEE_SYNC_SAFETY_LOOKBACK ? head - FEE_SYNC_SAFETY_LOOKBACK : 0n;
    let from = cursor < safetyFloor ? cursor : safetyFloor;
    if (from > head) from = head;

    // getLogs over a FALLBACK transport across every Arc RPC, not just the
    // keeper's default [0]. The default may be thirdweb (1000-block getLogs cap)
    // or a dedicated RPC that rejects the scan; fallback rolls to the next RPC
    // (rpc.testnet.arc.network handles getLogs) on any error, so the scan stops
    // silently dying on a single bad endpoint. Short per-RPC timeout so trying
    // several stays well under the Vercel ceiling.
    const logsClient = createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(FEE_SYNC_LOG_RPCS.map((u) => http(u, { timeout: 4_000 }))),
    });
    // Collect new pool addresses across a bounded number of windows.
    const pools: Address[] = [];
    let scannedTo = from;
    for (let w = 0; w < MAX_FEE_SYNC_WINDOWS_PER_RUN && scannedTo < head; w++) {
        const to = scannedTo + FEE_SYNC_WINDOW - 1n > head ? head : scannedTo + FEE_SYNC_WINDOW - 1n;
        // Raw eth_getLogs (topic0 only). viem's typed getLogs wants an event/args
        // shape, but Arc ignores indexed-topic filters anyway, so the raw request
        // is both simpler and faithful to how the referral scan reads Arc logs.
        let logs: { data: Hex }[] | null = null;
        try {
            logs = (await logsClient.request({
                method: "eth_getLogs",
                params: [
                    {
                        address: cfg.v3Factory,
                        topics: [POOL_CREATED_TOPIC0],
                        fromBlock: ("0x" + scannedTo.toString(16)) as Hex,
                        toBlock: ("0x" + to.toString(16)) as Hex,
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ] as any,
            })) as { data: Hex }[];
        } catch (e) {
            // Surface the REAL error (all fallback RPCs exhausted) instead of a
            // guess; keep the cursor and retry next tick.
            summary.notes.push(`fee-sync getLogs err @${scannedTo}: ${errMsg(e).slice(0, 140)}`);
            break;
        }
        for (const log of logs) {
            // data = abi.encode(int24 tickSpacing, address pool); pool is word 2.
            if (!log.data || log.data.length < 2 + 128) continue;
            const pool = getAddr(("0x" + log.data.slice(2 + 64 + 24, 2 + 128)) as Address);
            if (pool !== ZERO) pools.push(pool);
        }
        scannedTo = to + 1n;
    }
    summary.fees.scanned += pools.length;

    let actions = 0;
    const seen = new Set<string>();
    for (const pool of pools) {
        if (actions >= MAX_FEE_SYNCS_PER_RUN) break;
        const key = pool.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const isLaunch = (await withTimeout(
            publicClient
                .readContract({
                    address: cfg.feeProtocolManager,
                    abi: FEE_MANAGER_ABI,
                    functionName: "isLaunchPool",
                    args: [pool],
                })
                .then((v) => v === true)
                .catch(() => null),
            RPC_TIMEOUT_MS,
        )) as boolean | null;
        const fp = (await withTimeout(
            publicClient
                .readContract({ address: pool, abi: POOL_SLOT0_ABI, functionName: "slot0" })
                .then((r) => Number((r as readonly unknown[])[5]))
                .catch(() => null),
            RPC_TIMEOUT_MS,
        )) as number | null;

        // Already in target state: a launch pool at 0 (launchpad handled it) or an
        // ordinary pool already fee-enabled (fp != 0). Skip the tx.
        const alreadyOk =
            (isLaunch === true && fp === 0) || (isLaunch === false && fp !== null && fp !== 0);
        if (alreadyOk) {
            summary.fees.skipped++;
            continue;
        }

        try {
            const hash = await walletClient.writeContract({
                address: cfg.feeProtocolManager,
                abi: FEE_MANAGER_ABI,
                functionName: "sync",
                args: [pool],
                chain: ARC_CHAIN,
                account: keeper,
                maxFeePerGas: MAX_FEE_PER_GAS_WEI,
            });
            await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
            await insertKeeperEvent({ leg: "fees", eventType: "sync", refId: pool, txHash: hash });
            summary.fees.synced++;
            actions++;
        } catch (err) {
            // Failed sync (on-chain revert, or a shared-wallet nonce clash when
            // the operator EOA also submits user txs). Surface it instead of
            // swallowing it, and do NOT treat it as done -- the trailing safety
            // window re-scans and retries next run until it lands. UnknownTier
            // (a launch-only-tier ordinary pool) also lands here and just
            // re-skips harmlessly each run.
            summary.fees.skipped++;
            summary.notes.push(`fee-sync ${pool.slice(0, 10)} failed: ${errMsg(err)}`);
        }
    }

    // Advance only when we drained under the tx cap; if we capped out there may be
    // more pools in this span, so keep the cursor and the pre-check skips the ones
    // already synced next tick.
    if (actions < MAX_FEE_SYNCS_PER_RUN) {
        await setKeeperCursor(FEE_SYNC_CURSOR, scannedTo).catch(() => {});
    }
}

// ===================================================================
// helpers
// ===================================================================

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Normalise a config address: return it only if it is a real, non-zero address,
 * else undefined. `safeAddress()` (lib/constants) returns the ZERO address for an
 * unset env var, and isAddress(0x0)===true, so a bare truthy+isAddress check
 * would treat "unset" as "configured". Everywhere the keeper branches on an
 * OPTIONAL address (ExchangeMulti, XyloNet) it must use this.
 */
function liveAddress(v: string | undefined): Address | undefined {
    return v && isAddress(v) && v.toLowerCase() !== ZERO ? (v as Address) : undefined;
}

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

/**
 * Read a V2-style router's getAmountsOut and return the LAST hop's output, or
 * null on any failure (no pool / revert / timeout). Used to price each direct
 * venue at the exact chunk size the keeper will then execute (quote == execute).
 */
async function getAmountsOutLast(
    publicClient: PublicClient,
    router: Address,
    amountIn: bigint,
    path: Address[],
): Promise<bigint | null> {
    const amounts = (await withTimeout(
        publicClient.readContract({
            address: router,
            abi: ROUTER_ABI,
            functionName: "getAmountsOut",
            args: [amountIn, path],
        }) as Promise<readonly bigint[]>,
        RPC_TIMEOUT_MS,
    )) as readonly bigint[] | null;
    if (!amounts || amounts.length < 2) return null;
    return amounts[amounts.length - 1];
}

// Arcade V3 standard fee tiers (0.01% / 0.05% / 0.3% / 1%), same set the swap
// aggregator's arcade-v3 provider fans out over.
const ARCADE_V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;

/**
 * Price a DIRECT single-pool Arcade V3 fill for `chunkIn`, returning the best
 * tier + its output, or null if no V3 pool quotes this pair. FAITHFUL to what
 * the V3 router executes:
 *   - The router skims the anti-sniper tax off the input for launchpad tokens,
 *     then swaps the net. So we quote at (chunkIn - skim), exactly like the
 *     swap aggregator's arcade-v3 provider, while the swapData still passes the
 *     FULL chunkIn (the router re-derives net internally). quote == execute.
 *   - Only USDC<->token direct pools (one leg is USDC): the overwhelming
 *     limit/DCA shape. clanker->clanker multi-hop V3 is intentionally skipped.
 * The returned `tier` is the winning pool fee, baked into the V3 venue.
 */
async function quoteV3BestDirect(
    publicClient: PublicClient,
    cfg: OrbsCfg,
    srcToken: Address,
    dstToken: Address,
    chunkIn: bigint,
): Promise<{ quotedOut: bigint; tier: number } | null> {
    if (!cfg.v3Router || !cfg.v3Quoter) return null;
    const isUsdcIn = srcToken.toLowerCase() === cfg.usdc.toLowerCase();
    const isUsdcOut = dstToken.toLowerCase() === cfg.usdc.toLowerCase();
    if (!isUsdcIn && !isUsdcOut) return null; // direct USDC pools only

    // Replicate the router's anti-sniper skim on the taxed (non-USDC) side.
    // 0 for non-launchpad / post-window tokens, so this is a no-op for them.
    let snipeBps = 0n;
    if (cfg.launchpad) {
        const taxedSide = isUsdcIn ? dstToken : srcToken;
        const bps = (await withTimeout(
            publicClient
                .readContract({
                    address: cfg.launchpad,
                    abi: LAUNCHPAD_ABI,
                    functionName: "currentSnipeBps",
                    args: [taxedSide],
                })
                .catch(() => 0n) as Promise<bigint>,
            RPC_TIMEOUT_MS,
        )) as bigint | null;
        if (bps && bps > 0n) snipeBps = bps;
    }
    const netIn = chunkIn - (chunkIn * snipeBps) / 10_000n;
    if (netIn <= 0n) return null;

    const perTier = await Promise.all(
        ARCADE_V3_FEE_TIERS.map(async (tier) => {
            const out = (await withTimeout(
                publicClient
                    .readContract({
                        address: cfg.v3Quoter as Address,
                        abi: V3_QUOTER_ABI,
                        functionName: "quoteExactInputSingle",
                        args: [srcToken, dstToken, tier, netIn],
                    })
                    .catch(() => 0n) as Promise<bigint>,
                RPC_TIMEOUT_MS,
            )) as bigint | null;
            return out && out > 0n ? { tier, out } : null;
        }),
    );
    let best: { tier: number; out: bigint } | null = null;
    for (const q of perTier) {
        if (q && (best === null || q.out > best.out)) best = q;
    }
    return best ? { quotedOut: best.out, tier: best.tier } : null;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
