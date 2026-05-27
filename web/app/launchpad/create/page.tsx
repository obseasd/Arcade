"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { decodeEventLog, erc20Abi, isAddress, zeroAddress, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES, CREATION_FEE_USDC, LaunchMode } from "@/lib/constants";
import { encodeMetadataDataUri } from "@/lib/metadata";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { formatUSDC } from "@/lib/utils";

/** Display label for a launch mode (contract modes are unchanged). */
function modeLabel(mode: LaunchMode): string {
  if (mode === LaunchMode.PUMP) return "Pump";
  if (mode === LaunchMode.CLANKER) return "Arcade";
  return "Clanker"; // CLANKER_V3
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
      await ensureAllowance(CREATION_FEE_USDC);

      setTx({ status: "pending", message: "Building metadata…" });
      const metadataURI = encodeMetadataDataUri({
        image: image.trim() || undefined,
        description: description.trim() || undefined,
        twitter: twitter.trim() || undefined,
        telegram: telegram.trim() || undefined,
        website: website.trim() || undefined,
      });

      setTx({ status: "pending", message: "Launching token…" });

      // CLANKER allows an optional secondary creator address.
      // Validate `creator2` only when set; ignore in PUMP mode.
      const trimmedC2 = creator2.trim();
      const useCreator2 =
        mode === LaunchMode.CLANKER && trimmedC2.length > 0 && isAddress(trimmedC2);
      const creator2Addr: Address = useCreator2 ? (trimmedC2 as Address) : zeroAddress;
      const creator2ShareBps = useCreator2 ? Math.round(creator2SharePct * 100) : 0;

      const hash = await writeContractAsync({
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "createToken",
        args: [name.trim(), symbol.trim(), metadataURI, mode, creator2Addr, creator2ShareBps],
      });

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
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Link
        href="/launchpad"
        className="mb-6 inline-flex items-center gap-2 text-sm text-arc-text-muted transition-colors hover:text-arc-text"
      >
        <ArrowLeft className="h-4 w-4" /> Launchpad
      </Link>
      <h1 className="mb-2 text-3xl font-semibold">Launch a token</h1>
      <p className="mb-8 text-sm text-arc-text-muted">
        Mint a new token with a fixed 1B supply.{" "}
        {mode === LaunchMode.CLANKER_V3 ? (
          <>
            The full supply is locked single-sided in a Uniswap V3 pool at launch — tradeable
            instantly, no bonding curve, LP can never be rugged, and you earn 80% of all swap fees.
          </>
        ) : (
          <>
            Trading starts immediately on a bonding curve. Migration to the DEX happens automatically
            when the curve fills.
          </>
        )}{" "}
        Creation fee:{" "}
        <span className="tabular-nums text-arc-text">{formatUSDC(CREATION_FEE_USDC, 6, 0)} USDC</span>.
      </p>

      <div className="arc-card space-y-5 p-6">
        {/* Chosen launch mode (picked in the modal) */}
        <div className="flex items-center justify-between rounded-xl border border-arc-border bg-arc-bg-elevated px-4 py-3">
          <div>
            <div className="text-xs text-arc-text-muted">Launch mode</div>
            <div className="text-sm font-semibold text-arc-text">{modeLabel(mode)}</div>
          </div>
          <Link href="/launchpad" className="text-xs text-arc-cta-hover hover:underline">
            Change
          </Link>
        </div>

        <Field label="Name" hint="Display name shown on the discovery page.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 32))}
            placeholder="e.g. Moon Rocket"
            className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
          />
        </Field>
        <Field label="Symbol" hint="Ticker — uppercase letters, up to 12 chars.">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
            placeholder="ROCKET"
            className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 tabular-nums"
          />
        </Field>
        <Field label="Image URL" hint="Hosted image (Imgur, IPFS, etc.). Recommended 512×512.">
          <input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="https://..."
            className="arc-input rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
          />
        </Field>
        <Field label="Description" hint="Pitch your token in a few lines.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            placeholder="A short description visible on the token page…"
            rows={3}
            className="arc-input w-full resize-none rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2"
          />
        </Field>

        {mode === LaunchMode.CLANKER && (
          <details className="rounded-xl border border-arc-border bg-arc-bg-elevated open:bg-arc-surface">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm text-arc-text-muted hover:text-arc-text">
              Secondary creator fee receiver (optional)
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
                  className="arc-input rounded-xl border border-arc-border bg-arc-bg px-3 py-2 tabular-nums"
                />
              </Field>
              {creator2 && !isAddress(creator2.trim()) && (
                <div className="text-xs text-arc-danger">Invalid address.</div>
              )}
              <Field
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
                  className="w-full accent-arc-cta-hover"
                />
              </Field>
            </div>
          </details>
        )}

        <details className="rounded-xl border border-arc-border bg-arc-bg-elevated open:bg-arc-surface">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm text-arc-text-muted hover:text-arc-text">
            Socials (optional)
          </summary>
          <div className="space-y-3 px-4 pb-4">
            <Field label="Twitter / X">
              <input
                value={twitter}
                onChange={(e) => setTwitter(e.target.value)}
                placeholder="https://twitter.com/..."
                className="arc-input rounded-xl border border-arc-border bg-arc-bg px-3 py-2"
              />
            </Field>
            <Field label="Telegram">
              <input
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                placeholder="https://t.me/..."
                className="arc-input rounded-xl border border-arc-border bg-arc-bg px-3 py-2"
              />
            </Field>
            <Field label="Website">
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://..."
                className="arc-input rounded-xl border border-arc-border bg-arc-bg px-3 py-2"
              />
            </Field>
          </div>
        </details>

        <button
          onClick={onSubmit}
          disabled={!account || !valid || tx.status === "pending" || !hasFee}
          className="arc-button-primary w-full py-3 text-base"
        >
          {!account
            ? "Connect wallet"
            : !hasFee
              ? `Need ${formatUSDC(CREATION_FEE_USDC, 6, 0)} USDC to launch`
              : !valid
                ? "Fill in name and symbol"
                : tx.status === "pending"
                  ? "Launching…"
                  : "Launch token"}
        </button>
        <TxStatus state={tx} />
      </div>
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

