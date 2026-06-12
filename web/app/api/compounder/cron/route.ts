import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    isAddress,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    getActivePositions,
    stampLastAction,
    insertEvent,
    enqueueAction,
    type CompounderPosition,
} from "@/lib/compounderPersistence";
import { isDbConfigured } from "@/lib/db";
import { AUTO_COMPOUNDER_ABI, modeIdFromLabel } from "@/lib/abis/autoCompounder";
import { ADDRESSES } from "@/lib/constants";

/**
 * Compounder cron scanner.
 *
 * Triggered every 5 minutes by .github/workflows/compounder-scan.yml.
 * For each active position:
 *
 *   1. Read pendingFees(tokenId) from the on-chain Compounder so the
 *      decision uses the same state the contract will enforce at
 *      execute-time (no race vs. a stale DB cache).
 *   2. If the max of (fees0, fees1) meets the position's minFeeMicros
 *      threshold AND the 5-minute per-position cooldown has elapsed,
 *      submit the corresponding write (compound() or pushFees()) via
 *      the operator wallet.
 *   3. On success, stamp last_action_at + insert an event row + ack.
 *   4. On revert, log the error in a compounder_actions row marked
 *      'failed' so the dashboard surfaces it without polluting the
 *      successful-action stream.
 *
 * Hard caps on the per-run work:
 *   - MAX_POSITIONS_PER_RUN = 25 so a single scanner cannot run the
 *     operator dry. The GH Actions cadence (every 5 min) covers 300
 *     active positions in 1 hour worst-case; bump the cap when we
 *     exceed that.
 *   - per-action gas budget protection via the operator's standard
 *     wallet client (will simulate first and abort if est > cap).
 *
 * Auth: shared bearer secret COMPOUNDER_CRON_SECRET, same pattern as
 * the stats cron route.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_POSITIONS_PER_RUN = 25;
const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
        default: { http: ["https://rpc.testnet.arc.network"] },
        public: { http: ["https://rpc.testnet.arc.network"] },
    },
} as const;

interface RunSummary {
    scanned: number;
    triggered: number;
    skipped: number;
    failed: number;
    notes: string[];
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

    const operatorKey = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as
        | Hex
        | undefined;
    if (!operatorKey || !operatorKey.startsWith("0x")) {
        return NextResponse.json(
            { ran: false, reason: "COMPOUNDER_OPERATOR_PRIVATE_KEY not configured" },
            { status: 200 },
        );
    }

    const account = privateKeyToAccount(operatorKey);
    const publicClient = createPublicClient({
        chain: ARC_CHAIN,
        transport: http(),
    });
    const walletClient = createWalletClient({
        account,
        chain: ARC_CHAIN,
        transport: http(),
    });

    const active = await getActivePositions();
    const work = active.slice(0, MAX_POSITIONS_PER_RUN);

    const summary: RunSummary = {
        scanned: work.length,
        triggered: 0,
        skipped: 0,
        failed: 0,
        notes: [],
    };

    for (const position of work) {
        try {
            await handleOne(
                position,
                compounderAddress,
                publicClient,
                walletClient,
                account,
                summary,
            );
        } catch (err) {
            summary.failed++;
            summary.notes.push(
                `token=${position.tokenId} error=${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    return NextResponse.json({
        ran: true,
        ...summary,
    });
}

async function handleOne(
    position: CompounderPosition,
    compounderAddress: Address,
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: ReturnType<typeof privateKeyToAccount>,
    summary: RunSummary,
): Promise<void> {
    const tokenId = BigInt(position.tokenId);

    // pendingFees + nextActionAvailableAt are cheap, parallelisable.
    const [pending, nextAt] = await Promise.all([
        publicClient.readContract({
            address: compounderAddress,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "pendingFees",
            args: [tokenId],
        }),
        publicClient.readContract({
            address: compounderAddress,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "nextActionAvailableAt",
            args: [tokenId],
        }),
    ]);

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (nextAt > nowSec) {
        summary.skipped++;
        summary.notes.push(`token=${position.tokenId} reason=cooldown`);
        return;
    }

    const [fee0, fee1] = pending as readonly [bigint, bigint];
    const best = fee0 > fee1 ? fee0 : fee1;
    const threshold = BigInt(position.minFeeMicros);
    if (best < threshold) {
        summary.skipped++;
        summary.notes.push(
            `token=${position.tokenId} reason=below-threshold best=${best.toString()}`,
        );
        return;
    }

    const modeId = modeIdFromLabel(position.mode);
    if (modeId === 1 /* RECEIVE */) {
        // viem's default gas estimate already simulates so a stale
        // pendingFees that would revert (e.g. a parallel manual claim
        // emptied the position) surfaces as an estimate error before
        // we burn the operator's gas.
        const hash = await walletClient.writeContract({
            address: compounderAddress,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "pushFees",
            args: [tokenId],
            chain: ARC_CHAIN,
            account,
        });
        await onTxSubmitted({
            kind: "pushFees",
            position,
            hash,
            fee0,
            fee1,
            summary,
            publicClient,
        });
        return;
    }

    if (modeId === 2 /* COMPOUND */) {
        // Slippage: position-level maxSlippageBps applied to the lower
        // bound expected by NPM. Pass amount0Min/amount1Min as 0 for
        // the MVP — the contract clamps to net0 / net1 internally and
        // we don't yet have an off-chain quoter that justifies a
        // tighter bound. A future iteration computes the tick-aware
        // optimal lower bound and passes it through.
        const hash = await walletClient.writeContract({
            address: compounderAddress,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "compound",
            args: [tokenId, 0n, 0n],
            chain: ARC_CHAIN,
            account,
        });
        await onTxSubmitted({
            kind: "compound",
            position,
            hash,
            fee0,
            fee1,
            summary,
            publicClient,
        });
        return;
    }

    // NORMAL mode should never reach here because getActivePositions
    // filters them out, but defend in depth in case the SQL gets
    // edited in a way that breaks the invariant.
    summary.skipped++;
    summary.notes.push(`token=${position.tokenId} reason=mode-normal`);
}

interface SubmittedContext {
    kind: "compound" | "pushFees";
    position: CompounderPosition;
    hash: Hex;
    fee0: bigint;
    fee1: bigint;
    summary: RunSummary;
    publicClient: ReturnType<typeof createPublicClient>;
}

async function onTxSubmitted(ctx: SubmittedContext): Promise<void> {
    // Block until the receipt lands so we know whether to flip the DB
    // row to succeeded / failed. The Vercel function maxDuration is
    // 60s and Arc blocks are ~0.5s — even a 6-tx scan with one block
    // confirmation each stays under budget.
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash: ctx.hash,
    });

    const nowIso = new Date().toISOString();
    if (receipt.status === "success") {
        ctx.summary.triggered++;
        await stampLastAction(ctx.position.tokenId, nowIso);
        await insertEvent({
            tokenId: ctx.position.tokenId,
            eventType: ctx.kind === "compound" ? "Compounded" : "FeesPushed",
            amount0: ctx.fee0.toString(),
            amount1: ctx.fee1.toString(),
            txHash: ctx.hash,
            blockNumber: receipt.blockNumber.toString(),
        });
    } else {
        ctx.summary.failed++;
        await enqueueAction(ctx.position.tokenId, ctx.kind, {
            error: "tx-reverted",
            txHash: ctx.hash,
            blockNumber: receipt.blockNumber.toString(),
        });
    }
}
