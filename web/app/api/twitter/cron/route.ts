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
import { ADDRESSES } from "@/lib/constants";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
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

    for (const intent of ready) {
        try {
            await handleIntent(
                intent,
                escrowAddress,
                publicClient,
                walletClient,
                account,
                summary,
            );
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

    return NextResponse.json({ ran: true, ...summary });
}

async function handleIntent(
    intent: ClaimIntent,
    escrowAddress: Address,
    publicClient: ReturnType<typeof createPublicClient>,
    walletClient: ReturnType<typeof createWalletClient>,
    account: ReturnType<typeof privateKeyToAccount>,
    summary: RunSummary,
): Promise<void> {
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
        return;
    }

    // pendingClaims returns a tuple. We only need a handful of fields
    // for the decision; the type is intentionally widened to readonly
    // unknown[] so a small ABI revision does not break the cron loudly.
    const tuple = onChain as readonly unknown[];
    const consumed = Boolean(tuple[6]);
    const vetoed = Boolean(tuple[7]);
    const executeAfter = BigInt(tuple[3] as bigint);
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
        return;
    }
    if (vetoed) {
        await markIntentResult(intent.nonce, {
            status: "failed",
            error: "on-chain vetoed",
        });
        summary.skipped++;
        summary.notes.push(`nonce=${intent.nonce} reason=vetoed`);
        return;
    }
    if (executeAfter > nowSec) {
        summary.skipped++;
        summary.notes.push(`nonce=${intent.nonce} reason=timelock-not-elapsed`);
        return;
    }

    // Mark claiming BEFORE submission so a duplicate cron run cannot
    // both fire claimByTwitter for the same nonce. The contract is
    // idempotent (claimByTwitter reverts on a consumed nonce) so the
    // worst case is one wasted gas estimate per duplicate, but
    // pre-stamping cuts that out.
    await markIntentResult(intent.nonce, {
        status: "claiming",
        error: null,
    });

    const hash = await walletClient.writeContract({
        address: escrowAddress,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "claimByTwitter",
        args: [intent.nonce as Hex],
        chain: ARC_CHAIN,
        account,
        maxFeePerGas: MAX_FEE_PER_GAS_WEI,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") {
        summary.triggered++;
        await markIntentResult(intent.nonce, {
            status: "succeeded",
            txHash: hash,
        });
        await stampLastClaim(intent.twitterHandle);
    } else {
        summary.failed++;
        await markIntentResult(intent.nonce, {
            status: "failed",
            txHash: hash,
            error: "tx-reverted",
        });
    }
}
