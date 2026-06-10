import { Address, Hex } from "viem";
import { ADDRESSES, SYNTHRA_V3_FEES } from "@/lib/constants";
import { SYNTHRA_FACTORY_ABI, SYNTHRA_QUOTER_ABI } from "@/lib/abis/synthraV3";
import { UNIVERSAL_ROUTER_ABI } from "@/lib/abis/universalRouter";
import {
    encodeCommands,
    encodeSweepInput,
    encodeUnwrapWethInput,
    encodeV3Path,
    encodeV3SwapExactInInput,
    encodeWrapEthInput,
    UR_COMMANDS,
    UR_CONSTANTS,
} from "./universalRouter";
import { PROVIDER_META, RouteProvider, RouteQuote } from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * UnitFlow V3 provider — Uniswap V3 fork. All pools route through
 * Wrapped USDC (`ADDRESSES.wusdc`, 18 dec), so a swap with native Arc
 * USDC on either side needs to wrap or unwrap atomically. Universal
 * Router makes this a single tx by chaining commands.
 *
 * Three execution shapes depending on which side is native USDC:
 *
 *   USDC -> X (USDC in, X out)
 *     [WRAP_ETH] (msg.value -> WUSDC held by router)
 *     [V3_SWAP_EXACT_IN] (WUSDC -> X, payerIsUser=false because router holds WUSDC)
 *     [SWEEP] (push X to user)
 *
 *   X -> USDC (X in, USDC out)
 *     [PERMIT2_PERMIT + V3_SWAP_EXACT_IN to router] (X -> WUSDC stays in router)
 *     [UNWRAP_WETH] (WUSDC -> native USDC, sweep to user)
 *
 *   X -> Y (neither side is native USDC)
 *     [PERMIT2_PERMIT + V3_SWAP_EXACT_IN to user]
 *
 * The WRAP_ETH variant takes msg.value rather than Permit2 — the user
 * sends amountIn worth of native USDC with the execute() call. The
 * other two variants need a Permit2 signature.
 */

interface QuoteResult {
    fee: number;
    amountOut: bigint;
}

