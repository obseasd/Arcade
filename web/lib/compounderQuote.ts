import type { Address } from "viem";
import { ADDRESSES } from "@/lib/constants";

/**
 * USDC-equivalent quoting for compounder fee amounts, shared by the main
 * cron (which writes event rows right after it submits a tx) and the
 * reconcile worker (which heals rows the cron failed to write).
 *
 * Extracted from the cron route so BOTH writers compute the same
 * usd_value_micros. Previously the reconcile / backfill routes inserted
 * events with no USD value (defaulting to 0), so any Compounded / FeesPushed
 * row first written by the reconciler contributed $0 to the creator's
 * "Total claimed" USD headline forever (fee audit 2026-07-02 MEDIUM-1).
 *
 * Every RPC call falls back to 0 on failure so a quoting hiccup can never
 * erase or block an event write; the authoritative datum is the raw token
 * amount, the USD figure is a best-effort convenience.
 */

const RPC_TIMEOUT_MS = 3_000;

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

const ZERO = "0x0000000000000000000000000000000000000000";

async function quoteLegToUsdc(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    quoter: Address,
    usdc: Address,
    token: Address | null,
    amount: bigint,
): Promise<bigint> {
    if (amount === 0n) return 0n;
    if (!token || token === ZERO) return 0n;
    if (token.toLowerCase() === usdc.toLowerCase()) return amount;
    // Fan out across every fee tier in parallel; each tier resolves to
    // (amount or 0) and Math.max picks the winner. A failed / slow tier
    // contributes 0 via withTimeout fall-through so it can never hold up
    // the whole leg.
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

/**
 * USDC-micros value of a (fee0, fee1) pair for a position whose two sides
 * are token0Address / token1Address. Returns 0 when USDC or the V3 quoter
 * is unconfigured, or when both legs fail to quote.
 */
export async function quoteUsdcValueForPair(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    token0Address: string | null,
    token1Address: string | null,
    fee0: bigint,
    fee1: bigint,
): Promise<bigint> {
    const usdc = ADDRESSES.usdc as Address;
    if (!usdc || usdc === ZERO) return 0n;
    const quoter = ADDRESSES.v3Quoter as Address;
    if (!quoter || quoter === ZERO) return 0n;

    const [leg0Micros, leg1Micros] = await Promise.all([
        quoteLegToUsdc(publicClient, quoter, usdc, token0Address as Address | null, fee0),
        quoteLegToUsdc(publicClient, quoter, usdc, token1Address as Address | null, fee1),
    ]);
    return leg0Micros + leg1Micros;
}
