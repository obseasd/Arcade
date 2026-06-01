"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
    ArrowRight,
    ArrowRightLeft,
    ChevronDown,
    Copy,
    Download,
    FileText,
    LineChart,
    LogOut,
    Power,
    Send,
    Shield,
    X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Address, erc20Abi } from "viem";
import { useAccount, useDisconnect, useReadContract } from "wagmi";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { loadBridgeHistory, type HistoryEntry } from "@/lib/bridgeHistory";
import { listPendingClaims, type PendingTwitterClaim } from "@/lib/pendingClaims";
import { pushToast } from "@/lib/toast";
import { cn, formatUSDC } from "@/lib/utils";
import { TokenIcon } from "@/components/ui/TokenIcon";

/**
 * Header wallet widget. Two-part trigger (USDC balance | wallet chip) that
 * opens a vertical dropdown panel inspired by Uniswap / Backpack's wallet
 * widget: avatar + shortened address up top, big USD balance, Send/Receive
 * shortcuts, "View wallet" deep link, and a compact recent-activity list
 * pulled from in-app localStorage (bridge history + pending Twitter claims).
 *
 * Top-right icons in the panel:
 *   - LP-simulator shortcut (replaces the generic gear icon)
 *   - Power icon → small submenu with "Switch wallet" / "Disconnect"
 *
 * Owner-only "Admin" entry surfaces in the small submenu when the connected
 * wallet matches `escrow.owner()`. Read disclosure is harmless: the admin
 * page's data is already public via cast call; write actions require a real
 * signature regardless of the menu state.
 */
