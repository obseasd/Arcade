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

import {
    createPublicClient,
    http,
    erc20Abi,
    zeroAddress,
    maxUint160,
    maxUint256,
    toFunctionSignature,
    getAbiItem,
    type Address,
    type Hex,
} from "viem";
import { arcTestnet } from "@/lib/chains";
import { ADDRESSES, CREATION_FEE_USDC } from "@/lib/constants";
import { quoteBestLeg } from "@/lib/routing/multiLegQuote";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { encodePermit2PermitInput, type Permit2PermitSingle } from "@/lib/routing/universalRouter";
import {
    PERMIT2_ADDRESS,
    PERMIT2_ABI,
    PERMIT2_DEFAULT_EXPIRATION_SECONDS,
} from "@/lib/abis/permit2";

export const ARC_CHAIN = "ARC-TESTNET" as const;

/** Server-side Arc public client. Uses the same RPC the app resolves to. */
export const arc = createPublicClient({
    chain: arcTestnet,
    // Bound RPC latency so a hung node returns an error instead of stalling
    // an agent's request forever (audit: no transport timeout).
    transport: http(process.env.NEXT_PUBLIC_ARC_RPC_URL || "https://rpc.testnet.arc.network", {
        timeout: 12_000,
    }),
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

/** Resolve a token reference: a known symbol (USDC, USDT, ...) or a 0x address. */
export function resolveToken(ref: unknown): Address | null {
    if (isAddr(ref)) return ref;
    if (typeof ref !== "string") return null;
    const k = KNOWN_TOKENS.find((t) => t.symbol.toLowerCase() === ref.trim().toLowerCase());
    return k ? k.address : null;
}

/** Human-readable amount for a raw integer (up to 6 significant fractional digits). */
function fmtAmount(raw: bigint, decimals: number): string {
    const neg = raw < 0n;
    const a = neg ? -raw : raw;
    const base = 10n ** BigInt(decimals);
    const frac = (a % base).toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
    return `${neg ? "-" : ""}${(a / base).toString()}${frac ? "." + frac : ""}`;
}

const tokenMeta = (addr: Address, decimals: number) => {
    const k = KNOWN_TOKENS.find((t) => t.address.toLowerCase() === addr.toLowerCase());
    return { address: addr, symbol: k?.symbol ?? null, decimals };
};

// ===== Descriptor model =====

export type ContractCall = {
    chain: typeof ARC_CHAIN;
    contractAddress: Address;
    abiFunctionSignature: string;
    /** Ordered args, JSON-safe (bigints serialized to decimal strings). */
    abiParameters: unknown[];
    /** Native value to send with the call (USDC raw units; usually "0" on Arc). */
    value?: string;
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

/** Emit an approve descriptor ONLY when the owner's current allowance is below
 *  `amount` (saves the agent a redundant approve tx). If `owner` is unknown, we
 *  cannot check, so we emit the approve to be safe. */
async function approvalCallIfNeeded(
    owner: Address | undefined,
    token: Address,
    spender: Address,
    amount: bigint,
    label: string,
): Promise<ContractCall | null> {
    if (owner) {
        try {
            const cur = (await arc.readContract({
                address: token,
                abi: erc20Abi,
                functionName: "allowance",
                args: [owner, spender],
            })) as bigint;
            if (cur >= amount) return null;
        } catch {
            /* read failed -> fall through and emit the approve */
        }
    }
    return approvalCall(token, spender, amount, label);
}

/** Spreadable variant: returns [approve] or [] depending on allowance. */
const oneApprove = async (
    owner: Address | undefined,
    token: Address,
    spender: Address,
    amount: bigint,
    label: string,
): Promise<ContractCall[]> => {
    const c = await approvalCallIfNeeded(owner, token, spender, amount, label);
    return c ? [c] : [];
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
    /** Stable error code + retryable flag so agents can branch (set on ok:false). */
    code?: string;
    retryable?: boolean;
    provider?: string;
    amountIn: string;
    amountInFmt?: string;
    amountOut?: string;
    amountOutFmt?: string;
    /** Slippage floor on amountOut (raw units) the agent is protected to. */
    minAmountOut?: string;
    slippageBps?: number;
    tokenIn?: { address: Address; symbol: string | null; decimals: number };
    tokenOut?: { address: Address; symbol: string | null; decimals: number };
    /** What the agent should do next (machine-oriented hint). */
    nextStep?: string;
    /** true when the route executes via plain contract calls the agent can
     *  sign directly. false for Permit2 venues until /swap/finalize. */
    executable?: boolean;
    /** Permit2 venues: sign typedData, then call /swap/finalize. */
    requiresPermit2Signature?: boolean;
    permit2?: {
        approve: ContractCall;
        typedData: unknown;
        permit: unknown;
        finalize: string;
    };
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
    if (!route || route.amountOut === 0n) {
        return {
            ok: false,
            code: "NO_ROUTE",
            retryable: false,
            reason: "no route found for this pair/amount on any Arc venue",
            amountIn: params.amountIn.toString(),
            calls: [],
        };
    }
    const minAmountOut = (route.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const baseOut = {
        ok: true as const,
        provider: route.provider,
        amountIn: params.amountIn.toString(),
        amountInFmt: fmtAmount(params.amountIn, decimalsIn),
        amountOut: route.amountOut.toString(),
        amountOutFmt: fmtAmount(route.amountOut, decimalsOut),
        minAmountOut: minAmountOut.toString(),
        slippageBps,
        tokenIn: tokenMeta(params.tokenIn, decimalsIn),
        tokenOut: tokenMeta(params.tokenOut, decimalsOut),
    };

    // Permit2 venue (Synthra, UnitFlow): 2-step flow. The agent approves the
    // token to Permit2 once, signs the PermitSingle typed-data with its wallet
    // (Circle sign/typedData), then calls /swap/finalize to get the execute call.
    if (route.permit2) {
        const { typedData, permitJson } = await buildPermit2Request(
            params.tokenIn,
            route.permit2.permitSpender,
            params.recipient,
        );
        return {
            ...baseOut,
            executable: false,
            requiresPermit2Signature: true,
            nextStep:
                "Run permit2.approve once (token -> Permit2), sign permit2.typedData with Circle sign/typedData, then POST /api/agent/swap/finalize with the same params plus { permit: permit2.permit, signature }.",
            note: "Permit2 venue. (1) run permit2.approve once, (2) sign permit2.typedData with your wallet, (3) POST /api/agent/swap/finalize with the same params plus { permit: permit2.permit, signature } to get the execute call.",
            permit2: {
                approve: approvalCall(params.tokenIn, PERMIT2_ADDRESS, maxUint256, "Permit2"),
                typedData,
                permit: permitJson,
                finalize: "POST /api/agent/swap/finalize",
            },
            calls: [],
        };
    }

    // Plain route (Arcade V2/V3, Xylonet): approve + one call. The function
    // signature is derived from the executor's own ABI so any venue works.
    const sig = sigFromExecutor(route.executor);
    if (!sig) {
        return {
            ...baseOut,
            executable: false,
            note: "could not derive the call signature for this venue",
            calls: [],
        };
    }
    const swapApprove = await approvalCallIfNeeded(
        params.recipient,
        route.approval.token,
        route.approval.spender,
        route.approval.amount,
        "Arcade router",
    );
    return {
        ...baseOut,
        executable: true,
        nextStep:
            "Submit calls[] in order via Circle createContractExecutionTransaction on blockchain ARC-TESTNET.",
        calls: [
            ...(swapApprove ? [swapApprove] : []),
            {
                chain: ARC_CHAIN,
                contractAddress: route.executor.router,
                abiFunctionSignature: sig,
                abiParameters: route.executor.args.map(jsonSafe),
                value: route.executor.value ? route.executor.value.toString() : "0",
                description: `Swap ${params.amountIn} of ${params.tokenIn} to ${params.tokenOut} via ${route.provider}. Output goes to ${params.recipient}.`,
            },
        ],
    };
}

// ===== Permit2 (2-step agent flow) =====

const PERMIT_TYPES = {
    PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
    ],
    PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
    ],
} as const;

type PermitJson = {
    details: { token: Address; amount: string; expiration: number; nonce: number };
    spender: Address;
    sigDeadline: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sigFromExecutor(executor: { abi: any; functionName: string }): string | null {
    try {
        const item = getAbiItem({ abi: executor.abi, name: executor.functionName });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return item ? toFunctionSignature(item as any) : null;
    } catch {
        return null;
    }
}

async function buildPermit2Request(token: Address, spender: Address, owner: Address) {
    let nonce = 0;
    try {
        const a = (await arc.readContract({
            address: PERMIT2_ADDRESS,
            abi: PERMIT2_ABI,
            functionName: "allowance",
            args: [owner, token, spender],
        })) as readonly [bigint, number, number];
        nonce = Number(a[2]);
    } catch {
        /* default nonce 0 */
    }
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + PERMIT2_DEFAULT_EXPIRATION_SECONDS;
    const permitJson: PermitJson = {
        details: { token, amount: maxUint160.toString(), expiration: deadline, nonce },
        spender,
        sigDeadline: String(deadline),
    };
    const typedData = {
        domain: { name: "Permit2", chainId: arcTestnet.id, verifyingContract: PERMIT2_ADDRESS },
        types: PERMIT_TYPES,
        primaryType: "PermitSingle",
        message: permitJson,
    };
    return { typedData, permitJson };
}

function parsePermit(p: PermitJson): Permit2PermitSingle {
    return {
        details: {
            token: p.details.token,
            amount: BigInt(p.details.amount),
            expiration: Number(p.details.expiration),
            nonce: Number(p.details.nonce),
        },
        spender: p.spender,
        sigDeadline: BigInt(p.sigDeadline),
    };
}

/** Step 2 of a Permit2 swap: inject the agent's signature into the Universal
 *  Router execute call and return the final descriptor to submit. */
export async function finalizePermit2Swap(params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    recipient: Address;
    slippageBps?: number;
    permit: PermitJson;
    signature: Hex;
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
    if (!route || !route.permit2) {
        return {
            ok: false,
            reason: "no Permit2 route for these params now (the best route may have shifted)",
            amountIn: params.amountIn.toString(),
            calls: [],
        };
    }
    const encoded = encodePermit2PermitInput(parsePermit(params.permit), params.signature);
    const args = route.executor.args as unknown[];
    const inputs = [...((args[1] as Hex[]) ?? [])];
    const idx = route.permit2.permitInputIndex;
    if (idx < 0 || idx >= inputs.length) {
        return { ok: false, reason: "invalid permitInputIndex", amountIn: params.amountIn.toString(), calls: [] };
    }
    inputs[idx] = encoded;
    const sig = sigFromExecutor(route.executor) ?? "execute(bytes,bytes[],uint256)";
    return {
        ok: true,
        provider: route.provider,
        amountIn: params.amountIn.toString(),
        amountOut: route.amountOut.toString(),
        executable: true,
        calls: [
            {
                chain: ARC_CHAIN,
                contractAddress: route.executor.router,
                abiFunctionSignature: sig,
                abiParameters: [args[0], inputs, jsonSafe(args[2])],
                description: `Execute the signed Permit2 swap via ${route.provider}.`,
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
    owner?: Address;
}): Promise<SwapPlan> {
    const slippageBps = params.slippageBps ?? 100;
    const state = await readTokenState(params.token);
    if (state === null) {
        return {
            ok: false,
            code: "READ_FAILED",
            retryable: true,
            reason: "could not read token state (RPC error or not a launchpad token)",
            amountIn: params.amountUsdcIn.toString(),
            calls: [],
        };
    }
    if (state.migrated) {
        return {
            ok: false,
            code: "GRADUATED",
            retryable: false,
            reason: "token has graduated to the DEX; use POST /api/agent/swap (USDC -> token) instead",
            amountIn: params.amountUsdcIn.toString(),
            calls: [],
        };
    }
    let q: readonly [bigint, bigint, bigint];
    try {
        q = (await arc.readContract({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "quoteBuy",
            args: [params.token, params.amountUsdcIn],
        })) as readonly [bigint, bigint, bigint];
    } catch {
        return {
            ok: false,
            code: "QUOTE_FAILED",
            retryable: true,
            reason: "quoteBuy reverted (bad token or amount)",
            amountIn: params.amountUsdcIn.toString(),
            calls: [],
        };
    }
    if (q[0] === 0n) {
        return {
            ok: false,
            code: "NO_CURVE",
            retryable: false,
            reason: "token has no active bonding curve (zero quote); verify the token address",
            amountIn: params.amountUsdcIn.toString(),
            calls: [],
        };
    }
    const minOut = (q[0] * BigInt(10_000 - slippageBps)) / 10_000n;
    const refund = q[2];
    return {
        ok: true,
        provider: "arcade-launchpad",
        amountIn: params.amountUsdcIn.toString(),
        amountInFmt: fmtAmount(params.amountUsdcIn, 6),
        amountOut: q[0].toString(),
        amountOutFmt: fmtAmount(q[0], 18),
        minAmountOut: minOut.toString(),
        slippageBps,
        executable: true,
        nextStep:
            "Submit calls[] in order (approve USDC, then buy) via Circle createContractExecutionTransaction on ARC-TESTNET.",
        note: refund > 0n ? `Curve will refund ${refund} USDC (it graduates mid-buy).` : undefined,
        calls: [
            ...(await oneApprove(params.owner, ADDRESSES.usdc, ADDRESSES.launchpad, params.amountUsdcIn, "Arcade launchpad")),
            {
                chain: ARC_CHAIN,
                contractAddress: ADDRESSES.launchpad,
                abiFunctionSignature: "buy(address,uint256,uint256)",
                abiParameters: [params.token, params.amountUsdcIn.toString(), minOut.toString()],
                value: "0",
                description: `Buy ${params.token} on the bonding curve with ${params.amountUsdcIn} USDC (min ${minOut} tokens out).`,
            },
        ],
    };
}

export async function getLaunchpadSellPlan(params: {
    token: Address;
    tokensIn: bigint;
    slippageBps?: number;
    owner?: Address;
}): Promise<SwapPlan> {
    const slippageBps = params.slippageBps ?? 100;
    const state = await readTokenState(params.token);
    if (state === null) {
        return {
            ok: false,
            code: "READ_FAILED",
            retryable: true,
            reason: "could not read token state (RPC error or not a launchpad token)",
            amountIn: params.tokensIn.toString(),
            calls: [],
        };
    }
    if (state.migrated) {
        return {
            ok: false,
            code: "GRADUATED",
            retryable: false,
            reason: "token has graduated to the DEX; use POST /api/agent/swap (token -> USDC) instead",
            amountIn: params.tokensIn.toString(),
            calls: [],
        };
    }
    let usdcOut: bigint;
    try {
        usdcOut = (await arc.readContract({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: "quoteSell",
            args: [params.token, params.tokensIn],
        })) as bigint;
    } catch {
        return {
            ok: false,
            code: "QUOTE_FAILED",
            retryable: true,
            reason: "quoteSell reverted (bad token or amount)",
            amountIn: params.tokensIn.toString(),
            calls: [],
        };
    }
    if (usdcOut === 0n) {
        return {
            ok: false,
            code: "NO_CURVE",
            retryable: false,
            reason: "token has no active bonding curve (zero quote); verify the token address",
            amountIn: params.tokensIn.toString(),
            calls: [],
        };
    }
    const minOut = (usdcOut * BigInt(10_000 - slippageBps)) / 10_000n;
    return {
        ok: true,
        provider: "arcade-launchpad",
        amountIn: params.tokensIn.toString(),
        amountInFmt: fmtAmount(params.tokensIn, 18),
        amountOut: usdcOut.toString(),
        amountOutFmt: fmtAmount(usdcOut, 6),
        minAmountOut: minOut.toString(),
        slippageBps,
        executable: true,
        nextStep:
            "Submit calls[] in order (approve token, then sell) via Circle createContractExecutionTransaction on ARC-TESTNET.",
        calls: [
            ...(await oneApprove(params.owner, params.token, ADDRESSES.launchpad, params.tokensIn, "Arcade launchpad")),
            {
                chain: ARC_CHAIN,
                contractAddress: ADDRESSES.launchpad,
                abiFunctionSignature: "sell(address,uint256,uint256)",
                abiParameters: [params.token, params.tokensIn.toString(), minOut.toString()],
                value: "0",
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

export async function getMultiswapPlan(params: {
    inputs: { token: Address; amount: bigint }[];
    tokenOut: Address;
    minTotalOut?: bigint;
    slippageBps?: number;
    owner?: Address;
}): Promise<SwapPlan> {
    const slippageBps = params.slippageBps ?? 100;
    const total = params.inputs.reduce((a, i) => a + i.amount, 0n);
    const decimalsOut = await getDecimals(params.tokenOut);

    // Compute a real slippage floor. Without it the contract runs with
    // minTotalOut=0 and is fully sandwich-exposed (audit HIGH). Estimate the
    // expected output by quoting each input -> tokenOut and summing, then apply
    // slippage. A caller-supplied minTotalOut overrides this.
    let minTotalOut = params.minTotalOut;
    let expectedOut: bigint | undefined;
    if (minTotalOut === undefined) {
        const quotes = await Promise.all(
            params.inputs.map(async (i) => {
                if (i.token.toLowerCase() === params.tokenOut.toLowerCase()) return i.amount;
                try {
                    const decimalsIn = await getDecimals(i.token);
                    const r = await quoteBestLeg(
                        {
                            tokenIn: i.token,
                            tokenOut: params.tokenOut,
                            decimalsIn,
                            decimalsOut,
                            amountIn: i.amount,
                            recipient: ADDRESSES.multiSwap,
                            slippageBps,
                            deadline: deadlineFromNow(),
                        },
                        arc,
                    );
                    return r ? r.amountOut : 0n;
                } catch {
                    return 0n;
                }
            }),
        );
        expectedOut = quotes.reduce((a, b) => a + b, 0n);
        minTotalOut = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
    }

    return {
        ok: true,
        provider: "arcade-multiswap",
        amountIn: total.toString(),
        amountOut: expectedOut?.toString(),
        amountOutFmt: expectedOut !== undefined ? fmtAmount(expectedOut, decimalsOut) : undefined,
        minAmountOut: minTotalOut.toString(),
        slippageBps,
        executable: true,
        nextStep:
            "Submit calls[] in order (one approve per input, then swapToSingle) via Circle createContractExecutionTransaction on ARC-TESTNET.",
        calls: [
            ...(
                await Promise.all(
                    params.inputs.map((i) =>
                        oneApprove(params.owner, i.token, ADDRESSES.multiSwap, i.amount, "Arcade MultiSwap"),
                    ),
                )
            ).flat(),
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
                value: "0",
                description: `Converge ${params.inputs.length} inputs into ${params.tokenOut} in one settlement.`,
            },
        ],
    };
}

// ===== Discovery =====

export async function listKnownMarkets() {
    return KNOWN_TOKENS.map((t) => ({ ...t, tradeable: true }));
}

export type TrendingToken = {
    token: Address;
    symbol: string;
    decimals: number;
    marketCapUsdc: string;
    marketCapUsdcFmt: string;
    /** Approx USDC price per whole token (FDV / 1B supply). */
    priceUsdc: string;
    migrated: boolean;
    curveProgressBps: number;
    /** Which endpoint to trade this token: bonding curve vs the DEX. */
    tradeVia: "launchpad" | "swap";
};

/** Launchpad tokens sorted by market cap (USDC). Avoids multicall3 (broken on
 *  Arc) by reading individually via Promise.all. Returns [] on RPC failure. */
export async function listTrending(limit = 15): Promise<TrendingToken[]> {
    let count = 0;
    try {
        count = Number(
            (await arc.readContract({
                address: ADDRESSES.launchpad,
                abi: LAUNCHPAD_ABI,
                functionName: "getTokensCount",
            })) as bigint,
        );
    } catch {
        return [];
    }
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
            const mcBig = mc as bigint;
            const migrated = st?.migrated ?? false;
            return {
                token,
                symbol: String(sym),
                decimals: 18,
                marketCapUsdc: mcBig.toString(),
                marketCapUsdcFmt: fmtAmount(mcBig, 6),
                priceUsdc: (Number(mcBig) / 1e15).toPrecision(6),
                migrated,
                curveProgressBps: migrated ? 10_000 : Number((sold * 10_000n) / CURVE),
                tradeVia: migrated ? "swap" : "launchpad",
            } as TrendingToken;
        }),
    );
    return rows
        .sort((a, b) => (BigInt(b.marketCapUsdc) > BigInt(a.marketCapUsdc) ? 1 : -1))
        .slice(0, limit);
}

export async function getPortfolio(wallet: Address) {
    const usdc = ADDRESSES.usdc.toLowerCase();
    const balances = await Promise.all(
        KNOWN_TOKENS.map(async (t) => {
            const bal = (await arc
                .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] })
                .catch(() => 0n)) as bigint;
            // Best-effort USDC valuation: USDC is 1:1; others are quoted to USDC.
            let valueUsdc: string | null = "0";
            if (bal > 0n) {
                if (t.address.toLowerCase() === usdc) {
                    valueUsdc = bal.toString();
                } else {
                    try {
                        const r = await quoteBestLeg(
                            {
                                tokenIn: t.address,
                                tokenOut: ADDRESSES.usdc,
                                decimalsIn: t.decimals,
                                decimalsOut: 6,
                                amountIn: bal,
                                recipient: wallet,
                                slippageBps: 100,
                                deadline: deadlineFromNow(),
                            },
                            arc,
                        );
                        valueUsdc = r ? r.amountOut.toString() : null;
                    } catch {
                        valueUsdc = null;
                    }
                }
            }
            return {
                symbol: t.symbol,
                address: t.address,
                decimals: t.decimals,
                balanceRaw: bal.toString(),
                balanceFmt: fmtAmount(bal, t.decimals),
                valueUsdc,
                valueUsdcFmt: valueUsdc !== null ? fmtAmount(BigInt(valueUsdc), 6) : null,
            };
        }),
    );
    const totalValueUsdc = balances.reduce((a, b) => a + (b.valueUsdc ? BigInt(b.valueUsdc) : 0n), 0n);
    return {
        wallet,
        totalValueUsdc: totalValueUsdc.toString(),
        totalValueUsdcFmt: fmtAmount(totalValueUsdc, 6),
        balances,
        note: "Reference tokens only (valued by quoting to USDC). Launchpad-token holdings are not listed here.",
    };
}
