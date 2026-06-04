"use client";

import { ChevronDown, ChevronUp, Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Address } from "viem";

import { Modal } from "@/components/ui/Modal";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { cn } from "@/lib/utils";

type PoolType = "amm" | "v3";

interface FeeTier {
    bps: number;
    label: string;
    description: string;
    /** Surface a "Highest 1D Volume" pill on the tier the indexer reports as
     *  dominant - hard-coded to 0.30% for the AMM-heavy testnet for now. */
    highlight?: boolean;
}

const FEE_TIERS: FeeTier[] = [
    { bps: 1, label: "0.01% fee", description: "Best for very stable pairs." },
    { bps: 5, label: "0.05% fee", description: "Best for stable pairs." },
    { bps: 30, label: "0.3% fee", description: "Best for most pairs.", highlight: true },
    { bps: 100, label: "1% fee", description: "Best for exotic pairs." },
];

interface Pair {
    token0: { address: Address; symbol: string };
    token1: { address: Address; symbol: string };
}

interface Props {
    open: boolean;
    onClose: () => void;
    /** Pair the modal initialises with - typically the highest-TVL pool so the
     *  user lands on the flagship. Falls back to {USDC, USDC} if missing. */
    defaultPair?: Pair;
    tokens: TokenOption[];
}

/**
 * Two-step "Create a new pool" entry point that mirrors HyperSwap's modal:
 * pool type (Standard AMM vs Concentrated Liquidity), then the two tokens,
 * then (for CL only) a fee tier. The Continue button hands off to the live
 * add-liquidity surface at /positions; the modal itself just collects the
 * selection so the user doesn't have to scroll through a long form.
 */
