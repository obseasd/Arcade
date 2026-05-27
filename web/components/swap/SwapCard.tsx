"use client";

import { ArrowDownUp, ChevronDown, HelpCircle } from "lucide-react";
import Image from "next/image";
import { useRef } from "react";
import { useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useUsdValue } from "@/lib/hooks/useTokenUsdPrice";
import { useSwapRoute } from "@/lib/hooks/useSwapRoute";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { SwapConfirmModal } from "./SwapConfirmModal";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
  address: ADDRESSES.usdc,
  symbol: "USDC",
  name: "USD Coin",
  decimals: USDC_DECIMALS,
  pinned: true,
};

const PRESETS_BPS = [10, 50, 100];
const DEFAULT_BPS = 10;

type Side = "in" | "out";

export function SwapCard() {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v2Tokens } = useV2Tokens();
  const { writeContractAsync } = useWriteContract();

  const allTokens: TokenOption[] = useMemo(() => [USDC_TOKEN, ...v2Tokens], [v2Tokens]);

  const [tokenIn, setTokenIn] = useState<TokenOption>(USDC_TOKEN);
  const [tokenOut, setTokenOut] = useState<TokenOption | null>(null);
  const [amountInStr, setAmountInStr] = useState("");
  const [amountOutStr, setAmountOutStr] = useState("");
  const [lastEdited, setLastEdited] = useState<Side>("in");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_BPS);
  const [slippageCustom, setSlippageCustom] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [pickerOpen, setPickerOpen] = useState<Side | null>(null);
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!tokenOut && v2Tokens.length > 0) setTokenOut(v2Tokens[0]);
  }, [v2Tokens, tokenOut]);

  const decimalsIn = tokenIn.decimals ?? 18;
  const decimalsOut = tokenOut?.decimals ?? 18;

  const amountInRaw = useMemo(() => {
    try {
      return amountInStr && lastEdited === "in" ? parseUnits(amountInStr, decimalsIn) : 0n;
    } catch {
      return 0n;
    }
  }, [amountInStr, decimalsIn, lastEdited]);
  const amountOutRawTyped = useMemo(() => {
    try {
      return amountOutStr && lastEdited === "out" ? parseUnits(amountOutStr, decimalsOut) : 0n;
    } catch {
      return 0n;
    }
  }, [amountOutStr, decimalsOut, lastEdited]);

  // Resolve the swap path (direct if a pool exists, else via USDC)
  const route = useSwapRoute(tokenIn.address, tokenOut?.address);
  const path = route.path;

  const quoteOut = useReadContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: amountInRaw > 0n && path.length >= 2 ? [amountInRaw, path] : undefined,
    query: { enabled: lastEdited === "in" && amountInRaw > 0n && path.length >= 2 },
  });
  const quoteIn = useReadContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsIn",
    args: amountOutRawTyped > 0n && path.length >= 2 ? [amountOutRawTyped, path] : undefined,
    query: { enabled: lastEdited === "out" && amountOutRawTyped > 0n && path.length >= 2 },
  });

  // `getAmountsOut/In` return all intermediate amounts; we want first/last.
  const amountsOut = quoteOut.data as bigint[] | undefined;
  const amountsIn = quoteIn.data as bigint[] | undefined;
  const computedAmountOut = amountsOut?.[amountsOut.length - 1];
  const computedAmountIn = amountsIn?.[0];

  useEffect(() => {
    if (lastEdited === "in") {
      if (computedAmountOut !== undefined) setAmountOutStr(formatUnits(computedAmountOut, decimalsOut));
      else if (amountInRaw === 0n) setAmountOutStr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedAmountOut, lastEdited, amountInRaw]);
  useEffect(() => {
    if (lastEdited === "out") {
      if (computedAmountIn !== undefined) setAmountInStr(formatUnits(computedAmountIn, decimalsIn));
      else if (amountOutRawTyped === 0n) setAmountInStr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedAmountIn, lastEdited, amountOutRawTyped]);

  const finalAmountIn: bigint = lastEdited === "in" ? amountInRaw : computedAmountIn ?? 0n;
  const finalAmountOut: bigint = lastEdited === "in" ? computedAmountOut ?? 0n : amountOutRawTyped;

  const minOut = (finalAmountOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const maxIn = (finalAmountIn * BigInt(10_000 + slippageBps)) / 10_000n;

  // Balances
  const balanceIn = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account && !!tokenIn.address },
  });
  const balanceOut = useReadContract({
    address: tokenOut?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account && !!tokenOut },
  });
  const balInRaw = (balanceIn.data as bigint | undefined) ?? 0n;
  const balOutRaw = (balanceOut.data as bigint | undefined) ?? 0n;

  // USD values
  const inUsd = useUsdValue(tokenIn.address, finalAmountIn, decimalsIn);
  const outUsd = useUsdValue(tokenOut?.address, finalAmountOut, decimalsOut);

  // Fee = 0.3% of input (V2)
  const feeRaw = (finalAmountIn * 3n) / 1000n;
  const feeFormatted = formatTokenAmount(feeRaw, decimalsIn);
  // Total loss % includes price impact + AMM fee (already baked into out amount)
  const lossPct =
    inUsd.usd !== undefined && outUsd.usd !== undefined && inUsd.usd > 0
      ? ((outUsd.usd - inUsd.usd) / inUsd.usd) * 100
      : undefined;

  const { ensureAllowance } = useApproveIfNeeded(tokenIn.address, ADDRESSES.router);

  // Slippage helpers
  const onSlippagePreset = (bps: number) => {
    setSlippageBps(bps);
    setSlippageCustom("");
  };
  const onSlippageCustom = (s: string) => {
    const cleaned = s.replace(/[^0-9.]/g, "");
    setSlippageCustom(cleaned);
    const n = parseFloat(cleaned);
    if (!isNaN(n) && n > 0 && n <= 50) setSlippageBps(Math.round(n * 100));
  };

  // Labels for modal
  const symIn = tokenIn.symbol ?? "TOKEN";
  const symOut = tokenOut?.symbol ?? "TOKEN";
  const priceLabel =
    finalAmountIn > 0n && finalAmountOut > 0n && tokenOut
      ? (() => {
          const per1 = (finalAmountOut * 10n ** BigInt(decimalsIn)) / finalAmountIn;
          return `1 ${symIn} = ${formatTokenAmount(per1, decimalsOut, 6)} ${symOut}`;
        })()
      : "—";
  const exactIn = lastEdited === "in";
  const guardKey = exactIn ? "Min. received" : "Max. sent";
  const guardLabel = exactIn
    ? `${formatTokenAmount(minOut, decimalsOut, 6)} ${symOut}`
    : `${formatTokenAmount(maxIn, decimalsIn, 6)} ${symIn}`;

  const fetching = quoteOut.isFetching || quoteIn.isFetching;
  const canSwap =
    !!account && !!tokenOut && finalAmountIn > 0n && finalAmountOut > 0n && !fetching && tx.status !== "pending";

  const flipTokens = () => {
    if (!tokenOut) return;
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountInStr("");
    setAmountOutStr("");
    setLastEdited("in");
  };

  const onConfirm = async () => {
    if (!account || !tokenOut) return;
    setTx({ status: "pending", message: "Approving…" });
    try {
      await ensureAllowance(exactIn ? finalAmountIn : maxIn);
      setTx({ status: "pending", message: "Submitting swap…" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const hash = exactIn
        ? await writeContractAsync({
            address: ADDRESSES.router,
            abi: ROUTER_ABI,
            functionName: "swapExactTokensForTokens",
            args: [finalAmountIn, minOut, path, account, deadline],
          })
        : await writeContractAsync({
            address: ADDRESSES.router,
            abi: ROUTER_ABI,
            functionName: "swapTokensForExactTokens",
            args: [finalAmountOut, maxIn, path, account, deadline],
          });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });

      // Close the modal immediately and push a toast notification instead
      setConfirmOpen(false);
      setTx({ status: "idle" });
      setAmountInStr("");
      setAmountOutStr("");
      balanceIn.refetch();
      balanceOut.refetch();

      pushToast({
        kind: "swap",
        tokenAddress: tokenOut.address,
        tokenSymbol: tokenOut.symbol,
        amountFormatted: formatTokenAmount(finalAmountOut, decimalsOut, 6),
      });
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Swap failed" });
    }
  };

  // ----- Render -----

  return (
    <div className="arc-card relative p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Swap</h2>
        <SlippagePopover
          open={showSettings}
          onToggle={() => setShowSettings((s) => !s)}
          onClose={() => setShowSettings(false)}
          slippageBps={slippageBps}
          slippageCustom={slippageCustom}
          onPreset={onSlippagePreset}
          onCustom={onSlippageCustom}
        />
      </div>

      {/* FROM box */}
      <TokenBox
        label="From"
        token={tokenIn}
        amountStr={amountInStr}
        onAmountChange={(v) => {
          setLastEdited("in");
          setAmountInStr(v);
        }}
        onTokenClick={() => setPickerOpen("in")}
        balanceRaw={balInRaw}
        usdValue={inUsd.usd}
        showHalfMax
        onHalf={
          account && balInRaw > 0n
            ? () => {
                setLastEdited("in");
                setAmountInStr(formatUnits(balInRaw / 2n, decimalsIn));
              }
            : undefined
        }
        onMax={
          account && balInRaw > 0n
            ? () => {
                setLastEdited("in");
                setAmountInStr(formatUnits(balInRaw, decimalsIn));
              }
            : undefined
        }
      />

      {/* Flip button overlapping both */}
      <div className="relative z-10 -my-2 flex justify-center">
        <button
          onClick={flipTokens}
          className="rounded-xl border border-arc-border bg-arc-surface-2/40 p-2 backdrop-blur-md transition-all hover:bg-arc-surface-3/60 active:scale-95"
        >
          <ArrowDownUp className="h-4 w-4 text-arc-text" />
        </button>
      </div>

      {/* TO box */}
      <TokenBox
        label="For"
        token={tokenOut}
        amountStr={amountOutStr}
        onAmountChange={(v) => {
          setLastEdited("out");
          setAmountOutStr(v);
        }}
        onTokenClick={() => setPickerOpen("out")}
        balanceRaw={balOutRaw}
        usdValue={outUsd.usd}
        lossPct={lossPct}
        feeLabel={feeRaw > 0n ? `Fee ${feeFormatted} ${tokenIn.symbol ?? "TOKEN"}` : undefined}
      />

      {/* Route + rate row (between For box and Swap button) */}
      {finalAmountIn > 0n && finalAmountOut > 0n && tokenOut && (
        <div className="mt-4 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-arc-text-muted">
            <Image src="/route.png" alt="" width={14} height={14} className="h-3.5 w-3.5 opacity-75" />
            <span>via</span>
            <span className="font-medium text-arc-text">Arcade V2</span>
            {route.viaUsdc && (
              <span className="ml-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[10px] font-medium text-arc-cta-hover">
                {symIn} → USDC → {symOut}
              </span>
            )}
          </div>
          <div className="text-arc-text-muted tabular-nums">
            1 {symIn} ≈{" "}
            <span className="text-arc-text">
              {formatTokenAmount(
                (finalAmountOut * 10n ** BigInt(decimalsIn)) / finalAmountIn,
                decimalsOut,
                6,
              )}
            </span>{" "}
            {symOut}
          </div>
        </div>
      )}

      <button
        onClick={() => setConfirmOpen(true)}
        disabled={!canSwap}
        className="arc-button-primary mt-5 w-full py-3.5 text-base"
      >
        {!account
          ? "Connect wallet"
          : !tokenOut
            ? "Select token"
            : finalAmountIn === 0n && finalAmountOut === 0n
              ? "Enter amount"
              : fetching
                ? "Fetching price…"
                : "Swap"}
      </button>

      {tx.status !== "idle" && !confirmOpen && <TxStatus state={tx} className="mt-3" />}

      <TokenSelectModal
        open={pickerOpen !== null}
        onClose={() => setPickerOpen(null)}
        tokens={allTokens}
        onSelect={(t) => {
          if (pickerOpen === "in") setTokenIn(t);
          else setTokenOut(t);
          setAmountInStr("");
          setAmountOutStr("");
          setLastEdited("in");
        }}
        selectedAddress={pickerOpen === "in" ? tokenIn.address : tokenOut?.address}
        excludeAddress={pickerOpen === "in" ? tokenOut?.address : tokenIn.address}
      />


      {tokenOut && (
        <SwapConfirmModal
          open={confirmOpen}
          onClose={() => {
            setConfirmOpen(false);
            if (tx.status !== "pending") setTx({ status: "idle" });
          }}
          onConfirm={onConfirm}
          tokenIn={tokenIn}
          tokenOut={tokenOut}
          amountInFormatted={formatTokenAmount(finalAmountIn, decimalsIn, 6)}
          amountOutFormatted={formatTokenAmount(finalAmountOut, decimalsOut, 6)}
          rateLabel={priceLabel}
          guardLabel={guardLabel}
          guardKey={guardKey}
          tx={tx}
        />
      )}

      {/* Glow ON the card's bottom border. Bright spot AT the border itself,
          halo fades upward into the card. (v3 — confirmed working) */}
      {canSwap && (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-1/2 h-[3px] w-3/4 -translate-x-1/2 rounded-full bg-gradient-to-r from-transparent via-arc-cta-hover to-transparent"
          />
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-1/2 h-7 w-[88%] -translate-x-1/2 rounded-full opacity-95 blur-md"
            style={{
              background:
                "radial-gradient(ellipse at center bottom, rgba(52, 90, 120, 0.95) 0%, rgba(52, 90, 120, 0.45) 35%, transparent 75%)",
            }}
          />
        </>
      )}
    </div>
  );
}

