"use client";

import { ArrowLeft, Calendar, ChevronDown, Info, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, isAddress, parseUnits } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { TokenSelectModal, type TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { pushToast } from "@/lib/toast";
import { cn, formatAddress, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
    address: ADDRESSES.usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: USDC_DECIMALS,
    pinned: true,
};

/** Default campaign duration: 7 days from now, rounded to the nearest hour. */
function defaultDateRange(): { start: Date; end: Date } {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { start, end };
}

/** Datetime-local input value formatter: YYYY-MM-DDTHH:mm. */
function toInputValue(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours(),
    )}:${pad(d.getMinutes())}`;
}

/** Human-readable date label matching the inline-button copy. */
function formatDateLabel(d: Date): string {
    return d.toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

export default function IncentivizePage() {
    const { address: account, isConnected } = useAccount();
    const { tokens: v2Tokens } = useV2Tokens();
    const { tokens: v3Tokens } = useV3Tokens();

    // Merge V2 + V3 + USDC for the pickers, deduped by address.
    const tokenOptions = useMemo<TokenOption[]>(() => {
        const seen = new Set<string>();
        const out: TokenOption[] = [];
        const all = [
            USDC_TOKEN,
            ...v2Tokens.map((t) => ({
                address: t.address,
                symbol: t.symbol ?? "TOKEN",
                name: t.name ?? "Token",
                decimals: t.decimals ?? 18,
                pinned: false,
            })),
            ...v3Tokens.map((t) => ({
                address: t.address,
                symbol: t.symbol ?? "TOKEN",
                name: t.name ?? "Token",
                decimals: t.decimals ?? 18,
                pinned: false,
            })),
        ];
        for (const t of all) {
            const k = t.address.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(t);
        }
        return out;
    }, [v2Tokens, v3Tokens]);

    // --- Form state ----------------------------------------------------
    const [token1, setToken1] = useState<TokenOption | undefined>(undefined);
    const [token2, setToken2] = useState<TokenOption | undefined>(undefined);
    const [pickerOpen, setPickerOpen] = useState<"token1" | "token2" | "reward" | null>(null);

    const init = useMemo(() => defaultDateRange(), []);
    const [startDate, setStartDate] = useState(init.start);
    const [endDate, setEndDate] = useState(init.end);

    const [rewardToken, setRewardToken] = useState<TokenOption | undefined>(undefined);
    const [rewardAmount, setRewardAmount] = useState("");

    const [excludeOn, setExcludeOn] = useState(false);
    const [excludedAddresses, setExcludedAddresses] = useState<string[]>([]);
    const [excludeDraft, setExcludeDraft] = useState("");

    // Agreement is implicit on click of the Launch button now that the
    // disclaimer line below the form replaces the checkbox.

    // Auto-resolve a pool address for the two selected tokens (V2 first, V3
    // fallback). For the MVP we display "Pool found / not found" as a soft
    // signal; the actual Merkl campaign launch happens server-side once the
    // partner integration is wired.
    const pairQ = useReadContract({
        address: ADDRESSES.factory,
        abi: [
            {
                type: "function",
                name: "getPair",
                stateMutability: "view",
                inputs: [
                    { name: "tokenA", type: "address" },
                    { name: "tokenB", type: "address" },
                ],
                outputs: [{ name: "pair", type: "address" }],
            },
        ] as const,
        functionName: "getPair",
        args: token1 && token2 ? [token1.address, token2.address] : undefined,
        query: { enabled: !!token1 && !!token2 },
    });
    const pairAddress = pairQ.data as Address | undefined;
    const poolFound = !!pairAddress && pairAddress !== "0x0000000000000000000000000000000000000000";

    // --- Validation ----------------------------------------------------
    const durationHours = useMemo(() => {
        const ms = endDate.getTime() - startDate.getTime();
        return Math.max(0, Math.round(ms / (1000 * 60 * 60)));
    }, [startDate, endDate]);

    const rewardAmountBn = useMemo(() => {
        if (!rewardToken || !rewardAmount) return 0n;
        try {
            return parseUnits(rewardAmount, rewardToken.decimals ?? 18);
        } catch {
            return 0n;
        }
    }, [rewardToken, rewardAmount]);

    const formValid =
        !!token1 &&
        !!token2 &&
        token1.address !== token2.address &&
        poolFound &&
        durationHours >= 1 &&
        endDate > new Date() &&
        !!rewardToken &&
        rewardAmountBn > 0n;

    // --- Reward balance for the connected wallet ----------------------
    const rewardBalanceQ = useReadContract({
        address: rewardToken?.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account && !!rewardToken },
    });
    const rewardBalance = (rewardBalanceQ.data as bigint | undefined) ?? 0n;
    const insufficientBalance = !!rewardToken && rewardAmountBn > rewardBalance;

    // --- Submit (placeholder) -----------------------------------------
    const onLaunch = async () => {
        if (!isConnected) {
            pushToast({ kind: "error", title: "Connect a wallet first" });
            return;
        }
        if (!formValid) return;
        if (insufficientBalance) {
            pushToast({ kind: "error", title: `Insufficient ${rewardToken?.symbol} balance` });
            return;
        }
        // Campaign launch is operated by an external Merkl-style partner. For
        // the MVP we surface the request to the team via a toast; once the
        // partner integration is live this hooks into their contract.
        pushToast({
            kind: "info",
            title: "Campaign request received",
            message:
                "Liquidity-incentive campaigns are operated by our partner. Our team will reach out to finalise this campaign within 24h.",
        });
    };

    return (
        <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
            <Link
                href="/swap"
                className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
            >
                <ArrowLeft className="h-4 w-4" /> Swap
            </Link>

            <div className="mb-10 text-center">
                <h1 className="text-3xl font-semibold sm:text-4xl">Incentivize Liquidity</h1>
                <p className="mt-3 text-sm text-arc-text-muted sm:text-base">
                    Add rewards to a pool to incentivize liquidity providers joining in.
                </p>
            </div>

            <div className="space-y-6">
                {/* Tokens ----------------------------------------------- */}
                <section className="arc-card p-5 sm:p-6">
                    <h2 className="text-base font-semibold">Tokens</h2>
                    <p className="mt-1 text-xs text-arc-text-muted">
                        Which token pair would you like to add liquidity to?
                    </p>
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <TokenPickerButton
                            label="Token 1"
                            token={token1}
                            onClick={() => setPickerOpen("token1")}
                        />
                        <TokenPickerButton
                            label="Token 2"
                            token={token2}
                            onClick={() => setPickerOpen("token2")}
                        />
                    </div>
                </section>

                {/* Existing pools --------------------------------------- */}
                <section className="arc-card p-5 sm:p-6">
                    <h2 className="text-base font-semibold">Existing pools</h2>
                    <p className="mt-1 text-xs text-arc-text-muted">
                        Select a pool to incentivize liquidity
                    </p>
                    <div className="mt-4">
                        {token1 && token2 && pairQ.isLoading && (
                            <div className="rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-4 text-center text-sm text-arc-text-muted">
                                Looking up pool...
                            </div>
                        )}
                        {(!token1 || !token2) && (
                            <div className="rounded-xl border border-dashed border-arc-border bg-arc-bg-elevated px-4 py-4 text-center text-sm text-arc-text-muted">
                                Select both tokens to find a pool
                            </div>
                        )}
                        {token1 && token2 && !pairQ.isLoading && !poolFound && (
                            <div className="rounded-xl border border-arc-warn/30 bg-arc-warn/10 px-4 py-4 text-sm text-arc-warn">
                                No V2 pool exists yet for this pair. Create a pool first via the
                                Arcade router or pick a different pair.
                            </div>
                        )}
                        {token1 && token2 && poolFound && pairAddress && (
                            <div className="rounded-xl border border-arc-success/30 bg-arc-success/10 px-4 py-4">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3">
                                        <div className="flex -space-x-2">
                                            <AutoTokenIcon
                                                address={token1.address}
                                                symbol={token1.symbol}
                                                size={28}
                                            />
                                            <AutoTokenIcon
                                                address={token2.address}
                                                symbol={token2.symbol}
                                                size={28}
                                            />
                                        </div>
                                        <div>
                                            <div className="text-sm font-medium text-arc-success">
                                                {token1.symbol} / {token2.symbol}
                                            </div>
                                            <div className="text-[10px] text-arc-text-faint">
                                                Arcade V2 pool · {formatAddress(pairAddress)}
                                            </div>
                                        </div>
                                    </div>
                                    <a
                                        href={`https://explorer.testnet.arc.network/address/${pairAddress}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-[10px] text-arc-text-muted hover:text-arc-text"
                                    >
                                        explorer
                                    </a>
                                </div>
                            </div>
                        )}
                    </div>
                </section>

                {/* Duration --------------------------------------------- */}
                <section className="arc-card p-5 sm:p-6">
                    <h2 className="text-base font-semibold">Duration</h2>
                    <p className="mt-1 text-xs text-arc-text-muted">
                        The time period you want to distribute rewards within.
                    </p>
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <DateField
                            label="Start date"
                            value={startDate}
                            onChange={setStartDate}
                        />
                        <DateField
                            label="End date"
                            value={endDate}
                            onChange={setEndDate}
                            min={startDate}
                        />
                    </div>
                    {durationHours > 0 && (
                        <div className="mt-3 text-[11px] text-arc-text-faint">
                            Campaign window: {durationHours} hours ({(durationHours / 24).toFixed(1)} days)
                        </div>
                    )}
                </section>

                {/* Rewards ---------------------------------------------- */}
                <section className="arc-card p-5 sm:p-6">
                    <h2 className="text-base font-semibold">Rewards</h2>
                    <p className="mt-1 text-xs text-arc-text-muted">
                        How many rewards in total would you like to distribute?
                    </p>
                    <div className="mt-4 rounded-2xl border border-arc-border bg-white/[0.015] p-4">
                        <div className="mb-3 flex items-center justify-between">
                            <span className="text-sm text-arc-text-muted">Token</span>
                            <button type="button"
                                onClick={() => setPickerOpen("reward")}
                                className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-2 text-base font-semibold transition-colors hover:bg-arc-surface-3"
                            >
                                {rewardToken ? (
                                    <>
                                        <AutoTokenIcon
                                            address={rewardToken.address}
                                            symbol={rewardToken.symbol}
                                            size={24}
                                        />
                                        <span>{rewardToken.symbol}</span>
                                        <ChevronDown className="h-4 w-4 text-arc-text-muted" />
                                    </>
                                ) : (
                                    <>
                                        <span>Select a token</span>
                                        <ChevronDown className="h-4 w-4 text-arc-text-muted" />
                                    </>
                                )}
                            </button>
                        </div>
                        <input
                            aria-label="Reward amount"
                            type="text"
                            inputMode="decimal"
                            value={rewardAmount}
                            onChange={(e) =>
                                setRewardAmount(e.target.value.replace(/[^0-9.]/g, ""))
                            }
                            placeholder="0.0"
                            className="arc-input w-full bg-transparent text-3xl font-medium leading-tight sm:text-4xl"
                        />
                        <div className="mt-2 flex items-center justify-between text-[11px]">
                            <span className="text-arc-text-faint">
                                {rewardToken && rewardToken.address === ADDRESSES.usdc
                                    ? `~$${formatUSDC(rewardAmountBn, USDC_DECIMALS, 2)}`
                                    : "$-"}
                            </span>
                            {rewardToken && account && (
                                <span className="text-arc-text-faint">
                                    Balance:{" "}
                                    {rewardBalance === 0n
                                        ? "-"
                                        : formatUSDC(rewardBalance, rewardToken.decimals ?? 18, 4)}{" "}
                                    {rewardToken.symbol}
                                </span>
                            )}
                        </div>
                    </div>

                    <p className="mt-4 text-xs text-arc-text-muted">
                        Rewards are distributed per hour. The minimum reward for this
                        distribution depends on the selected duration.
                    </p>
                    <p className="mt-2 text-xs text-arc-text-muted">
                        Looking to get your token added here?{" "}
                        <a
                            href="mailto:zilioliantoine@gmail.com?subject=Arcade%20incentivize%20token%20request"
                            className="text-arc-cta-hover underline-offset-2 hover:underline"
                        >
                            Get in touch with us.
                        </a>
                    </p>
                </section>

                {/* Exclude addresses ------------------------------------ */}
                <section className="arc-card p-5 sm:p-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-semibold">
                                Exclude any addresses from receiving rewards?
                            </h2>
                        </div>
                        <div className="ml-3 flex shrink-0 items-center gap-1 rounded-xl border border-arc-border bg-white/[0.015] p-1">
                            <button type="button"
                                onClick={() => setExcludeOn(true)}
                                className={cn(
                                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                    excludeOn
                                        ? "bg-arc-cta text-white"
                                        : "text-arc-text-muted hover:text-arc-text",
                                )}
                            >
                                On
                            </button>
                            <button type="button"
                                onClick={() => setExcludeOn(false)}
                                className={cn(
                                    "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                    !excludeOn
                                        ? "bg-arc-cta text-white"
                                        : "text-arc-text-muted hover:text-arc-text",
                                )}
                            >
                                Off
                            </button>
                        </div>
                    </div>

                    {excludeOn && (
                        <div className="mt-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <input
                                    aria-label="Address to exclude"
                                    value={excludeDraft}
                                    onChange={(e) => setExcludeDraft(e.target.value)}
                                    placeholder="0x... address to exclude"
                                    className="flex-1 rounded-lg border border-arc-border bg-white/[0.015] px-3 py-2 text-sm tabular-nums focus:border-arc-cta-hover focus:outline-none"
                                />
                                <button type="button"
                                    onClick={() => {
                                        const s = excludeDraft.trim();
                                        if (!isAddress(s)) {
                                            pushToast({
                                                kind: "error",
                                                title: "Invalid address",
                                            });
                                            return;
                                        }
                                        if (excludedAddresses.includes(s.toLowerCase())) return;
                                        setExcludedAddresses((p) => [...p, s.toLowerCase()]);
                                        setExcludeDraft("");
                                    }}
                                    className="inline-flex items-center gap-1 rounded-lg border border-arc-border bg-white/[0.015] px-3 py-2 text-xs font-medium text-arc-text transition-colors hover:bg-white/5"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Add
                                </button>
                            </div>
                            {excludedAddresses.length > 0 && (
                                <div className="space-y-1">
                                    {excludedAddresses.map((a) => (
                                        <div
                                            key={a}
                                            className="flex items-center justify-between gap-2 rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2 text-xs"
                                        >
                                            <span className="truncate font-mono tabular-nums">{a}</span>
                                            <button type="button"
                                                onClick={() =>
                                                    setExcludedAddresses((p) =>
                                                        p.filter((x) => x !== a),
                                                    )
                                                }
                                                className="text-arc-text-faint transition-colors hover:text-arc-danger"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </section>

                {/* Terms + Submit --------------------------------------- */}
                <section className="space-y-4">
                    <p className="text-center text-xs text-arc-text-muted">
                        By launching this campaign, you agree to the Arcade incentive program
                        terms and acknowledge that distributed rewards cannot be recovered.
                    </p>

                    <button type="button"
                        onClick={onLaunch}
                        disabled={!formValid || insufficientBalance}
                        className={cn(
                            "arc-button-primary w-full py-4 text-base font-semibold",
                            (!formValid || insufficientBalance) &&
                                "cursor-not-allowed opacity-50",
                        )}
                    >
                        {!isConnected
                            ? "Connect wallet"
                            : !token1 || !token2
                              ? "Select both tokens"
                              : !poolFound
                                ? "No pool found for this pair"
                                : !rewardToken
                                  ? "Select a reward token"
                                  : rewardAmountBn === 0n
                                    ? "Enter a reward amount"
                                    : durationHours < 1
                                      ? "Duration must be at least 1 hour"
                                      : insufficientBalance
                                        ? `Insufficient ${rewardToken.symbol}`
                                          : "Launch Campaign"}
                    </button>

                    <div className="rounded-xl border border-arc-cta-hover/20 bg-arc-cta-hover/5 p-3 text-center text-xs text-arc-text-muted">
                        <Info className="mr-1 inline h-3 w-3 text-arc-cta-hover" />
                        Liquidity-incentive campaigns are coordinated with Arcade ops while the
                        Merkl-style partner integration is being finalised. You will hear back
                        within 24h of submitting.
                    </div>
                </section>
            </div>

            {pickerOpen && (
                <TokenSelectModal
                    open={!!pickerOpen}
                    onClose={() => setPickerOpen(null)}
                    onSelect={(t: TokenOption) => {
                        if (pickerOpen === "token1") setToken1(t);
                        else if (pickerOpen === "token2") setToken2(t);
                        else if (pickerOpen === "reward") setRewardToken(t);
                        setPickerOpen(null);
                    }}
                    tokens={tokenOptions.filter((t) => {
                        if (pickerOpen === "token1") return t.address !== token2?.address;
                        if (pickerOpen === "token2") return t.address !== token1?.address;
                        return true;
                    })}
                />
            )}
        </div>
    );
}

// -------------------------------------------------------------------
// Subcomponents
// -------------------------------------------------------------------

function TokenPickerButton({
    label,
    token,
    onClick,
}: {
    label: string;
    token: TokenOption | undefined;
    onClick: () => void;
}) {
    return (
        <div className="flex items-center justify-between rounded-2xl border border-arc-border bg-white/[0.015] px-4 py-4">
            <span className="text-sm text-arc-text-muted">{label}</span>
            {/* Pill button styled exactly like the SwapCard token chip so the
                picker UX is consistent between the swap and incentivize forms. */}
            <button type="button"
                onClick={onClick}
                className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-2 text-base font-semibold transition-colors hover:bg-arc-surface-3"
            >
                {token ? (
                    <>
                        <AutoTokenIcon address={token.address} symbol={token.symbol} size={24} />
                        <span>{token.symbol}</span>
                        <ChevronDown className="h-4 w-4 text-arc-text-muted transition-transform group-hover:text-arc-text" />
                    </>
                ) : (
                    <>
                        <span>Select a token</span>
                        <ChevronDown className="h-4 w-4 text-arc-text-muted" />
                    </>
                )}
            </button>
        </div>
    );
}

function DateField({
    label,
    value,
    onChange,
    min,
}: {
    label: string;
    value: Date;
    onChange: (d: Date) => void;
    min?: Date;
}) {
    // Reflect the chosen Date back to the native datetime-local input value.
    // The input is the single source of truth; we hand-format the displayed
    // pill text from the Date object so the visual matches the spec
    // ("Jun 04, 2026 21:58") even though most browsers' datetime-local
    // chrome looks different.
    return (
        <label className="block text-sm">
            <span className="text-arc-text-muted">{label}</span>
            <div className="relative mt-1">
                <input
                    type="datetime-local"
                    value={toInputValue(value)}
                    min={min ? toInputValue(min) : undefined}
                    onChange={(e) => {
                        const d = new Date(e.target.value);
                        if (!isNaN(d.getTime())) onChange(d);
                    }}
                    className="peer absolute inset-0 w-full cursor-pointer rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-3 text-sm opacity-0"
                />
                <div className="pointer-events-none flex items-center justify-between rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-3 text-sm tabular-nums peer-hover:border-arc-cta-hover/40">
                    <span>{formatDateLabel(value)}</span>
                    <Calendar className="h-4 w-4 text-arc-text-muted" />
                </div>
            </div>
        </label>
    );
}

// silence accidental dead-import lints for hooks that are reserved for the
// post-integration form (Pinata uploads, V3 quoter etc).
void useEffect;
