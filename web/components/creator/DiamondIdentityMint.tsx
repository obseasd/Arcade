"use client";

import { ArrowUp, ExternalLink, Gem, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
    ERC_8004_IDENTITY_ABI,
    ERC_8004_IDENTITY_ADDRESS,
} from "@/lib/abis/erc8004Identity";
import { runSequential } from "@/lib/routing/runSequential";
import { useCreatorTier, type CreatorTier } from "@/lib/hooks/useCreatorTier";
import { pushToast } from "@/lib/toast";

/**
 * Audit 2026-06-18 H-09: when the on-chain ArcadeIdentityIssuer is
 * wired (NEXT_PUBLIC_ARCADE_IDENTITY_ISSUER_ADDRESS set), mint routes
 * through it so the tier is verified on-chain before forwarding to
 * the ERC-8004 Registry. Otherwise we fall back to direct
 * Registry.mint (legacy behavior; tier gate is client-side only).
 */
/**
 * Mints an Arcade Creator Identity NFT (ERC-8004) for the connected
 * wallet, gated on the wallet's bonded-launch tier (Silver / Gold /
 * Diamond).
 *
 * Rendering rules (audit 2026-06-18 M-08 fix: matches actual behavior):
 *   - tier === "none"     → render nothing. The badge is only earned
 *                           at 3+ bonded launches.
 *   - Silver / Gold / Diamond + balanceOf === 0 → "Claim TIER Identity"
 *   - balanceOf > 0 AND mintedTier < currentTier → "Upgrade to TIER"
 *     (H-10: previously the old NFT carried stale lower-tier metadata
 *     forever; the upgrade flow burns the old token and mints a fresh
 *     one with the higher-tier metadata)
 *   - balanceOf > 0 AND mintedTier === currentTier → "Identity claimed"
 *
 * The metadata URI is built inline as a base64-encoded data: JSON URI
 * (audit M-07: previously hex-encoded; most marketplaces decode
 * base64 but not hex). Tiny calldata, no off-chain pin.
 */
