"use client";

import { ArrowLeft, Check, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { useEffect, useMemo, useState } from "react";
import {
    Address,
    erc20Abi,
    formatUnits,
    isAddress,
    parseUnits,
    zeroAddress,
} from "viem";
import { mainnet } from "wagmi/chains";
import {
    useAccount,
    useBalance,
    useEnsAddress,
    useEnsName,
    usePublicClient,
    useSendTransaction,
    useWriteContract,
} from "wagmi";
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

const USDC_NATIVE_ADDR = "0x0000000000000000000000000000000000000000" as Address;

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
    const balanceDecimals = balanceQ.data?.decimals ?? token?.decimals ?? 18;
    const balanceFormatted = balanceQ.data
        ? formatUnits(balanceRaw, balanceDecimals)
        : "0";

    // ENS lookup on the recipient: resolve `name.eth` -> address, and
    // reverse-resolve the address to a primary name for the review screen.
    const looksLikeEns =
        recipientInput.endsWith(".eth") || recipientInput.endsWith(".xyz");
    const ensQ = useEnsAddress({
        name: looksLikeEns ? recipientInput : undefined,
        chainId: mainnet.id,
        query: { enabled: looksLikeEns },
    });
    const resolvedAddress: Address | undefined = useMemo(() => {
        if (isAddress(recipientInput)) return recipientInput as Address;
        if (ensQ.data && isAddress(ensQ.data)) return ensQ.data as Address;
        return undefined;
    }, [recipientInput, ensQ.data]);

    const reverseEnsQ = useEnsName({
        address: resolvedAddress,
        chainId: mainnet.id,
        query: { enabled: !!resolvedAddress },
    });

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
            return looksLikeEns && ensQ.isLoading ? "Resolving ENS…" : "Invalid address";
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
            if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
            setStep("success");
            // Log the activity so the row appears in the feed without
            // the user having to refresh.
            if (account) {
                addActivity({
                    type: "swap",
                    account,
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
            >
                <div className="p-5">
                    {step === "form" && (
                        <FormView
                            amount={amount}
                            setAmount={setAmount}
                            token={token}
                            onPickToken={() => setTokenSelectOpen(true)}
                            balanceFormatted={balanceFormatted}
                            balanceLabel={balanceQ.data?.symbol ?? token?.symbol ?? ""}
                            onMax={onMax}
                            recipientInput={recipientInput}
                            setRecipientInput={setRecipientInput}
                            resolvedAddress={resolvedAddress}
                            reverseEns={reverseEnsQ.data}
                            ensLoading={looksLikeEns && ensQ.isLoading}
                            onClose={onClose}
                            canContinue={canContinue}
                            cta={cta}
                            onContinue={() => setStep("review")}
                        />
                    )}
                    {step === "review" && token && resolvedAddress && (
                        <ReviewView
                            amount={amount}
                            token={token}
                            recipient={resolvedAddress}
                            reverseEns={reverseEnsQ.data}
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
    token,
    onPickToken,
    balanceFormatted,
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
    token: TokenOption | undefined;
    onPickToken: () => void;
    balanceFormatted: string;
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
    const recipientDisplay = (() => {
        if (!resolvedAddress) return null;
        const short = `${resolvedAddress.slice(0, 6)}...${resolvedAddress.slice(-4)}`;
        return reverseEns ? `${reverseEns} (${short})` : short;
    })();

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

            {/* You're sending - big amount input + token chip at the bottom */}
            <div className="mt-4 rounded-2xl border border-arc-border bg-arc-surface p-4">
                <div className="text-xs font-semibold text-arc-text">You&apos;re sending</div>
                <div className="my-6 flex items-center justify-center">
                    <input
                        inputMode="decimal"
                        autoFocus
                        value={amount}
                        onChange={(e) => {
                            const v = e.target.value.replace(/,/g, ".");
                            if (v === "" || /^\d*\.?\d*$/.test(v)) setAmount(v);
                        }}
                        placeholder="0"
                        className="w-full bg-transparent text-center text-5xl font-semibold tabular-nums text-arc-text outline-none placeholder:text-arc-text-faint/50"
                    />
                </div>
                {/* Token chip + balance + Max */}
                <div className="flex items-center justify-between gap-3 rounded-xl bg-arc-bg-elevated px-3 py-2">
                    <button
                        type="button"
                        onClick={onPickToken}
                        className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-white/5"
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
                                    <div className="truncate text-[11px] text-arc-text-faint">
                                        Balance: {balanceFormatted} {balanceLabel}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <span className="text-sm text-arc-text-muted">Select token</span>
                        )}
                        <ChevronDown className="ml-1 h-3.5 w-3.5 text-arc-text-faint" />
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

            {/* Recipient field */}
            <div className="mt-3 rounded-2xl border border-arc-border bg-arc-surface px-4 py-3">
                <div className="text-xs font-semibold text-arc-text">To</div>
                <input
                    value={recipientInput}
                    onChange={(e) => setRecipientInput(e.target.value.trim())}
                    placeholder="Wallet address or ENS name"
                    className="mt-1 w-full bg-transparent text-sm text-arc-text outline-none placeholder:text-arc-text-faint"
                />
                {recipientInput && (
                    <div className="mt-1 text-[11px]">
                        {recipientDisplay ? (
                            <span className="text-arc-text-faint">Resolves to {recipientDisplay}</span>
                        ) : ensLoading ? (
                            <span className="text-arc-text-faint">Resolving ENS…</span>
                        ) : (
                            <span className="text-arc-warn">
                                Not a valid address or ENS name
                            </span>
                        )}
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
    token,
    recipient,
    reverseEns,
    onBack,
    onClose,
    onConfirm,
}: {
    amount: string;
    token: TokenOption;
    recipient: Address;
    reverseEns?: string | null;
    onBack: () => void;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const shortAddr = `${recipient.slice(0, 6)}...${recipient.slice(-4)}`;
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

            <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-arc-border bg-arc-surface px-4 py-3">
                    <div>
                        <div className="text-2xl font-semibold tabular-nums text-arc-text">
                            {amount} {token.symbol ?? ""}
                        </div>
                    </div>
                    <AutoTokenIcon
                        address={token.address}
                        symbol={token.symbol}
                        size={36}
                    />
                </div>
                <div className="rounded-2xl border border-arc-border bg-arc-surface px-4 py-3">
                    <div className="text-xs font-semibold text-arc-text">To</div>
                    <div className="mt-1 break-all text-sm font-medium text-arc-text">
                        {reverseEns ?? shortAddr}
                    </div>
                    {reverseEns && (
                        <div className="text-[11px] text-arc-text-faint">{shortAddr}</div>
                    )}
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-arc-border bg-arc-surface px-4 py-2.5 text-sm">
                    <span className="text-arc-text-faint">Network cost</span>
                    <span className="text-arc-text">~ gas TBD</span>
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
