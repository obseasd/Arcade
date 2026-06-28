/**
 * Arcade Agent core — server-side helpers that let ANY third-party AI agent
 * use Arcade on Arc, signing with its OWN wallet (e.g. a Circle
 * developer-controlled wallet via createContractExecutionTransaction).
 *
 * The trust model: Arcade reads markets + computes best execution and returns
 * ready-to-sign CONTRACT-CALL DESCRIPTORS (contract address + Solidity
 * function signature + ordered, JSON-safe arguments). Arcade never holds the
 * agent's keys; the agent signs + submits with its own Circle Wallet.
 *
 * A descriptor maps 1:1 onto Circle's createContractExecutionTransaction:
 *   { contractAddress, abiFunctionSignature, abiParameters }
 */

import { createPublicClient, http, erc20Abi, zeroAddress, type Address } from "viem";
import { arcTestnet } from "@/lib/chains";
import { ADDRESSES, CREATION_FEE_USDC } from "@/lib/constants";
import { quoteBestLeg } from "@/lib/routing/multiLegQuote";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";

export const ARC_CHAIN = "ARC-TESTNET" as const;

/** Server-side Arc public client. Uses the same RPC the app resolves to. */
export const arc = createPublicClient({
    chain: arcTestnet,
    transport: http(process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network"),
});

const isAddr = (a: unknown): a is Address =>
    typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== zeroAddress;

/** Always-tradeable reference tokens. Launchpad tokens come from listTrending. */
export const KNOWN_TOKENS = (
    [
        { symbol: "USDC", address: ADDRESSES.usdc, decimals: 6, kind: "native-gas-stablecoin" },
        { symbol: "WUSDC", address: ADDRESSES.wusdc, decimals: 18, kind: "wrapped-usdc" },
        { symbol: "USDT", address: ADDRESSES.usdt, decimals: 18, kind: "stablecoin" },
        { symbol: "EURC", address: ADDRESSES.eurc, decimals: 6, kind: "stablecoin" },
        { symbol: "cirBTC", address: ADDRESSES.cirBtc, decimals: 8, kind: "btc" },
        { symbol: "WETH", address: ADDRESSES.weth, decimals: 18, kind: "eth" },
    ] as { symbol: string; address: Address; decimals: number; kind: string }[]
).filter((t) => isAddr(t.address));

// ===== Descriptor model =====

export type ContractCall = {
    chain: typeof ARC_CHAIN;
    contractAddress: Address;
    abiFunctionSignature: string;
    /** Ordered args, JSON-safe (bigints serialized to decimal strings). */
    abiParameters: unknown[];
    description: string;
};

/** Recursively serialize bigints to strings so descriptors are JSON-safe. */
const jsonSafe = (v: unknown): unknown =>
    typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(jsonSafe) : v;

export function approvalCall(
    token: Address,
    spender: Address,
    amount: bigint,
    label: string,
): ContractCall {
    return {
        chain: ARC_CHAIN,
        contractAddress: token,
        abiFunctionSignature: "approve(address,uint256)",
        abiParameters: [spender, amount.toString()],
        description: `Approve ${label} to spend ${amount.toString()} (raw units) of token ${token}.`,
    };
}

/** Solidity signatures for the swap executors the router returns. */
const SWAP_SIG: Record<string, string> = {
    swapExactTokensForTokens: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    swapTokensForExactTokens: "swapTokensForExactTokens(uint256,uint256,address[],address,uint256)",
    exactInputSingle: "exactInputSingle(address,address,uint24,address,uint256,uint256,uint256)",
    exactInputThroughUsdc:
        "exactInputThroughUsdc(address,address,uint24,address,uint256,uint256,uint256,uint256)",
    swapMigratedRoute: "swapMigratedRoute(address,address,uint256,uint256,uint256,uint256)",
};

const deadlineFromNow = (secs = 600) => BigInt(Math.floor(Date.now() / 1000) + secs);

async function getDecimals(token: Address): Promise<number> {
    const known = KNOWN_TOKENS.find((t) => t.address.toLowerCase() === token.toLowerCase());
    if (known) return known.decimals;
    try {
        return Number(await arc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
    } catch {
        return 18;
    }
}

// ===== Quote + swap plan =====

export type SwapPlan = {
    ok: boolean;
    reason?: string;
    provider?: string;
    amountIn: string;
    amountOut?: string;
    /** true when the best route executes via a plain contract call an agent
     *  can sign directly (Arcade V2/V3). Permit2-based external venues need a
     *  typed-data signature step not yet automated for agents. */
    executable?: boolean;
    note?: string;
    /** Ordered calls the agent signs + submits with its Circle Wallet. */
    calls: ContractCall[];
};

export async function getSwapPlan(params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    recipient: Address;
    slippageBps?: number;
}): Promise<SwapPlan> {
    const slippageBps = params.slippageBps ?? 50;
    const [decimalsIn, decimalsOut] = await Promise.all([
        getDecimals(params.tokenIn),
        getDecimals(params.tokenOut),
    ]);
    const route = await quoteBestLeg(
        {
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            decimalsIn,
            decimalsOut,
            amountIn: params.amountIn,
            recipient: params.recipient,
            slippageBps,
            deadline: deadlineFromNow(),
        },
        arc,
    );
    if (!route) {
        return { ok: false, reason: "no route found", amountIn: params.amountIn.toString(), calls: [] };
    }
    const executable = route.provider.startsWith("arcade") && !route.permit2;
    const sig = SWAP_SIG[route.executor.functionName];
    if (!executable || !sig) {
        return {
            ok: true,
            provider: route.provider,
            amountIn: params.amountIn.toString(),
            amountOut: route.amountOut.toString(),
            executable: false,
            note:
                "Best price is on an external Permit2 venue, which needs an EIP-712 signature step not yet automated for agents. The quote is informational; execute via an Arcade-native route or await v2 Permit2 agent support.",
            calls: [],
        };
    }
    return {
        ok: true,
        provider: route.provider,
        amountIn: params.amountIn.toString(),
        amountOut: route.amountOut.toString(),
        executable: true,
        calls: [
            approvalCall(route.approval.token, route.approval.spender, route.approval.amount, "Arcade router"),
            {
                chain: ARC_CHAIN,
                contractAddress: route.executor.router,
                abiFunctionSignature: sig,
                abiParameters: route.executor.args.map(jsonSafe),
                description: `Swap ${params.amountIn} of ${params.tokenIn} to ${params.tokenOut} via ${route.provider}. Output goes to ${params.recipient}.`,
            },
        ],
    };
}

// ===== Launchpad (bonding curve) =====

type TokenState = { migrated: boolean; tokensSold: bigint };

async function readTokenState(token: Address): Promise<TokenState | null> {
    try {
        const st = (await arc.readContract({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "getTokenState",
            args: [token],
        })) as unknown as TokenState;
        return { migrated: st.migrated, tokensSold: BigInt(st.tokensSold) };
    } catch {
        return null;
    }
}

export async function getLaunchpadBuyPlan(params: {
    token: Address;
    amountUsdcIn: bigint;
    slippageBps?: number;
}): Promise<SwapPlan> {
    const slippageBps = params.slippageBps ?? 100;
    const state = await readTokenState(params.token);
    if (state?.migrated) {
        return {
            ok: false,
            reason: "token has graduated to the DEX; use POST /api/agent/swap (USDC -> token) instead",
            amountIn: params.amountUsdcIn.toString(),
            calls: [],
        };
    }
    const q = (await arc.readContract({
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "quoteBuy",
        args: [params.token, params.amountUsdcIn],
    })) as readonly [bigint, bigint, bigint];
    const minOut = (q[0] * BigInt(10_000 - slippageBps)) / 10_000n;
    return {
        ok: true,
        provider: "arcade-launchpad",
        amountIn: params.amountUsdcIn.toString(),
        amountOut: q[0].toString(),
        executable: true,
        calls: [
            approvalCall(ADDRESSES.usdc, ADDRESSES.launchpad, params.amountUsdcIn, "Arcade launchpad"),
            {
                chain: ARC_CHAIN,
                contractAddress: ADDRESSES.launchpad,
                abiFunctionSignature: "buy(address,uint256,uint256)",
                abiParameters: [params.token, params.amountUsdcIn.toString(), minOut.toString()],
                description: `Buy ${params.token} on the bonding curve with ${params.amountUsdcIn} USDC (min ${minOut} tokens out).`,
            },
        ],
    };
}

export async function getLaunchpadSellPlan(params: {
    token: Address;
    tokensIn: bigint;
    slippageBps?: number;
}): Promise<SwapPlan> {
    const slippageBps = params.slippageBps ?? 100;
    const state = await readTokenState(params.token);
    if (state?.migrated) {
        return {
            ok: false,
            reason: "token has graduated to the DEX; use POST /api/agent/swap (token -> USDC) instead",
            amountIn: params.tokensIn.toString(),
            calls: [],
        };
    }
    const usdcOut = (await arc.readContract({
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "quoteSell",
        args: [params.token, params.tokensIn],
    })) as bigint;
    const minOut = (usdcOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return {
        ok: true,
        provider: "arcade-launchpad",
        amountIn: params.tokensIn.toString(),
        amountOut: usdcOut.toString(),
        executable: true,
        calls: [
            approvalCall(params.token, ADDRESSES.launchpad, params.tokensIn, "Arcade launchpad"),
            {
                chain: ARC_CHAIN,
                contractAddress: ADDRESSES.launchpad,
                abiFunctionSignature: "sell(address,uint256,uint256)",
                abiParameters: [params.token, params.tokensIn.toString(), minOut.toString()],
                description: `Sell ${params.tokensIn} of ${params.token} on the bonding curve (min ${minOut} USDC out).`,
            },
        ],
    };
}

export function getCreateTokenPlan(params: {
    name: string;
    symbol: string;
    metadataURI?: string;
    mode?: number; // 0=PUMP, 1=CLANKER, 2=CLANKER_V3
    creator2?: Address;
    creator2ShareBps?: number;
}): SwapPlan {
    const mode = params.mode ?? 0;
    return {
        ok: true,
        provider: "arcade-launchpad",
        amountIn: CREATION_FEE_USDC.toString(),
        executable: true,
        note: `Launching a token costs ${CREATION_FEE_USDC} USDC (creation fee).`,
        calls: [
            approvalCall(ADDRESSES.usdc, ADDRESSES.launchpad, CREATION_FEE_USDC, "Arcade launchpad (creation fee)"),
            {
                chain: ARC_CHAIN,
                contractAddress: ADDRESSES.launchpad,
                abiFunctionSignature: "createToken(string,string,string,uint8,address,uint16)",
                abiParameters: [
                    params.name,
                    params.symbol,
                    params.metadataURI ?? "",
                    mode,
                    params.creator2 ?? zeroAddress,
                    params.creator2ShareBps ?? 0,
                ],
                description: `Launch token ${params.symbol} (${params.name}) in mode ${mode}.`,
            },
        ],
    };
}

// ===== MultiSwap (basket -> one output) =====

export function getMultiswapPlan(params: {
    inputs: { token: Address; amount: bigint }[];
    tokenOut: Address;
    minTotalOut?: bigint;
}): SwapPlan {
    const minTotalOut = params.minTotalOut ?? 0n;
    const total = params.inputs.reduce((a, i) => a + i.amount, 0n);
    return {
        ok: true,
        provider: "arcade-multiswap",
        amountIn: total.toString(),
        executable: true,
        calls: [
            ...params.inputs.map((i) =>
                approvalCall(i.token, ADDRESSES.multiSwap, i.amount, "Arcade MultiSwap"),
            ),
            {
                chain: ARC_CHAIN,
                contractAddress: ADDRESSES.multiSwap,
                abiFunctionSignature: "swapToSingle((address,uint256)[],address,uint256,uint256)",
                abiParameters: [
                    params.inputs.map((i) => [i.token, i.amount.toString()]),
                    params.tokenOut,
                    minTotalOut.toString(),
                    deadlineFromNow().toString(),
                ],
                description: `Converge ${params.inputs.length} inputs into ${params.tokenOut} in one settlement.`,
            },
        ],
    };
}

// ===== Discovery =====

export async function listKnownMarkets() {
    return KNOWN_TOKENS.map((t) => ({ ...t }));
}

export type TrendingToken = {
    token: Address;
    symbol: string;
    marketCapUsdc: string;
    migrated: boolean;
    curveProgressBps: number;
};

/** Launchpad tokens sorted by market cap (USDC). Avoids multicall3 (broken on
 *  Arc) by reading individually via Promise.all. */
export async function listTrending(limit = 15): Promise<TrendingToken[]> {
    const count = Number(
        (await arc.readContract({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "getTokensCount",
        })) as bigint,
    );
    if (count === 0) return [];
    const start = Math.max(0, count - Math.min(limit * 2, count));
    const idxs = Array.from({ length: count - start }, (_, i) => start + i);
    const addrs = (await Promise.all(
        idxs.map((i) =>
            arc
                .readContract({
                    address: ADDRESSES.launchpad,
                    abi: LAUNCHPAD_ABI,
                    functionName: "allTokens",
                    args: [BigInt(i)],
                })
                .catch(() => null),
        ),
    )) as (Address | null)[];
    const tokens = addrs.filter(isAddr) as Address[];

    const CURVE = 800_000_000n * 10n ** 18n;
    const rows = await Promise.all(
        tokens.map(async (token) => {
            const [mc, st, sym] = await Promise.all([
                arc
                    .readContract({ address: ADDRESSES.launchpad, abi: LAUNCHPAD_ABI, functionName: "marketCap", args: [token] })
                    .catch(() => 0n),
                readTokenState(token),
                arc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
            ]);
            const sold = st?.tokensSold ?? 0n;
            return {
                token,
                symbol: String(sym),
                marketCapUsdc: (mc as bigint).toString(),
                migrated: st?.migrated ?? false,
                curveProgressBps: st?.migrated ? 10_000 : Number((sold * 10_000n) / CURVE),
            } as TrendingToken;
        }),
    );
    return rows
        .sort((a, b) => (BigInt(b.marketCapUsdc) > BigInt(a.marketCapUsdc) ? 1 : -1))
        .slice(0, limit);
}

export async function getPortfolio(wallet: Address) {
    const balances = await Promise.all(
        KNOWN_TOKENS.map(async (t) => {
            const bal = (await arc
                .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] })
                .catch(() => 0n)) as bigint;
            return { symbol: t.symbol, address: t.address, decimals: t.decimals, balanceRaw: bal.toString() };
        }),
    );
    return { wallet, balances };
}