export function HeaderWalletWidget() {
    const { address, connector } = useAccount();
    const { disconnect } = useDisconnect();
    const [menuOpen, setMenuOpen] = useState(false);
    const [powerOpen, setPowerOpen] = useState(false);
    const [receiveOpen, setReceiveOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);

    // Close the panel + the power submenu when clicking outside.
    useEffect(() => {
        if (!menuOpen) return;
        const onDocClick = (e: MouseEvent) => {
            if (!menuRef.current?.contains(e.target as Node)) {
                setMenuOpen(false);
                setPowerOpen(false);
            }
        };
        document.addEventListener("mousedown", onDocClick);
        return () => document.removeEventListener("mousedown", onDocClick);
    }, [menuOpen]);

    // Closing the panel always closes the nested submenu so the next open
    // starts clean.
    useEffect(() => {
        if (!menuOpen) setPowerOpen(false);
    }, [menuOpen]);

    const balanceQ = useReadContract({
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address, refetchInterval: 8000 },
    });
    const raw = (balanceQ.data as bigint | undefined) ?? 0n;
    const amountWhole = formatUSDC(raw, USDC_DECIMALS, 0);
    const usdValue = formatUSDC(raw, USDC_DECIMALS, 2);

    // Owner-only admin shortcut, gated on chain (a "spoof" can see this but
    // cannot sign any of the admin writes).
    const escrowOwnerQ = useReadContract({
        address: ADDRESSES.twitterEscrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "owner",
        query: { enabled: !!ADDRESSES.twitterEscrow },
    });
    const isEscrowOwner =
        !!address
        && !!escrowOwnerQ.data
        && (escrowOwnerQ.data as string).toLowerCase() === address.toLowerCase();

    const copyAddress = async () => {
        if (!address) return;
        try {
            await navigator.clipboard.writeText(address);
            pushToast({ kind: "info", title: "Address copied" });
        } catch {
            pushToast({ kind: "error", title: "Couldn't copy" });
        }
    };

    return (
        <ConnectButton.Custom>
            {({ account, openAccountModal, openConnectModal, openChainModal, chain, mounted }) => {
                const ready = mounted;
                const connected = ready && account && chain && !!address;

                if (!connected) {
                    return (
                        <button onClick={openConnectModal} className="arc-button-primary px-4 py-2 text-sm">
                            Connect Wallet
                        </button>
                    );
                }

                if (chain.unsupported) {
                    return (
                        <button
                            onClick={openChainModal}
                            className="rounded-xl border border-arc-danger/40 bg-arc-danger/10 px-3 py-2 text-sm font-medium text-arc-danger"
                        >
                            Wrong network
                        </button>
                    );
                }

                const short = formatShortAddress(address);
                const walletName = connector?.name ?? "Wallet";
                const walletIcon = (connector as any)?.icon as string | undefined;

                return (
                    <div ref={menuRef} className="relative font-sans">
                        {/* Trigger: USDC chip | wallet chip (unchanged shape) */}
                        <div
                            style={{ height: "52px", minHeight: "52px" }}
                            className="flex items-stretch overflow-hidden rounded-2xl border border-arc-gray/20 bg-black/15 backdrop-blur-xl"
                        >
                            <div className="flex items-center gap-2 px-3">
                                <TokenIcon symbol="USDC" size={22} />
                                <div className="flex flex-col leading-tight">
                                    <span className="text-xs font-semibold text-arc-text">{amountWhole}</span>
                                    <span className="text-[9px] text-arc-text-muted">${usdValue}</span>
                                </div>
                            </div>

                            <div className="my-2 w-0.5 rounded-full bg-arc-gray/60" />

                            <button
                                onClick={() => setMenuOpen((v) => !v)}
                                className="flex items-center gap-2 px-3 transition-colors hover:bg-white/5"
                            >
                                <WalletIcon icon={walletIcon} name={walletName} size={24} />
                                <div className="flex flex-col items-start leading-tight">
                                    <span className="text-[9px] text-arc-text-muted">{walletName}</span>
                                    <span className="text-xs font-semibold text-arc-text">{short}</span>
                                </div>
                                <ChevronDown
                                    className={cn(
                                        "h-3 w-3 text-arc-text-muted transition-transform",
                                        menuOpen && "rotate-180",
                                    )}
                                />
                            </button>
                        </div>

                        {/* Wallet panel (Uniswap-style) */}
                        {menuOpen && (
                            <div className="absolute right-0 top-[58px] z-50 w-[360px] overflow-hidden rounded-2xl border border-arc-gray/20 bg-black/40 shadow-arc-card backdrop-blur-2xl">
                                {/* Top row: avatar + address (left) | LP-sim + power (right) */}
                                <div className="flex items-start justify-between gap-3 p-4">
                                    <button
                                        onClick={copyAddress}
                                        className="group flex min-w-0 items-center gap-2 rounded-lg p-1 -m-1 hover:bg-white/5"
                                        title="Copy full address"
                                    >
                                        <WalletIcon icon={walletIcon} name={walletName} size={36} />
                                        <div className="min-w-0 text-left">
                                            <div className="truncate text-sm font-semibold text-arc-text">
                                                {short}
                                            </div>
                                            <div className="flex items-center gap-1 text-[10px] text-arc-text-faint opacity-0 transition-opacity group-hover:opacity-100">
                                                <Copy className="h-2.5 w-2.5" />
                                                Copy
                                            </div>
                                        </div>
                                    </button>

                                    <div className="flex shrink-0 items-center gap-1">
                                        {isEscrowOwner && (
                                            <Link
                                                href="/admin/escrow"
                                                onClick={() => setMenuOpen(false)}
                                                title="Admin"
                                                className="rounded-lg p-2 text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                                            >
                                                <Shield className="h-4 w-4" />
                                            </Link>
                                        )}
                                        <Link
                                            href="/lp-simulator"
                                            onClick={() => setMenuOpen(false)}
                                            title="LP Simulator"
                                            className="rounded-lg p-2 text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
                                        >
                                            <LineChart className="h-4 w-4" />
                                        </Link>
                                        <div className="relative">
                                            <button
                                                onClick={() => setPowerOpen((v) => !v)}
                                                className={cn(
                                                    "rounded-lg p-2 text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text",
                                                    powerOpen && "bg-white/5 text-arc-text",
                                                )}
                                                title="Wallet actions"
                                            >
                                                <Power className="h-4 w-4" />
                                            </button>
                                            {powerOpen && (
                                                <div className="absolute right-0 top-full z-10 mt-1 w-56 overflow-hidden rounded-xl border border-arc-gray/20 bg-black/60 shadow-arc-card backdrop-blur-2xl">
                                                    <PowerMenuItem
                                                        icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
                                                        onClick={() => {
                                                            // Close the panel BEFORE the connect modal opens
                                                            // so the user doesn't see two overlapping menus.
                                                            setPowerOpen(false);
                                                            setMenuOpen(false);
                                                            openConnectModal();
                                                        }}
                                                    >
                                                        Changer de wallet
                                                    </PowerMenuItem>
                                                    <PowerMenuItem
                                                        icon={<LogOut className="h-3.5 w-3.5" />}
                                                        onClick={() => {
                                                            setPowerOpen(false);
                                                            setMenuOpen(false);
                                                            disconnect();
                                                        }}
                                                        variant="danger"
                                                    >
                                                        Déconnecter
                                                    </PowerMenuItem>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Big USD balance */}
                                <div className="px-4 pb-4">
                                    <div className="text-3xl font-semibold tabular-nums text-arc-text">
                                        ${usdValue}
                                    </div>
                                </div>

                                {/* Send / Receive shortcuts.
                                    Lighter blue (sky-400) per design ask - the deeper
                                    arc-cta-hover was too dark / close to the panel bg. */}
                                <div className="grid grid-cols-2 gap-2 px-4 pb-3">
                                    <button
                                        onClick={() => {
                                            openAccountModal();
                                            setMenuOpen(false);
                                        }}
                                        className="flex flex-col items-center justify-center gap-1.5 rounded-xl bg-sky-400/10 px-3 py-4 text-sky-400 transition-colors hover:bg-sky-400/20"
                                    >
                                        <Send className="h-5 w-5" />
                                        <span className="text-sm font-medium">Envoyer</span>
                                    </button>
                                    <button
                                        onClick={() => setReceiveOpen(true)}
                                        className="flex flex-col items-center justify-center gap-1.5 rounded-xl bg-sky-400/10 px-3 py-4 text-sky-400 transition-colors hover:bg-sky-400/20"
                                    >
                                        <Download className="h-5 w-5" />
                                        <span className="text-sm font-medium">Recevoir</span>
                                    </button>
                                </div>

                                {/* View wallet / portfolio link.
                                    Compact centered text-only link per design ask -
                                    the bordered button shape was visually competing
                                    with the action buttons above it. */}
                                <div className="flex justify-center px-4 pb-1">
                                    <Link
                                        href="/my-tokens"
                                        onClick={() => setMenuOpen(false)}
                                        className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium text-arc-text-muted transition-colors hover:text-arc-text"
                                    >
                                        Voir le portefeuille
                                        <ArrowRight className="h-3 w-3" />
                                    </Link>
                                </div>

                                {/* Activity feed */}
                                <ActivityFeed address={address} onLinkClick={() => setMenuOpen(false)} />
                            </div>
                        )}

                        {receiveOpen && address && (
                            <ReceiveModal
                                address={address}
                                onClose={() => setReceiveOpen(false)}
                                onCopy={copyAddress}
                            />
                        )}
                    </div>
                );
            }}
        </ConnectButton.Custom>
    );
}

