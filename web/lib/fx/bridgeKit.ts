import type { EIP1193Provider } from "viem";
import { isFxConfigured } from "./appKit";

/**
 * Circle App Kit bridge — Solana <-> Arc USDC (SCAFFOLD).
 *
 * Our hand-rolled CCTP bridge (lib/cctp.ts + BridgeCard) covers EVM <-> Arc
 * only — it can't sign Solana transactions. App Kit's Bridge abstracts
 * CCTP across EVM AND Solana, so this wrapper adds the Solana leg WITHOUT
 * touching the audited EVM/CCTP path: the EVM side keeps using our code,
 * and only the Solana destination/source routes through App Kit here.
 *
 * Status: SCAFFOLD — not yet exercised in-browser. Gated on the same Kit
 * Key as the FX panel (isFxConfigured) plus a Phantom wallet at runtime.
 *
 * The SDK + Solana web3 deps are imported lazily so they never load during
 * SSR or for users who don't open the Solana bridge widget.
 */

export type BridgeDirection = "arc-to-solana" | "solana-to-arc";

/** Minimal shape of Phantom's injected provider (window.solana). */
export interface SolanaInjectedProvider {
    isPhantom?: boolean;
    publicKey?: { toString(): string } | null;
    connect(): Promise<{ publicKey: { toString(): string } }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
}

export interface KitBridgeOpts {
    direction: BridgeDirection;
    /** EVM (Arc) side: user's EIP1193 wallet + address. */
    evmProvider: EIP1193Provider;
    evmAddress: string;
    /** Solana side: Phantom provider + base58 address. */
    solanaProvider: SolanaInjectedProvider;
    solanaAddress: string;
    /** Human-readable USDC amount (e.g. "10.00"). */
    amount: string;
}

/** Same gate as the FX panel: one Kit Key powers swap + bridge. */
export function isSolanaBridgeConfigured(): boolean {
    return isFxConfigured();
}

/** Read Phantom from the window, if present. */
export function getPhantom(): SolanaInjectedProvider | null {
    if (typeof window === "undefined") return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sol = (window as any).solana as SolanaInjectedProvider | undefined;
    return sol && sol.isPhantom ? sol : (sol ?? null);
}

async function buildKitAndBridgeParams(opts: KitBridgeOpts) {
    const { AppKit } = await import("@circle-fin/app-kit");
    const { createViemAdapterFromProvider } = await import(
        "@circle-fin/adapter-viem-v2"
    );
    const { createSolanaAdapterFromProvider } = await import(
        "@circle-fin/adapter-solana"
    );
    const evmAdapter = await createViemAdapterFromProvider({
        provider: opts.evmProvider,
    });
    const solanaAdapter = await createSolanaAdapterFromProvider({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: opts.solanaProvider as any,
    });

    const arc = {
        adapter: evmAdapter,
        chain: "Arc_Testnet",
        address: opts.evmAddress,
    };
    const sol = {
        adapter: solanaAdapter,
        chain: "Solana_Devnet",
        address: opts.solanaAddress,
    };
    const from = opts.direction === "arc-to-solana" ? arc : sol;
    const to = opts.direction === "arc-to-solana" ? sol : arc;

    const kit = new AppKit();
    const params = { from, to, amount: opts.amount, token: "USDC" };
    return { kit, params };
}

/** Quote a Solana<->Arc bridge (no signature). */
export async function estimateKitBridge(opts: KitBridgeOpts) {
    const { kit, params } = await buildKitAndBridgeParams(opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return kit.estimateBridge(params as any);
}

/** Execute a Solana<->Arc bridge (prompts both wallets as needed). */
export async function executeKitBridge(opts: KitBridgeOpts) {
    const { kit, params } = await buildKitAndBridgeParams(opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return kit.bridge(params as any);
}
