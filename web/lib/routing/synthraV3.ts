import { Address, Hex } from "viem";
import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI } from "@/lib/abis/synthraV3";
import { UNIVERSAL_ROUTER_ABI } from "@/lib/abis/universalRouter";
import {
    encodeCommands,
    encodePermit2PermitInput,
    encodeV3Path,
    encodeV3SwapExactInInput,
    UR_COMMANDS,
} from "./universalRouter";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * Synthra V3 provider — vanilla Uniswap V3 fork at
 * `ADDRESSES.synthra*`. Quote logic walks the standard 4 fee tiers via
 * Factory.getPool, then quotes survivors in parallel via QuoterV2 and
 * picks the largest amountOut.
 *
 * Execution path: Universal Router + Permit2 (instead of the legacy
 * SwapRouter02 + per-router approve). The user approves USDC to Permit2
 * ONE TIME EVER; per-swap they sign an EIP-712 PermitSingle authorising
 * the Universal Router for that exact amount. The UR's PERMIT2_PERMIT
 * command consumes the signature and the V3_SWAP_EXACT_IN command does
 * the swap inline.
 *
 * Saves a separate `approve` tx per route switch and matches Tower /
 * Uniswap modern UX (single-tap swap once Permit2 is approved). The
 * `permit2` metadata on the returned RouteQuote tells the SwapCard to
 * (a) check / prompt the one-time Permit2 approval, (b) sign the
 * permit, (c) inject the signature into the executor args.
 */
export const synthraV3Provider: RouteProvider = {
    meta: PROVIDER_META["synthra-v3"],

    async quote(req, publicClient) {
        if (
            ADDRESSES.synthraFactory === ZERO_ADDRESS ||
            ADDRESSES.synthraQuoter === ZERO_ADDRESS ||
            ADDRESSES.synthraUniversalRouter === ZERO_ADDRESS
        ) {
            return null;
        }
        if (req.amountIn === 0n) return null;

        // 1. Pool discovery across all 4 fee tiers in parallel.
        const poolChecks = SYNTHRA_V3_FEES.map((fee) =>
            publicClient
                .readContract({
                    address: ADDRESSES.synthraFactory,
                    abi: SYNTHRA_FACTORY_ABI,
                    functionName: "getPool",
                    args: [req.tokenIn, req.tokenOut, fee],
                })
                .then((pool: Address) => ({ fee, pool, ok: pool !== ZERO_ADDRESS }))
                .catch(() => ({ fee, pool: ZERO_ADDRESS as Address, ok: false })),
        );
        const pools = await Promise.all(poolChecks);
        const liveTiers = pools.filter((p) => p.ok);
        if (liveTiers.length === 0) return null;

        // 2. Parallel quoting via QuoterV2.quoteExactInputSingle.
        const quoteCalls = liveTiers.map((p) =>
            publicClient
                .readContract({
                    address: ADDRESSES.synthraQuoter,
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

        const amountOutMinimum =
            (best.amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

        // 3. Build Universal Router commands + inputs:
        //    [PERMIT2_PERMIT, V3_SWAP_EXACT_IN]
        // PERMIT2_PERMIT input is a placeholder ("0x") — the SwapCard
        // rewrites it after signing the PermitSingle. V3_SWAP_EXACT_IN
        // uses payerIsUser=true so the router pulls via Permit2 (which
        // it does using the just-installed allowance from PERMIT2_PERMIT).
        const path: Hex = encodeV3Path([
            { token: req.tokenIn },
            { token: req.tokenOut, fee: best.fee },
        ]);
        const commands = encodeCommands([
            UR_COMMANDS.PERMIT2_PERMIT,
            UR_COMMANDS.V3_SWAP_EXACT_IN,
        ]);
        const permitPlaceholder: Hex = "0x";
        const swapInput = encodeV3SwapExactInInput({
            recipient: req.recipient,
            amountIn: req.amountIn,
            amountOutMin: amountOutMinimum,
            path,
            payerIsUser: true,
        });

        const executor: RouteQuote["executor"] = {
            router: ADDRESSES.synthraUniversalRouter,
            abi: UNIVERSAL_ROUTER_ABI,
            functionName: "execute",
            args: [commands, [permitPlaceholder, swapInput], req.deadline],
        };

        return {
            provider: "synthra-v3",
            amountOut: best.amountOut,
            fee: best.fee,
            pathLabel: `${(best.fee / 10_000).toFixed(2)}% pool`,
            approval: {
                // The user-facing approval is now to Permit2, not the
                // router. SwapCard does this once and reuses across all
                // Permit2-aware routes.
                token: req.tokenIn,
                spender: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
                amount: req.amountIn,
            },
            executor,
            permit2: {
                permitSpender: ADDRESSES.synthraUniversalRouter,
                permitInputIndex: 0,
            },
        };
    },
};