// ===================== Activity feed =====================

/**
 * Compact recent-activity list pulled from in-app localStorage (bridge
 * history + pending Twitter claims). Until the Ponder indexer lands this
 * is what we can show without a heavy RPC scan; once the indexer is up
 * this component swaps to a GraphQL feed.
 */
function ActivityFeed({ address, onLinkClick }: { address: Address; onLinkClick: () => void }) {
    const [bridges, setBridges] = useState<HistoryEntry[]>([]);
    const [claims, setClaims] = useState<PendingTwitterClaim[]>([]);

    useEffect(() => {
        setBridges(loadBridgeHistory());
        setClaims(listPendingClaims(address));
        const handler = () => {
            setBridges(loadBridgeHistory());
            setClaims(listPendingClaims(address));
        };
        window.addEventListener("storage", handler);
        return () => window.removeEventListener("storage", handler);
    }, [address]);

    // Merge + sort by recency. Cap at 3 rows so the panel stays compact.
    const items = useMemo(() => {
        const all = [
            ...bridges.slice(0, 3).map((b) => ({
                kind: "bridge" as const,
                ts: b.burnedAt,
                row: b,
            })),
            ...claims.slice(0, 3).map((c) => ({
                kind: "claim" as const,
                ts: c.savedAt * 1000,
                row: c,
            })),
        ];
        return all.sort((a, b) => b.ts - a.ts).slice(0, 3);
    }, [bridges, claims]);

    if (items.length === 0) {
        return (
            <div className="px-4 pb-4 pt-3">
                <div className="mb-2 text-xs font-semibold text-arc-text">Activité récente</div>
                <div className="text-[11px] text-arc-text-faint">No activity yet.</div>
            </div>
        );
    }

    return (
        <div className="px-4 pb-4 pt-3">
            <div className="mb-2 text-xs font-semibold text-arc-text">Activité récente</div>
            <div className="space-y-2">
                {items.map((it, i) =>
                    it.kind === "bridge" ? (
                        <BridgeRow key={i} entry={it.row} />
                    ) : (
                        <ClaimRow key={i} entry={it.row} />
                    ),
                )}
            </div>
            <Link
                href={`https://testnet.arcscan.app/address/${address}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onLinkClick}
                className="mt-3 flex items-center justify-center gap-1 rounded-xl border border-arc-border px-4 py-2 text-[11px] font-medium text-arc-text-muted transition-colors hover:bg-white/5 hover:text-arc-text"
            >
                Voir toute l&apos;activité
                <ArrowRight className="h-3 w-3" />
            </Link>
        </div>
    );
}

// Per design: the VALUE goes white, the action label goes muted, the
// time-ago text is bumped ~+40% (10px → 14px ≈ text-sm) so the user
// can scan it at a glance. Leading icon on the left of each row;
// placeholder lucide icons for now, user is bringing custom logos.
function BridgeRow({ entry }: { entry: HistoryEntry }) {
    const amountStr = (() => {
        try {
            return formatUSDC(BigInt(entry.amountRaw6), 6, 2);
        } catch {
            return "?";
        }
    })();
    const status =
        entry.status === "minted"
            ? "Bridge confirmé"
            : entry.status === "failed"
              ? "Bridge échoué"
              : "Bridge en attente";
    return (
        <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-arc-cta-hover/15 text-arc-cta-hover">
                <ArrowRightLeft className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-arc-text-faint">{status}</div>
                <div className="truncate text-xs font-medium text-arc-text">{amountStr} USDC</div>
            </div>
            <div className="shrink-0 text-sm text-arc-text-faint">{formatAgo(entry.burnedAt)}</div>
        </div>
    );
}

function ClaimRow({ entry }: { entry: PendingTwitterClaim }) {
    const ready = Math.floor(Date.now() / 1000) >= entry.executeAfter;
    return (
        <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-arc-cta-hover/15 text-arc-cta-hover">
                <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-arc-text-faint">
                    {ready ? "Twitter claim prêt" : "Twitter claim en attente"}
                </div>
                <div className="truncate text-xs font-medium text-arc-text">@{entry.handle}</div>
            </div>
            <div className="shrink-0 text-sm text-arc-text-faint">{formatAgo(entry.savedAt * 1000)}</div>
        </div>
    );
}

function formatAgo(ts: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

// ===================== Receive modal =====================

function ReceiveModal({
    address,
    onClose,
    onCopy,
}: {
    address: Address;
    onClose: () => void;
    onCopy: () => void;
}) {
    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-arc-border bg-arc-bg-elevated p-5 shadow-arc-card"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold text-arc-text">Recevoir</h2>
                    <button onClick={onClose} className="text-arc-text-faint hover:text-arc-text">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <p className="mt-1 text-xs text-arc-text-muted">
                    Partage cette adresse pour recevoir USDC ou tokens sur Arc.
                </p>
                <div className="mt-4 break-all rounded-xl border border-arc-border bg-arc-surface px-3 py-3 font-mono text-xs text-arc-text">
                    {address}
                </div>
                <button
                    onClick={onCopy}
                    className="arc-button-primary mt-4 flex w-full items-center justify-center gap-2 py-2.5 text-sm"
                >
                    <Copy className="h-4 w-4" />
                    Copier l&apos;adresse
                </button>
                <p className="mt-3 text-[11px] text-arc-text-faint">
                    Vérifie toujours que tu es sur Arc testnet (chainId 5042002) avant que
                    l&apos;envoyeur ne broadcast.
                </p>
            </div>
        </div>
    );
}

// ===================== shared primitives =====================

function PowerMenuItem({
    icon,
    onClick,
    children,
    variant,
}: {
    icon: React.ReactNode;
    onClick?: () => void;
    children: React.ReactNode;
    variant?: "default" | "danger";
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs transition-colors",
                variant === "danger"
                    ? "text-arc-danger hover:bg-arc-danger/10"
                    : "text-arc-text hover:bg-white/5",
            )}
        >
            <span className={variant === "danger" ? "text-arc-danger" : "text-arc-text-muted"}>
                {icon}
            </span>
            {children}
        </button>
    );
}

function WalletIcon({ icon, name, size = 24 }: { icon?: string; name: string; size?: number }) {
    if (icon) {
        // eslint-disable-next-line @next/next/no-img-element
        return (
            <img
                src={icon}
                alt={name}
                width={size}
                height={size}
                style={{ width: size, height: size }}
                className="rounded-lg"
            />
        );
    }
    return (
        <div
            style={{ width: size, height: size }}
            className="flex items-center justify-center rounded-lg bg-gradient-to-br from-arc-primary to-arc-cta text-xs font-bold text-white"
        >
            {name.slice(0, 1).toUpperCase()}
        </div>
    );
}

function formatShortAddress(address: string | undefined): string {
    if (!address) return "";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
