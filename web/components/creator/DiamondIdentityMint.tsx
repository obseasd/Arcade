"use client";

import { ExternalLink, Gem, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { stringToHex, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
    ERC_8004_IDENTITY_ABI,
    ERC_8004_IDENTITY_ADDRESS,
} from "@/lib/abis/erc8004Identity";
import { useCreatorTier } from "@/lib/hooks/useCreatorTier";
import { pushToast } from "@/lib/toast";

/**
 * Mints an Arcade Diamond Creator Identity NFT (ERC-8004) for the
 * connected wallet, when that wallet has the Diamond tier (10+
 * bonded launches).
 *
 * Rendering rules:
 *   - tier !== "diamond" → render nothing. The badge is only earned at
 *     10 bonded launches and we don't want to tease the surface to
 *     creators who can't claim yet.
 *   - balanceOf > 0 → render the "already minted" state. ERC-8004 NFTs
 *     are not soulbound by the standard but we treat the existence of
 *     any token on the wallet as "Identity claimed" — re-minting would
 *     give the same metadata anyway.
 *   - else → render the claim CTA. Mint writes to ERC_8004_IDENTITY_ADDRESS
 *     with a data: URI metadata JSON describing the creator + tier +
 *     bonded count. Tiny calldata, no Pinata round-trip.
 *
 * The metadata URI is built inline as a data: JSON URI for now so we
 * never block the mint on Pinata or an indexer. Once we have an
 * Arcade-controlled IPFS pin route (POST /api/pin/identity) it can
 * replace the inline encoding, but the contract accepts any string
 * URI so the migration is one-line.
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

    const metadataUri = useMemo<string>(() => {
        if (!account) return "";
        const json = {
            name: `Arcade Diamond Creator`,
            description:
                "Issued to wallets that have shipped 10+ bonded token launches on Arcade. Portable proof of creator track record on Arc.",
            image:
                "https://www.arcade.trading/og/diamond-creator.png",
            attributes: [
                { trait_type: "tier", value: "Diamond" },
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
        // Encoding as `data:application/json,<hex>` keeps the URI tiny
        // (~600 bytes) and avoids any off-chain pin. Browsers and
        // explorers that read the tokenURI can decode the hex back to
        // JSON in one step.
        const hex: Hex = stringToHex(JSON.stringify(json));
        return `data:application/json;hex,${hex.slice(2)}`;
    }, [account, bondedCount]);

    const onMint = async () => {
        if (!account) return;
        setMinting(true);
        try {
            const hash = await writeContractAsync({
                address: ERC_8004_IDENTITY_ADDRESS,
                abi: ERC_8004_IDENTITY_ABI,
                functionName: "mint",
                args: [account, metadataUri],
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
                title: "Diamond Identity minted",
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

    if (!account || tierLoading) return null;
    if (tier !== "diamond") return null;

    const alreadyMinted =
        ((balanceOfQ.data as bigint | undefined) ?? 0n) > 0n;

    return (
        <div className="arc-card flex items-start gap-4 p-5">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-sky-400/10 text-sky-400">
                <Gem className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-arc-text">
                    Diamond Creator Identity
                </div>
                <p className="mt-1 text-xs text-arc-text-muted">
                    You shipped {bondedCount} bonded launches. Claim your
                    ERC-8004 Identity NFT — readable across every Arc dapp
                    that respects the standard.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {alreadyMinted ? (
                        <span className="inline-flex items-center gap-1 rounded-md border border-arc-success/40 bg-arc-success/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-arc-success">
                            <Gem className="h-3 w-3" />
                            Identity claimed
                        </span>
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
                                    Claim Diamond Identity
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
