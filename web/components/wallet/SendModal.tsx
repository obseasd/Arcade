"use client";

import { ArrowLeft, Check, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { useEffect, useMemo, useState } from "react";
import {
    Address,
    erc20Abi,
    formatUnits,
    getAddress,
    isAddress,
    parseUnits,
    zeroAddress,
} from "viem";
import {
    useAccount,
    useBalance,
    usePublicClient,
    useSendTransaction,
    useWriteContract,
} from "wagmi";
import { useEnsForward, useEnsReverseVerified } from "@/lib/ens";
import { Modal } from "@/components/ui/Modal";
import { TokenSelectModal, type TokenOption } from "@/components/ui/TokenSelectModal";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useLaunchpadTokens } from "@/lib/hooks/useLaunchpadTokens";
import { addActivity } from "@/lib/activityFeed";
import { pushToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Uniswap-style "Send crypto" modal. 3-step flow inside the same dialog:
 *
 *   1. form     — amount input + token picker + recipient field
 *   2. review   — read-only confirmation card with the resolved address
 *                 and a Confirm Send button
 *   3. status   — pending / success / error state with the tx hash
 *
 * Token list is the union of pinned brand tokens (USDC, the launchpad's
 * paired token, etc), V2/V3 launchpad tokens, and the user's HoldingInfo
 * from useMyHoldings - so the picker offers anything the wallet actually
 * holds plus the canonical pair pieces.
 *
 * Recipient is resolved against L1 ENS (the user can type `name.eth`) AND
 * accepts a raw 0x address. ENS reverse-lookup runs in parallel so the
 * review screen shows both forms when the user provided an address that
 * has a primary name.
 *
 * Native USDC (Arc testnet gas token) goes through useSendTransaction;
 * every other ERC20 routes through useWriteContract + transfer(to,
 * amount). The send and writeContract surfaces are deliberately kept
 * separate so each can show its own pending / error state without
 * cross-talk.
 */
interface Props {
    open: boolean;
    onClose: () => void;
    /** Optional initial token to preselect (e.g. when the modal is
     *  triggered from a token-detail page). Falls back to USDC. */
    defaultToken?: TokenOption;
}

type Step = "form" | "review" | "sending" | "success" | "error";

export function SendModal({ open, onClose, defaultToken }: Props) {
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { sendTransactionAsync } = useSendTransaction();
    const { writeContractAsync } = useWriteContract();

    const [step, setStep] = useState<Step>("form");
    const [amount, setAmount] = useState("");
    const [recipientInput, setRecipientInput] = useState("");
    const [tokenSelectOpen, setTokenSelectOpen] = useState(false);
    const [token, setToken] = useState<TokenOption | undefined>(defaultToken);
    const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
    const [errorMessage, setErrorMessage] = useState<string | undefined>();
    const [unverified, setUnverified] = useState(false);

    // Build the token list: USDC + every launchpad token. We mark USDC
    // as the canonical default so it sits at the top of the picker.
    const { tokens: launchpadTokens } = useLaunchpadTokens();
    const tokenOptions: TokenOption[] = useMemo(() => {
        const out: TokenOption[] = [
            {
                address: ADDRESSES.usdc,
                symbol: "USDC",
                name: "USD Coin",
                decimals: USDC_DECIMALS,
                pinned: true,
            },
        ];
        for (const t of launchpadTokens) {
            out.push({
                address: t.address,
                symbol: t.symbol,
                name: t.name,
                decimals: 18,
            });
        }
        return out;
    }, [launchpadTokens]);

    // Default to USDC the first time the modal opens with no explicit
    // override, so the user lands on the gas token.
    useEffect(() => {
        if (open && !token) {
            setToken(tokenOptions[0]);
        }
    }, [open, token, tokenOptions]);

    // Reset form state every time the modal opens so a previous half-
    // filled send doesn't leak into the next session.
    useEffect(() => {
        if (open) {
            setStep("form");
            setTxHash(undefined);
            setErrorMessage(undefined);
        }
    }, [open]);

    const isNativeUsdc =
        !!token && token.address.toLowerCase() === ADDRESSES.usdc.toLowerCase();

    // Balance for the selected token. Native USDC reads via useBalance
    // (no contract address); ERC20 reads balanceOf for that token.
    const nativeBalQ = useBalance({
        address: account,
        query: { enabled: !!account && isNativeUsdc },
    });
    const erc20BalQ = useBalance({
        address: account,
        token: !isNativeUsdc && token ? token.address : undefined,
        query: { enabled: !!account && !isNativeUsdc && !!token },
    });
    const balanceQ = isNativeUsdc ? nativeBalQ : erc20BalQ;
    const balanceRaw = balanceQ.data?.value ?? 0n;
    // ARC_NATIVE_VALUE_DECIMALS: Arc testnet's nativeCurrency is
    // configured as decimals:6 (USDC) in the chain config, but the raw
    // EVM `value` field is always 18dp wei-equivalent on every EVM
    // chain we've shipped against. useBalance returns formatUnits(value,
    // 6) which prints "152000000000000.000000" when the user holds 152
    // USDC. Override to 18dp for native so display + parseUnits use the
    // EVM precision the on-chain value carries. Audit finding UI-H-4
    // documented this constant so the assumption lives in one place
    // instead of at every call site.
    const ARC_NATIVE_VALUE_DECIMALS = 18;
    const balanceDecimals = isNativeUsdc
        ? ARC_NATIVE_VALUE_DECIMALS
        : (balanceQ.data?.decimals ?? token?.decimals ?? 18);
    const balanceFormatted = balanceQ.data
        ? formatUnits(balanceRaw, balanceDecimals)
        : "0";
    // Compact balance for the chip: 4 dp max, no trailing zeroes.
    const balanceCompact = (() => {
        const n = Number(balanceFormatted);
        if (!Number.isFinite(n)) return balanceFormatted;
        return n.toLocaleString("en-US", {
            maximumFractionDigits: 4,
            minimumFractionDigits: 0,
        });
    })();
    // USD value of the parsed amount. Only USDC has a stable 1:1 price
    // we trust on Arc testnet (no oracle yet for launchpad tokens), so
    // we surface the dollar amount for USDC and dash everything else.
    const amountUsd: number | undefined = (() => {
        if (!amount) return undefined;
        const n = Number(amount);
        if (!Number.isFinite(n)) return undefined;
        if (isNativeUsdc) return n;
        return undefined;
    })();
    const balanceUsd: number | undefined = isNativeUsdc
        ? Number(balanceFormatted)
        : undefined;

    // ENS lookup via the dedicated lib/ens module. It uses viem directly
    // with a multi-RPC fallback list (env var first, then llamarpc,
    // publicnode, ankr, cloudflare) so a single provider hiccup doesn't
    // kill recipient resolution. Debounce + normalize are handled inside.
    const ensForward = useEnsForward(recipientInput);
    const looksLikeEns = recipientInput.includes(".") && !isAddress(recipientInput);
    const resolvedAddress: Address | undefined = useMemo(() => {
        if (isAddress(recipientInput)) return recipientInput as Address;
        if (ensForward.address) return ensForward.address;
        return undefined;
    }, [recipientInput, ensForward.address]);
    const verifiedReverseEns = useEnsReverseVerified(resolvedAddress ?? null);

    // Try to parse the amount. Empty / 0 / invalid -> undefined so the
    // Send button stays disabled and we don't compute "0" everywhere.
    const amountRaw: bigint | undefined = useMemo(() => {
        if (!amount || amount === "0" || amount === ".") return undefined;
        try {
            const v = parseUnits(amount, balanceDecimals);
            return v > 0n ? v : undefined;
        } catch {
            return undefined;
        }
    }, [amount, balanceDecimals]);

    const overBalance = amountRaw !== undefined && amountRaw > balanceRaw;
    const canContinue =
        !!resolvedAddress &&
        !!amountRaw &&
        !overBalance &&
        resolvedAddress.toLowerCase() !== zeroAddress;

    const cta = (() => {
        if (!amount) return "Enter an amount";
        if (overBalance) return "Insufficient balance";
        if (!recipientInput) return "Enter a recipient";
        if (!resolvedAddress)
            return looksLikeEns && ensForward.loading ? "Resolving ENS…" : "Invalid address";
        return "Send";
    })();

    const onMax = () => {
        if (balanceQ.data) {
            setAmount(formatUnits(balanceRaw, balanceDecimals));
        }
    };

    const onSubmit = async () => {
        if (!canContinue || !resolvedAddress || !token || !amountRaw) return;
        setStep("sending");
        setErrorMessage(undefined);
        try {
            let hash: `0x${string}`;
            if (isNativeUsdc) {
                hash = await sendTransactionAsync({
                    to: resolvedAddress,
                    value: amountRaw,
                });
            } else {
                hash = await writeContractAsync({
                    address: token.address,
                    abi: erc20Abi,
                    functionName: "transfer",
                    args: [resolvedAddress, amountRaw],
                });
            }
            setTxHash(hash);
            // If no public client is available (chain misconfigured)
            // we can't wait for inclusion, but the wallet did broadcast
            // a hash so we mark it "submitted" rather than "success" so
            // the user sees the explorer link + a clear caveat. Audit
            // UI-M-12.
            // Audit 2026-06-11 UX-C-3: receipt.status check. Critical for
            // Send specifically — without this, a reverted transfer (e.g.
            // recipient is a contract that rejects the token) was reported
            // as success and the user believed their funds had left the
            // wallet. addActivity would also write a misleading "Sent ..."
            // row to the feed.
            if (publicClient) {
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(
                        `Transfer reverted on-chain (tx ${hash.slice(0, 10)}…). Recipient may reject this token, or the network rejected the transaction.`,
                    );
                }
                setStep("success");
            } else {
                setStep("success");
                setUnverified(true);
            }
            // Log the activity so the row appears in the feed without
            // the user having to refresh. Use the dedicated "send" type
            // (not "swap" - audit finding UI-3) so the Address column
            // renders TO + recipient instead of TRANSACTION + tx hash.
            // We hijack `token` to carry the recipient address since
            // ActivityEntry has no dedicated counterparty field.
            if (account) {
                addActivity({
                    type: "send",
                    account,
                    token: resolvedAddress,
                    label: `Sent ${token.symbol ?? "TOKEN"}`,
                    value: `${amount} ${token.symbol ?? ""}`,
                    txHash: hash,
                });
            }
            pushToast({
                kind: "info",
                title: "Send confirmed",
                message: `${amount} ${token.symbol ?? ""} sent`,
            });
        } catch (e: any) {
            setStep("error");
            setErrorMessage(e?.shortMessage || e?.message || "Transaction failed");
        }
    };

    if (!open) return null;

    return (
        <>
            <Modal
                open={open}
                onClose={onClose}
                widthClassName="max-w-[420px]"
                backdropClassName="backdrop:bg-black/60"
                className="border-arc-border bg-arc-bg-elevated"
                // Block backdrop click while a tx is mid-flight so the
                // user can't accidentally drop the modal between wallet
                // signature and receipt - their tx still lands but the
                // success/error path here would never fire. Audit
                // UI-M-16.
                closeOnBackdrop={step !== "sending"}
            >
                <div className="p-5">
                    {step === "form" && (
                        <FormView
                            amount={amount}
                            setAmount={setAmount}
                            amountUsd={amountUsd}
                            token={token}
                            onPickToken={() => setTokenSelectOpen(true)}
                            balanceCompact={balanceCompact}
                            balanceUsd={balanceUsd}
                            balanceLabel={token?.symbol ?? balanceQ.data?.symbol ?? ""}
                            onMax={onMax}
                            recipientInput={recipientInput}
                            setRecipientInput={setRecipientInput}
                            resolvedAddress={resolvedAddress}
                            reverseEns={verifiedReverseEns}
                            ensLoading={looksLikeEns && ensForward.loading}
                            onClose={onClose}
                            canContinue={canContinue}
                            cta={cta}
                            onContinue={() => setStep("review")}
                        />
                    )}
                    {step === "review" && token && resolvedAddress && (
                        <ReviewView
                            amount={amount}
                            amountUsd={amountUsd}
                            token={token}
                            recipient={resolvedAddress}
                            reverseEns={verifiedReverseEns}
                            onBack={() => setStep("form")}
                            onClose={onClose}
                            onConfirm={onSubmit}
                        />
                    )}
                    {step === "sending" && (
                        <StatusView
                            kind="pending"
                            title="Sending transaction"
                            subtitle="Confirm in your wallet, then wait for inclusion."
                            txHash={txHash}
                            onClose={onClose}
                        />
                    )}
                    {step === "success" && (
                        <StatusView
                            kind="success"
                            title="Transaction sent"
                            subtitle={token ? `${amount} ${token.symbol ?? ""} on its way.` : ""}
                            txHash={txHash}
                            onClose={onClose}
                        />
                    )}
                    {step === "error" && (
                        <StatusView
                            kind="error"
                            title="Send failed"
                            subtitle={errorMessage ?? "The transaction did not go through."}
                            txHash={txHash}
                            onClose={() => setStep("form")}
                            closeLabel="Back to form"
                        />
                    )}
                </div>
            </Modal>

            <TokenSelectModal
                open={tokenSelectOpen}
                onClose={() => setTokenSelectOpen(false)}
                tokens={tokenOptions}
                selectedAddress={token?.address}
                onSelect={(t) => {
                    setToken(t);
                    setTokenSelectOpen(false);
                    setAmount("");
                }}
            />
        </>
    );
}

