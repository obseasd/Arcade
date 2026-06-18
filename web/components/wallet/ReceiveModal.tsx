"use client";

import { ArrowLeft, Check, Copy, QrCode } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { Address } from "viem";

// Audit 2026-06-18b bundle-weight: qrcode.react is only needed once the
// user opens the QR view (a secondary action behind a button click).
// Defer it via next/dynamic so the library is code-split out of the
// initial route bundle that ships the Receive button. ssr:false because
// the QR canvas is client-only anyway. Rendered output is identical.
const QRCodeSVG = dynamic(
    () => import("qrcode.react").then((m) => m.QRCodeSVG),
    { ssr: false },
);
import { useEnsName } from "wagmi";
import { mainnet } from "wagmi/chains";
import { Modal } from "@/components/ui/Modal";
import { pushToast } from "@/lib/toast";

/**
 * Uniswap-style "Receive crypto" modal. Two stacked views inside the
 * same dialog: the default shows the connected wallet (ENS if any +
 * shortened address + Copy + QR icons), the QR view swaps to a large
 * scannable code + the full address below it. Backed by the shared
 * <Modal> for backdrop / ESC / focus-trap behaviour.
 *
 * ENS resolution runs against L1 mainnet because Arc testnet has no
 * ENS deployment of its own; if reverse lookup fails or the user
 * isn't an ENS holder the modal just shows the address.
 *
 * Removed the "From an account" / Coinbase fund slot + Get help link
 * from the Uniswap reference per user request; the surface is a pure
 * receive panel with no third-party deep links.
 */
interface Props {
    address: Address;
    onClose: () => void;
}

export function ReceiveModal({ address, onClose }: Props) {
    const [view, setView] = useState<"main" | "qr">("main");
    const [justCopied, setJustCopied] = useState(false);

    // Reverse-resolve the address against L1 ENS. The chainId override
    // is required because the wallet is connected to Arc testnet, which
    // has no ENS contracts; without it the hook just returns undefined.
    const { data: ensName } = useEnsName({
        address,
        chainId: mainnet.id,
    });

    const shortAddress = `${address.slice(0, 6)}...${address.slice(-4)}`;

    const onCopy = async (label = "Address copied") => {
        try {
            await navigator.clipboard.writeText(address);
            pushToast({ kind: "info", title: label });
            setJustCopied(true);
            window.setTimeout(() => setJustCopied(false), 1400);
        } catch {
            pushToast({ kind: "error", title: "Couldn't copy" });
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            widthClassName="max-w-[400px]"
            backdropClassName="backdrop:bg-black/60 backdrop:backdrop-blur-sm"
            className="border-arc-border bg-arc-bg-elevated"
        >
            {view === "main" ? (
                <div className="relative p-5">
                    <button
                        type="button"
                        onClick={onClose}
                        className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                        aria-label="Close receive modal"
                    >
                        <CrossIcon size={14} />
                    </button>
                    <div className="text-center">
                        <h2 className="text-lg font-semibold text-arc-text">
                            Receive crypto
                        </h2>
                        <p className="mt-1.5 text-sm text-arc-text-muted">
                            Fund your wallet by transferring crypto from another wallet or account.
                        </p>
                    </div>

                    {/* Wallet card: ENS + short address on the left, Copy + QR
                        buttons on the right. The whole card is the visual
                        anchor; the icons sit in their own pill so they read
                        as actionable controls. */}
                    <div className="mt-5 flex items-center gap-3 rounded-2xl border border-arc-border bg-arc-surface px-4 py-3">
                        <Image
                            src="/arcdlogo22.png"
                            alt=""
                            width={36}
                            height={36}
                            className="h-9 w-9 shrink-0 rounded-full"
                            unoptimized
                        />
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold text-arc-text">
                                {ensName ?? shortAddress}
                            </div>
                            {ensName && (
                                <div className="truncate text-xs text-arc-text-faint">
                                    {shortAddress}
                                </div>
                            )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => onCopy()}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-arc-border bg-arc-bg-elevated text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                                aria-label="Copy address"
                                title="Copy address"
                            >
                                {justCopied ? (
                                    <Check className="h-3.5 w-3.5 animate-copy-pop text-arc-success" />
                                ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => setView("qr")}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-arc-border bg-arc-bg-elevated text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                                aria-label="Show QR code"
                                title="Show QR code"
                            >
                                <QrCode className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="p-5">
                    <div className="flex items-center justify-between">
                        <button
                            type="button"
                            onClick={() => setView("main")}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                            aria-label="Back"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-arc-text-faint transition-colors hover:bg-white/5 hover:text-arc-text"
                            aria-label="Close receive modal"
                        >
                            <CrossIcon size={14} />
                        </button>
                    </div>

                    <div className="mt-1 text-center">
                        <h2 className="truncate text-base font-semibold text-arc-text">
                            {ensName ?? shortAddress}
                        </h2>
                    </div>

                    {/* QR canvas. EIP-681 URI (ethereum:0xADDR@chainId)
                        instead of the bare address so wallets that scan
                        the QR know which chain it belongs to and don't
                        default to mainnet. The bare address is shown
                        below for users who copy-paste manually. Audit
                        UI-M-14. Light fg on dark bg with the brand
                        glyph in the centre. */}
                    <div className="mt-4 flex items-center justify-center">
                        <div className="rounded-2xl border border-arc-border bg-arc-bg-elevated p-4">
                            <QRCodeSVG
                                value={`ethereum:${address}@5042002`}
                                size={220}
                                bgColor="#0d1424"
                                fgColor="#38BDF8"
                                level="M"
                                marginSize={1}
                                imageSettings={{
                                    src: "/arcdlogo22.png",
                                    height: 40,
                                    width: 40,
                                    excavate: true,
                                }}
                            />
                        </div>
                    </div>
                    <div className="mt-2 text-center text-[11px] font-medium uppercase tracking-wider text-arc-warn">
                        Arc testnet only · chainId 5042002
                    </div>

                    {/* Address read-out: small label + the full hex address,
                        with a copy icon in the label row. Wraps onto two
                        lines on narrow screens since the full hex is 42 chars. */}
                    <div className="mt-4 rounded-2xl border border-arc-border bg-arc-surface p-3">
                        <div className="flex items-center justify-center gap-1.5 text-[11px] uppercase tracking-wider text-arc-text-faint">
                            Arc address
                            <button
                                type="button"
                                onClick={() => onCopy("Address copied")}
                                className="text-arc-text-faint transition-colors hover:text-arc-text"
                                aria-label="Copy address"
                                title="Copy"
                            >
                                {justCopied ? (
                                    <Check className="h-3 w-3 animate-copy-pop text-arc-success" />
                                ) : (
                                    <Copy className="h-3 w-3" />
                                )}
                            </button>
                        </div>
                        <div className="mt-1.5 break-all text-center font-mono text-xs text-arc-text">
                            {address}
                        </div>
                    </div>
                </div>
            )}
        </Modal>
    );
}
