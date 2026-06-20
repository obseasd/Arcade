import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    http,
    isAddress,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES } from "@/lib/constants";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import {
    MULTICALL3_ADDRESS,
    MULTICALL3_AGGREGATE3_ABI,
} from "@/lib/multicall3";
import { isDbConfigured } from "@/lib/db";
import {
    getReadyClaimIntents,
    markIntentResult,
    stampLastClaim,
    type ClaimIntent,
} from "@/lib/twitterEscrowPersistence";

/**
 * Twitter Escrow auto-claim cron.
 *
 * Flow:
 *   1. /api/twitter-callback signs an EIP-712 claim and stores a
 *      pending row in twitter_claim_intents.
 *   2. User signs authorize(claim, sig) on chain. A reconcile worker
 *      (future) or the manual /claim page flips the DB row to status
 *      'authorized' and stamps execute_after from the contract.
 *   3. This cron walks status='authorized' rows whose execute_after
 *      is past, AND whose @handle has a non-revoked OAuth link, AND
 *      fires claimByTwitter(nonce) via the operator wallet. The user
 *      receives the USDC + clankerToken in their wallet WITHOUT
 *      paying gas for the claim itself — the operator pays.
 *
 * The contract's authorize() requires recipient == msg.sender so the
 * keeper cannot bypass that gate. Once authorized, however,
 * claimByTwitter is permissionless and the cron settles every ready
 * intent without further user signature.
 *
 * Auth: same Bearer secret as the Compounder cron
 * (COMPOUNDER_CRON_SECRET) so the operator manages a single rotation
 * surface. The token covers /api/compounder/cron, /api/compounder/reconcile,
 * AND /api/twitter/cron.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_INTENTS_PER_RUN = 6;
const RPC_TIMEOUT_MS = 3_000;
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n; // 100 gwei (audit I8 pattern)
const MIN_OPERATOR_BALANCE_WEI = 1_000_000n; // 1 USDC

// Dedicated provider URL via NEXT_PUBLIC_ARC_RPC_URL (Alchemy / thirdweb)
// prepended to the fallback list so the auto-claim cron stops competing
// with the rest of the app for public-RPC bandwidth.
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

    const escrowAddress = ADDRESSES.twitterEscrow as Address;
    if (!isAddress(escrowAddress, { strict: false })) {
        return NextResponse.json(
            { ran: false, reason: "NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS not configured" },
            { status: 200 },
        );
    }
    const operatorKey = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as
        | Hex
        | undefined;
    // Audit 2026-06-18b M-26: validate the full 0x + 64-hex shape so a
    // malformed key returns a clear reason instead of a cryptic
    // privateKeyToAccount throw mid-request.
    if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) {
        return NextResponse.json(
            { ran: false, reason: "COMPOUNDER_OPERATOR_PRIVATE_KEY missing or malformed" },
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

    // Same low-balance circuit breaker as the Compounder cron.
    const operatorBalance = await publicClient.getBalance({
        address: account.address,
    });
    if (operatorBalance < MIN_OPERATOR_BALANCE_WEI) {
        return NextResponse.json(
            {
                ran: false,
                reason: "Operator balance below threshold — refill USDC",
                balance: operatorBalance.toString(),
                threshold: MIN_OPERATOR_BALANCE_WEI.toString(),
            },
            { status: 503 },
        );
    }

    const ready = await getReadyClaimIntents(MAX_INTENTS_PER_RUN);
    const summary: RunSummary = {
        scanned: ready.length,
        triggered: 0,
        skipped: 0,
        failed: 0,
        notes: [],
    };

    // Phase 1 — pre-flight each intent (on-chain pendingClaims read +
    // consumed/vetoed/timelock gates + pre-stamp "claiming"). Collect the
    // nonces that are actually claimable.
    const eligible: ClaimIntent[] = [];
    for (const intent of ready) {
        try {
            const ok = await prepareIntent(
                intent,
                escrowAddress,
                publicClient,
                summary,
            );
            if (ok) eligible.push(intent);
        } catch (err) {
            summary.failed++;
            const msg = err instanceof Error ? err.message : String(err);
            summary.notes.push(`nonce=${intent.nonce} error=${msg}`);
            await markIntentResult(intent.nonce, {
                status: "failed",
                error: msg.slice(0, 500),
            });
        }
    }

    // Phase 2 — batch ALL eligible claimByTwitter into ONE transaction via
    // the standard Multicall3 (claimByTwitter is permissionless, so the
    // multicall being msg.sender is fine). allowFailure:true so a single
    // nonce that became stale between phase 1 and execution doesn't sink
    // every other user's claim.
    if (eligible.length > 0) {
        const calls = eligible.map((it) => ({
            target: escrowAddress,
            allowFailure: true,
            callData: encodeFunctionData({
                abi: TWITTER_ESCROW_V3_ABI,
                functionName: "claimByTwitter",
                args: [it.nonce as Hex],
            }),
        }));
        let batchHash: Hex | null = null;
        try {
            batchHash = await walletClient.writeContract({
                address: MULTICALL3_ADDRESS,
                abi: MULTICALL3_AGGREGATE3_ABI,
                functionName: "aggregate3",
                args: [calls],
                chain: ARC_CHAIN,
                account,
                maxFeePerGas: MAX_FEE_PER_GAS_WEI,
            });
            await publicClient.waitForTransactionReceipt({ hash: batchHash });
        } catch (err) {
            // The batch tx failed to submit/confirm. Leave the intents
            // pre-stamped "claiming"; the next run re-reads pendingClaims
            // and retries (claimByTwitter is idempotent on consumed nonces).
            const msg = err instanceof Error ? err.message : String(err);
            summary.notes.push(`batch-submit error=${msg}`);
        }

        // Phase 3 — settle the DB per nonce from on-chain truth. The
        // Claimed event carries no nonce, so `consumed == true` is the
        // authoritative per-nonce success signal (an allowFailure subcall
        // that reverted leaves the nonce unconsumed).
        for (const it of eligible) {
            const onChain = await withTimeout(
                publicClient.readContract({
                    address: escrowAddress,
                    abi: TWITTER_ESCROW_V3_ABI,
                    functionName: "pendingClaims",
                    args: [it.nonce as Hex],
                }),
                RPC_TIMEOUT_MS,
            );
            const consumed = onChain
                ? Boolean((onChain as readonly unknown[])[9])
                : false;
            if (consumed) {
                summary.triggered++;
                await markIntentResult(it.nonce, {
                    status: "succeeded",
                    txHash: batchHash,
                });
                await stampLastClaim(it.twitterHandle);
            } else {
                summary.failed++;
                await markIntentResult(it.nonce, {
                    status: "failed",
                    txHash: batchHash,
                    error: "claim-not-consumed-after-batch",
                });
            }
        }
    }

    return NextResponse.json({ ran: true, ...summary });
}

/**
 * Pre-flight a single intent: read on-chain pendingClaims, apply the
 * consumed/vetoed/timelock gates, and (for claimable ones) pre-stamp the
 * DB row "claiming". Returns true when the nonce should be included in the
 * batched claimByTwitter, false when it was skipped/settled here. The
 * actual claim + DB settle happen in the batched phases of the POST
 * handler — this function never submits a transaction.
 */
