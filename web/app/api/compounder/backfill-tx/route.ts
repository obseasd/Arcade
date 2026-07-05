import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    decodeEventLog,
    fallback,
    http,
    keccak256,
    toBytes,
    type Address,
    type Hex,
} from "viem";
import { AUTO_COMPOUNDER_ABI } from "@/lib/abis/autoCompounder";
import { ADDRESSES } from "@/lib/constants";
import { isDbConfigured } from "@/lib/db";
import { insertEvent, getPosition } from "@/lib/compounderPersistence";
import { quoteUsdcValueForPair } from "@/lib/compounderQuote";

/**
 * Single-tx Compounded event backfill.
 *
 * Bypass the getLogs range scan entirely: take a tx hash, fetch its
 * receipt directly, decode any Compounded / FeesPushed event in the
 * receipt, and call insertEvent. This is the bulletproof path for
 * healing one specific compound that the cron's keeper-path lost
 * (eg. quoteUsdcValueForPair threw before insertEvent landed) or that
 * the reconcile getLogs walker missed (eg. Arc public RPC returned a
 * flaky empty 200 for the right block range).
 *
 * Auth: same Bearer secret as the cron / reconcile routes.
 *
 * Usage:
 *   curl -X POST "https://.../api/compounder/backfill-tx?hash=0x7c28c52e..." \
 *     -H "Authorization: Bearer <COMPOUNDER_CRON_SECRET>"
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ARC_RPC_LIST: readonly string[] = [
    "https://5042002.rpc.thirdweb.com",
    "https://rpc.testnet.arc.network",
];

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

    const hash = req.nextUrl.searchParams.get("hash");
    if (!hash || !/^0x[a-fA-F0-9]{64}$/.test(hash)) {
        return NextResponse.json(
            { error: "hash query param required (0x + 64 hex chars)" },
            { status: 400 },
        );
    }

    if (!isDbConfigured()) {
        return NextResponse.json(
            { error: "Postgres not configured" },
            { status: 500 },
        );
    }

    const publicClient = createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(ARC_RPC_LIST.map((url) => http(url))),
    });

    let receipt;
    try {
        receipt = await publicClient.getTransactionReceipt({
            hash: hash as Hex,
        });
    } catch (err) {
        return NextResponse.json(
            {
                error: "getTransactionReceipt failed",
                detail: (err as { shortMessage?: string; message?: string })
                    ?.shortMessage ??
                    (err as { message?: string })?.message ??
                    String(err),
            },
            { status: 500 },
        );
    }

    if (receipt.status !== "success") {
        return NextResponse.json(
            { error: "tx did not succeed", status: receipt.status },
            { status: 400 },
        );
    }

    let chainBlockAtIso: string | null = null;
    try {
        const block = await publicClient.getBlock({
            blockNumber: receipt.blockNumber,
        });
        chainBlockAtIso = new Date(Number(block.timestamp) * 1000).toISOString();
    } catch {
        chainBlockAtIso = null;
    }

    const results: Array<{
        topic: string;
        eventName?: string;
        tokenId?: string;
        amount0?: string;
        amount1?: string;
        ok?: boolean;
        decodeError?: string;
        insertError?: string;
    }> = [];

    const compounderAddress = (ADDRESSES.autoCompounder as string).toLowerCase();
    for (const log of receipt.logs) {
        // Only trust Compounded/FeesPushed logs emitted BY the compounder.
        // Without this, anyone can deploy a contract that emits an identically-
        // shaped event in an unrelated tx and have the reconciler credit a
        // forged compound (mirror of the cron route's emitter gate).
        if (!log.address || log.address.toLowerCase() !== compounderAddress) continue;
        const topic0 = log.topics[0];
        if (!topic0) continue;
        if (topic0 !== TOPIC_COMPOUNDED && topic0 !== TOPIC_FEES_PUSHED) {
            continue;
        }
        const result: (typeof results)[number] = { topic: topic0 };
        try {
            const decoded = decodeEventLog({
                abi: AUTO_COMPOUNDER_ABI,
                data: log.data,
                topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
            });
            result.eventName = decoded.eventName;

            if (decoded.eventName === "Compounded") {
                const args = decoded.args as unknown as {
                    tokenId: bigint;
                    fee0Collected: bigint;
                    fee1Collected: bigint;
                    protocolFee0: bigint;
                    protocolFee1: bigint;
                };
                // LOW-3 / MEDIUM-1 (fee audit 2026-07-02): store NET fees
                // (Compounded emits gross + a separate protocol cut) and price
                // them in USDC so a backfilled row is not stuck at $0.
                const net0 =
                    args.fee0Collected > args.protocolFee0
                        ? args.fee0Collected - args.protocolFee0
                        : 0n;
                const net1 =
                    args.fee1Collected > args.protocolFee1
                        ? args.fee1Collected - args.protocolFee1
                        : 0n;
                result.tokenId = args.tokenId.toString();
                result.amount0 = net0.toString();
                result.amount1 = net1.toString();
                try {
                    const pos = await getPosition(args.tokenId.toString());
                    const usdValueMicros = await quoteUsdcValueForPair(
                        publicClient,
                        pos?.token0Address ?? null,
                        pos?.token1Address ?? null,
                        net0,
                        net1,
                    ).catch(() => 0n);
                    const ok = await insertEvent({
                        tokenId: args.tokenId.toString(),
                        eventType: "Compounded",
                        amount0: net0.toString(),
                        amount1: net1.toString(),
                        protocolFee0: args.protocolFee0.toString(),
                        protocolFee1: args.protocolFee1.toString(),
                        usdValueMicros: usdValueMicros.toString(),
                        txHash: hash,
                        blockNumber: receipt.blockNumber.toString(),
                        chainBlockAtIso,
                    });
                    result.ok = ok;
                } catch (err) {
                    result.insertError =
                        (err as { message?: string })?.message ??
                        String(err);
                }
            } else if (decoded.eventName === "FeesPushed") {
                const args = decoded.args as unknown as {
                    tokenId: bigint;
                    amount0: bigint;
                    amount1: bigint;
                    protocolFee0: bigint;
                    protocolFee1: bigint;
                };
                result.tokenId = args.tokenId.toString();
                result.amount0 = args.amount0.toString();
                result.amount1 = args.amount1.toString();
                try {
                    // FeesPushed amount0/amount1 are already net of the
                    // protocol cut; price them directly (MEDIUM-1).
                    const pos = await getPosition(args.tokenId.toString());
                    const usdValueMicros = await quoteUsdcValueForPair(
                        publicClient,
                        pos?.token0Address ?? null,
                        pos?.token1Address ?? null,
                        args.amount0,
                        args.amount1,
                    ).catch(() => 0n);
                    const ok = await insertEvent({
                        tokenId: args.tokenId.toString(),
                        eventType: "FeesPushed",
                        amount0: args.amount0.toString(),
                        amount1: args.amount1.toString(),
                        protocolFee0: args.protocolFee0.toString(),
                        protocolFee1: args.protocolFee1.toString(),
                        usdValueMicros: usdValueMicros.toString(),
                        txHash: hash,
                        blockNumber: receipt.blockNumber.toString(),
                        chainBlockAtIso,
                    });
                    result.ok = ok;
                } catch (err) {
                    result.insertError =
                        (err as { message?: string })?.message ??
                        String(err);
                }
            }
        } catch (err) {
            result.decodeError =
                (err as { message?: string })?.message ?? String(err);
        }
        results.push(result);
    }

    return NextResponse.json({
        hash,
        blockNumber: receipt.blockNumber.toString(),
        chainBlockAtIso,
        logsProcessed: results.length,
        results,
    });
}