async function bestQuote(
    publicClient: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
): Promise<QuoteResult | null> {
    const poolChecks = SYNTHRA_V3_FEES.map((fee) =>
        publicClient
            .readContract({
                address: ADDRESSES.unitflowFactory,
                abi: SYNTHRA_FACTORY_ABI,
                functionName: "getPool",
                args: [tokenIn, tokenOut, fee],
            })
            .then((pool: Address) => ({ fee, pool, ok: pool !== ZERO_ADDRESS }))
            .catch(() => ({ fee, pool: ZERO_ADDRESS as Address, ok: false })),
    );
    const pools = await Promise.all(poolChecks);
    const live = pools.filter((p) => p.ok);
    if (live.length === 0) return null;

    const quoteCalls = live.map((p) =>
        publicClient
            .readContract({
                address: ADDRESSES.unitflowQuoter,
                abi: SYNTHRA_QUOTER_ABI,
                functionName: "quoteExactInputSingle",
                args: [
                    {
                        tokenIn,
                        tokenOut,
                        amountIn,
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
    return best;
}

export const unitflowV3Provider: RouteProvider = {
    meta: PROVIDER_META["unitflow-v3"],

    async quote(req, publicClient) {
        if (
            ADDRESSES.unitflowFactory === ZERO_ADDRESS ||
            ADDRESSES.unitflowQuoter === ZERO_ADDRESS ||
            ADDRESSES.unitflowUniversalRouter === ZERO_ADDRESS ||
            ADDRESSES.wusdc === ZERO_ADDRESS
        ) {
            return null;
        }
        if (req.amountIn === 0n) return null;

        const isUsdc = (a: Address) =>
            a.toLowerCase() === ADDRESSES.usdc.toLowerCase();
        const inIsUsdc = isUsdc(req.tokenIn);
        const outIsUsdc = isUsdc(req.tokenOut);

        // Substitute USDC -> WUSDC for the pool query (UnitFlow pools
        // are WUSDC-keyed even when the user-facing token is native USDC).
        const quoteTokenIn = inIsUsdc ? ADDRESSES.wusdc : req.tokenIn;
        const quoteTokenOut = outIsUsdc ? ADDRESSES.wusdc : req.tokenOut;
        if (quoteTokenIn.toLowerCase() === quoteTokenOut.toLowerCase()) {
            // USDC <-> USDC is a no-op via UnitFlow; let the wrap/unwrap
            // contract handle it elsewhere.
            return null;
        }

        // Scale amountIn: native USDC is 6-dec, WUSDC is 18-dec. When
        // wrapping the user's USDC, the resulting WUSDC has 12 more dec
        // of precision. The Quoter expects amounts in the token's own
        // decimals, so for USDC-in routes we quote at (amountIn * 1e12).
        const quotedAmountIn = inIsUsdc
            ? req.amountIn * 10n ** 12n
            : req.amountIn;
        const best = await bestQuote(
            publicClient,
            quoteTokenIn,
            quoteTokenOut,
            quotedAmountIn,
        );
        if (!best) return null;

        // Same scaling on the way out: WUSDC->USDC unwraps at 1:1 minus
        // the 12 decimal shift, so divide by 1e12 to surface a native
        // USDC amount to the user.
        const userFacingAmountOut = outIsUsdc
            ? best.amountOut / 10n ** 12n
            : best.amountOut;
        if (userFacingAmountOut === 0n) return null;

        const amountOutMinUserFacing =
            (userFacingAmountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;
        const amountOutMinInternal = outIsUsdc
            ? amountOutMinUserFacing * 10n ** 12n
            : amountOutMinUserFacing;

        const path: Hex = encodeV3Path([
            { token: quoteTokenIn },
            { token: quoteTokenOut, fee: best.fee },
        ]);

        // Build commands + inputs per the three shapes.
        let commands: Hex;
        let inputs: Hex[];
        let value: bigint = 0n;
        let permit2: RouteQuote["permit2"] | undefined;
        const router = ADDRESSES.unitflowUniversalRouter;
        const userRecipient = req.recipient;

        if (inIsUsdc) {
            // USDC -> X: WRAP_ETH, V3_SWAP_EXACT_IN (router pays from
            // its own balance), SWEEP X -> user.
            commands = encodeCommands([
                UR_COMMANDS.WRAP_ETH,
                UR_COMMANDS.V3_SWAP_EXACT_IN,
                UR_COMMANDS.SWEEP,
            ]);
            inputs = [
                encodeWrapEthInput(
                    UR_CONSTANTS.ROUTER_AS_RECIPIENT,
                    quotedAmountIn,
                ),
                encodeV3SwapExactInInput({
                    recipient: userRecipient,
                    amountIn: quotedAmountIn,
                    amountOutMin: amountOutMinInternal,
                    path,
                    payerIsUser: false,
                }),
                encodeSweepInput(
                    quoteTokenOut,
                    userRecipient,
                    amountOutMinUserFacing,
                ),
            ];
            value = req.amountIn;
        } else if (outIsUsdc) {
            // X -> USDC: PERMIT2_PERMIT (user signs), V3_SWAP into router,
            // UNWRAP_WETH to user.
            commands = encodeCommands([
                UR_COMMANDS.PERMIT2_PERMIT,
                UR_COMMANDS.V3_SWAP_EXACT_IN,
                UR_COMMANDS.UNWRAP_WETH,
            ]);
            inputs = [
                "0x", // PERMIT2_PERMIT placeholder, SwapCard fills after sig
                encodeV3SwapExactInInput({
                    recipient: UR_CONSTANTS.ROUTER_AS_RECIPIENT,
                    amountIn: req.amountIn,
                    amountOutMin: amountOutMinInternal,
                    path,
                    payerIsUser: true,
                }),
                encodeUnwrapWethInput(userRecipient, amountOutMinUserFacing),
            ];
            permit2 = { permitSpender: router, permitInputIndex: 0 };
        } else {
            // X -> Y (no USDC on either side): PERMIT2_PERMIT, V3_SWAP_EXACT_IN.
            commands = encodeCommands([
                UR_COMMANDS.PERMIT2_PERMIT,
                UR_COMMANDS.V3_SWAP_EXACT_IN,
            ]);
            inputs = [
                "0x",
                encodeV3SwapExactInInput({
                    recipient: userRecipient,
                    amountIn: req.amountIn,
                    amountOutMin: amountOutMinInternal,
                    path,
                    payerIsUser: true,
                }),
            ];
            permit2 = { permitSpender: router, permitInputIndex: 0 };
        }

        const executor: RouteQuote["executor"] = {
            router,
            abi: UNIVERSAL_ROUTER_ABI,
            functionName: "execute",
            args: [commands, inputs, req.deadline],
            value: value || undefined,
        };

        return {
            provider: "unitflow-v3",
            amountOut: userFacingAmountOut,
            fee: best.fee,
            pathLabel: inIsUsdc
                ? `wrap → ${(best.fee / 10_000).toFixed(2)}% pool`
                : outIsUsdc
                  ? `${(best.fee / 10_000).toFixed(2)}% pool → unwrap`
                  : `${(best.fee / 10_000).toFixed(2)}% pool`,
            approval: {
                // USDC->X uses msg.value (no approval needed). Other
                // variants approve to Permit2 (one-time max). The
                // SwapCard's approve helper reads the right token from
                // here.
                token: req.tokenIn,
                spender: inIsUsdc
                    ? router // no approval needed for the wrap variant
                    : ("0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address),
                amount: req.amountIn,
            },
            executor,
            permit2,
        };
    },
};