export function DiamondIdentityMint() {
    const { address: account } = useAccount();
    const publicClient = usePublicClient();
    const { writeContractAsync } = useWriteContract();
    const { tier, bondedCount, isLoading: tierLoading } = useCreatorTier(account);

    const balanceOfQ = useReadContract({
        address: ERC_8004_IDENTITY_ADDRESS,
        abi: ERC_8004_IDENTITY_ABI,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
        query: { enabled: !!account, refetchInterval: 30_000 },
    });

    const [minting, setMinting] = useState(false);
    const [upgrading, setUpgrading] = useState(false);

    const tierLabel =
        tier === "diamond"
            ? "Diamond"
            : tier === "gold"
                ? "Gold"
                : tier === "silver"
                    ? "Silver"
                    : "";

    const metadataUri = useMemo<string>(() => {
        if (!account) return "";
        const json = {
            name: `Arcade ${tierLabel} Creator`,
            description: `Issued to wallets that have shipped enough bonded token launches on Arcade to reach the ${tierLabel} tier. Portable proof of creator track record on Arc.`,
            image: `https://www.arcade.trading/og/${tier}-creator.png`,
            attributes: [
                { trait_type: "tier", value: tierLabel },
                { trait_type: "bonded_launches", value: bondedCount },
                {
                    trait_type: "issuer",
                    value: "Arcade",
                },
                {
                    trait_type: "issued_to",
                    value: account.toLowerCase(),
                },
                {
                    trait_type: "issued_at_block",
                    value: "minted",
                },
            ],
        };
        // Audit 2026-06-18 M-07: switched from `data:application/json;hex,`
        // to `data:application/json;base64,` because most NFT marketplaces
        // and explorers (OpenSea, Rarible, Magic Eden, blockscout) decode
        // base64 data URIs but not the non-standard `hex` form. The
        // tokenURI now renders correctly cross-platform with the same
        // calldata size (~750 bytes).
        const base64 =
            typeof window !== "undefined" && typeof window.btoa === "function"
                ? window.btoa(JSON.stringify(json))
                : Buffer.from(JSON.stringify(json), "utf-8").toString("base64");
        return `data:application/json;base64,${base64}`;
    }, [account, bondedCount, tier, tierLabel]);

    const onMint = async () => {
        if (!account) return;
        setMinting(true);
        try {
            // 2026-06-21: the live Arc registry gates mint(address,string)
            // to an internal authorized minter — it reverts for EOAs AND
            // for our Issuer (which forwards to registry.mint), so both
            // the Issuer path and the legacy direct-mint path never
            // worked (verified on-chain). The standard's permissionless
            // self-registration register(uri) mints to msg.sender and is
            // the only working path. Called straight from the creator's
            // wallet; tier stays verified client-side (the registry is
            // permissionless by design, so on-chain tier gating through
            // it isn't possible regardless).
            const hash = await writeContractAsync({
                address: ERC_8004_IDENTITY_ADDRESS,
                abi: ERC_8004_IDENTITY_ABI,
                functionName: "register",
                args: [metadataUri],
            });
            if (publicClient) {
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                if (receipt.status !== "success") {
                    throw new Error(
                        `Mint reverted on-chain (tx ${hash.slice(0, 10)}…).`,
                    );
                }
            }
            pushToast({
                kind: "info",
                title: `${tierLabel} Identity minted`,
                message: "Visible to any Arc dapp reading the ERC-8004 registry.",
            });
            void balanceOfQ.refetch();
        } catch (e: unknown) {
            const msg =
                (e as { shortMessage?: string; message?: string })?.shortMessage ??
                (e as { message?: string })?.message ??
                "Mint failed";
            pushToast({
                kind: "error",
                title: "Mint failed",
                message: msg.slice(0, 160),
            });
        } finally {
            setMinting(false);
        }
    };

    /**
     * Audit 2026-06-18 H-10: upgrade flow. The ERC-8004 metadata URI is
     * baked on-chain at mint time, so a creator who hit Silver then
     * graduated to Gold/Diamond carries permanently stale lower-tier
     * metadata. This handler burns the most recent Identity NFT held by
     * the connected wallet and mints a fresh one carrying the current
     * tier's metadata. 2 txs by design (burn + mint); the toast tracks
     * both so the user sees the flow.
     */
    const onUpgrade = async () => {
        if (!account || !publicClient) return;
        setUpgrading(true);
        try {
            const balance = (balanceOfQ.data as bigint | undefined) ?? 0n;
            if (balance === 0n) {
                pushToast({ kind: "error", title: "Nothing to upgrade", message: "No Identity NFT in wallet." });
                return;
            }
            // Pick the most recently held tokenId (last index in the
            // owner's enumerable list). For wallets holding exactly one
            // it's the only entry; for a wallet holding multiple (e.g.
            // legacy mints from a prior tier) we burn the newest first.
            const tokenId = (await publicClient.readContract({
                address: ERC_8004_IDENTITY_ADDRESS,
                abi: ERC_8004_IDENTITY_ABI,
                functionName: "tokenOfOwnerByIndex",
                args: [account, balance - 1n],
            })) as bigint;
            // Arc's callFrom precompile is dead, so the old atomic
            // burn + re-register Multicall3From batch reverts on-chain.
            // Run the two legs as direct txs from the user's wallet, in
            // order: burn the stale NFT, then register(uri) which
            // self-registers for msg.sender (the user) so the fresh NFT
            // lands in the creator's wallet. Without batch atomicity the
            // legs run as two confirmations; runSequential awaits the burn
            // receipt before the register so the order is preserved.
            await runSequential(
                [
                    {
                        address: ERC_8004_IDENTITY_ADDRESS,
                        abi: ERC_8004_IDENTITY_ABI,
                        functionName: "burn",
                        args: [tokenId],
                    },
                    {
                        address: ERC_8004_IDENTITY_ADDRESS,
                        abi: ERC_8004_IDENTITY_ABI,
                        functionName: "register",
                        args: [metadataUri],
                    },
                ],
                { writeContractAsync, publicClient },
            );
            pushToast({
                kind: "info",
                title: `${tierLabel} Identity refreshed`,
                message: "Old tier burned, new tier minted (2 transactions).",
            });
            void balanceOfQ.refetch();
        } catch (e: unknown) {
            const msg =
                (e as { shortMessage?: string; message?: string })?.shortMessage ??
                (e as { message?: string })?.message ??
                "Upgrade failed";
            pushToast({
                kind: "error",
                title: "Upgrade failed",
                message: msg.slice(0, 160),
            });
        } finally {
            setUpgrading(false);
        }
    };

    if (!account || tierLoading) return null;
    if (tier === "none") return null;

    const alreadyMinted =
        ((balanceOfQ.data as bigint | undefined) ?? 0n) > 0n;

    // Tier-specific accent. Mirror the CreatorTierBadge palette so the
    // mint card on /my-tokens reads visually as the same product surface
    // as the badge that appears on the launchpad detail page.
    const tierAccent =
        tier === "diamond"
            ? {
                  iconWrap: "bg-sky-400/10 text-sky-400",
                  badgeWrap: "border-sky-400/40 bg-sky-400/10 text-sky-400",
              }
            : tier === "gold"
                ? {
                      iconWrap: "bg-arc-warn/10 text-arc-warn",
                      badgeWrap: "border-arc-warn/40 bg-arc-warn/10 text-arc-warn",
                  }
                : {
                      iconWrap: "bg-white/[0.06] text-arc-text-muted",
                      badgeWrap: "border-arc-border bg-white/[0.03] text-arc-text-muted",
                  };

    return (
        <div className="arc-card flex items-start gap-4 p-5">
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${tierAccent.iconWrap}`}>
                <Gem className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-arc-text">
                    {tierLabel} Creator Identity
                </div>
                <p className="mt-1 text-xs text-arc-text-muted">
                    You shipped {bondedCount} bonded launches. Claim your
                    ERC-8004 Identity NFT — readable across every Arc dapp
                    that respects the standard.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {alreadyMinted ? (
                        <>
                            <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${tierAccent.badgeWrap}`}>
                                <Gem className="h-3 w-3" />
                                Identity claimed
                            </span>
                            {/* H-10: re-mint to refresh tier metadata after a graduation lifts the wallet from Silver -> Gold / Diamond. */}
                            <button
                                type="button"
                                onClick={() => void onUpgrade()}
                                disabled={upgrading}
                                className="inline-flex items-center gap-1 rounded-md border border-arc-border bg-white/[0.03] px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-arc-text-muted transition-colors hover:bg-white/[0.06] hover:text-arc-text disabled:cursor-not-allowed disabled:opacity-60"
                                title="Burn the current Identity NFT and re-mint with current tier metadata"
                            >
                                {upgrading ? (
                                    <>
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Refreshing…
                                    </>
                                ) : (
                                    <>
                                        <ArrowUp className="h-3 w-3" />
                                        Refresh tier
                                    </>
                                )}
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={() => void onMint()}
                            disabled={minting}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-arc-cta px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-arc-cta-hover disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {minting ? (
                                <>
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                    Minting…
                                </>
                            ) : (
                                <>
                                    <Gem className="h-3 w-3" />
                                    Claim {tierLabel} Identity
                                </>
                            )}
                        </button>
                    )}
                    <a
                        href={`https://testnet.arcscan.app/address/${ERC_8004_IDENTITY_ADDRESS}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-arc-text-faint hover:text-arc-text-muted"
                    >
                        ERC-8004 registry
                        <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                </div>
            </div>
        </div>
    );
}
