"use client";
import { V4PreviewBanner } from "@/components/launchpad/V4PreviewBanner";

import { ArrowLeft, Lock, Image as ImageIcon, Upload } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import { Address, decodeEventLog, isAddress, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import {
    ARCADE_HOOK_ABI,
    ARCADE_HOOK_MODE,
    type ArcadeHookMode,
} from "@/lib/abis/arcadeHook";
import { ADDRESSES, CREATION_FEE_USDC, V4_HOOK_ENABLED } from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { encodeMetadataDataUri, resolveIpfs } from "@/lib/metadata";
import { pushToast } from "@/lib/toast";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { cn, formatUSDC } from "@/lib/utils";

const MAX_NAME = 32;
const MAX_SYMBOL = 12;
const MAX_DESCRIPTION = 280;
const MAX_SNIPE_BPS = 5_000;
const MAX_SNIPE_DECAY_MINUTES = 60;
// CLANKER direct-launch start market cap (FDV in USDC). Mirrors the hook's
// CLANKER_DEFAULT/MIN/MAX_START_MCAP constants.
const CLANKER_DEFAULT_START_MCAP = 35_000;
const CLANKER_MIN_START_MCAP = 1_000;
const CLANKER_MAX_START_MCAP = 10_000_000;

/** Fallback inline-encode the image as a downscaled JPEG data URL when Pinata
 * is not reachable. Mirrors the V2 launchpad's encodeInlineDataUrl so the V4
 * create flow stays usable on environments without PINATA_JWT. */
async function encodeInlineImage(file: File): Promise<string> {
    const blob = await new Promise<Blob | null>((resolve) => {
        const img = new window.Image();
        img.onload = () => {
            const target = 192;
            const ratio = Math.min(target / img.width, target / img.height, 1);
            const w = Math.round(img.width * ratio);
            const h = Math.round(img.height * ratio);
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) return resolve(null);
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob((b) => resolve(b), "image/jpeg", 0.72);
        };
        img.onerror = () => resolve(null);
        img.src = URL.createObjectURL(file);
    });
    if (!blob) return "";
    const buf = await blob.arrayBuffer();
    const b64 = typeof window !== "undefined"
        ? window.btoa(String.fromCharCode(...new Uint8Array(buf)))
        : "";
    return `data:image/jpeg;base64,${b64}`;
}