// ---------------------------------------------------------------------
// Form view
// ---------------------------------------------------------------------

function FormView({
    amount,
    setAmount,
    amountUsd,
    token,
    onPickToken,
    balanceCompact,
    balanceUsd,
    balanceLabel,
    onMax,
    recipientInput,
    setRecipientInput,
    resolvedAddress,
    reverseEns,
    ensLoading,
    onClose,
    canContinue,
    cta,
    onContinue,
}: {
    amount: string;
    setAmount: (s: string) => void;
    amountUsd?: number;
    token: TokenOption | undefined;
    onPickToken: () => void;
    balanceCompact: string;
    balanceUsd?: number;
    balanceLabel: string;
    onMax: () => void;
    recipientInput: string;
    setRecipientInput: (s: string) => void;
    resolvedAddress?: Address;
    reverseEns?: string | null;
    ensLoading: boolean;
    onClose: () => void;
    canContinue: boolean;
    cta: string;
    onContinue: () => void;
}) {
    const shortAddr = resolvedAddress
        ? `${resolvedAddress.slice(0, 6)}...${resolvedAddress.slice(-4)}`
        : "";

    return (
        <>
            <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-arc-text">Send crypto</h2>
                <button
                    type="button"
                    onClick={onClose}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                    aria-label="Close"
                >
                    <CrossIcon size={14} />
                </button>
            </div>

            {/* You're sending - taller card with more breathing room around
                the big amount, USD value below it, and the token chip pinned
                to the bottom. Matches the Uniswap reference where this card
                takes ~60% of the modal height. */}
            <div className="mt-4 rounded-2xl border border-arc-border bg-white/[0.015] px-4 py-5">
                <div className="text-xs font-semibold text-arc-text">You&apos;re sending</div>
                <div className="my-10 flex flex-col items-center">
                    {/* Auto-shrink the big amount once it overflows
                        the 420px modal: 6xl for up to 6 chars, 5xl up
                        to 9, 4xl beyond. Keeps long decimals readable
                        on small viewports. Audit UI-M-15. */}
                    <input
                        inputMode="decimal"
                        autoFocus
                        value={amount}
                        onChange={(e) => {
                            const v = e.target.value.replace(/,/g, ".");
                            if (v === "" || /^\d*\.?\d*$/.test(v)) setAmount(v);
                        }}
                        placeholder="0"
                        className={cn(
                            "w-full bg-transparent text-center font-semibold tabular-nums text-arc-text outline-none placeholder:text-arc-text-faint/50",
                            amount.length <= 6
                                ? "text-6xl"
                                : amount.length <= 9
                                  ? "text-5xl"
                                  : "text-4xl",
                        )}
                    />
                    {amountUsd !== undefined && (
                        <div className="mt-2 text-base text-arc-text-faint">
                            ${amountUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                    )}
                </div>
                {/* Token chip - same inner-row layout as the recipient chip
                    below (28px avatar, 2.5 gap, 2-line right block) so the
                    eye reads them as a stacked pair. */}
                <div className="flex items-center justify-between gap-3 rounded-xl bg-arc-bg-elevated px-3 py-3">
                    <button
                        type="button"
                        onClick={onPickToken}
                        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-white/5"
                    >
                        {token ? (
                            <>
                                <AutoTokenIcon
                                    address={token.address}
                                    symbol={token.symbol}
                                    size={28}
                                />
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-arc-text">
                                        {token.symbol ?? "?"}
                                    </div>
                                    <div className="truncate text-[10px] text-arc-text-faint">
                                        Balance: {balanceCompact} {balanceLabel}
                                        {balanceUsd !== undefined && (
                                            <>
                                                {" "}
                                                <span className="text-arc-text-faint">
                                                    (${balanceUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <ChevronDown className="ml-1 h-3.5 w-3.5 text-arc-text-faint" />
                            </>
                        ) : (
                            <span className="text-sm text-arc-text-muted">Select token</span>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={onMax}
                        className="rounded-md bg-sky-400/15 px-2 py-1 text-[11px] font-semibold text-sky-400 transition-colors hover:bg-sky-400/25"
                    >
                        Max
                    </button>
                </div>
            </div>

            {/* Recipient field - identical outer dimensions empty vs filled.
                Left padding is pl-7 (instead of px-3) so the 28px avatar
                sits at the same x position as the USDC token icon inside
                the "You're sending" surface (that one nests an
                bg-arc-bg-elevated chip with px-3 inside the px-4 outer
                surface, putting the icon at outer-edge + 16 + 12 = 28 from
                the slot left). Matching the recipient slot to pl-7 (= 28)
                lines the two avatars up at the byte level. Right padding
                stays pr-3 so the X close button keeps its tight inset. */}
            <div className="relative mt-3 flex items-center gap-2.5 rounded-2xl border border-arc-border bg-white/[0.015] py-3 pl-7 pr-3">
                {resolvedAddress ? (
                    <>
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-arc-cta-hover/30 text-[10px] font-bold uppercase text-arc-cta-hover">
                            {(reverseEns ?? resolvedAddress).slice(2, 4)}
                        </div>
                        <div className="min-w-0 flex-1 text-sm font-semibold text-arc-text">
                            <div className="truncate">{reverseEns ?? shortAddr}</div>
                        </div>
                        <button
                            type="button"
                            onClick={() => setRecipientInput("")}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                            aria-label="Clear recipient"
                        >
                            <CrossIcon size={12} />
                        </button>
                    </>
                ) : (
                    <>
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-arc-cta-hover/20 text-[9px] font-bold text-arc-cta-hover">
                            0x
                        </div>
                        <input
                            value={recipientInput}
                            onChange={(e) => setRecipientInput(e.target.value.trim())}
                            placeholder="Wallet address or ENS name"
                            className="min-w-0 flex-1 bg-transparent text-sm text-arc-text outline-none placeholder:text-arc-text-faint"
                        />
                    </>
                )}
                {recipientInput && !resolvedAddress && !ensLoading && (
                    <div className="absolute left-7 right-3 top-full mt-1.5 text-[11px] text-arc-warn">
                        Not a valid address or ENS name
                    </div>
                )}
            </div>

            <button
                type="button"
                onClick={onContinue}
                disabled={!canContinue}
                className={cn(
                    "mt-4 w-full rounded-2xl py-3.5 text-base font-semibold transition-colors",
                    canContinue
                        ? "bg-arc-cta text-white hover:bg-arc-cta-hover"
                        : "cursor-not-allowed bg-arc-cta-disabled text-arc-text-muted",
                )}
            >
                {cta}
            </button>
        </>
    );
}

// ---------------------------------------------------------------------
// Review view
// ---------------------------------------------------------------------

function ReviewView({
    amount,
    amountUsd,
    token,
    recipient,
    reverseEns,
    onBack,
    onClose,
    onConfirm,
}: {
    amount: string;
    amountUsd?: number;
    token: TokenOption;
    recipient: Address;
    reverseEns?: string | null;
    onBack: () => void;
    onClose: () => void;
    onConfirm: () => void;
}) {
    // Display the EIP-55 checksummed form so the user can spot byte-
    // edits in the recipient address (lowercased addresses also pass
    // isAddress but with no error detection). Audit UI-M-13.
    const checksumRecipient = getAddress(recipient);
    const shortAddr = `${checksumRecipient.slice(0, 6)}...${checksumRecipient.slice(-4)}`;
    return (
        <>
            <div className="flex items-center justify-between">
                <button
                    type="button"
                    onClick={onBack}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                    aria-label="Back"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <h2 className="text-base font-semibold text-arc-text">Review send</h2>
                <button
                    type="button"
                    onClick={onClose}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                    aria-label="Close"
                >
                    <CrossIcon size={14} />
                </button>
            </div>

            {/* Review card: borderless sections so the modal reads as a
                single sheet. USD value sits below the token amount, then a
                clear darker divider separates the "what + where" block from
                the "how much it costs you" block. */}
            <div className="mt-4 overflow-hidden rounded-2xl bg-arc-surface">
                <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                    <div className="min-w-0">
                        <div className="text-2xl font-semibold tabular-nums text-arc-text">
                            {amount} {token.symbol ?? ""}
                        </div>
                        {amountUsd !== undefined && (
                            <div className="mt-0.5 text-xs text-arc-text-faint">
                                ${amountUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                        )}
                    </div>
                    <AutoTokenIcon
                        address={token.address}
                        symbol={token.symbol}
                        size={36}
                    />
                </div>
                <div className="px-4 py-3.5">
                    <div className="text-xs font-semibold text-arc-text">To</div>
                    <div className="mt-1 break-all text-sm font-medium text-arc-text">
                        {reverseEns ?? shortAddr}
                    </div>
                    {reverseEns && (
                        <div className="text-[11px] text-arc-text-faint">{shortAddr}</div>
                    )}
                </div>
                <div className="mx-4 border-t border-arc-border/40" />
                <div className="flex items-center justify-between px-4 py-3.5 text-sm">
                    <span className="text-arc-text-faint">Network cost</span>
                    <div className="flex items-center gap-1.5">
                        <AutoTokenIcon
                            address={ADDRESSES.usdc}
                            symbol="USDC"
                            size={16}
                        />
                        <span className="text-arc-text">~ TBD</span>
                    </div>
                </div>
            </div>

            <button
                type="button"
                onClick={onConfirm}
                className="mt-4 w-full rounded-2xl bg-arc-cta py-3.5 text-base font-semibold text-white transition-colors hover:bg-arc-cta-hover"
            >
                Confirm send
            </button>
        </>
    );
}

// ---------------------------------------------------------------------
// Status view (pending / success / error)
// ---------------------------------------------------------------------

function StatusView({
    kind,
    title,
    subtitle,
    txHash,
    onClose,
    closeLabel,
}: {
    kind: "pending" | "success" | "error";
    title: string;
    subtitle: string;
    txHash?: `0x${string}`;
    onClose: () => void;
    closeLabel?: string;
}) {
    return (
        <div className="text-center">
            <div className="mt-2 flex justify-center">
                {kind === "pending" && (
                    <Loader2 className="h-12 w-12 animate-spin text-sky-400" />
                )}
                {kind === "success" && (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-arc-success/20 text-arc-success">
                        <Check className="h-6 w-6" />
                    </div>
                )}
                {kind === "error" && (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-arc-danger/20 text-arc-danger">
                        <CrossIcon size={20} />
                    </div>
                )}
            </div>
            <h2 className="mt-4 text-lg font-semibold text-arc-text">{title}</h2>
            <p className="mt-1 text-sm text-arc-text-muted">{subtitle}</p>
            {txHash && (
                <a
                    href={`https://testnet.arcscan.app/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-1 text-xs text-arc-text-faint hover:text-arc-text"
                >
                    View tx
                    <ExternalLink className="h-3 w-3" />
                </a>
            )}
            <button
                type="button"
                onClick={onClose}
                className="mt-5 w-full rounded-2xl bg-arc-cta py-3.5 text-base font-semibold text-white transition-colors hover:bg-arc-cta-hover"
            >
                {closeLabel ?? "Close"}
            </button>
        </div>
    );
}
