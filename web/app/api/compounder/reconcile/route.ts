import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    decodeEventLog,
    fallback,
    http,
    isAddress,
    keccak256,
    toBytes,
    type Address,
    type Hex,
} from "viem";
import { AUTO_COMPOUNDER_ABI } from "@/lib/abis/autoCompounder";
import { ADDRESSES } from "@/lib/constants";
import { isDbConfigured } from "@/lib/db";
import { quoteUsdcValueForPair } from "@/lib/compounderQuote";

/** tokenId -> the position's two token addresses, for USDC pricing. */
type PosAddrMap = Map<
    string,
    { token0Address: string | null; token1Address: string | null }
>;
import {
    getActivePositions,
    insertEvent,
    upsertPosition,
    restampOwnerOnRedeposit,
    markWithdrawn,
    type CompounderMode,
} from "@/lib/compounderPersistence";

/**
 * Audit I5 fix: reconciliation worker.
 *
 * The 5-minute cron writes `compounder_events` from the receipt of
 * every tx it submits. Two on-chain event paths bypass that mirror:
 *
 *   (1) The keeper hits a transient 503 BETWEEN writeContract and
 *       insertEvent. The on-chain tx is canonical; the DB row is
 *       missing forever.
 *   (2) A user deposits / withdraws / setMode's via Etherscan or a
 *       direct safeTransferFrom(...,data) call, bypassing the API
 *       entirely. The contract emits PositionDeposited /
 *       PositionWithdrawn / ModeChanged events the cron never sees.
 *
 * This handler scans the on-chain event log over a configurable
 * lookback window, decodes every Compounder event, and reconciles
 * each one into the DB via the existing insertEvent / upsertPosition
 * / markWithdrawn helpers. ON CONFLICT DO NOTHING + the UNIQUE(tx_hash)
 * index from migration 003 make the writes idempotent, so a scan
 * that overlaps with the keeper's normal writes is safe.
 *
 * Triggered by .github/workflows/compounder-reconcile.yml on an
 * hourly cadence — long enough that we never overlap with two cron
 * runs and short enough that gaps surface within an SLA the team
 * can act on.
 *
 * Auth uses the same Bearer secret as the main cron (COMPOUNDER_CRON_SECRET).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Reconcile scans wide 50k-block getLogs windows.
//
// RPC ranking (Arc testnet, 2026-06-15 diagnostics):
//   1. thirdweb        — consistent, hard cap 1000 blocks per request
//   2. Arc public RPC  — accepts >1000 blocks but returns intermittent
//                        empty 200-OK responses (no error, fallback can't
//                        detect → silent data loss). Demoted to backup.
//   3. Alchemy         — caps getLogs at 10 blocks (free tier), useless
//                        for this scan path. Last in the list.
//
// Pair this list with BLOCK_WINDOW = 1000n so every provider can serve
// any chunk without truncation.
const ARC_RPC_LIST: readonly string[] = (() => {
    const out: string[] = [
        "https://5042002.rpc.thirdweb.com",
        "https://rpc.testnet.arc.network",
    ];
    const dedicated = process.env.NEXT_PUBLIC_ARC_RPC_URL;
    if (dedicated) out.push(dedicated);
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

// Chunk size is bounded by the strictest still-useful provider.
// Thirdweb caps getLogs at 1000 blocks (-32005 "Log response size
// exceeded"); Arc public RPC accepts wider but returns flaky empty
// 200s that the fallback can't distinguish from "no logs". 1000
// keeps thirdweb (now the primary) happy and the cron's 50k lookback
// walks as 50 small chunks instead of 25. Hourly cadence × 50k =
// ~7h of headroom per scan, still plenty.
const BLOCK_WINDOW = 1_000n;
const LOOKBACK_BLOCKS = 50_000n;

// Pre-hashed event signatures so the decoded log filter does not
// re-keccak on every call. Mirrors the cron's hot-path pattern.
const TOPIC_POSITION_DEPOSITED = keccak256(
    toBytes(
        "PositionDeposited(uint256,address,uint8,uint64,uint16)",
    ),
);
const TOPIC_POSITION_WITHDRAWN = keccak256(
    toBytes("PositionWithdrawn(uint256,address)"),
);
const TOPIC_MODE_CHANGED = keccak256(
    toBytes("ModeChanged(uint256,uint8,uint8,uint64,uint16)"),
);
const TOPIC_COMPOUNDED = keccak256(
    toBytes(
        "Compounded(uint256,address,uint256,uint256,uint256,uint256,uint128,uint256,uint256,uint256,uint256)",
    ),
);
const TOPIC_FEES_PUSHED = keccak256(
    toBytes(
        "FeesPushed(uint256,address,address,uint256,uint256,uint256,uint256)",
    ),
);

function modeIdToLabel(id: number): CompounderMode {
    if (id === 1) return "RECEIVE";
    if (id === 2) return "COMPOUND";
    return "NORMAL";
}

interface RunSummary {
    compounderAddress: string;
    fromBlock: string;
    toBlock: string;
    eventsScanned: number;
    deposits: number;
    withdraws: number;
    modeChanges: number;
    compounds: number;
    feesPushed: number;
    rpcErrors: number;
    firstRpcError?: string;
    handlerErrors: number;
    firstHandlerError?: string;
}

export async function POST(req: NextRequest) {
    const secret = process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) {
        return NextResponse.json(
            { error: "COMPOUNDER_CRON_SECRET not configured" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    const expected = `Bearer ${secret}`;
    if (!auth || auth.length !== expected.length || auth !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isDbConfigured()) {
        return NextResponse.json(
            { ran: false, reason: "Postgres not configured" },
            { status: 200 },
        );
    }

    const compounderAddress = ADDRESSES.autoCompounder as Address;
    if (!isAddress(compounderAddress, { strict: false })) {
        return NextResponse.json(
            { ran: false, reason: "NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS not configured" },
            { status: 200 },
        );
    }

    // fallback() iterates URLs on RPC error. http() without an explicit
    // URL only uses rpcUrls.default.http[0], so a single misbehaving
    // primary used to break the whole scan; fallback fixes that.
    const publicClient = createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(ARC_RPC_LIST.map((url) => http(url))),
    });

    const head = await publicClient.getBlockNumber();
    const fromBlock = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;

    // Walk the window in 50k chunks so a wider span never trips the
    // Arc range cap. Each chunk's logs are decoded in-memory and
    // dispatched to the right reconciler.
    const summary: RunSummary = {
        compounderAddress,
        fromBlock: fromBlock.toString(),
        toBlock: head.toString(),
        eventsScanned: 0,
        deposits: 0,
        withdraws: 0,
        modeChanges: 0,
        compounds: 0,
        feesPushed: 0,
        rpcErrors: 0,
        handlerErrors: 0,
    };

    // Build a tokenId -> token-addresses map so each Compounded / FeesPushed
    // event can be priced in USDC the same way the cron does (fee audit
    // 2026-07-02 MEDIUM-1: reconcile-first rows used to store usd = 0
    // permanently). Only active positions carry token addresses; a withdrawn
    // position's events fall back to usd = 0, unchanged from before.
    const activeForQuote = await getActivePositions().catch(() => []);
    const posByTokenId = new Map<
        string,
        { token0Address: string | null; token1Address: string | null }
    >();
    for (const pos of activeForQuote) {
        posByTokenId.set(pos.tokenId, {
            token0Address: pos.token0Address,
            token1Address: pos.token1Address,
        });
    }

    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        const logs = await publicClient
            .getLogs({
                address: compounderAddress,
                fromBlock: from,
                toBlock: to,
            })
            .catch((err) => {
                // eslint-disable-next-line no-console
                console.warn("[reconcile] getLogs failed", from, to, err);
                summary.rpcErrors++;
                if (!summary.firstRpcError) {
                    summary.firstRpcError =
                        (err as { shortMessage?: string; message?: string })
                            ?.shortMessage ??
                        (err as { message?: string })?.message ??
                        String(err);
                }
                return [] as Awaited<ReturnType<typeof publicClient.getLogs>>;
            });
        for (const log of logs) {
            summary.eventsScanned++;
            const topic0 = log.topics[0];
            if (!topic0) continue;
            try {
                if (topic0 === TOPIC_POSITION_DEPOSITED) {
                    await reconcileDeposit(log, publicClient, summary);
                } else if (topic0 === TOPIC_POSITION_WITHDRAWN) {
                    await reconcileWithdraw(log, summary);
                } else if (topic0 === TOPIC_MODE_CHANGED) {
                    await reconcileModeChanged(log, publicClient, summary);
                } else if (topic0 === TOPIC_COMPOUNDED) {
                    await reconcileCompounded(log, publicClient, summary, posByTokenId);
                } else if (topic0 === TOPIC_FEES_PUSHED) {
                    await reconcileFeesPushed(log, publicClient, summary, posByTokenId);
                }
            } catch (err) {
                // Per-event failures must NOT abort the whole sweep —
                // a single malformed log should not block the rest of
                // the reconciliation. Log and move on.
                // eslint-disable-next-line no-console
                console.warn(
                    "[reconcile] event handler failed:",
                    log.transactionHash,
                    err,
                );
                summary.handlerErrors++;
                if (!summary.firstHandlerError) {
                    summary.firstHandlerError =
                        (err as { shortMessage?: string; message?: string })
                            ?.shortMessage ??
                        (err as { message?: string })?.message ??
                        String(err);
                }
            }
        }
    }

    return NextResponse.json({ ran: true, ...summary });
}

type EvmLog = {
    transactionHash?: Hex | null;
    blockNumber?: bigint | null;
    topics: readonly Hex[];
    data: Hex;
};

async function reconcileDeposit(
    log: EvmLog,
    publicClient: ReturnType<typeof createPublicClient>,
    summary: RunSummary,
): Promise<void> {
    // PositionDeposited(uint256 indexed tokenId, address indexed
    //   depositor, uint8 mode, uint64 minFeeMicros, uint16 maxSlippageBps)
    const decoded = decodeEventLog({
        abi: AUTO_COMPOUNDER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== "PositionDeposited") return;
    const args = decoded.args as {
        tokenId: bigint;
        depositor: Address;
        mode: number;
        minFeeMicros: bigint;
        maxSlippageBps: number;
    };
    summary.deposits++;
    // 2026-06-15 audit MEDIUM fix: order matters. restampOwnerOnRedeposit
    // is a no-op unless withdrawn_at IS NOT NULL on the existing row
    // (legitimate re-entry); if it fires it refreshes owner_address +
    // deposited_at so the tenure-window query attributes events to the
    // new owner. upsertPosition then writes the new mode/threshold/
    // slippage. The C2 defence on owner_address in upsertPosition still
    // applies to the public POST route (this trusted path runs only
    // server-side from the reconcile cron).
    await restampOwnerOnRedeposit({
        tokenId: args.tokenId.toString(),
        ownerAddress: args.depositor,
    });
    await upsertPosition({
        tokenId: args.tokenId.toString(),
        ownerAddress: args.depositor,
        mode: modeIdToLabel(args.mode),
        minFeeMicros: args.minFeeMicros.toString(),
        maxSlippageBps: args.maxSlippageBps,
    });
    // Discard publicClient here; the upsert is the entire reconciliation.
    void publicClient;
}

async function reconcileWithdraw(log: EvmLog, summary: RunSummary): Promise<void> {
    const decoded = decodeEventLog({
        abi: AUTO_COMPOUNDER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== "PositionWithdrawn") return;
    const args = decoded.args as { tokenId: bigint; to: Address };
    summary.withdraws++;
    await markWithdrawn(args.tokenId.toString());
    void args.to;
}

async function reconcileModeChanged(
    log: EvmLog,
    publicClient: ReturnType<typeof createPublicClient>,
    summary: RunSummary,
): Promise<void> {
    // We don't have the full position state from a ModeChanged event
    // alone (no token0/token1/fee/ticks), so the reconciler queries
    // the active positions list and updates the matching row. The
    // DB-row owner is preserved because the upsert's ON CONFLICT
    // clause drops owner_address from its SET list (Audit C2 defence
    // in depth from commit ab4fb31).
    const decoded = decodeEventLog({
        abi: AUTO_COMPOUNDER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== "ModeChanged") return;
    const args = decoded.args as {
        tokenId: bigint;
        oldMode: number;
        newMode: number;
        minFeeMicros: bigint;
        maxSlippageBps: number;
    };
    const active = await getActivePositions();
    const existing = active.find(
        (p) => p.tokenId === args.tokenId.toString(),
    );
    if (!existing) return; // Not tracked → nothing to update.
    summary.modeChanges++;
    await upsertPosition({
        tokenId: existing.tokenId,
        ownerAddress: existing.ownerAddress,
        mode: modeIdToLabel(args.newMode),
        minFeeMicros: args.minFeeMicros.toString(),
        maxSlippageBps: args.maxSlippageBps,
    });
    void publicClient;
}

async function reconcileCompounded(
    log: EvmLog,
    publicClient: ReturnType<typeof createPublicClient>,
    summary: RunSummary,
    posByTokenId: PosAddrMap,
): Promise<void> {
    const decoded = decodeEventLog({
        abi: AUTO_COMPOUNDER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== "Compounded") return;
    const args = decoded.args as {
        tokenId: bigint;
        caller: Address;
        fee0Collected: bigint;
        fee1Collected: bigint;
        protocolFee0: bigint;
        protocolFee1: bigint;
        liquidityAdded: bigint;
        amount0Used: bigint;
        amount1Used: bigint;
        amount0Leftover: bigint;
        amount1Leftover: bigint;
    };
    summary.compounds++;
    void args.caller;
    void args.liquidityAdded;
    void args.amount0Used;
    void args.amount1Used;
    void args.amount0Leftover;
    void args.amount1Leftover;
    // LOW-3 (fee audit 2026-07-02): Compounded emits GROSS collected fees +
    // the protocol cut separately; store NET (gross - cut) so reconcile rows
    // are on the same basis as the cron writes and as FeesPushed.
    const net0 =
        args.fee0Collected > args.protocolFee0 ? args.fee0Collected - args.protocolFee0 : 0n;
    const net1 =
        args.fee1Collected > args.protocolFee1 ? args.fee1Collected - args.protocolFee1 : 0n;
    const [usdValueMicros, chainBlockAtIso] = await Promise.all([
        quoteEventUsd(publicClient, posByTokenId, args.tokenId.toString(), net0, net1),
        blockTimestampIso(publicClient, log.blockNumber ?? 0n),
    ]);
    const ok = await insertEvent({
        tokenId: args.tokenId.toString(),
        eventType: "Compounded",
        amount0: net0.toString(),
        amount1: net1.toString(),
        protocolFee0: args.protocolFee0.toString(),
        protocolFee1: args.protocolFee1.toString(),
        usdValueMicros: usdValueMicros.toString(),
        txHash: log.transactionHash ?? null,
        blockNumber: log.blockNumber?.toString() ?? null,
        chainBlockAtIso,
    });
    if (!ok) {
        // Surface persistence failures to the run summary so a swallowed
        // INSERT (FK violation, type mismatch, dropped connection) is not
        // mistakable for a successful reconcile pass.
        throw new Error(
            `insertEvent returned false for tx ${log.transactionHash ?? "(none)"}`,
        );
    }
}

async function reconcileFeesPushed(
    log: EvmLog,
    publicClient: ReturnType<typeof createPublicClient>,
    summary: RunSummary,
    posByTokenId: PosAddrMap,
): Promise<void> {
    const decoded = decodeEventLog({
        abi: AUTO_COMPOUNDER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
    });
    if (decoded.eventName !== "FeesPushed") return;
    const args = decoded.args as {
        tokenId: bigint;
        caller: Address;
        recipient: Address;
        amount0: bigint;
        amount1: bigint;
        protocolFee0: bigint;
        protocolFee1: bigint;
    };
    summary.feesPushed++;
    void args.caller;
    void args.recipient;
    // FeesPushed amount0/amount1 are already NET of the protocol cut (the
    // contract subtracts it before emitting), so price them directly.
    const [usdValueMicros, chainBlockAtIso] = await Promise.all([
        quoteEventUsd(
            publicClient,
            posByTokenId,
            args.tokenId.toString(),
            args.amount0,
            args.amount1,
        ),
        blockTimestampIso(publicClient, log.blockNumber ?? 0n),
    ]);
    await insertEvent({
        tokenId: args.tokenId.toString(),
        eventType: "FeesPushed",
        amount0: args.amount0.toString(),
        amount1: args.amount1.toString(),
        protocolFee0: args.protocolFee0.toString(),
        protocolFee1: args.protocolFee1.toString(),
        usdValueMicros: usdValueMicros.toString(),
        txHash: log.transactionHash ?? null,
        blockNumber: log.blockNumber?.toString() ?? null,
        chainBlockAtIso,
    });
}

/** Price a (fee0, fee1) pair in USDC micros for the position identified by
 *  tokenId, using its token addresses from the active-position map. Returns
 *  0 when the position isn't in the map (e.g. withdrawn) or the quote fails,
 *  mirroring the cron's best-effort behaviour so a quote hiccup never blocks
 *  the event write. */
async function quoteEventUsd(
    publicClient: ReturnType<typeof createPublicClient>,
    posByTokenId: PosAddrMap,
    tokenId: string,
    fee0: bigint,
    fee1: bigint,
): Promise<bigint> {
    const pos = posByTokenId.get(tokenId);
    if (!pos) return 0n;
    return quoteUsdcValueForPair(
        publicClient,
        pos.token0Address,
        pos.token1Address,
        fee0,
        fee1,
    ).catch(() => 0n);
}

async function blockTimestampIso(
    publicClient: ReturnType<typeof createPublicClient>,
    blockNumber: bigint,
): Promise<string | null> {
    if (blockNumber === 0n) return null;
    try {
        const block = await publicClient.getBlock({ blockNumber });
        return new Date(Number(block.timestamp) * 1000).toISOString();
    } catch {
        return null;
    }
}