export default function ArcadeHookCreatePage() {
    if (!V4_HOOK_ENABLED) {
        return (
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
                <div className="rounded-2xl border border-arc-border bg-arc-surface p-8 text-center">
                    <Lock className="mx-auto h-8 w-8 text-arc-text-muted" />
                    <h1 className="mt-4 text-xl font-semibold">ArcadeHook not configured</h1>
                    <p className="mt-2 text-sm text-arc-text-muted">
                        Set <code>NEXT_PUBLIC_ARCADE_HOOK_ADDRESS</code> and{" "}
                        <code>NEXT_PUBLIC_LOCKED_VAULT_ADDRESS</code> in env to use the V4 hook.
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
    // Inner reads useSearchParams (?mode=), which Next 15 requires under a
    // Suspense boundary or the static prerender of this route fails.
    return (
        <Suspense fallback={null}>
            <Inner />
        </Suspense>
    );
}

function Inner() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const publicClient = usePublicClient();
    const { address: account, isConnected } = useAccount();

    // Mode can be preselected from the launch picker (?mode=0 PUMP, 1 CLANKER).
    const modeParam = Number(searchParams.get("mode"));
    const initialMode: ArcadeHookMode =
        modeParam === ARCADE_HOOK_MODE.CLANKER
            ? ARCADE_HOOK_MODE.CLANKER
            : ARCADE_HOOK_MODE.PUMP;

    // --- Form state ---------------------------------------------------------
    const [name, setName] = useState("");
    const [symbol, setSymbol] = useState("");
    const [description, setDescription] = useState("");
    const [image, setImage] = useState("");
    const [imagePreview, setImagePreview] = useState("");
    const [imageUploading, setImageUploading] = useState(false);
    const [mode, setMode] = useState<ArcadeHookMode>(initialMode);

    // CLANKER-only fields (only relevant when mode == CLANKER).
    const [creator2, setCreator2] = useState("");
    const [creator2Pct, setCreator2Pct] = useState(0); // % (UI 0..100)
    // CLANKER fee tier: 1/2/3 = 1%/2%/3% fixed post-graduation fee. PUMP ignores it.
    const [feeTier, setFeeTier] = useState<1 | 2 | 3>(1);
    // CLANKER: optional Twitter @handle that receives the creator fees (accrues
    // in a handle-gated escrow, claimable by the verified owner). Empty = direct.
    const [feeHandle, setFeeHandle] = useState("");
    // CLANKER: start market cap (FDV in USDC) the single-sided LP is seeded at.
    const [startMcap, setStartMcap] = useState(CLANKER_DEFAULT_START_MCAP);

    // Snipe config. Both zero means no anti-sniper.
    const [snipeStartBps, setSnipeStartBps] = useState(0);
    const [snipeDecayMinutes, setSnipeDecayMinutes] = useState(10);

    const [txState, setTxState] = useState<TxState>({ status: "idle" });

    const { ensureAllowance } = useApproveIfNeeded(ADDRESSES.usdc, ADDRESSES.arcadeHook);
    const { writeContractAsync } = useWriteContract();

    const isClanker = mode === ARCADE_HOOK_MODE.CLANKER;
    const creator2Addr =
        isClanker && creator2.trim().length > 0 && isAddress(creator2.trim())
            ? (creator2.trim() as Address)
            : (zeroAddress as Address);
    const creator2Bps = isClanker && creator2Addr !== zeroAddress ? creator2Pct * 100 : 0;

    const startMcapValid =
        !isClanker ||
        (Number.isFinite(startMcap) &&
            startMcap >= CLANKER_MIN_START_MCAP &&
            startMcap <= CLANKER_MAX_START_MCAP);

    const formValid =
        name.trim().length > 0 &&
        symbol.trim().length > 0 &&
        snipeStartBps >= 0 &&
        snipeStartBps <= MAX_SNIPE_BPS &&
        (mode === ARCADE_HOOK_MODE.PUMP || mode === ARCADE_HOOK_MODE.CLANKER) &&
        (!isClanker || creator2.trim().length === 0 || isAddress(creator2.trim())) &&
        creator2Pct >= 0 &&
        creator2Pct <= 100 &&
        startMcapValid &&
        !imageUploading;

    /**
     * Pin an image to IPFS via the project's existing /api/pin/file endpoint
     * (PINATA_JWT lives server-side only). Falls back to a 192px-downscaled
     * data:image/jpeg URL when Pinata is not reachable so the form stays
     * usable on environments without Pinata configured. Mirrors the V2
     * launchpad's onImageFile handler.
     */
    // Hard cap mirroring /api/pin/file MAX_BYTES. Catching it client-side
    // avoids a multi-MB upload that the Vercel platform rejects with an
    // opaque "RPC error" before our route can return a clean 413.
    const IMAGE_MAX_BYTES = 2_000_000;

    const onImageFile = async (file: File | undefined) => {
        if (!file) return;

        if (file.size > IMAGE_MAX_BYTES) {
            pushToast({
                kind: "error",
                title: "Image too large",
                message: `Max ${Math.round(IMAGE_MAX_BYTES / 1000)} KB. Picked file is ${(file.size / 1_000_000).toFixed(1)} MB.`,
            });
            return;
        }
        if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.type)) {
            pushToast({
                kind: "error",
                title: "Unsupported image type",
                message: "Pick a PNG, JPG, GIF, or WEBP file.",
            });
            return;
        }

        setImagePreview(URL.createObjectURL(file));
        setImageUploading(true);
        try {
            const form = new FormData();
            form.append("file", file);
            const res = await fetch("/api/pin/file", { method: "POST", body: form });
            if (!res.ok) {
                let serverMsg: string | undefined;
                try {
                    const body = (await res.json()) as { error?: string };
                    serverMsg = body?.error;
                } catch {
                    /* non-JSON platform error */
                }
                throw new Error(serverMsg ?? `pin/file ${res.status}`);
            }
            const { uri } = (await res.json()) as { uri: string };
            setImage(uri);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            pushToast({
                kind: "info",
                title: "Inline fallback",
                message: `Upload failed (${msg.slice(0, 120)}); embedding image inline instead.`,
            });
            try {
                const inline = await encodeInlineImage(file);
                setImage(inline);
            } catch {
                pushToast({
                    kind: "error",
                    title: "Image rejected",
                    message: "Could not process this file. Pick a different image.",
                });
            }
        } finally {
            setImageUploading(false);
        }
    };

    const previewSrc = imagePreview || resolveIpfs(image) || image;

    const onCreate = async () => {
        if (!isConnected || !account) {
            pushToast({ kind: "error", title: "Connect wallet first" });
            return;
        }
        if (ADDRESSES.arcadeHook === zeroAddress) {
            pushToast({ kind: "error", title: "ArcadeHook address not configured" });
            return;
        }

        try {
            setTxState({ status: "pending", message: "Approving 3 USDC creation fee..." });
            await ensureAllowance(CREATION_FEE_USDC);

            setTxState({ status: "pending", message: "Submitting createLaunch..." });
            // Anti-sniper rides the hook fee-take, which a CLANKER single-sided
            // pool cannot support; the hook reverts a snipe config on CLANKER, so
            // never send one. PUMP keeps the configured skim.
            const effectiveSnipeStartBps = isClanker ? 0 : snipeStartBps;
            const snipeDecaySeconds = effectiveSnipeStartBps > 0 ? snipeDecayMinutes * 60 : 0;
            // Build the on-chain metadataURI. encodeMetadataDataUri yields a
            // data:application/json;base64 URI that bundles name/symbol/image/
            // description in a single calldata blob, mirroring the V2 launch
            // pattern so frontends + indexers can render token info without
            // a network fetch.
            // name + symbol live on the ERC20 itself; metadataURI carries the
            // off-chain extras only (image, description, social links).
            const metadataURI = description.trim() || image
                ? encodeMetadataDataUri({
                    description: description.trim() || undefined,
                    image: image || undefined,
                })
                : "";
            const hash = await writeContractAsync({
                address: ADDRESSES.arcadeHook,
                abi: ARCADE_HOOK_ABI,
                functionName: "createLaunch",
                args: [
                    name.trim(),
                    symbol.trim(),
                    metadataURI,
                    mode,
                    creator2Addr,
                    creator2Bps,
                    effectiveSnipeStartBps,
                    snipeDecaySeconds,
                    // CLANKER: the creator-chosen fee tier (1/2/3 = 1%/2%/3%).
                    // PUMP ignores this and runs the mcap-decaying dynamic fee.
                    isClanker ? feeTier : 0,
                    // CLANKER: optional Twitter @handle to receive the creator
                    // fees (claimable by the verified handle owner). Empty =
                    // fees go direct to the launcher. PUMP ignores it.
                    isClanker ? feeHandle.trim().replace(/^@/, "") : "",
                    // CLANKER: start market cap (FDV) the single-sided LP is
                    // seeded at, in USDC micro-units. PUMP ignores it (bonding
                    // curve sets its own start price).
                    isClanker ? parseUnits(String(startMcap), 6) : 0n,
                ],
            });

            setTxState({ status: "pending", message: "Waiting for confirmation..." });
            if (!publicClient) throw new Error("public client unavailable");
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            // Pull the new token address out of the TokenLaunched event.
            let newToken: Address | undefined;
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== ADDRESSES.arcadeHook.toLowerCase()) continue;
                try {
                    const decoded = decodeEventLog({
                        abi: ARCADE_HOOK_ABI,
                        data: log.data,
                        topics: log.topics,
                    });
                    if (decoded.eventName === "TokenLaunched") {
                        newToken = (decoded.args as { token: Address }).token;
                        break;
                    }
                } catch {
                    /* not our event */
                }
            }
            if (!newToken) throw new Error("TokenLaunched event not found in receipt");

            setTxState({
                status: "success",
                hash,
                message: `Token deployed at ${newToken}`,
            });
            // Small delay so the success state is visible before nav.
            setTimeout(() => router.push(`/launchpad/v4hook/${newToken}`), 800);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            setTxState({ status: "error", message: msg });
        }
    };

    return (
        <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
            <V4PreviewBanner />
            <div className="mb-6 flex items-center gap-3">
                <Link
                    href="/launchpad"
                    className="rounded-lg border border-arc-border bg-arc-surface p-2 hover:border-arc-primary/40"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                <div className="flex-1">
                    <h1 className="text-2xl font-semibold">Launch on V4 (ArcadeHook)</h1>
                    <p className="mt-1 text-sm text-arc-text-muted">
                        Atomic createLaunch on the unified V4 hook. PUMP runs a bonding curve
                        (starts ~$5k mcap, graduates near ~$60k into a locked full-range V4 LP).
                        CLANKER launches directly: the full supply is seeded single-sided in a
                        locked V4 LP at your chosen start market cap, tradable immediately with a
                        fixed fee tier.
                    </p>
                </div>
            </div>

            <div className="space-y-5 rounded-2xl border border-arc-border bg-arc-surface p-6">
                {/* Identity row: image left, name+symbol right ---------- */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
                    <label className="flex h-32 w-32 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 self-center overflow-hidden rounded-xl border border-dashed border-arc-border bg-arc-bg-elevated transition-colors hover:border-arc-cta-hover sm:self-stretch">
                        {previewSrc ? (
                            <Image
                                src={previewSrc}
                                alt="Token icon"
                                width={128}
                                height={128}
                                unoptimized
                                className="h-full w-full object-cover"
                            />
                        ) : (
                            <>
                                <ImageIcon className="h-6 w-6 text-arc-text-muted" />
                                <span className="text-[10px] text-arc-text-muted">Token icon</span>
                                <span className="text-[10px] text-arc-text-faint">PNG / JPG</span>
                            </>
                        )}
                        <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="sr-only"
                            onChange={(e) => onImageFile(e.target.files?.[0])}
                        />
                        {imageUploading && (
                            <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] uppercase tracking-wider text-white">
                                <Upload className="mr-1 h-3 w-3 animate-pulse" />
                                Uploading
                            </span>
                        )}
                    </label>
                    <div className="flex flex-1 flex-col gap-2">
                        <label className="block text-sm">
                            <span className="text-arc-text-muted">Name</span>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value.slice(0, MAX_NAME))}
                                placeholder="Arcade Demo Token"
                                className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm focus:border-arc-cta-hover focus:outline-none"
                            />
                        </label>
                        <label className="block text-sm">
                            <span className="text-arc-text-muted">Symbol</span>
                            <input
                                value={symbol}
                                onChange={(e) =>
                                    setSymbol(
                                        e.target.value
                                            .toUpperCase()
                                            .replace(/[^A-Z0-9]/g, "")
                                            .slice(0, MAX_SYMBOL),
                                    )
                                }
                                placeholder="ARC"
                                className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm uppercase focus:border-arc-cta-hover focus:outline-none"
                            />
                        </label>
                    </div>
                </div>
                <label className="block text-sm">
                    <span className="text-arc-text-muted">
                        Description{" "}
                        <span className="text-xs text-arc-text-faint">
                            ({description.length} / {MAX_DESCRIPTION})
                        </span>
                    </span>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
                        placeholder="A short pitch your token deserves..."
                        rows={3}
                        className="mt-1 w-full resize-none rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm focus:border-arc-cta-hover focus:outline-none"
                    />
                </label>

                {/* Mode select -------------------------------------------- */}
                <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                    <span className="text-sm font-medium text-arc-text">Launch mode</span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <ModeButton
                            active={mode === ARCADE_HOOK_MODE.PUMP}
                            onClick={() => setMode(ARCADE_HOOK_MODE.PUMP)}
                            title="PUMP"
                            subtitle="Dynamic fee 1% -> 0.30%"
                            description="Post-grad swap fee decays with market cap, pump.fun-style. 80% you / 20% protocol."
                        />
                        <ModeButton
                            active={mode === ARCADE_HOOK_MODE.CLANKER}
                            onClick={() => setMode(ARCADE_HOOK_MODE.CLANKER)}
                            title="CLANKER"
                            subtitle="Direct launch, fixed fee 1/2/3%"
                            description="No curve: full supply seeded single-sided in a locked V4 LP, tradable at once. Fixed swap fee, 80% you / 20% protocol."
                        />
                    </div>
                </div>

                {/* Start market cap (CLANKER only) --------------------------- */}
                {isClanker && (
                    <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                        <span className="text-sm font-medium text-arc-text">Start market cap</span>
                        <label className="block text-sm">
                            <span className="text-arc-text-muted">FDV in USDC</span>
                            <input
                                type="number"
                                min={CLANKER_MIN_START_MCAP}
                                max={CLANKER_MAX_START_MCAP}
                                step={1_000}
                                value={startMcap}
                                onChange={(e) => setStartMcap(Number(e.target.value))}
                                placeholder={String(CLANKER_DEFAULT_START_MCAP)}
                                className={cn(
                                    "mt-1 w-full rounded-lg border bg-arc-bg px-3 py-2 text-sm tabular-nums focus:outline-none",
                                    startMcapValid
                                        ? "border-arc-border focus:border-arc-cta-hover"
                                        : "border-red-500/60 focus:border-red-500",
                                )}
                            />
                        </label>
                        <p className="text-xs text-arc-text-faint">
                            The full supply is seeded single-sided at this fully-diluted valuation
                            (${CLANKER_MIN_START_MCAP.toLocaleString()} to $
                            {CLANKER_MAX_START_MCAP.toLocaleString()}). The price only moves as
                            people buy. Default ${CLANKER_DEFAULT_START_MCAP.toLocaleString()}.
                        </p>
                    </div>
                )}

                {/* Creator2 (CLANKER only) ----------------------------------- */}
                {isClanker && (
                    <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                        <span className="text-sm font-medium text-arc-text">
                            Optional secondary recipient
                        </span>
                        <label className="block text-sm">
                            <span className="text-arc-text-muted">Address</span>
                            <input
                                value={creator2}
                                onChange={(e) => setCreator2(e.target.value)}
                                placeholder="0x... (optional)"
                                className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm tabular-nums focus:border-arc-cta-hover focus:outline-none"
                            />
                        </label>
                        <label className="block text-sm">
                            <span className="text-arc-text-muted">
                                Share of creator cut ({creator2Pct}%)
                            </span>
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={creator2Pct}
                                onChange={(e) => setCreator2Pct(Number(e.target.value))}
                                disabled={creator2.trim().length === 0}
                                className="mt-2 w-full"
                            />
                        </label>
                        <p className="text-xs text-arc-text-faint">
                            Only active in CLANKER mode. Leave empty to route the full creator
                            cut to the launcher.
                        </p>

                        <div className="border-t border-arc-border pt-3">
                            <span className="text-sm text-arc-text-muted">
                                Post-graduation fee tier
                            </span>
                            <div className="mt-2 flex gap-2">
                                {([1, 2, 3] as const).map((t) => (
                                    <button
                                        key={t}
                                        type="button"
                                        onClick={() => setFeeTier(t)}
                                        className={`flex-1 rounded-lg border px-3 py-2 text-sm tabular-nums transition ${
                                            feeTier === t
                                                ? "border-arc-cta-hover bg-arc-cta/10 text-arc-text"
                                                : "border-arc-border bg-arc-bg text-arc-text-muted hover:border-arc-cta-hover"
                                        }`}
                                    >
                                        {t}%
                                    </button>
                                ))}
                            </div>
                            <p className="mt-2 text-xs text-arc-text-faint">
                                Fixed swap fee once the token graduates to the AMM. 80% to you,
                                20% to the protocol. PUMP mode instead decays from 1% to 0.30% as
                                market cap grows.
                            </p>
                        </div>

                        <label className="block border-t border-arc-border pt-3 text-sm">
                            <span className="text-arc-text-muted">
                                Send creator fees to a Twitter @ (optional)
                            </span>
                            <input
                                value={feeHandle}
                                onChange={(e) => setFeeHandle(e.target.value)}
                                placeholder="@handle — leave empty to receive fees in your wallet"
                                className="mt-1 w-full rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm focus:border-arc-cta-hover focus:outline-none"
                            />
                            <p className="mt-1 text-xs text-arc-text-faint">
                                The creator fees accrue in a handle-gated escrow; the verified
                                owner of the @ claims them after connecting a wallet. Useful when
                                launching a token on behalf of someone who has not joined yet.
                            </p>
                        </label>
                    </div>
                )}

                {/* Anti-sniper (PUMP only) -------------------------------- */}
                {/* CLANKER's single-sided pool can't carry the hook fee-take the
                    anti-sniper skim rides on; the hook rejects a snipe config on
                    CLANKER, so the control is hidden there (the tier LP fee is
                    CLANKER's only friction). */}
                {!isClanker && (
                <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
                    <span className="text-sm font-medium text-arc-text">
                        Anti-sniper tax (optional)
                    </span>
                    <label className="block text-sm">
                        <span className="text-arc-text-muted">
                            Starting rate ({(snipeStartBps / 100).toFixed(2)}%)
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={MAX_SNIPE_BPS}
                            step={100}
                            value={snipeStartBps}
                            onChange={(e) => setSnipeStartBps(Number(e.target.value))}
                            className="mt-2 w-full"
                        />
                    </label>
                    <label className="block text-sm">
                        <span className="text-arc-text-muted">
                            Decay window ({snipeDecayMinutes} min)
                        </span>
                        <input
                            type="range"
                            min={1}
                            max={MAX_SNIPE_DECAY_MINUTES}
                            step={1}
                            value={snipeDecayMinutes}
                            onChange={(e) => setSnipeDecayMinutes(Number(e.target.value))}
                            disabled={snipeStartBps === 0}
                            className="mt-2 w-full"
                        />
                    </label>
                    <p className="text-xs text-arc-text-faint">
                        Linear decay from start rate to 0 over the window. Only applies to
                        post-graduation BUYs through the V4 router.
                    </p>
                </div>
                )}

                {/* Fee summary --------------------------------------------- */}
                <div className="flex items-center justify-between rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm">
                    <span className="text-arc-text-muted">Creation fee</span>
                    <span>{formatUSDC(CREATION_FEE_USDC)} USDC</span>
                </div>

                {/* Submit -------------------------------------------------- */}
                <button type="button"
                    onClick={onCreate}
                    disabled={!formValid || txState.status === "pending"}
                    className={cn(
                        "arc-button-primary w-full py-3 text-sm font-semibold",
                        (!formValid || txState.status === "pending") &&
                            "cursor-not-allowed opacity-50",
                    )}
                >
                    {txState.status === "pending"
                        ? "Submitting..."
                        : `Create launch (pays ${formatUSDC(CREATION_FEE_USDC)} USDC)`}
                </button>

                <TxStatus state={txState} />
            </div>
        </div>
    );
}

function ModeButton({
    active,
    onClick,
    title,
    subtitle,
    description,
}: {
    active: boolean;
    onClick: () => void;
    title: string;
    subtitle: string;
    description: string;
}) {
    return (
        <button
            onClick={onClick}
            type="button"
            className={cn(
                "rounded-xl border p-3 text-left transition-all",
                active
                    ? "border-arc-cta-hover bg-arc-cta-hover/10"
                    : "border-arc-border bg-arc-bg hover:border-arc-cta-hover/40",
            )}
        >
            <div className="text-sm font-semibold">{title}</div>
            <div className="mt-0.5 text-xs text-arc-text-muted">{subtitle}</div>
            <div className="mt-2 text-[11px] text-arc-text-faint">{description}</div>
        </button>
    );
}
