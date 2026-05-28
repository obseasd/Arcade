"use client";

import { ArrowLeft, X, Image as ImageIcon, Upload, ChevronDown, Pencil, Check } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { decodeEventLog, encodeAbiParameters, erc20Abi, isAddress, parseUnits, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES, CREATION_FEE_USDC, LaunchMode } from "@/lib/constants";
import { encodeMetadataDataUri } from "@/lib/metadata";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { RecipientEditModal } from "@/components/bridge/RecipientEditModal";
import { cn, formatAddress, formatUSDC } from "@/lib/utils";

/** Display label for a launch mode (contract modes are unchanged). */
function modeLabel(mode: LaunchMode): string {
  if (mode === LaunchMode.PUMP) return "Pump";
  if (mode === LaunchMode.CLANKER) return "Arcade";
  return "Clanker"; // CLANKER_V3
}

/** Filled-track gradient for `.arc-slider`, given the value as a 0-100 %.
 * Filled = the site's blue accent; unfilled = translucent white (stays legible,
 * never the page background) — same active/inactive contrast as a slider's dots. */
function sliderFill(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  return `linear-gradient(to right, #15508f 0%, #2f7fd6 ${p}%, rgba(255,255,255,0.16) ${p}%, rgba(255,255,255,0.16) 100%)`;
}

/** Pool-type presets (mirror the launchpad's POOL_* constants). */
const POOL_TYPES = [
  { id: 0 as const, label: "Standard", sub: "USDC · 35k · 3 positions" },
  { id: 1 as const, label: "Legacy", sub: "USDC · custom · 1 position" },
  { id: 2 as const, label: "Deep", sub: "USDC · 50k · 3 positions" },
  { id: 3 as const, label: "WETH", sub: "WETH · 10 ETH · 3 positions" },
];

/** Reward-token preference (matches the locker's RewardToken enum). */
type RewardPref = 0 | 1 | 2; // 0 = Both, 1 = USDC (Paired), 2 = Token (Clanker)

interface RecipientRow {
  recipient: string;
  // checked = this recipient manages its own slot (admin = recipient);
  // unchecked = the creator (connected wallet) stays admin of the slot.
  isAdmin: boolean;
  pct: number; // 0–100, all rows auto-balance to 100
  pref: RewardPref;
}

export default function CreateTokenPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 text-arc-text-muted">Loading…</div>}>
      <CreateTokenInner />
    </Suspense>
  );
}

function CreateTokenInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { address: account } = useAccount();
  const publicClient = usePublicClient();

  // Launch mode is chosen in the modal on /launchpad and passed via ?mode=.
  const modeParam = Number(searchParams.get("mode"));
  const initialMode: LaunchMode =
    modeParam === LaunchMode.CLANKER || modeParam === LaunchMode.CLANKER_V3
      ? modeParam
      : LaunchMode.PUMP;

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [mode] = useState<LaunchMode>(initialMode);
  const [creator2, setCreator2] = useState("");
  const [creator2SharePct, setCreator2SharePct] = useState(50); // 0–100
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  // CLANKER_V3 fee recipients (up to 3). Defaults to the connected wallet 100%.
  const [recipients, setRecipients] = useState<RecipientRow[]>([
    { recipient: "", isAdmin: true, pct: 100, pref: 0 },
  ]);
  const [feeTier, setFeeTier] = useState<10_000 | 20_000 | 30_000>(10_000); // 1% / 2% / 3%
  // Pool type (Clanker-style presets): 0 Standard (USDC 35k, 3 pos), 1 Legacy
  // (USDC custom, 1 pos), 2 Deep (USDC 50k, 3 pos), 3 WETH (10 ETH, 3 pos).
  const [poolType, setPoolType] = useState<0 | 1 | 2 | 3>(0);
  const [legacyMcapStr, setLegacyMcapStr] = useState("35000"); // USDC, Legacy only
  const [creatorBuyStr, setCreatorBuyStr] = useState(""); // USDC to spend buying at launch
  // Optional team vault (locked/vesting allocation).
  const [vaultPct, setVaultPct] = useState(0); // 0–90% of supply
  const [vaultLockupDays, setVaultLockupDays] = useState(30);
  const [vaultVestingDays, setVaultVestingDays] = useState(0);
  // Vault recipient: defaults to the connected wallet; pencil opens an override.
  const [vaultRecipientOverride, setVaultRecipientOverride] = useState<Address | null>(null);
  const [vaultRecipientModalOpen, setVaultRecipientModalOpen] = useState(false);
  // Optional anti-sniper tax (soft, router-enforced): a starting % of each buy
  // skimmed to the treasury, decaying linearly to 0 over the window (seconds).
  const [snipeStartPct, setSnipeStartPct] = useState(0); // 0-50%
  const [snipeDecaySeconds, setSnipeDecaySeconds] = useState(10);
  const isV3 = mode === LaunchMode.CLANKER_V3;

  const snipeValid = !isV3 || snipeStartPct === 0 || (snipeStartPct <= 50 && snipeDecaySeconds >= 1);

  // Effective vault recipient (override, else the connected wallet).
  const vaultRecipient = vaultRecipientOverride ?? account;
  const vaultValid = !isV3 || vaultPct === 0 || (vaultPct <= 90 && vaultLockupDays >= 7);

  // Background illustration matching the chosen launch mode.
  const modeBg =
    mode === LaunchMode.PUMP
      ? "/pumpfuntoken.png"
      : mode === LaunchMode.CLANKER
        ? "/arctoken.png"
        : "/clankertoken.png";
  const isWethPool = poolType === 3;
  const legacyMcapNum = Number(legacyMcapStr);
  const poolValid =
    !isV3 ||
    poolType !== 1 ||
    (Number.isFinite(legacyMcapNum) && legacyMcapNum >= 1 && legacyMcapNum <= 1_000_000);
  // Preview helpers.
  const pairedSymbol = isWethPool ? "WETH" : "USDC";
  const positionsCount = poolType === 1 ? 1 : 3;
  const startMcapLabel =
    poolType === 0
      ? "35,000 USDC"
      : poolType === 1
        ? `${legacyMcapStr || "0"} USDC`
        : poolType === 2
          ? "50,000 USDC"
          : "10 WETH";

  // Prefill the first recipient with the connected wallet.
  useEffect(() => {
    if (!account) return;
    setRecipients((prev) =>
      prev[0] && prev[0].recipient === ""
        ? [{ ...prev[0], recipient: account }, ...prev.slice(1)]
        : prev,
    );
  }, [account]);

  const recipientsValid = (() => {
    if (!isV3) return true;
    if (recipients.length < 1 || recipients.length > 3) return false;
    let sum = 0;
    for (const r of recipients) {
      if (!isAddress(r.recipient.trim())) return false;
      if (r.pct <= 0) return false;
      sum += r.pct;
    }
    return sum === 100;
  })();

  const setRecipient = (i: number, patch: Partial<RecipientRow>) =>
    setRecipients((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Set one row's % and auto-balance the remainder across the other rows
  // (proportional to their current weights; equal split if they're all 0).
  const setRecipientPct = (i: number, raw: number) =>
    setRecipients((prev) => {
      if (prev.length === 1) return prev.map((r) => ({ ...r, pct: 100 }));
      const v = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
      const remaining = 100 - v;
      const otherIdx = prev.map((_, idx) => idx).filter((idx) => idx !== i);
      const otherSum = otherIdx.reduce((a, idx) => a + (prev[idx].pct || 0), 0);
      const shares: Record<number, number> = {};
      let acc = 0;
      otherIdx.forEach((idx) => {
        const s = otherSum > 0
          ? Math.round((prev[idx].pct / otherSum) * remaining)
          : Math.round(remaining / otherIdx.length);
        shares[idx] = s;
        acc += s;
      });
      // Absorb rounding drift on the last "other" row.
      if (otherIdx.length > 0) shares[otherIdx[otherIdx.length - 1]] += remaining - acc;
      return prev.map((r, idx) =>
        idx === i ? { ...r, pct: v } : { ...r, pct: Math.max(0, shares[idx]) },
      );
    });

  // Add a row and re-split everything evenly so the total stays at 100.
  const addRecipient = () =>
    setRecipients((prev) => {
      if (prev.length >= 3) return prev;
      const next = [...prev, { recipient: "", isAdmin: true, pct: 0, pref: 0 as RewardPref }];
      const base = Math.floor(100 / next.length);
      return next.map((r, idx) => ({ ...r, pct: idx === 0 ? 100 - base * (next.length - 1) : base }));
    });

  // Remove a row and give its share back to the first remaining row.
  const removeRecipient = (i: number) =>
    setRecipients((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      if (next.length === 0) return prev;
      const sum = next.reduce((a, r) => a + (r.pct || 0), 0);
      next[0] = { ...next[0], pct: Math.max(0, next[0].pct + (100 - sum)) };
      return next;
    });

  // Read an uploaded image, downscale to 256px (keeps the on-chain metadata
  // string small), and store it as a data: URL so no external hosting is needed.
  const onImageFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new window.Image();
      img.onload = () => {
        const max = 256;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setImage(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        setImage(canvas.toDataURL("image/png"));
      };
      img.onerror = () => setImage(dataUrl);
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const usdcBalance = useReadContract({
    address: ADDRESSES.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account },
  });

  const { ensureAllowance } = useApproveIfNeeded(ADDRESSES.usdc, ADDRESSES.launchpad);
  const { writeContractAsync } = useWriteContract();

  const hasFee =
    (usdcBalance.data as bigint | undefined) !== undefined &&
    (usdcBalance.data as bigint) >= CREATION_FEE_USDC;

  const valid = name.trim().length > 0 && symbol.trim().length > 0 && symbol.trim().length <= 12;

  const onSubmit = async () => {
    if (!account || !valid) return;
    setTx({ status: "pending", message: "Approving USDC creation fee…" });
    try {
      // Creator buy (V3 only): the launchpad pulls this USDC on top of the fee.
      let creatorBuyUsdc = 0n;
      if (isV3 && !isWethPool && creatorBuyStr.trim()) {
        try {
          creatorBuyUsdc = parseUnits(creatorBuyStr.trim(), 6);
        } catch {
          creatorBuyUsdc = 0n;
        }
      }
      await ensureAllowance(CREATION_FEE_USDC + creatorBuyUsdc);

      setTx({ status: "pending", message: "Building metadata…" });
      const metadataURI = encodeMetadataDataUri({
        image: image.trim() || undefined,
        description: description.trim() || undefined,
        twitter: twitter.trim() || undefined,
        telegram: telegram.trim() || undefined,
        website: website.trim() || undefined,
      });

      setTx({ status: "pending", message: "Launching token…" });

      let hash: `0x${string}`;
      if (isV3) {
        // Clanker mode: custom fee recipients (up to 3) with admin + token pref.
        const rs = recipients.map((r) => {
          const rec = r.recipient.trim() as Address;
          // Admin must be non-zero (the locker rejects address(0)): the slot's
          // admin is the recipient itself when "Admin" is checked, else the creator.
          const adm = (r.isAdmin ? rec : (account as string)) as Address;
          return { recipient: rec, admin: adm, bps: Math.round(r.pct * 100), tokenPref: r.pref };
        });
        // Bundled ClankerOptions, ABI-encoded as bytes (the contract takes
        // `bytes optsData` so its calldata decoder stays within via_ir's
        // stack budget). Tuple order must match the on-chain struct.
        const optsData = encodeAbiParameters(
          [
            {
              type: "tuple",
              components: [
                { name: "fee", type: "uint24" },
                { name: "creatorBuyUsdc", type: "uint256" },
                { name: "vaultPct", type: "uint16" },
                { name: "vaultLockupDuration", type: "uint64" },
                { name: "vaultVestingDuration", type: "uint64" },
                { name: "vaultRecipient", type: "address" },
                { name: "snipeStartBps", type: "uint16" },
                { name: "snipeDecaySeconds", type: "uint32" },
                { name: "poolType", type: "uint8" },
                { name: "legacyMcapUsdc", type: "uint256" },
              ],
            },
          ],
          [
            {
              fee: feeTier,
              creatorBuyUsdc,
              vaultPct: Math.round(vaultPct * 100),
              vaultLockupDuration: BigInt((vaultLockupDays || 0) * 86_400),
              vaultVestingDuration: BigInt((vaultVestingDays || 0) * 86_400),
              vaultRecipient: (vaultRecipientOverride ?? account) as Address,
              snipeStartBps: Math.round(snipeStartPct * 100),
              snipeDecaySeconds: snipeDecaySeconds || 0,
              poolType,
              // Legacy custom start mcap (USDC, 6dp); 0 for the fixed presets.
              legacyMcapUsdc: poolType === 1 ? parseUnits(legacyMcapStr.trim() || "0", 6) : 0n,
            },
          ],
        );
        // Explicit gas limit: wallets that can't simulate on a custom chain
        // (Arc) fall back to a bogus low estimate. createClankerV3 needs
        // ~11-12M gas. We use a tight +10% buffer and cap at 14M because
        // public RPCs (thirdweb) reject per-tx gas above ~15M even when the
        // block limit is higher.
        const clankerArgs = [name.trim(), symbol.trim(), metadataURI, rs, optsData] as const;
        const GAS_CAP = 14_000_000n;
        let gas = GAS_CAP;
        if (publicClient) {
          try {
            const est = await publicClient.estimateContractGas({
              address: ADDRESSES.launchpad,
              abi: LAUNCHPAD_ABI,
              functionName: "createClankerV3",
              args: clankerArgs,
              account,
            });
            const buffered = (est * 110n) / 100n;
            gas = buffered > GAS_CAP ? GAS_CAP : buffered;
          } catch {
            /* keep the cap fallback */
          }
        }
        hash = await writeContractAsync({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "createClankerV3",
          args: clankerArgs,
          gas,
        });
      } else {
        // PUMP / Arcade (CLANKER): bonding curve. Arcade allows an optional
        // secondary creator address.
        const trimmedC2 = creator2.trim();
        const useCreator2 =
          mode === LaunchMode.CLANKER && trimmedC2.length > 0 && isAddress(trimmedC2);
        const creator2Addr: Address = useCreator2 ? (trimmedC2 as Address) : zeroAddress;
        const creator2ShareBps = useCreator2 ? Math.round(creator2SharePct * 100) : 0;
        const args = [name.trim(), symbol.trim(), metadataURI, mode, creator2Addr, creator2ShareBps] as const;
        // Explicit gas (wallet sim doesn't work on Arc): a curve launch needs ~1.5M.
        let gas = 3_000_000n;
        if (publicClient) {
          try {
            const est = await publicClient.estimateContractGas({
              address: ADDRESSES.launchpad,
              abi: LAUNCHPAD_ABI,
              functionName: "createToken",
              args,
              account,
            });
            gas = (est * 125n) / 100n;
          } catch {
            /* keep the fallback */
          }
        }
        hash = await writeContractAsync({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "createToken",
          args,
          gas,
        });
      }

      if (!publicClient) throw new Error("No public client");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Decode the TokenCreated event to grab the new token address
      let newAddr: `0x${string}` | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: LAUNCHPAD_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenCreated") {
            newAddr = (decoded.args as any).token as `0x${string}`;
            break;
          }
        } catch {
          /* skip */
        }
      }

      setTx({ status: "success", message: "Token launched!" });
      if (newAddr) {
        router.push(`/launchpad/${newAddr}`);
      } else {
        router.push("/launchpad");
      }
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Failed to launch" });
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link
        href="/launchpad"
        className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
      >
        <ArrowLeft className="h-4 w-4" /> Launchpad
      </Link>
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-semibold sm:text-4xl">
          Launch a{" "}
          <span className="bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover bg-clip-text text-transparent">
            {modeLabel(mode)}
          </span>
        </h1>
        <p className="mx-auto mt-2 max-w-lg text-sm text-arc-text-muted">
          {mode === LaunchMode.CLANKER_V3
            ? "Deploy instantly. Full supply locked single-sided in a V3 pool, tradeable right away, LP un-ruggable, fees to you."
            : "Trading starts on a bonding curve and migrates to the DEX automatically when it fills."}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="arc-card space-y-5 p-6">
        {/* Image (left, square — spans the 3 fields) + launch mode / name / symbol */}
        <div className="flex gap-2">
          <label className="flex w-32 shrink-0 cursor-pointer flex-col items-center justify-center gap-1.5 self-stretch overflow-hidden rounded-xl border border-dashed border-arc-border bg-arc-bg-elevated transition-colors hover:border-arc-cta-hover">
            {image.trim() ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image.trim()} alt="" className="h-full w-full object-cover" />
            ) : (
              <>
                <Upload className="h-6 w-6 text-arc-text-faint" />
                <span className="text-[10px] leading-none text-arc-text-faint">PNG / JPEG</span>
              </>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => onImageFile(e.target.files?.[0])}
            />
          </label>
          <div className="flex flex-1 flex-col gap-2">
            {/* Launch mode — background = the mode's illustration */}
            <div
              className="relative flex items-center justify-between overflow-hidden rounded-xl border border-arc-border bg-cover bg-center px-4 py-2"
              style={{ backgroundImage: `url('${modeBg}')` }}
            >
              <span className="pointer-events-none absolute inset-0 bg-black/55" aria-hidden />
              <div className="relative">
                <div className="text-xs text-white/70">Launch mode</div>
                <div className="text-sm font-semibold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {modeLabel(mode)}
                </div>
              </div>
              <Link href="/launchpad" className="relative text-xs font-medium text-white hover:underline">
                Change
              </Link>
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 32))}
              placeholder="Token name"
              className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5"
            />
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
              placeholder="$SYMBOL"
              className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-1.5 tabular-nums"
            />
          </div>
        </div>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            placeholder="A short description visible on the token page…"
            rows={3}
            className="arc-input w-full resize-none rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
          />
        </Field>

        {isV3 && (
          <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
            <span className="text-sm font-medium text-arc-text">Pool type</span>
            <div className="grid grid-cols-2 gap-2">
              {POOL_TYPES.map((pt) => (
                <button
                  key={pt.id}
                  type="button"
                  onClick={() => setPoolType(pt.id)}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-all",
                    poolType === pt.id
                      ? "border-arc-cta-hover bg-arc-cta-hover/15"
                      : "border-arc-border bg-white/[0.03] hover:bg-white/[0.05]",
                  )}
                >
                  <div className="text-sm font-semibold text-arc-text">{pt.label}</div>
                  <div className="text-[11px] text-arc-text-faint">{pt.sub}</div>
                </button>
              ))}
            </div>
            {poolType === 1 && (
              <Field label="Starting market cap (USDC)" hint="1 to 1,000,000.">
                <input
                  inputMode="numeric"
                  value={legacyMcapStr}
                  onChange={(e) => setLegacyMcapStr(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="35000"
                  className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 tabular-nums"
                />
              </Field>
            )}
            {!poolValid && (
              <div className="text-xs text-arc-danger">Starting market cap must be 1 to 1,000,000 USDC.</div>
            )}
          </div>
        )}

        {isV3 && (
          <div className="space-y-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-4">
            <span className="text-sm font-medium text-arc-text">Fee recipients</span>
            {recipients.map((r, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-arc-border bg-white/[0.03] p-3">
                <div className="flex items-center gap-2">
                  <input
                    value={r.recipient}
                    onChange={(e) => setRecipient(i, { recipient: e.target.value })}
                    placeholder="0x recipient"
                    className="arc-input flex-1 rounded-lg border border-arc-border bg-arc-bg-elevated px-2 py-1.5 text-sm tabular-nums"
                  />
                  <input
                    inputMode="numeric"
                    value={r.pct}
                    readOnly={recipients.length === 1}
                    onChange={(e) => setRecipientPct(i, parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10))}
                    className="arc-input w-14 rounded-lg border border-arc-border bg-arc-bg-elevated px-2 py-1.5 text-right text-sm tabular-nums"
                  />
                  <span className="text-xs text-arc-text-muted">%</span>
                  {recipients.length > 1 && (
                    <button
                      onClick={() => removeRecipient(i)}
                      className="text-arc-text-faint transition-colors hover:text-arc-danger"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <PrefSelect value={r.pref} onChange={(v) => setRecipient(i, { pref: v })} />
                  <button
                    type="button"
                    onClick={() => setRecipient(i, { isAdmin: !r.isAdmin })}
                    title="On: this recipient can rotate its own payout later. Off: you (the creator) stay admin of this slot."
                    className={cn(
                      "flex select-none items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                      r.isAdmin
                        ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
                        : "border-arc-border bg-arc-bg-elevated text-arc-text-muted hover:text-arc-text",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors",
                        r.isAdmin ? "border-arc-cta-hover bg-arc-cta-hover text-white" : "border-arc-border",
                      )}
                    >
                      {r.isAdmin && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                    Admin
                  </button>
                </div>
              </div>
            ))}
            {recipients.length < 3 && (
              <button onClick={addRecipient} className="text-xs font-medium text-arc-cta-hover hover:underline">
                + Add recipient
              </button>
            )}
            {!recipientsValid && recipients.some((r) => r.recipient.trim() !== "") && (
              <div className="text-xs text-arc-danger">Recipients must be valid addresses summing to 100%.</div>
            )}
          </div>
        )}

        {isV3 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Fee tier */}
            <div>
              <div className="mb-1.5 text-sm font-medium text-arc-text">Fee tier</div>
              <div className="flex gap-2">
                {([10_000, 20_000, 30_000] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFeeTier(f)}
                    className={cn(
                      "flex-1 rounded-xl border py-2 text-sm font-semibold transition-all",
                      feeTier === f
                        ? "border-arc-cta-hover bg-arc-cta-hover/15 text-arc-text"
                        : "border-arc-border bg-arc-bg-elevated text-arc-text-muted hover:bg-arc-surface",
                    )}
                  >
                    {f / 10_000}%
                  </button>
                ))}
              </div>
            </div>

            {/* Creator buy (USDC pools only) */}
            <div>
              <div className="mb-1.5 text-sm font-medium text-arc-text">Creator buy</div>
              <div
                className={cn(
                  "flex items-center gap-2 rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2",
                  isWethPool && "opacity-50",
                )}
              >
                <input
                  value={isWethPool ? "" : creatorBuyStr}
                  onChange={(e) => setCreatorBuyStr(e.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder={isWethPool ? "Unavailable on WETH pools" : "0"}
                  inputMode="decimal"
                  disabled={isWethPool}
                  className="arc-input flex-1 bg-transparent text-sm tabular-nums"
                />
                {!isWethPool && <span className="text-xs text-arc-text-muted">USDC</span>}
              </div>
            </div>
          </div>
        )}

        {isV3 && (
          <details className="rounded-xl border border-arc-border bg-arc-bg-elevated open:bg-arc-surface">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm text-arc-text-muted hover:text-arc-text">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/safe.png" alt="" className="h-4 w-4 shrink-0" />
              <span>Team vault</span>
              <ChevronDown className="arc-disclosure ml-auto h-4 w-4 shrink-0 text-arc-text-faint" />
            </summary>
            <div className="space-y-3 px-4 pb-4">
              <RangeField label={`Vaulted supply: ${vaultPct}%`}>
                <input
                  type="range"
                  min={0}
                  max={90}
                  step={1}
                  value={vaultPct}
                  onChange={(e) => setVaultPct(Number(e.target.value))}
                  className="arc-slider"
                  style={{ background: sliderFill((vaultPct / 90) * 100) }}
                />
              </RangeField>
              {vaultPct > 0 && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Lockup" hint="Days, min 7.">
                      <input
                        type="number"
                        min={7}
                        value={vaultLockupDays}
                        onChange={(e) => setVaultLockupDays(Number(e.target.value))}
                        className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 tabular-nums"
                      />
                    </Field>
                    <Field label="Vesting" hint="Days.">
                      <input
                        type="number"
                        min={0}
                        value={vaultVestingDays}
                        onChange={(e) => setVaultVestingDays(Number(e.target.value))}
                        className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 tabular-nums"
                      />
                    </Field>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-sm font-medium text-arc-text">Vault recipient</span>
                    <button
                      type="button"
                      onClick={() => setVaultRecipientModalOpen(true)}
                      className="flex w-full items-center justify-between rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-left transition-colors hover:border-arc-cta-hover"
                    >
                      <span className="text-sm tabular-nums text-arc-text">
                        {vaultRecipient ? formatAddress(vaultRecipient) : "Connect wallet"}
                        {!vaultRecipientOverride && account && (
                          <span className="ml-2 text-xs text-arc-text-faint">(you)</span>
                        )}
                      </span>
                      <Pencil className="h-3.5 w-3.5 text-arc-text-faint" />
                    </button>
                  </div>
                  {!vaultValid && (
                    <div className="text-xs text-arc-danger">Lockup must be ≥ 7 days.</div>
                  )}
                </>
              )}
            </div>
          </details>
        )}

        {isV3 && (
          <details className="rounded-xl border border-arc-border bg-arc-bg-elevated open:bg-arc-surface">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm text-arc-text-muted hover:text-arc-text">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/target.png" alt="" className="h-4 w-4 shrink-0" />
              <span>Anti-sniper tax - tax early buys, decaying to zero (optional)</span>
              <ChevronDown className="arc-disclosure ml-auto h-4 w-4 shrink-0 text-arc-text-faint" />
            </summary>
            <div className="space-y-3 px-4 pb-4">
              <RangeField
                label={`Starting tax: ${snipeStartPct}%`}
                hint="Max 50%. 0 disables the tax."
              >
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
                  value={snipeStartPct}
                  onChange={(e) => setSnipeStartPct(Number(e.target.value))}
                  className="arc-slider"
                  style={{ background: sliderFill((snipeStartPct / 50) * 100) }}
                />
              </RangeField>
              {snipeStartPct > 0 && (
                <Field label="Decay window (seconds)">
                  <input
                    inputMode="numeric"
                    value={snipeDecaySeconds}
                    onChange={(e) => setSnipeDecaySeconds(parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10))}
                    className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 tabular-nums"
                  />
                </Field>
              )}
              {!snipeValid && (
                <div className="text-xs text-arc-danger">
                  Starting tax must be ≤ 50% and the decay window at least 1 second.
                </div>
              )}
            </div>
          </details>
        )}

        {mode === LaunchMode.CLANKER && (
          <details className="rounded-xl border border-arc-border bg-arc-bg-elevated open:bg-arc-surface">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm text-arc-text-muted hover:text-arc-text">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/social.png" alt="" className="h-4 w-4 shrink-0" />
              <span>Secondary creator fee receiver (optional)</span>
              <ChevronDown className="arc-disclosure ml-auto h-4 w-4 shrink-0 text-arc-text-faint" />
            </summary>
            <div className="space-y-3 px-4 pb-4">
              <Field
                label="Second creator address"
                hint="When set, a share of the creator portion is routed here."
              >
                <input
                  value={creator2}
                  onChange={(e) => setCreator2(e.target.value)}
                  placeholder="0x…"
                  className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 tabular-nums"
                />
              </Field>
              {creator2 && !isAddress(creator2.trim()) && (
                <div className="text-xs text-arc-danger">Invalid address.</div>
              )}
              <RangeField
                label={`Share to second receiver: ${creator2SharePct}%`}
                hint="Of the creator portion (the other half goes to the launcher wallet)."
              >
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={creator2SharePct}
                  onChange={(e) => setCreator2SharePct(Number(e.target.value))}
                  className="arc-slider"
                  style={{ background: sliderFill(creator2SharePct) }}
                />
              </RangeField>
            </div>
          </details>
        )}

        <details className="rounded-xl border border-arc-border bg-arc-bg-elevated open:bg-arc-surface">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm text-arc-text-muted hover:text-arc-text">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/social.png" alt="" className="h-4 w-4 shrink-0" />
            <span>Socials (optional)</span>
            <ChevronDown className="arc-disclosure ml-auto h-4 w-4 shrink-0 text-arc-text-faint" />
          </summary>
          <div className="space-y-3 px-4 pb-4">
            <Field label="Twitter / X">
              <input
                value={twitter}
                onChange={(e) => setTwitter(e.target.value)}
                placeholder="https://twitter.com/..."
                className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
              />
            </Field>
            <Field label="Telegram">
              <input
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                placeholder="https://t.me/..."
                className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
              />
            </Field>
            <Field label="Website">
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://..."
                className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
              />
            </Field>
          </div>
        </details>
        </div>
        {/* End form card */}

        {/* Live preview - mirrors Clanker's right-hand summary. */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <div className="arc-card space-y-4 p-5">
            <div className="flex items-center gap-3">
              {image.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={image.trim()}
                  alt=""
                  className="h-12 w-12 rounded-xl object-cover ring-1 ring-arc-border"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-arc-border">
                  <ImageIcon className="h-5 w-5 text-arc-text-faint" />
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate font-semibold text-arc-text">{name.trim() || "Token name"}</div>
                <div className="flex items-center gap-1.5 text-sm text-arc-text-muted">
                  <span className="truncate">${symbol.trim() || "SYMBOL"}</span>
                  <span className="text-arc-text-faint">·</span>
                  <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-arc-text">
                    Arc
                  </span>
                </div>
              </div>
            </div>

            {isV3 ? (
              <>
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-arc-text-muted">Liquidity Pool</span>
                    <span className="tabular-nums text-arc-text">{100 - vaultPct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-arc-cta-hover to-arc-primary-hover transition-all"
                      style={{ width: `${100 - vaultPct}%` }}
                    />
                  </div>
                  {vaultPct > 0 && (
                    <div className="mt-1 flex items-center justify-between text-[11px] text-arc-text-faint">
                      <span>Team vault (locked)</span>
                      <span className="tabular-nums">{vaultPct}%</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-arc-text-muted">Fees</span>
                  <span className="tabular-nums text-arc-text">
                    {feeTier / 10_000}% static
                    {snipeStartPct > 0 ? ` · ${snipeDecaySeconds}s sniper tax` : ""}
                  </span>
                </div>

                <details className="border-t border-arc-border pt-3">
                  <summary className="flex cursor-pointer select-none items-center justify-between text-sm text-arc-text-muted hover:text-arc-text">
                    <span>Liquidity details</span>
                    <ChevronDown className="arc-disclosure h-4 w-4 text-arc-text-faint" />
                  </summary>
                  <div className="mt-2 space-y-2 text-sm">
                    <PreviewRow label="Pool type" value={POOL_TYPES[poolType].label} />
                    <PreviewRow label="Paired with" value={pairedSymbol} />
                    <PreviewRow label="Starting mcap" value={startMcapLabel} />
                    <PreviewRow label="Positions" value={`${positionsCount} (locked)`} />
                    <PreviewRow label="Fee recipients" value={String(recipients.length)} />
                    {!isWethPool && Number(creatorBuyStr) > 0 && (
                      <PreviewRow label="Creator buy" value={`${creatorBuyStr} USDC`} />
                    )}
                  </div>
                </details>
              </>
            ) : (
              <div className="space-y-2 border-t border-arc-border pt-3 text-sm">
                <PreviewRow label="Type" value="Bonding curve" />
                <PreviewRow
                  label="Fee split"
                  value={mode === LaunchMode.PUMP ? "50% you / 50% platform" : "30% you / 70% platform"}
                />
                <PreviewRow label="Migrates to" value="Arcade V2 (LP burned)" />
              </div>
            )}
          </div>

          <button
            onClick={onSubmit}
            disabled={
              !account ||
              !valid ||
              (isV3 && (!recipientsValid || !vaultValid || !snipeValid || !poolValid)) ||
              tx.status === "pending" ||
              !hasFee
            }
            className="arc-button-primary w-full py-3 text-base"
          >
            {!account
              ? "Connect wallet"
              : !hasFee
                ? `Need ${formatUSDC(CREATION_FEE_USDC, 6, 0)} USDC to launch`
                : !valid
                  ? "Fill in name and symbol"
                  : isV3 && !recipientsValid
                    ? "Fix fee recipients"
                    : tx.status === "pending"
                      ? "Launching…"
                      : `Launch ${modeLabel(mode)}`}
          </button>
          <TxStatus state={tx} />
        </aside>
      </div>

      <RecipientEditModal
        open={vaultRecipientModalOpen}
        onClose={() => setVaultRecipientModalOpen(false)}
        current={vaultRecipient}
        ownAccount={account}
        onSave={setVaultRecipientOverride}
        title="Vault recipient"
        description="By default the vaulted tokens vest to your connected wallet. You can override the recipient below."
      />
    </div>
  );
}

/** Dark-themed dropdown for a recipient's reward-token preference. */
function PrefSelect({ value, onChange }: { value: RewardPref; onChange: (v: RewardPref) => void }) {
  const [open, setOpen] = useState(false);
  const opts: { v: RewardPref; label: string }[] = [
    { v: 0, label: "Both" },
    { v: 1, label: "USDC only" },
    { v: 2, label: "Token only" },
  ];
  const current = opts.find((o) => o.v === value)?.label ?? "Both";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border border-arc-border bg-arc-bg-elevated px-2 py-1.5 text-xs text-arc-text"
      >
        {current}
        <ChevronDown className={cn("h-3.5 w-3.5 text-arc-text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 min-w-[8rem] overflow-hidden rounded-lg border border-arc-border bg-arc-bg-elevated shadow-arc-card">
            {opts.map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => {
                  onChange(o.v);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06]",
                  o.v === value ? "text-arc-text" : "text-arc-text-muted",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-arc-text-muted">{label}</span>
      <span className="truncate text-right text-arc-text">{value}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-arc-text">{label}</span>
        {hint && <span className="text-xs text-arc-text-faint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

/**
 * Like Field but renders a <div> (not a <label>): wrapping a range slider in a
 * <label> breaks click-to-drag in Chromium, so sliders must not be inside one.
 */
function RangeField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-arc-text">{label}</span>
        {hint && <span className="text-xs text-arc-text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

