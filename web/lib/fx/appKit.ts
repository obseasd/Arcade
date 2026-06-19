import type { EIP1193Provider } from "viem";

/**
 * Circle App Kit — native stablecoin FX (USDC <-> EURC) on Arc.
 *
 * Why this exists: EURC<->USDC on our AMM pools is thin (large price
 * impact). Circle's App Kit Swap routes the pair through Circle's
 * stablecoin FX service for a tight, near-interbank rate instead of an
 * AMM curve. This module is a thin, ISOLATED wrapper — it never touches
 * the existing router/aggregator path, and the whole feature is gated on
 * NEXT_PUBLIC_CIRCLE_KIT_KEY being present (absent → the FX panel never
 * renders and nothing here runs).
 *
 * The SDK is imported lazily inside the call paths so its (large,
 * Solana-pulling) bundle and any browser-only globals never load during
 * SSR or for users who don't open the FX widget.
 *
 * kitKey: this is a Circle Console "Kit Key" (the publishable SDK key,
 * distinct from an API Key / Client Key), so it ships client-side as a
 * NEXT_PUBLIC_ var. Set a domain allowlist on it in Console.
 *
 * Fee: Circle takes a 0.02% provider fee; we add a 0.03% custom fee
 * (FX_FEE_BPS) → ~0.05% total. Of our 0.03%, Circle's split sends 90% to
 * our recipient and 10% to Arc. The custom fee only applies when
 * NEXT_PUBLIC_FX_FEE_RECIPIENT is set; otherwise only Circle's 0.02%
 * provider fee applies and the swap still works.
 */

const KIT_KEY = process.env.NEXT_PUBLIC_CIRCLE_KIT_KEY;
const FX_FEE_RECIPIENT = process.env.NEXT_PUBLIC_FX_FEE_RECIPIENT;
const FX_FEE_BPS = 3; // 0.03% (1 bps = 0.01%)

export type FxToken = "USDC" | "EURC";

/** Feature flag: the FX path only exists when a Kit Key is configured. */
export function isFxConfigured(): boolean {
    return typeof KIT_KEY === "string" && KIT_KEY.length > 0;
}

/** True when both legs are Circle stablecoins we route through FX. */
export function isFxPair(inSym?: string, outSym?: string): boolean {
    const ok = (s?: string): s is FxToken => s === "USDC" || s === "EURC";
    return isFxConfigured() && ok(inSym) && ok(outSym) && inSym !== outSym;
}

export interface FxSwapOpts {
    /** The user's EIP1193 wallet provider (from the wagmi connector). */
    provider: EIP1193Provider;
    /** The user's address (source + recipient of the FX swap). */
    address: string;
    tokenIn: FxToken;
    tokenOut: FxToken;
    /** Human-readable decimal amount (e.g. "1.00"). */
    amountIn: string;
    /** Slippage in basis points (e.g. 50 = 0.5%). */
    slippageBps: number;
}

async function buildKitAndParams(opts: FxSwapOpts) {
    // Lazy import keeps the SDK out of the SSR bundle / non-FX users.
    const { AppKit, Blockchain } = await import("@circle-fin/app-kit");
    const { createViemAdapterFromProvider } = await import(
        "@circle-fin/adapter-viem-v2"
    );
    const adapter = createViemAdapterFromProvider({ provider: opts.provider });
    const kit = new AppKit();
    const customFee = FX_FEE_RECIPIENT
        ? { percentageBps: FX_FEE_BPS, recipientAddress: FX_FEE_RECIPIENT }
        : undefined;
    const params = {
        from: { adapter, chain: Blockchain.Arc_Testnet, address: opts.address },
        tokenIn: opts.tokenIn,
        tokenOut: opts.tokenOut,
        amountIn: opts.amountIn,
        config: {
            kitKey: KIT_KEY,
            slippageBps: opts.slippageBps,
            ...(customFee ? { customFee } : {}),
        },
    };
    return { kit, params };
}

/** Quote an FX swap (no signature). Returns the SDK's SwapEstimate. */
export async function estimateFxSwap(opts: FxSwapOpts) {
    const { kit, params } = await buildKitAndParams(opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return kit.estimateSwap(params as any);
}

/** Execute an FX swap (prompts the user's wallet for the permit/tx). */
export async function executeFxSwap(opts: FxSwapOpts) {
    const { kit, params } = await buildKitAndParams(opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return kit.swap(params as any);
}
