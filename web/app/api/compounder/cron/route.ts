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

// Audit H3 fix: dropped from 25 to 6 to match the per-tx-confirmation
// budget the author's own doc-comment admitted. Per-action cost on Arc
// is ~5s (1 simulation read + 1 write + 1.5s receipt + 4-tier × 2-leg
// quoter fan-out, with H3 batch parallel = ~3s instead of ~8). At 6
// positions × 5s = 30s, well inside the 60s function ceiling with
// slack for cold-start + DB round-trips. With a 5-minute cron cadence
// we can process 6 × 12 = 72 positions/hour — enough for any
// realistic testnet load.
const MAX_POSITIONS_PER_RUN = 6;

// Audit H3 + I8 fix: every RPC read gets a per-call timeout via
// AbortController so a single slow eth_call cannot push the whole
// sweep past the 60s function ceiling. 3s matches the observed Arc
// p99 latency for a single readContract; bumping past that means
// somebody else's RPC issue cost us the budget for an honest action.
const RPC_TIMEOUT_MS = 3_000;

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

/** Run a promise under a hard timeout. Returns null on timeout (the
 *  caller is expected to treat null as "skip this leg / pool" and
 *  carry on with the rest of the sweep). Implemented with
 *  Promise.race so the underlying RPC call keeps running in the
 *  background and contributes to the next free RPC slot; that is
 *  cheaper than tearing down the viem transport per call. */
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
        // Audit H1 fix: derive amount0Min / amount1Min off-chain
        // before submitting the real tx. The contract stores
        // cfg.maxSlippageBps but never reads it (see findings H1 +
        // L1), so the only protection against MEV on the cron's
        // compound() comes from the cron itself passing tight mins.
        // Strategy: eth_call (simulateContract) compound(tokenId,
        // 0, 0) to learn the (amount0Used, amount1Used) the pool
        // would actually consume, then apply the position's
        // configured slippage to derive a floor. simulateContract
        // is a free read — no gas spent, no state change — but it
        // does dry-run the underlying NPM.collect + increaseLiquidity
        // sequence so the returned amounts match what the real tx
        // will execute against the same block state.
        //
        // Failure mode: if the simulation reverts (pool moved past
        // a tick boundary between the scanner's pendingFees read
        // and now, or the position is empty), we skip this tick
        // rather than submit a guaranteed-revert tx. The next 5-min
        // tick re-tries against fresh state.
        const slippageBps = BigInt(
            Math.max(0, Math.min(10_000, position.maxSlippageBps ?? 50)),
        );

        type CompoundSim = readonly [bigint, bigint, bigint];
        const sim = await withTimeout(
            publicClient
                .simulateContract({
                    address: compounderAddress,
                    abi: AUTO_COMPOUNDER_ABI,
                    functionName: "compound",
                    args: [tokenId, 0n, 0n],
                    account,
                })
                .then((r) => r.result as CompoundSim)
                .catch(() => null as CompoundSim | null),
            RPC_TIMEOUT_MS,
        );

        if (!sim) {
            summary.skipped++;
            summary.notes.push(
                `token=${position.tokenId} reason=sim-failed-or-timed-out`,
            );
            return;
        }

        // sim = [liquidityAdded, amount0Used, amount1Used]
        const amount0Used = sim[1];
        const amount1Used = sim[2];
        const amount0Min = (amount0Used * (10_000n - slippageBps)) / 10_000n;
        const amount1Min = (amount1Used * (10_000n - slippageBps)) / 10_000n;

        const hash = await walletClient.writeContract({
            address: compounderAddress,
            abi: AUTO_COMPOUNDER_ABI,
            functionName: "compound",
            args: [tokenId, amount0Min, amount1Min],
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
        // Audit H2 fix: compute the USDC-equivalent of fee0 + fee1 via
        // the V3 quoter so the dashboard's "Total claimed" headline is
        // a live number instead of the dead 0 the column shipped with
        // for every event ever written. The same quoter the swap UI
        // uses handles arbitrary V3 fee tiers (see arcadeV3Provider),
        // and the failure mode is intentionally permissive: any
        // quoting error contributes 0 to the sum so the metric
        // undercounts honestly rather than refusing to write the row.
        const usdValueMicros = await quoteUsdcValueForPair(
            ctx.publicClient,
            ctx.position.token0Address,
            ctx.position.token1Address,
            ctx.fee0,
            ctx.fee1,
        );
        await insertEvent({
            tokenId: ctx.position.tokenId,
            eventType: ctx.kind === "compound" ? "Compounded" : "FeesPushed",
            amount0: ctx.fee0.toString(),
            amount1: ctx.fee1.toString(),
            usdValueMicros: usdValueMicros.toString(),
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

// Minimal V3 quoter ABI used to price each fee leg in USDC. We do not
// import the full V3 ABI module here because the cron route stays
// node-runtime-only and the route-handler bundle should not pull the
// whole client-side router into the serverless package.
const QUOTER_ABI = [
    {
        type: "function",
        name: "quoteExactInputSingle",
        stateMutability: "nonpayable",
        inputs: [
            { name: "tokenIn", type: "address" },
            { name: "tokenOut", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "amountIn", type: "uint256" },
        ],
        outputs: [{ name: "amountOut", type: "uint256" }],
    },
] as const;

const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Return the USDC-equivalent micros of (amount0 of token0) + (amount1
 *  of token1). When a leg's input token IS USDC, no quote is needed —
 *  the amount maps 1:1 into the sum. For non-USDC legs we fan out the
 *  arcade-v3 quoter across every standard fee tier and take the
 *  highest non-zero quote. A leg that has no quotable route at any
 *  tier contributes 0; the row is still written so the UI never sees
 *  a missing event but the headline metric undercounts honestly.
 *
 *  Audit H3 fix: both legs run in parallel via Promise.all, and
 *  inside quoteLegToUsdc the 4-tier fan-out also runs in parallel.
 *  Previous sequential implementation took ~4 × 500ms × 2 legs =
 *  ~4s per position, which combined with the 25-position cap
 *  (since reduced to 6) pushed every run past the 60s function
 *  ceiling. Parallel fan-out is one slowest-RPC-latency per
 *  position instead, recovering ~3s of the budget. */
async function quoteUsdcValueForPair(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    token0Address: string | null,
    token1Address: string | null,
    fee0: bigint,
    fee1: bigint,
): Promise<bigint> {
    const usdc = ADDRESSES.usdc as Address;
    if (!usdc || usdc === "0x0000000000000000000000000000000000000000") return 0n;
    const quoter = ADDRESSES.v3Quoter as Address;
    if (!quoter || quoter === "0x0000000000000000000000000000000000000000") return 0n;

    const [leg0Micros, leg1Micros] = await Promise.all([
        quoteLegToUsdc(
            publicClient,
            quoter,
            usdc,
            token0Address as Address | null,
            fee0,
        ),
        quoteLegToUsdc(
            publicClient,
            quoter,
            usdc,
            token1Address as Address | null,
            fee1,
        ),
    ]);
    return leg0Micros + leg1Micros;
}

async function quoteLegToUsdc(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    quoter: Address,
    usdc: Address,
    token: Address | null,
    amount: bigint,
): Promise<bigint> {
    if (amount === 0n) return 0n;
    if (!token || token === "0x0000000000000000000000000000000000000000") return 0n;
    if (token.toLowerCase() === usdc.toLowerCase()) return amount;
    // H3 inner fan-out also parallel: each tier resolves to (amount or
    // null), Math.max(...) picks the winner. Failed tiers contribute 0
    // via withTimeout fall-through so a slow RPC for one tier can never
    // hold up the whole leg.
    const tierResults: bigint[] = await Promise.all(
        V3_FEE_TIERS.map(async (tier): Promise<bigint> => {
            const raw = await withTimeout<bigint>(
                publicClient
                    .readContract({
                        address: quoter,
                        abi: QUOTER_ABI,
                        functionName: "quoteExactInputSingle",
                        args: [token, usdc, tier, amount],
                    })
                    .then((v: unknown) => v as bigint)
                    .catch((): bigint => 0n),
                RPC_TIMEOUT_MS,
            );
            return raw ?? 0n;
        }),
    );
    let best = 0n;
    for (const r of tierResults) if (r > best) best = r;
    return best;
}

