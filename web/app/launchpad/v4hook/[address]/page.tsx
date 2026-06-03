"use client";

import { ArrowLeft, ExternalLink, Lock, ShieldCheck, ShieldOff, Sparkles, Clock } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, isAddress, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import {
    ARCADE_HOOK_ABI,
    ARCADE_HOOK_MODE,
    ARCADE_HOOK_STATUS,
} from "@/lib/abis/arcadeHook";
import {
    ADDRESSES,
    LAUNCHPAD_TOKEN_DECIMALS,
    USDC_DECIMALS,
    V4_HOOK_ENABLED,
} from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useArcadeHookCurveState } from "@/lib/hooks/useArcadeHookTokens";
import { useTokenImage, useTokenMetadata } from "@/lib/hooks/useTokenImage";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { formatAddress, formatToken, formatUSDC } from "@/lib/utils";

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
const GRADUATION_USDC = 20_000n * 10n ** 6n;

const MODE_LABEL: Record<number, string> = {
    [ARCADE_HOOK_MODE.PUMP]: "PUMP (50/50 split)",
    [ARCADE_HOOK_MODE.CLANKER]: "CLANKER (70/30 split)",
    [ARCADE_HOOK_MODE.CLANKER_V3]: "CLANKER V3 (locked LP)",
};

const STATUS_LABEL: Record<number, string> = {
    [ARCADE_HOOK_STATUS.CURVING]: "Curving",
    [ARCADE_HOOK_STATUS.GRADUATION_STARTED]: "Graduating",
    [ARCADE_HOOK_STATUS.GRADUATED]: "Graduated",
};

export default function ArcadeHookTokenPage() {
    if (!V4_HOOK_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">ArcadeHook not configured</h1>
                    <p className="mt-2 text-sm text-arc-text-muted">
                        Set <code>NEXT_PUBLIC_ARCADE_HOOK_ADDRESS</code> and{" "}
                        <code>NEXT_PUBLIC_LOCKED_VAULT_ADDRESS</code> in env.
                    </p>
                    <Link
                        href="/launchpad"
                        className="mt-6 inline-block rounded-lg border border-arc-border bg-arc-surface px-4 py-2 text-sm hover:border-arc-primary/40"
                    >
                        Back to launchpad
                    </Link>
                </div>
            </div>
        );
    }
    return <Inner />;
}

