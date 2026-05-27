"use client";

import { ArrowDownUp, ChevronDown, HelpCircle } from "lucide-react";
import Image from "next/image";
import { useRef } from "react";
import { useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_QUOTER_ABI, V3_ROUTER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS, V3_FEE } from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useUsdValue } from "@/lib/hooks/useTokenUsdPrice";
import { useSwapRoute } from "@/lib/hooks/useSwapRoute";
import { pushToast } from "@/lib/toast";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { SwapConfirmModal } from "./SwapConfirmModal";
import { SwapTabs, type SwapTab } from "./SwapTabs";
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

interface SwapCardProps {
  /** Active tab — used by the in-card tab strip in the header. */
  tab: SwapTab;
  onTabChange: (t: SwapTab) => void;
}

export function SwapCard({ tab, onTabChange }: SwapCardProps) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v2Tokens } = useV2Tokens();
  const { tokens: v3Tokens, isV3Token } = useV3Tokens();
  const { writeContractAsync } = useWriteContract();

  const allTokens: TokenOption[] = useMemo(() => {
    const seen = new Set<string>();
    const out: TokenOption[] = [];
    for (const t of [USDC_TOKEN, ...v2Tokens, ...v3Tokens]) {
      const k = t.address.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }, [v2Tokens, v3Tokens]);

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

  // --- V3 (CLANKER_V3) classification ---
  // A token launched single-sided into a locked V3 pool trades on V3, not V2.
  const isUsdcIn = tokenIn.address.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  const isUsdcOut = tokenOut?.address.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  const inIsV3 = isV3Token(tokenIn.address);
  const outIsV3 = isV3Token(tokenOut?.address);
  const isV3Swap = inIsV3 || outIsV3;
  // Single V3 hop when exactly one side is USDC; 2-hop via USDC when both are V3.
  const v3DoubleHop = inIsV3 && outIsV3;
  const v3SingleHop = isV3Swap && !v3DoubleHop && (isUsdcIn || isUsdcOut);
  // V3<->V2 (non-USDC) can't route in one router call — flag as unsupported.
  const v3Unsupported = isV3Swap && !v3DoubleHop && !v3SingleHop;

  // V3 router is exact-in only — force exact-in when this is a V3 swap.
  useEffect(() => {
    if ((route.useLaunchpadRouter || isV3Swap) && lastEdited === "out") setLastEdited("in");
  }, [route.useLaunchpadRouter, isV3Swap, lastEdited]);

  // V3 quote (exact-in). Single-hop or 2-hop-through-USDC depending on the pair.
  const quoteV3 = useReadContract({
    address: ADDRESSES.v3Quoter,
    abi: V3_QUOTER_ABI,
    functionName: v3DoubleHop ? "quoteExactInputThroughUsdc" : "quoteExactInputSingle",
    args:
      isV3Swap && !v3Unsupported && tokenOut && amountInRaw > 0n
        ? [tokenIn.address, tokenOut.address, V3_FEE, amountInRaw]
        : undefined,
    query: { enabled: isV3Swap && !v3Unsupported && !!tokenOut && amountInRaw > 0n },
  });
  const v3AmountOut = quoteV3.data as bigint | undefined;

  // V2 router quotes — used for direct routes and as the input estimator for
  // multi-hop routes that DON'T touch a migrated launchpad token.
  const quoteOut = useReadContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: amountInRaw > 0n && path.length >= 2 ? [amountInRaw, path] : undefined,
    query: {
      enabled:
        !isV3Swap && !route.useLaunchpadRouter && lastEdited === "in" && amountInRaw > 0n && path.length >= 2,
    },
  });
  const quoteIn = useReadContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsIn",
    args: amountOutRawTyped > 0n && path.length >= 2 ? [amountOutRawTyped, path] : undefined,
    query: {
      enabled:
        !isV3Swap && !route.useLaunchpadRouter && lastEdited === "out" && amountOutRawTyped > 0n && path.length >= 2,
    },
  });

  // Launchpad-router quote — accounts for the post-migration royalty on each
  // leg whose token is a migrated launchpad token. Only used in multi-hop
  // mode when at least one side is migrated.
  const quoteMigratedOut = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "quoteSwapMigratedRoute",
    args:
      route.useLaunchpadRouter && tokenOut && amountInRaw > 0n
        ? [tokenIn.address, tokenOut.address, amountInRaw]
        : undefined,
    query: {
      enabled: route.useLaunchpadRouter && !!tokenOut && amountInRaw > 0n,
    },
  });

  // `getAmountsOut/In` return all intermediate amounts; we want first/last.
  const amountsOut = quoteOut.data as bigint[] | undefined;
  const amountsIn = quoteIn.data as bigint[] | undefined;
  const migratedQuote = quoteMigratedOut.data as readonly [bigint, bigint] | undefined;
  const computedAmountOut = isV3Swap
    ? v3AmountOut
    : route.useLaunchpadRouter
      ? migratedQuote?.[0]
      : amountsOut?.[amountsOut.length - 1];
  const computedAmountIn = amountsIn?.[0];
  /** USDC amount taken as royalty across both legs (0 when not via launchpad). */
  const totalRoyaltyUsdc: bigint = migratedQuote?.[1] ?? 0n;

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

  // Pick the spender to approve based on the route: V3 router for CLANKER_V3
  // tokens, launchpad for royalty-aware multi-hop, else the V2 router.
  const swapSpender = isV3Swap
    ? ADDRESSES.v3Router
    : route.useLaunchpadRouter
      ? ADDRESSES.launchpad
      : ADDRESSES.router;
  const { ensureAllowance } = useApproveIfNeeded(tokenIn.address, swapSpender);

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

  const fetching =
    quoteOut.isFetching || quoteIn.isFetching || quoteMigratedOut.isFetching || quoteV3.isFetching;
  const canSwap =
    !!account &&
    !!tokenOut &&
    !v3Unsupported &&
    finalAmountIn > 0n &&
    finalAmountOut > 0n &&
    !fetching &&
    tx.status !== "pending";

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
      let hash: `0x${string}`;
      if (isV3Swap) {
        // CLANKER_V3 token: trade on the V3 pool via our V3 router. Exact-in
        // only (the effect above forces lastEdited="in"). Single hop if one
        // side is USDC, else 2-hop through USDC.
        hash = await writeContractAsync({
          address: ADDRESSES.v3Router,
          abi: V3_ROUTER_ABI,
          functionName: v3DoubleHop ? "exactInputThroughUsdc" : "exactInputSingle",
          args: [tokenIn.address, tokenOut.address, V3_FEE, account, finalAmountIn, minOut, deadline],
        });
      } else if (route.useLaunchpadRouter) {
        // Multi-hop through the launchpad's router so post-migration royalties
        // are charged on each leg whose token is a migrated launchpad token.
        // Only exact-in is supported; the effect above forces lastEdited="in".
        hash = await writeContractAsync({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "swapMigratedRoute",
          args: [tokenIn.address, tokenOut.address, finalAmountIn, minOut],
        });
      } else if (exactIn) {
        hash = await writeContractAsync({
          address: ADDRESSES.router,
          abi: ROUTER_ABI,
          functionName: "swapExactTokensForTokens",
          args: [finalAmountIn, minOut, path, account, deadline],
        });
      } else {
        hash = await writeContractAsync({
          address: ADDRESSES.router,
          abi: ROUTER_ABI,
          functionName: "swapTokensForExactTokens",
          args: [finalAmountOut, maxIn, path, account, deadline],
        });
      }
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
        <SwapTabs tab={tab} onTabChange={onTabChange} />
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

      {/* Cross-protocol (V3<->V2) routes can't execute in one tx. */}
      {v3Unsupported && (
        <div className="mt-3 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-2 text-xs text-arc-warn">
          Route through USDC: swap {symIn} → USDC, then USDC → {symOut} separately. Direct{" "}
          {symIn}→{symOut} mixes a V3 and a V2 pool, which isn&apos;t supported in one swap yet.
        </div>
      )}

      {/* Route + rate row (between For box and Swap button) */}
      {finalAmountIn > 0n && finalAmountOut > 0n && tokenOut && (
        <div className="mt-4 flex items-center justify-between text-xs">
          <div className="flex items-center gap-1.5 text-arc-text-muted">
            <Image src="/route.png" alt="" width={14} height={14} className="h-3.5 w-3.5 opacity-75" />
            <span>via</span>
            <span className="font-medium text-arc-text">{isV3Swap ? "Arcade V3" : "Arcade V2"}</span>
            {isV3Swap && v3DoubleHop && (
              <span className="ml-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[10px] font-medium text-arc-cta-hover">
                {symIn} → USDC → {symOut}
              </span>
            )}
            {isV3Swap && !v3DoubleHop && (
              <span className="ml-1 rounded-full border border-arc-success/40 bg-arc-success/10 px-1.5 py-0.5 text-[10px] font-medium text-arc-success">
                locked-LP pool
              </span>
            )}
            {!isV3Swap && route.viaUsdc && (
              <span className="ml-1 rounded-full border border-arc-cta-hover/40 bg-arc-cta-hover/10 px-1.5 py-0.5 text-[10px] font-medium text-arc-cta-hover">
                {symIn} → USDC → {symOut}
              </span>
            )}
            {route.useLaunchpadRouter && totalRoyaltyUsdc > 0n && (
              <span
                className="ml-1 rounded-full border border-arc-warn/30 bg-arc-warn/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-arc-warn"
                title="Post-migration creator royalty charged on each launchpad-migrated leg"
              >
                +{formatUSDC(totalRoyaltyUsdc, USDC_DECIMALS, 2)} USDC royalty
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