export function CreatePoolModal({ open, onClose, defaultPair, tokens }: Props) {
    const router = useRouter();
    const [poolType, setPoolType] = useState<PoolType>("amm");
    const [token0, setToken0] = useState<TokenOption | undefined>(undefined);
    const [token1, setToken1] = useState<TokenOption | undefined>(undefined);
    const [feeBps, setFeeBps] = useState<number>(30);
    const [expandedFee, setExpandedFee] = useState(false);
    const [pickerFor, setPickerFor] = useState<0 | 1 | null>(null);

    // When the modal opens, hydrate the selection with the default flagship
    // pair so the user doesn't see empty pickers. Stays sticky across opens
    // within the same session.
    useEffect(() => {
        if (!open) return;
        if (!token0 && defaultPair) {
            const t0 = tokens.find(
                (t) => t.address.toLowerCase() === defaultPair.token0.address.toLowerCase(),
            );
            if (t0) setToken0(t0);
        }
        if (!token1 && defaultPair) {
            const t1 = tokens.find(
                (t) => t.address.toLowerCase() === defaultPair.token1.address.toLowerCase(),
            );
            if (t1) setToken1(t1);
        }
    }, [open, defaultPair, tokens, token0, token1]);

    const canContinue = Boolean(token0 && token1 && token0.address !== token1.address);

    const selectedTier = useMemo(
        () => FEE_TIERS.find((t) => t.bps === feeBps) ?? FEE_TIERS[2],
        [feeBps],
    );

    function handleContinue() {
        // For now both routes land on /positions - the V2 AMM card lives there
        // and the V3 concentrated UI ships with the next release. Token + tier
        // selection is preserved in the query string so the destination page
        // can prefill once that UI is in.
        if (!token0 || !token1) return;
        const params = new URLSearchParams({
            type: poolType,
            t0: token0.address,
            t1: token1.address,
        });
        if (poolType === "v3") params.set("fee", String(feeBps));
        router.push(`/positions?${params.toString()}`);
        onClose();
    }

    return (
        <>
            <Modal
                open={open}
                onClose={onClose}
                widthClassName="max-w-md"
                backdropClassName="bg-black/40 backdrop-blur-md"
                className="border-arc-border bg-black/40 backdrop-blur-2xl"
            >
                <div className="flex items-center justify-between px-5 pb-3 pt-5">
                    <h3 className="text-lg font-semibold">Create a new pool</h3>
                    <button
                        onClick={onClose}
                        className="rounded-full border border-arc-border bg-black/30 p-1.5 text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="space-y-3 px-5 pb-5">
                    {/* Pool-type toggle */}
                    <div className="flex items-center gap-2">
                        <TypeButton
                            active={poolType === "amm"}
                            onClick={() => setPoolType("amm")}
                        >
                            Standard AMM
                        </TypeButton>
                        <TypeButton
                            active={poolType === "v3"}
                            onClick={() => setPoolType("v3")}
                        >
                            Concentrated Liquidity
                        </TypeButton>
                    </div>

                    {/* Token pickers */}
                    <TokenRow
                        token={token0}
                        onPick={() => setPickerFor(0)}
                        label="Token 1"
                    />
                    <TokenRow
                        token={token1}
                        onPick={() => setPickerFor(1)}
                        label="Token 2"
                    />

                    {/* Fee tier (V3 only) */}
                    {poolType === "v3" && (
                        <div className="overflow-hidden rounded-2xl border border-arc-border bg-white/[0.015]">
                            <button
                                onClick={() => setExpandedFee((v) => !v)}
                                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
                            >
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-semibold">
                                            {selectedTier.label}
                                        </span>
                                        {selectedTier.highlight && (
                                            <span className="rounded-md bg-arc-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-arc-success">
                                                Highest 1D Volume
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-0.5 text-xs text-arc-text-muted">
                                        {selectedTier.description}
                                    </div>
                                </div>
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-arc-border bg-black/30 px-2.5 py-1 text-xs font-medium">
                                    {expandedFee ? (
                                        <ChevronUp className="h-3.5 w-3.5" />
                                    ) : (
                                        <ChevronDown className="h-3.5 w-3.5" />
                                    )}
                                    {expandedFee ? "Hide" : "More"}
                                </span>
                            </button>
                            {expandedFee && (
                                <div className="grid grid-cols-2 gap-2 border-t border-arc-border p-3">
                                    {FEE_TIERS.map((tier) => (
                                        <button
                                            key={tier.bps}
                                            onClick={() => setFeeBps(tier.bps)}
                                            className={cn(
                                                "relative rounded-xl border bg-white/[0.015] p-3 text-left transition-colors",
                                                feeBps === tier.bps
                                                    ? "border-arc-success/80 shadow-[0_0_18px_-4px_rgba(16,185,129,0.45)]"
                                                    : "border-arc-border hover:border-arc-cta-hover/40",
                                            )}
                                        >
                                            {feeBps === tier.bps && (
                                                <span className="absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-arc-success text-black">
                                                    <Check className="h-3 w-3" strokeWidth={3} />
                                                </span>
                                            )}
                                            <div className="text-sm font-semibold">
                                                {tier.label}
                                            </div>
                                            <div className="mt-0.5 text-[11px] text-arc-text-muted">
                                                {tier.description}
                                            </div>
                                            <div className="mt-2 text-[11px] tabular-nums text-arc-text-faint">
                                                — 1D Volume
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <button
                        onClick={handleContinue}
                        disabled={!canContinue}
                        className={cn(
                            "mt-1 w-full rounded-2xl py-3.5 text-base font-semibold transition-colors",
                            canContinue
                                ? "bg-arc-cta text-white hover:bg-arc-cta-hover"
                                : "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted",
                        )}
                    >
                        Continue
                    </button>
                </div>
            </Modal>

            {/* Token-select sub-modals share TokenSelectModal so the search /
                pinned tokens behaviour matches Swap and Add-Liquidity. */}
            <TokenSelectModal
                open={pickerFor !== null}
                onClose={() => setPickerFor(null)}
                tokens={tokens}
                onSelect={(t) => {
                    if (pickerFor === 0) setToken0(t);
                    else if (pickerFor === 1) setToken1(t);
                    setPickerFor(null);
                }}
                selectedAddress={
                    pickerFor === 0 ? token0?.address : token1?.address
                }
                excludeAddress={
                    pickerFor === 0 ? token1?.address : token0?.address
                }
            />
        </>
    );
}

function TypeButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "rounded-xl px-3.5 py-1.5 text-sm font-medium transition-colors",
                active
                    ? "bg-arc-surface-3 text-arc-text"
                    : "bg-arc-surface-2 text-arc-text-muted hover:bg-arc-surface-3 hover:text-arc-text",
            )}
        >
            {children}
        </button>
    );
}

function TokenRow({
    token,
    onPick,
    label,
}: {
    token: TokenOption | undefined;
    onPick: () => void;
    label: string;
}) {
    return (
        <button
            onClick={onPick}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-arc-border bg-white/[0.015] px-4 py-3.5 text-left transition-colors hover:bg-white/[0.025]"
        >
            <div className="flex min-w-0 items-center gap-3">
                {token ? (
                    <>
                        <AutoTokenIcon
                            address={token.address}
                            symbol={token.symbol}
                            size={28}
                        />
                        <span className="text-base font-semibold">
                            {token.symbol ?? "?"}
                        </span>
                    </>
                ) : (
                    <span className="text-sm text-arc-text-muted">{label}</span>
                )}
            </div>
            <ChevronDown className="h-4 w-4 text-arc-text-muted" />
        </button>
    );
}