function Inner() {
    const params = useParams();
    const addrParam = (params.address as string) ?? "";
    const valid = isAddress(addrParam);
    const token = valid ? (addrParam as Address) : (zeroAddress as Address);

    // Curve state read drives almost everything else on the page.
    const { status, tokensSold, realUsdcReserve, mode, isLoading } = useArcadeHookCurveState(
        valid ? token : undefined,
    );

    // ERC20 metadata - direct token reads. Lighter than going through getCurveState.
    const nameQ = useReadContract({
        address: valid ? token : undefined,
        abi: erc20Abi,
        functionName: "name",
        query: { enabled: valid },
    });
    const symbolQ = useReadContract({
        address: valid ? token : undefined,
        abi: erc20Abi,
        functionName: "symbol",
        query: { enabled: valid },
    });

    const { metadata } = useTokenMetadata(valid ? token : undefined);
    const { image } = useTokenImage(valid ? token : undefined);

    // Anti-sniper config: per-token (startBps, decaySeconds, launchedAt).
    // Drives both the header pill and the buy-card warning during the
    // decay window post-graduation.
    const snipeQ = useReadContract({
        address: ADDRESSES.arcadeHook,
        abi: ARCADE_HOOK_ABI,
        functionName: "snipeConfigs",
        args: valid ? [token] : undefined,
        query: { enabled: valid && V4_HOOK_ENABLED, refetchInterval: 15_000 },
    });
    const snipeRaw = snipeQ.data as readonly [number, number, bigint] | undefined;
    const snipeStartBps = Number(snipeRaw?.[0] ?? 0);
    const snipeDecaySeconds = Number(snipeRaw?.[1] ?? 0);
    const snipeLaunchedAt = Number(snipeRaw?.[2] ?? 0n);

    // Live tick so the countdown updates every second without manual state
    // mutation on every render.
    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
    useEffect(() => {
        const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000);
        return () => clearInterval(t);
    }, []);

    const snipe = useMemo(() => {
        if (snipeStartBps === 0 || snipeDecaySeconds === 0 || snipeLaunchedAt === 0) {
            return { active: false, remainingSec: 0, currentBps: 0 };
        }
        const elapsed = nowSec - snipeLaunchedAt;
        if (elapsed >= snipeDecaySeconds) {
            return { active: false, remainingSec: 0, currentBps: 0 };
        }
        const remainingSec = snipeDecaySeconds - Math.max(0, elapsed);
        const currentBps = Math.round((snipeStartBps * remainingSec) / snipeDecaySeconds);
        return { active: true, remainingSec, currentBps };
    }, [snipeStartBps, snipeDecaySeconds, snipeLaunchedAt, nowSec]);

    const name = (nameQ.data as string | undefined) ?? "Unnamed";
    const symbol = (symbolQ.data as string | undefined) ?? "?";

    if (!valid) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-danger/40 bg-arc-danger/10 p-6 text-arc-danger">
                    Invalid token address: {addrParam}
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
            {/* Header --------------------------------------------------- */}
            <div className="mb-6 flex items-start gap-3 sm:items-center">
                <Link
                    href="/launchpad"
                    className="shrink-0 rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-primary/40"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                {/* On mobile we keep the icon smaller (48px) so the title gets
                    room to breathe; sm+ bumps it back to the hero 64px size. */}
                <div className="shrink-0">
                    <TokenIcon symbol={symbol} image={image} size={48} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h1 className="truncate text-xl font-semibold sm:text-3xl">
                            {name}{" "}
                            <span className="text-arc-text-muted">{symbol}</span>
                        </h1>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {mode !== undefined && (
                            <span className="rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                                {MODE_LABEL[mode]}
                            </span>
                        )}
                        {status !== undefined && (
                            <StatusPill status={status} />
                        )}
                        {snipeStartBps > 0 && (
                            <SnipePill
                                active={snipe.active}
                                currentBps={snipe.currentBps}
                                remainingSec={snipe.remainingSec}
                            />
                        )}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-arc-text-faint">
                        <span>{formatAddress(token)}</span>
                        <a
                            href={`https://explorer.testnet.arc.network/address/${token}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-arc-text-muted"
                        >
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    </div>
                </div>
            </div>

            {/* Two-column body: curve + trade ---------------------------- */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_400px]">
                <CurveProgressCard
                    status={status}
                    tokensSold={tokensSold}
                    realUsdcReserve={realUsdcReserve}
                    isLoading={isLoading}
                    description={metadata?.description}
                />
                <TradeCard
                    token={token}
                    symbol={symbol}
                    status={status}
                    tokensSold={tokensSold}
                    realUsdcReserve={realUsdcReserve}
                />
            </div>
        </div>
    );
}

// -------------------------------------------------------------------
// Status pill
// -------------------------------------------------------------------

function SnipePill({
    active,
    currentBps,
    remainingSec,
}: {
    active: boolean;
    currentBps: number;
    remainingSec: number;
}) {
    if (!active) {
        return (
            <span className="inline-flex items-center gap-1 rounded-md border border-arc-text-faint/30 bg-arc-text-faint/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-text-faint">
                <ShieldOff className="h-3 w-3" />
                Snipe expired
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-md border border-arc-warn/40 bg-arc-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
            <ShieldCheck className="h-3 w-3" />
            Snipe {(currentBps / 100).toFixed(2)}%
            <Clock className="ml-0.5 h-3 w-3" />
            {formatRemaining(remainingSec)}
        </span>
    );
}

function formatRemaining(seconds: number): string {
    if (seconds <= 0) return "0s";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (minutes < 60) return s > 0 ? `${minutes}m ${s}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m` : `${hours}h`;
}

function StatusPill({ status }: { status: number }) {
    if (status === ARCADE_HOOK_STATUS.CURVING) {
        return (
            <span className="inline-flex items-center gap-1 rounded-md border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-cta-hover">
                <Sparkles className="h-3 w-3" />
                {STATUS_LABEL[status]}
            </span>
        );
    }
    if (status === ARCADE_HOOK_STATUS.GRADUATED) {
        return (
            <span className="inline-flex items-center gap-1 rounded-md border border-arc-success/40 bg-arc-success/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-success">
                <ShieldCheck className="h-3 w-3" />
                {STATUS_LABEL[status]}
            </span>
        );
    }
    return (
        <span className="rounded-md border border-arc-warn/40 bg-arc-warn/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-arc-warn">
            {STATUS_LABEL[status]}
        </span>
    );
}

// -------------------------------------------------------------------
// Curve progress card
// -------------------------------------------------------------------

function CurveProgressCard({
    status,
    tokensSold,
    realUsdcReserve,
    isLoading,
    description,
}: {
    status: number | undefined;
    tokensSold: bigint;
    realUsdcReserve: bigint;
    isLoading: boolean;
    description?: string;
}) {
    const tokensSoldPct = useMemo(() => {
        if (CURVE_SUPPLY === 0n) return 0;
        const bps = (tokensSold * 10_000n) / CURVE_SUPPLY;
        return Math.min(100, Number(bps) / 100);
    }, [tokensSold]);

    const raisedPct = useMemo(() => {
        if (GRADUATION_USDC === 0n) return 0;
        const bps = (realUsdcReserve * 10_000n) / GRADUATION_USDC;
        return Math.min(100, Number(bps) / 100);
    }, [realUsdcReserve]);

    return (
        <div className="arc-card p-6">
            <div className="mb-1 text-xs uppercase tracking-wider text-arc-text-faint">
                Bonding curve progress
            </div>
            <div className="flex items-baseline gap-3">
                <div className="text-3xl font-semibold tabular-nums">
                    {formatUSDC(realUsdcReserve, USDC_DECIMALS, 2)}
                </div>
                <div className="text-sm text-arc-text-muted">
                    / {formatUSDC(GRADUATION_USDC, USDC_DECIMALS, 0)} USDC raised
                </div>
            </div>
            <div className="mt-4">
                <div className="relative h-3 overflow-hidden rounded-full bg-arc-bg-elevated">
                    <div
                        className="absolute left-0 top-0 h-full bg-gradient-to-r from-arc-cta to-arc-cta-hover transition-all"
                        style={{ width: `${raisedPct}%` }}
                    />
                </div>
                <div className="mt-1.5 flex justify-between text-[10px] text-arc-text-faint">
                    <span>{raisedPct.toFixed(2)}% to graduation</span>
                    <span>20,000 USDC threshold</span>
                </div>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 text-xs">
                <Stat
                    label="Tokens sold"
                    value={`${formatToken(tokensSold, LAUNCHPAD_TOKEN_DECIMALS, 2)}`}
                    sub={`${tokensSoldPct.toFixed(2)}% of 800M curve supply`}
                />
                <Stat
                    label="Remaining on curve"
                    value={formatToken(
                        CURVE_SUPPLY > tokensSold ? CURVE_SUPPLY - tokensSold : 0n,
                        LAUNCHPAD_TOKEN_DECIMALS,
                        2,
                    )}
                    sub="tokens"
                />
            </div>

            {status === ARCADE_HOOK_STATUS.GRADUATED && (
                <div className="mt-4 rounded-lg border border-arc-success/30 bg-arc-success/10 p-3 text-xs text-arc-success">
                    <div className="font-semibold">Graduated.</div>
                    <div className="mt-0.5">
                        The pool seeded 17,500 USDC + 200M tokens as full-range V4 LP. The seed
                        is locked permanently. Trade via the canonical V4 router.
                    </div>
                </div>
            )}

            {description && (
                <div className="mt-6 border-t border-arc-border pt-4">
                    <div className="text-xs uppercase tracking-wider text-arc-text-faint">About</div>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-arc-text-muted">
                        {description}
                    </p>
                </div>
            )}

            {isLoading && (
                <div className="mt-4 text-xs text-arc-text-faint">Loading curve state...</div>
            )}
        </div>
    );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2">
            <div className="text-arc-text-muted">{label}</div>
            <div className="mt-0.5 font-semibold tabular-nums">{value}</div>
            {sub && <div className="mt-0.5 text-[10px] text-arc-text-faint">{sub}</div>}
        </div>
    );
}

// -------------------------------------------------------------------
// Trade card (buy / sell, MVP)
// -------------------------------------------------------------------

function TradeCard({
    token,
    symbol,
    status,
    tokensSold,
    realUsdcReserve,
}: {
    token: Address;
    symbol: string;
    status: number | undefined;
    tokensSold: bigint;
    realUsdcReserve: bigint;
}) {
    const { address: account } = useAccount();
    const [tab, setTab] = useState<"buy" | "sell">("buy");
    const [amountStr, setAmountStr] = useState("");
    const [submitting, setSubmitting] = useState(false);

    const isCurving = status === ARCADE_HOOK_STATUS.CURVING;
    const isGraduated = status === ARCADE_HOOK_STATUS.GRADUATED;

    // Balances for HALF/MAX and slippage estimation.
    const usdcBalQ = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const tokenBalQ = useReadContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account },
    });
    const usdcBalance = (usdcBalQ.data as bigint | undefined) ?? 0n;
    const tokenBalance = (tokenBalQ.data as bigint | undefined) ?? 0n;

    // Approvals
    const buyApprove = useApproveIfNeeded(ADDRESSES.usdc, ADDRESSES.arcadeHook);
    const sellApprove = useApproveIfNeeded(token, ADDRESSES.arcadeHook);

    const { writeContractAsync } = useWriteContract();

    const inputDecimals = tab === "buy" ? USDC_DECIMALS : LAUNCHPAD_TOKEN_DECIMALS;
    const amountBn = useMemo(() => {
        try {
            if (!amountStr || Number(amountStr) <= 0) return 0n;
            return parseUnits(amountStr, inputDecimals);
        } catch {
            return 0n;
        }
    }, [amountStr, inputDecimals]);

    // Naive client-side quote. Pure curve simulation matches the on-chain
    // ArcadeV4Curve library; for the MVP we display a simple "spot price
    // estimate" rather than running the full sim. A future revision can
    // import the curve TS port.
    const estimateOut = useMemo(() => {
        if (amountBn === 0n) return 0n;
        const virtUsdc = 5_000n * 10n ** BigInt(USDC_DECIMALS);
        const virtToken = 1_000_000_000n * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);
        const currentUsdc = virtUsdc + realUsdcReserve;
        const currentTokens = virtToken - tokensSold;
        const K = virtUsdc * virtToken;
        if (tab === "buy") {
            // Apply 1% fee inline so the estimate reflects what the user
            // actually receives.
            const netIn = (amountBn * 9_900n) / 10_000n;
            const newUsdc = currentUsdc + netIn;
            if (newUsdc === 0n) return 0n;
            const newToken = K / newUsdc;
            if (currentTokens <= newToken) return 0n;
            return currentTokens - newToken;
        }
        const newToken = currentTokens + amountBn;
        if (newToken === 0n) return 0n;
        const newUsdc = K / newToken;
        if (currentUsdc <= newUsdc) return 0n;
        const grossOut = currentUsdc - newUsdc;
        // 1% fee on gross.
        return (grossOut * 9_900n) / 10_000n;
    }, [amountBn, realUsdcReserve, tokensSold, tab]);

    const onSubmit = async () => {
        if (!account) {
            pushToast({ kind: "error", title: "Connect wallet first" });
            return;
        }
        if (amountBn === 0n) {
            pushToast({ kind: "error", title: "Enter an amount" });
            return;
        }
        if (!isCurving) {
            pushToast({
                kind: "error",
                title: "Curve closed",
                message: "This token has graduated. Trade via the V4 router.",
            });
            return;
        }

        setSubmitting(true);
        try {
            if (tab === "buy") {
                if (amountBn > usdcBalance) {
                    pushToast({ kind: "error", title: "Insufficient USDC" });
                    return;
                }
                await buyApprove.ensureAllowance(amountBn);
                await writeContractAsync({
                    address: ADDRESSES.arcadeHook,
                    abi: ARCADE_HOOK_ABI,
                    functionName: "buy",
                    args: [token, amountBn, 0n],
                });
                pushToast({ kind: "info", title: `Buy submitted` });
            } else {
                if (amountBn > tokenBalance) {
                    pushToast({ kind: "error", title: `Insufficient ${symbol}` });
                    return;
                }
                await sellApprove.ensureAllowance(amountBn);
                await writeContractAsync({
                    address: ADDRESSES.arcadeHook,
                    abi: ARCADE_HOOK_ABI,
                    functionName: "sell",
                    args: [token, amountBn, 0n],
                });
                pushToast({ kind: "info", title: `Sell submitted` });
            }
            setAmountStr("");
        } catch (e) {
            const msg = e instanceof Error ? e.message : "Tx failed";
            pushToast({ kind: "error", title: "Failed", message: msg.slice(0, 120) });
        } finally {
            setSubmitting(false);
        }
    };

    const cta = () => {
        if (!account) return "Connect wallet";
        if (isGraduated) return "Curve graduated - use V4 router";
        if (status === ARCADE_HOOK_STATUS.GRADUATION_STARTED) return "Mid-graduation, retry";
        if (amountBn === 0n) return tab === "buy" ? "Enter USDC amount" : `Enter ${symbol} amount`;
        if (submitting) return "Submitting...";
        return tab === "buy" ? `Buy ${symbol}` : `Sell ${symbol}`;
    };

    const ctaDisabled = !account || !isCurving || amountBn === 0n || submitting;

    return (
        <div className="arc-card flex flex-col p-5">
            {/* Buy / Sell toggle */}
            <div className="mb-4 flex items-center gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
                {(["buy", "sell"] as const).map((t) => (
                    <button
                        key={t}
                        onClick={() => {
                            setTab(t);
                            setAmountStr("");
                        }}
                        className={
                            "flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors " +
                            (tab === t
                                ? "bg-arc-cta text-white"
                                : "text-arc-text-muted hover:text-arc-text")
                        }
                    >
                        {t === "buy" ? "Buy" : "Sell"}
                    </button>
                ))}
            </div>

            {/* Amount input */}
            <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
                <div className="mb-3 flex items-center justify-between text-xs text-arc-text-muted">
                    <span>{tab === "buy" ? "Spend" : "Sell"}</span>
                    <span>
                        {tab === "buy"
                            ? `${formatUSDC(usdcBalance, USDC_DECIMALS, 2)} USDC`
                            : `${formatToken(tokenBalance, LAUNCHPAD_TOKEN_DECIMALS, 4)} ${symbol}`}
                    </span>
                </div>
                <input
                    type="text"
                    inputMode="decimal"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ""))}
                    placeholder="0.0"
                    className="arc-input w-full bg-transparent text-3xl font-medium leading-tight sm:text-4xl"
                />
                <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="text-arc-text-faint">
                        {tab === "buy" ? "USDC" : symbol}
                    </span>
                    <div className="flex gap-1.5">
                        <QuickBtn
                            onClick={() =>
                                setAmountStr(
                                    formatUnits(
                                        tab === "buy" ? usdcBalance / 2n : tokenBalance / 2n,
                                        inputDecimals,
                                    ),
                                )
                            }
                        >
                            HALF
                        </QuickBtn>
                        <QuickBtn
                            onClick={() =>
                                setAmountStr(
                                    formatUnits(
                                        tab === "buy" ? usdcBalance : tokenBalance,
                                        inputDecimals,
                                    ),
                                )
                            }
                        >
                            MAX
                        </QuickBtn>
                    </div>
                </div>
            </div>

            {/* Estimated output */}
            <div className="mt-4 rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-3 text-xs text-arc-text-muted">
                <div className="flex items-center justify-between">
                    <span>Estimated out (1% fee included)</span>
                    <span className="text-arc-text tabular-nums">
                        {tab === "buy"
                            ? `${formatToken(estimateOut, LAUNCHPAD_TOKEN_DECIMALS, 4)} ${symbol}`
                            : `${formatUSDC(estimateOut, USDC_DECIMALS, 2)} USDC`}
                    </span>
                </div>
                <div className="mt-1 text-[10px] text-arc-text-faint">
                    Slippage 0% (no min-out guard in MVP). On-chain math is canonical.
                </div>
            </div>

            <button
                onClick={onSubmit}
                disabled={ctaDisabled}
                className={
                    "arc-button-primary mt-5 w-full py-3 text-base font-semibold " +
                    (ctaDisabled ? "cursor-not-allowed opacity-50" : "")
                }
            >
                {cta()}
            </button>

            <div className="mt-3 text-center text-[10px] text-arc-text-faint">
                Direct curve trade via ArcadeHook. 1% fee, split per mode.
            </div>
        </div>
    );
}

function QuickBtn({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className="rounded-md bg-arc-surface px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-arc-text-muted hover:bg-arc-cta hover:text-white"
        >
            {children}
        </button>
    );
}
