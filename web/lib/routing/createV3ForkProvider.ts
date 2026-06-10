import { Address, Hex } from "viem";
import { ADDRESSES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI } from "@/lib/abis/synthraV3";
import { UNIVERSAL_ROUTER_ABI } from "@/lib/abis/universalRouter";
import {
    encodeCommands,
    encodeV3Path,
    encodeV3SwapExactInInput,
    UR_COMMANDS,
} from "./universalRouter";
import {
    PROVIDER_META,
    ProviderId,
    QuoteRequest,
    RouteProvider,
    RouteQuote,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Audit A-2: provider factory for Uniswap V3 forks that share the
 * standard interfaces (Factory.getPool + QuoterV2.quoteExactInputSingle +
 * UniversalRouter + Permit2 metadata). synthraV3 and the future
 * unitflowV3 (once WUSDC wrap is verified) both implement the same call
 * shape with different addresses; this factory collapses the duplicate
 * ~140 LoC into a single config-driven path.
 *
 * Each fork still ships its own provider file as a thin export:
 *
 *   export const synthraV3Provider = createV3ForkProvider({
 *     id: "synthra-v3",
 *     factory: ADDRESSES.synthraFactory,
 *     quoter:  ADDRESSES.synthraQuoter,
 *     ur:      ADDRESSES.synthraUniversalRouter,
 *     feeTiers: SYNTHRA_V3_FEES,
 *     pivotToken: ADDRESSES.usdc, // optional through-USDC fallback
 *   });
 *
 * Adding a new V3 fork (BeraSwap-like, etc.) becomes ~10 lines.
 *
 * What the factory does NOT cover:
 *  - Native USDC <-> WUSDC wrap variants (WRAP_ETH command stream).
 *    That logic stays in unitflowV3.ts because it needs the
 *    msg.value semantics + decimal scaling specific to that fork's
 *    WUSDC contract. Once a fork verifies its wrap math the wrap
 *    config can land here as an optional field.
 *  - V2-style routers (XyloNet). Different ABI, different executor
 *    shape; gets its own helper.
 */

export interface V3ForkConfig {
    id: ProviderId;
    factory: Address;
    quoter: Address;
    /** UniversalRouter that will execute the swap via Permit2. */
    ur: Address;
    /** Fee tiers to enumerate. Standard V3: [100, 500, 3000, 10000]. */
    feeTiers: readonly number[];
    /**
     * Optional fallback pivot token (typically USDC). When provided and
     * direct (X -> Y) returns no pool, the provider tries a multi-hop
     * X -> pivot -> Y path via quoteExactInput.
     */
    pivotToken?: Address;
}

export function createV3ForkProvider(cfg: V3ForkConfig): RouteProvider {
    return {
        meta: PROVIDER_META[cfg.id],
        async quote(req, publicClient) {
            return v3ForkQuote(cfg, req, publicClient);
        },
    };
}

async function v3ForkQuote(
    cfg: V3ForkConfig,
    req: QuoteRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
): Promise<RouteQuote | null> {
    if (
        cfg.factory === ZERO_ADDRESS ||
        cfg.quoter === ZERO_ADDRESS ||
        cfg.ur === ZERO_ADDRESS
    ) {
        return null;
    }
    if (req.amountIn === 0n) return null;
    if (req.tokenIn.toLowerCase() === req.tokenOut.toLowerCase()) return null;

    // Step 1: fan-out pool discovery across all configured fee tiers.
    const poolChecks = cfg.feeTiers.map((fee) =>
        publicClient
            .readContract({
                address: cfg.factory,
                abi: SYNTHRA_FACTORY_ABI,
                functionName: "getPool",
                args: [req.tokenIn, req.tokenOut, fee],
            })
            .then((pool: Address) => ({ fee, ok: pool !== ZERO_ADDRESS }))
            .catch(() => ({ fee, ok: false })),
    );
    const pools = await Promise.all(poolChecks);
    const liveTiers = pools.filter((p) => p.ok);

    if (liveTiers.length === 0) {
        // Step 1b: optional through-pivot fallback.
        return cfg.pivotToken
            ? await pivotQuote(cfg, req, publicClient, cfg.pivotToken)
            : null;
    }

    // Step 2: parallel single-hop quotes, pick the largest amountOut.
    const quoteCalls = liveTiers.map((p) =>
        publicClient
            .readContract({
                address: cfg.quoter,
                abi: SYNTHRA_QUOTER_ABI,
                functionName: "quoteExactInputSingle",
                args: [
                    {
                        tokenIn: req.tokenIn,
                        tokenOut: req.tokenOut,
                        amountIn: req.amountIn,
                        fee: p.fee,
                        sqrtPriceLimitX96: 0n,
                    },
                ],
            })
            .then((result: readonly unknown[]) => ({
                fee: p.fee,
                amountOut: result[0] as bigint,
            }))
            .catch(() => ({ fee: p.fee, amountOut: 0n })),
    );
    const quotes = await Promise.all(quoteCalls);
    let best = quotes[0];
    for (const q of quotes) if (q.amountOut > best.amountOut) best = q;
    if (best.amountOut === 0n) return null;

    // Step 3: build executor with UR + Permit2.
    const amountOutMinimum =
        (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
    const path: Hex = encodeV3Path([
        { token: req.tokenIn },
        { token: req.tokenOut, fee: best.fee },
    ]);
    return buildExecutor(cfg, req, best.amountOut, amountOutMinimum, path, best.fee, undefined);
}

async function pivotQuote(
    cfg: V3ForkConfig,
    req: QuoteRequest,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    pivot: Address,
): Promise<RouteQuote | null> {
    if (
        pivot === ZERO_ADDRESS ||
        req.tokenIn.toLowerCase() === pivot.toLowerCase() ||
        req.tokenOut.toLowerCase() === pivot.toLowerCase()
    ) {
        return null;
    }
    // Fan-out both legs in parallel.
    const fanOut = cfg.feeTiers.flatMap((fee) => [
        publicClient
            .readContract({
                address: cfg.factory,
                abi: SYNTHRA_FACTORY_ABI,
                functionName: "getPool",
                args: [req.tokenIn, pivot, fee],
            })
            .then((pool: Address) => ({ leg: "in" as const, fee, ok: pool !== ZERO_ADDRESS }))
            .catch(() => ({ leg: "in" as const, fee, ok: false })),
        publicClient
            .readContract({
                address: cfg.factory,
                abi: SYNTHRA_FACTORY_ABI,
                functionName: "getPool",
                args: [pivot, req.tokenOut, fee],
            })
            .then((pool: Address) => ({ leg: "out" as const, fee, ok: pool !== ZERO_ADDRESS }))
            .catch(() => ({ leg: "out" as const, fee, ok: false })),
    ]);
    const results = await Promise.all(fanOut);
    const inFees = results.filter((r) => r.leg === "in" && r.ok).map((r) => r.fee);
    const outFees = results.filter((r) => r.leg === "out" && r.ok).map((r) => r.fee);
    if (inFees.length === 0 || outFees.length === 0) return null;

    const combos = inFees.flatMap((i) => outFees.map((o) => ({ inFee: i, outFee: o })));
    const quoteCalls = combos.map(({ inFee, outFee }) => {
        const path = encodeV3Path([
            { token: req.tokenIn },
            { token: pivot, fee: inFee },
            { token: req.tokenOut, fee: outFee },
        ]);
        return publicClient
            .readContract({
                address: cfg.quoter,
                abi: SYNTHRA_QUOTER_ABI,
                functionName: "quoteExactInput",
                args: [path, req.amountIn],
            })
            .then((result: readonly unknown[]) => ({
                inFee,
                outFee,
                path,
                amountOut: result[0] as bigint,
            }))
            .catch(() => ({ inFee, outFee, path, amountOut: 0n }));
    });
    const quotes = await Promise.all(quoteCalls);
    let best = quotes[0];
    for (const q of quotes) if (q.amountOut > best.amountOut) best = q;
    if (best.amountOut === 0n) return null;

    const amountOutMinimum =
        (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
    return buildExecutor(cfg, req, best.amountOut, amountOutMinimum, best.path, best.outFee, "via " + truncateAddress(pivot));
}

function buildExecutor(
    cfg: V3ForkConfig,
    req: QuoteRequest,
    amountOut: bigint,
    amountOutMinimum: bigint,
    path: Hex,
    feeForLabel: number,
    pathLabelOverride: string | undefined,
): RouteQuote {
    const commands = encodeCommands([
        UR_COMMANDS.PERMIT2_PERMIT,
        UR_COMMANDS.V3_SWAP_EXACT_IN,
    ]);
    const swapInput = encodeV3SwapExactInInput({
        recipient: req.recipient,
        amountIn: req.amountIn,
        amountOutMin: amountOutMinimum,
        path,
        payerIsUser: true,
    });
    const executor: RouteQuote["executor"] = {
        router: cfg.ur,
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [commands, ["0x" as Hex, swapInput], req.deadline],
    };
    return {
        provider: cfg.id,
        amountOut,
        fee: feeForLabel,
        pathLabel:
            pathLabelOverride ?? `${(feeForLabel / 10_000).toFixed(2)}% pool`,
        approval: {
            token: req.tokenIn,
            // Permit2 canonical
            spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
            amount: req.amountIn,
        },
        executor,
        permit2: { permitSpender: cfg.ur, permitInputIndex: 0 },
    };
}

function truncateAddress(a: Address): string {
    return `${a.slice(0, 6)}…`;
}

// Re-export so tests can stub the inner helpers.
export { v3ForkQuote, pivotQuote, ADDRESSES };