async function prepareIntent(
    intent: ClaimIntent,
    escrowAddress: Address,
    publicClient: ReturnType<typeof createPublicClient>,
    summary: RunSummary,
): Promise<boolean> {
    // Pre-flight: read the on-chain pendingClaims[nonce]. If executeAfter
    // > now OR claimed flag is set OR consumed, we skip without burning
    // gas. Also handles the "DB thinks authorized but chain doesn't"
    // race window — the DB row is just a hint; the contract is truth.
    const onChain = await withTimeout(
        publicClient.readContract({
            address: escrowAddress,
            abi: TWITTER_ESCROW_V3_ABI,
            functionName: "pendingClaims",
            args: [intent.nonce as Hex],
        }),
        RPC_TIMEOUT_MS,
    );
    if (!onChain) {
        summary.skipped++;
        summary.notes.push(`nonce=${intent.nonce} reason=onchain-read-timeout`);
        return false;
    }

    // pendingClaims returns the tuple defined by the ABI (see
    // web/lib/abis/twitterEscrowV3.ts):
    //   [0] recipient (address)
    //   [1] pairedToken (address)
    //   [2] pairedAmount (uint256)
    //   [3] clankerToken (address)
    //   [4] clankerAmount (uint256)
    //   [5] positionId (uint256)
    //   [6] slotIndex (uint256)
    //   [7] executeAfter (uint256)
    //   [8] deadline (uint256)
    //   [9] consumed (bool)
    //   [10] vetoed (bool)
    //
    // Audit 2026-06-18 H-14: previous code read [6] as consumed, [7] as
    // vetoed, [3] as executeAfter — i.e. it was reading slotIndex,
    // executeAfter, clankerToken instead. slotIndex is almost always
    // non-zero so `consumed` was effectively always true, the cron
    // stamped every intent as "succeeded" and never called
    // claimByTwitter. Auto-claim was silently dead since ship. Indices
    // now derive directly from the ABI order above.
    const tuple = onChain as readonly unknown[];
    const executeAfter = BigInt(tuple[7] as bigint);
    const consumed = Boolean(tuple[9]);
    const vetoed = Boolean(tuple[10]);
    const nowSec = BigInt(Math.floor(Date.now() / 1000));

    if (consumed) {
        // Already claimed — mark stale row as succeeded so the cron
        // does not waste time on it again.
        await markIntentResult(intent.nonce, {
            status: "succeeded",
            error: null,
        });
        summary.skipped++;
        summary.notes.push(`nonce=${intent.nonce} reason=already-consumed`);
        return false;
    }
    if (vetoed) {
        await markIntentResult(intent.nonce, {
            status: "failed",
            error: "on-chain vetoed",
        });
        summary.skipped++;
        summary.notes.push(`nonce=${intent.nonce} reason=vetoed`);
        return false;
    }
    if (executeAfter > nowSec) {
        summary.skipped++;
        summary.notes.push(`nonce=${intent.nonce} reason=timelock-not-elapsed`);
        return false;
    }

    // Mark claiming BEFORE the batch so a duplicate cron run cannot queue
    // the same nonce twice. claimByTwitter is idempotent (reverts on a
    // consumed nonce) and the batch uses allowFailure, so a duplicate is
    // harmless — pre-stamping just avoids the wasted slot.
    await markIntentResult(intent.nonce, {
        status: "claiming",
        error: null,
    });
    return true;
}