// ===== Sub-components =====

interface TokenBoxProps {
  label: string;
  token: TokenOption | null;
  amountStr: string;
  onAmountChange: (v: string) => void;
  onTokenClick: () => void;
  balanceRaw: bigint;
  usdValue: number | undefined;
  /** Show HALF/MAX buttons on the bottom-right (typical for the "From" box). */
  showHalfMax?: boolean;
  onHalf?: () => void;
  onMax?: () => void;
  /** Show loss % next to USD value (typical for the "To" box). */
  lossPct?: number;
  /** Optional fee string shown in the bottom-right (typical for the "To" box). */
  feeLabel?: string;
}

function TokenBox({
  label,
  token,
  amountStr,
  onAmountChange,
  onTokenClick,
  balanceRaw,
  usdValue,
  showHalfMax,
  onHalf,
  onMax,
  lossPct,
  feeLabel,
}: TokenBoxProps) {
  const decimals = token?.decimals ?? 18;
  const balLabel =
    decimals === USDC_DECIMALS
      ? formatUSDC(balanceRaw, decimals, 2)
      : formatToken(balanceRaw, decimals, 4);
  const usdLabel =
    usdValue !== undefined
      ? `~$${usdValue >= 100 ? usdValue.toFixed(2) : usdValue >= 1 ? usdValue.toFixed(3) : usdValue.toFixed(5)}`
      : "";

  const lossClass =
    lossPct === undefined
      ? "text-arc-text-faint"
      : lossPct >= 0
        ? "text-arc-success"
        : Math.abs(lossPct) < 1
          ? "text-arc-text-muted"
          : Math.abs(lossPct) < 5
            ? "text-arc-warn"
            : "text-arc-danger";

  return (
    <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5 transition-colors focus-within:border-arc-border-strong">
      {/* Header: label + token chip */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm text-arc-text-muted">{label}</span>
        <button
          onClick={onTokenClick}
          className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-2 text-base font-semibold transition-colors hover:bg-arc-surface-3"
        >
          {token ? (
            <>
              <TokenIcon symbol={token.symbol} size={24} />
              <span>{token.symbol}</span>
              <ChevronDown className="h-4 w-4 text-arc-text-muted transition-transform group-hover:text-arc-text" />
            </>
          ) : (
            <>
              <span>Select token</span>
              <ChevronDown className="h-4 w-4 text-arc-text-muted" />
            </>
          )}
        </button>
      </div>

      {/* Amount */}
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={amountStr}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, "");
          const parts = v.split(".");
          if (parts.length > 2) return;
          onAmountChange(v);
        }}
        className="arc-input w-full bg-transparent text-4xl font-medium leading-tight"
      />

      {/* Footer: USD + balance | HALF/MAX or fee */}
      <div className="mt-3 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-arc-text-muted">
          {usdLabel && <span>{usdLabel}</span>}
          {lossPct !== undefined && (
            <span className={cn("tabular-nums", lossClass)}>
              ({lossPct >= 0 ? "+" : ""}
              {lossPct.toFixed(2)}%)
            </span>
          )}
          {showHalfMax && token && (
            <span className="text-arc-text-faint">
              {balLabel} {token.symbol}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {feeLabel && <span className="tabular-nums text-arc-text-muted">{feeLabel}</span>}
          {showHalfMax && (
            <>
              <QuickButton onClick={onHalf}>HALF</QuickButton>
              <QuickButton onClick={onMax}>MAX</QuickButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QuickButton({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-all",
        "bg-arc-surface text-arc-text-muted",
        "hover:bg-arc-cta hover:text-white",
        "active:scale-90 active:bg-arc-cta-hover",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-arc-surface disabled:hover:text-arc-text-muted",
      )}
    >
      {children}
    </button>
  );
}

interface SlippagePopoverProps {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  slippageBps: number;
  slippageCustom: string;
  onPreset: (bps: number) => void;
  onCustom: (s: string) => void;
}

function SlippagePopover({
  open,
  onToggle,
  onClose,
  slippageBps,
  slippageCustom,
  onPreset,
  onCustom,
}: SlippagePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "rounded-lg p-2 transition-colors",
          open ? "bg-arc-surface-2 text-arc-text" : "text-arc-text-muted hover:bg-arc-surface hover:text-arc-text",
        )}
      >
        <Image src="/slider.png" alt="Slippage" width={18} height={18} className="h-4 w-4 opacity-80" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-2 w-72 rounded-2xl border border-arc-border bg-black/45 p-4 shadow-arc-card backdrop-blur-2xl"
        >
          <div className="mb-3 text-sm font-semibold text-arc-text">Transaction settings</div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-arc-text-muted">
            Slippage tolerance
            <HelpCircle className="h-3 w-3" />
          </div>
          <div className="flex items-center gap-1.5">
            {PRESETS_BPS.map((bps) => {
              const active = slippageCustom === "" && slippageBps === bps;
              return (
                <button
                  key={bps}
                  onClick={() => onPreset(bps)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    active
                      ? "bg-arc-cta text-white"
                      : "bg-arc-surface text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text",
                  )}
                >
                  {bps / 100}%
                </button>
              );
            })}
            <div
              className={cn(
                "ml-auto flex items-center gap-0.5 rounded-full border px-2.5 py-1 transition-colors",
                slippageCustom !== "" ? "border-arc-cta bg-arc-bg" : "border-arc-border bg-arc-surface",
              )}
            >
              <input
                type="text"
                inputMode="decimal"
                value={slippageCustom}
                onChange={(e) => onCustom(e.target.value)}
                placeholder="0.10"
                className="arc-input w-10 text-right text-xs"
              />
              <span className="text-[10px] text-arc-text-muted">%</span>
            </div>
          </div>
          {slippageBps > 500 && (
            <div className="mt-3 rounded-lg border border-arc-warn/30 bg-arc-warn/10 p-2 text-[11px] text-arc-warn">
              High slippage — your trade may be front-run.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Helpers =====

function formatTokenAmount(raw: bigint, decimals: number, fraction: number = 6): string {
  if (decimals === USDC_DECIMALS) return formatUSDC(raw, decimals, fraction);
  return formatToken(raw, decimals, fraction);
}
