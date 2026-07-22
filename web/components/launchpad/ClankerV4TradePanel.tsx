"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ARCADE_HOOK_ABI } from "@/lib/abis/arcadeHook";
import { V4_ROUTER_ABI } from "@/lib/abis/v4Router";
import { V4_QUOTER_ABI } from "@/lib/abis/v4Quoter";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS, V4_HOOK_CURVE_SUPPLY } from "@/lib/constants";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
import { reportReferralTrade } from "@/lib/referral";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

/** Bonding-curve state for a still-curving PUMP token. When passed, the panel
 *  trades on the ArcadeHook curve (hook.buy/sell) instead of the V4 router, so
 *  PUMP gets the exact same UI as CLANKER pre-graduation. */
export interface CurveTradeState {
  tokensSold: bigint;
  realUsdcReserve: bigint;
}

interface Props {
  /** The V4 token (CLANKER, or a still-curving / graduated PUMP). */
  token: Address;
  symbol: string;
  image?: string;
  /** Present => trade on the bonding curve (PUMP pre-graduation). Absent =>
   *  trade on the canonical V4 pool via the router (CLANKER / graduated PUMP). */
  curve?: CurveTradeState;
  /** Fired after a successful trade so the parent can refetch derived state. */
  onTradeSuccess?: () => void;
}

// The hook builds every launch pool with a fixed tick spacing of 200 and itself
// as the hook (see ArcadeHook._buildPoolKey). The fee is the CLANKER tier, read
// on-chain from poolFeeOf(token).
const TICK_SPACING = 200;

// Curve virtuals: MUST mirror ArcadeV4Curve VIRTUAL_USDC_RESERVE /
// VIRTUAL_TOKEN_RESERVE or the preview diverges from the on-chain out.
const VIRT_USDC = 5_800n * 10n ** BigInt(USDC_DECIMALS);
const VIRT_TOKEN = 1_135_000_000n * 10n ** BigInt(LAUNCHPAD_TOKEN_DECIMALS);
const CURVE_K = VIRT_USDC * VIRT_TOKEN;
// 3% slippage floor on curve trades (the hook enforces minOut via Slippage()).
const CURVE_SLIPPAGE_BPS = 300n;

/** Constant-product curve preview, net of the 1% curve fee, matching the hook. */
function previewCurveOut(
  side: "buy" | "sell",
  amountRaw: bigint,
  curve: CurveTradeState,
): bigint {
  if (amountRaw === 0n) return 0n;
  const currentUsdc = VIRT_USDC + curve.realUsdcReserve;
  const currentTokens = VIRT_TOKEN - curve.tokensSold;
  if (side === "buy") {
    const netIn = (amountRaw * 9_900n) / 10_000n;
    const newUsdc = currentUsdc + netIn;
    if (newUsdc === 0n) return 0n;
    const newToken = CURVE_K / newUsdc;
    if (currentTokens <= newToken) return 0n;
    const desiredOut = currentTokens - newToken;
    // Cap at the curve's remaining capacity, exactly like the on-chain
    // simulateBuy (a buy that crosses CURVE_SUPPLY only fills `maxOut`). Without
    // this the preview overstates the fill near graduation and the derived
    // minOut exceeds what the curve delivers -> the graduating buy reverts
    // Slippage(). (PUMP audit H1.)
    const maxOut = V4_HOOK_CURVE_SUPPLY > curve.tokensSold ? V4_HOOK_CURVE_SUPPLY - curve.tokensSold : 0n;
    return desiredOut > maxOut ? maxOut : desiredOut;
  }
  const newToken = currentTokens + amountRaw;
  if (newToken === 0n) return 0n;
  const newUsdc = CURVE_K / newToken;
  if (currentUsdc <= newUsdc) return 0n;
  const grossOut = currentUsdc - newUsdc;
  return (grossOut * 9_900n) / 10_000n;
}

/**
 * Buy/sell a V4 token with a single UI for both trading venues:
 *
 * - CLANKER, or a GRADUATED PUMP (`curve` absent): trades on the canonical
 *   Uniswap V4 pool via the ArcadeV4SwapRouter (exactInputSingle). Quote comes
 *   from the V4 quoter simulate; approval targets the router.
 * - A still-curving PUMP (`curve` present): trades on the ArcadeHook bonding
 *   curve (hook.buy/sell). Quote is the constant-product preview; approval
 *   targets the hook.
 *
 * Keeping one component means PUMP and CLANKER share the exact same panel
 * (balance, slippage selector, fee row, tx status) instead of the old bespoke
 * MVP curve card.
 */
export function ClankerV4TradePanel({ token, symbol, image, curve, onTradeSuccess }: Props) {
  const curveMode = !!curve;
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  // Single-sided concentrated liquidity moves price sharply per trade and can
  // drift between quote and execution; 3% default mirrors the V3 CLANKER panel.
  const [slippageBps, setSlippageBps] = useState(300);
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [routerOut, setRouterOut] = useState(0n);

  // The pool's fee tier (10000/20000/30000 = 1/2/3%), set at launch. Only used
  // by the router path; the curve runs the dynamic 1% fee (poolFeeOf === 0).
  const feeQ = useReadContract({
    address: ADDRESSES.arcadeHook,
    abi: ARCADE_HOOK_ABI,
    functionName: "poolFeeOf",
    args: [token],
    query: { enabled: token !== zeroAddress && !curveMode },
  });
  const fee = Number((feeQ.data as bigint | number | undefined) ?? 0);
  // A graduated PUMP pool has poolFeeOf === 0 by design (the hook captures the
  // fee itself), so "fee is 0" is a VALID loaded state, not a still-loading one.
  // Curve mode never waits on the fee read.
  const feeReady = curveMode || feeQ.data !== undefined;

  // Graduated PUMP has poolFeeOf === 0 but a LIVE dynamic fee (1% -> 0.30% with
  // market cap). Read it so the fee row shows the real rate instead of "…".
  const dynFeeQ = useReadContract({
    address: ADDRESSES.arcadeHook,
    abi: ARCADE_HOOK_ABI,
    functionName: "currentFeeBps",
    args: [token],
    query: { enabled: token !== zeroAddress && !curveMode && feeReady && fee === 0 },
  });
  const dynFeeBps = Number((dynFeeQ.data as bigint | number | undefined) ?? 0);

  // Canonical PoolKey (currencies sorted by address, exactly like the hook).
  const poolKey = useMemo(() => {
    const usdc = ADDRESSES.usdc;
    const [c0, c1] =
      usdc.toLowerCase() < token.toLowerCase()
        ? ([usdc, token] as const)
        : ([token, usdc] as const);
    return {
      currency0: c0,
      currency1: c1,
      fee,
      tickSpacing: TICK_SPACING,
      hooks: ADDRESSES.arcadeHook,
    } as const;
  }, [token, fee]);

  const usdcIsCurrency0 = poolKey.currency0.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  // Buy = spend USDC for token; input currency is USDC. zeroForOne swaps c0->c1.
  const zeroForOne = side === "buy" ? usdcIsCurrency0 : !usdcIsCurrency0;

  const usdcBalance = useReadContract({
    address: ADDRESSES.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account },
  });
  const tokenBalance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account },
  });

  const amountRaw = useMemo(() => {
    try {
      if (!amount) return 0n;
      const dec = side === "buy" ? USDC_DECIMALS : LAUNCHPAD_TOKEN_DECIMALS;
      return parseUnits(amount, dec);
    } catch {
      return 0n;
    }
  }, [amount, side]);

  // Curve preview is synchronous (constant product). Router quote is async (the
  // V4 quoter isn't `view` -- it reverts to unwind state -- so we simulate it).
  const curveOut = useMemo(
    () => (curve ? previewCurveOut(side, amountRaw, curve) : 0n),
    [curve, side, amountRaw],
  );
  useEffect(() => {
    if (curveMode) return; // curve path doesn't use the quoter
    let cancelled = false;
    if (!publicClient || amountRaw === 0n || !feeReady) {
      setRouterOut(0n);
      return;
    }
    publicClient
      .simulateContract({
        address: ADDRESSES.v4Quoter,
        abi: V4_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey, zeroForOne, exactAmount: amountRaw, hookData: "0x" }],
      })
      .then((res) => {
        if (cancelled) return;
        const out = (res.result as readonly [bigint, bigint])[0];
        setRouterOut(out);
      })
      .catch(() => {
        if (!cancelled) setRouterOut(0n);
      });
    return () => {
      cancelled = true;
    };
  }, [curveMode, publicClient, amountRaw, zeroForOne, fee, poolKey, feeReady]);

  const estimatedOut = curveMode ? curveOut : routerOut;
  const minOut = curveMode
    ? (estimatedOut * (10_000n - CURVE_SLIPPAGE_BPS)) / 10_000n
    : (estimatedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const spender = curveMode ? ADDRESSES.arcadeHook : ADDRESSES.v4Router;
  const { allowance, ensureAllowance } = useApproveIfNeeded(
    side === "buy" ? ADDRESSES.usdc : token,
    spender,
  );
  const { writeContractAsync } = useWriteContract();

  const onTrade = async () => {
    if (!account || amountRaw === 0n || !feeReady) return;
    setTx({ status: "pending", message: "Approving…" });
    try {
      if (allowance < amountRaw) {
        await ensureAllowance(amountRaw);
      }
      setTx({ status: "pending", message: "Submitting trade…" });
      const hash = curveMode
        ? await writeContractAsync({
            address: ADDRESSES.arcadeHook,
            abi: ARCADE_HOOK_ABI,
            functionName: side === "buy" ? "buy" : "sell",
            args: [token, amountRaw, minOut],
          })
        : await writeContractAsync({
            address: ADDRESSES.v4Router,
            abi: V4_ROUTER_ABI,
            functionName: "exactInputSingle",
            args: [poolKey, zeroForOne, amountRaw, minOut, account, 0n],
          });
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(
            `${side === "buy" ? "Buy" : "Sell"} reverted on-chain (tx ${hash.slice(0, 10)}…). Common causes: slippage too tight, price moved, deadline.`,
          );
        }
      }
      setTx({ status: "idle" });
      setAmount("");
      usdcBalance.refetch();
      tokenBalance.refetch();
      onTradeSuccess?.();
      const outTokenSymbol = side === "buy" ? symbol : "USDC";
      const outDecimals = side === "buy" ? LAUNCHPAD_TOKEN_DECIMALS : USDC_DECIMALS;
      const outFormatted =
        side === "buy"
          ? formatToken(estimatedOut, outDecimals, 6)
          : formatUSDC(estimatedOut, outDecimals, 6);
      addActivity({
        type: side,
        account,
        token,
        label: side === "buy" ? `Bought $${symbol}` : `Sold $${symbol}`,
        value: `${outFormatted} ${outTokenSymbol}`,
        txHash: hash,
      });
      // Referral accrual (fire-and-forget): USD volume = the USDC leg.
      const refVol = side === "buy" ? amountRaw : estimatedOut;
      if (refVol > 0n) reportReferralTrade(account, refVol);
      pushToast({
        kind: "swap",
        action: "Trade",
        tokenAddress: side === "buy" ? token : ADDRESSES.usdc,
        tokenSymbol: outTokenSymbol,
        tokenImage: side === "buy" ? image : undefined,
        amountFormatted: outFormatted,
      });
    } catch (e: unknown) {
      const err = e as { shortMessage?: string; message?: string };
      setTx({ status: "error", message: err?.shortMessage || err?.message || "Trade failed" });
    }
  };

  const sideDecimals = side === "buy" ? USDC_DECIMALS : LAUNCHPAD_TOKEN_DECIMALS;
  const inBalance = side === "buy"
    ? (usdcBalance.data as bigint | undefined)
    : (tokenBalance.data as bigint | undefined);
  const inBalanceFmt = inBalance
    ? side === "buy"
      ? formatUSDC(inBalance, USDC_DECIMALS, 2)
      : formatToken(inBalance, LAUNCHPAD_TOKEN_DECIMALS, 4)
    : "0";

  // Fee row label: curve = dynamic 1% fee; CLANKER = static tier; graduated PUMP
  // = the live dynamic fee (poolFeeOf is 0, so read currentFeeBps).
  const feeLabel = curveMode
    ? "1% (curve)"
    : fee > 0
      ? `${fee / 10_000}%`
      : dynFeeBps > 0
        ? `${(dynFeeBps / 100).toFixed(2)}% (dynamic)`
        : "…";

  return (
    <div className="arc-card p-5">
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => {
              setSide(s);
              setAmount("");
            }}
            className={cn(
              "rounded-lg py-2 text-sm font-medium transition-colors",
              side === s ? "bg-arc-primary text-white" : "text-arc-text-muted hover:text-arc-text",
            )}
          >
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <AmountInput
        label={side === "buy" ? "You pay" : "You sell"}
        value={amount}
        onChange={setAmount}
        symbol={side === "buy" ? "USDC" : symbol}
        image={side === "sell" ? image : undefined}
        balanceLabel={account ? `Balance: ${inBalanceFmt}` : undefined}
        onMax={account && inBalance ? () => setAmount(formatUnits(inBalance, sideDecimals)) : undefined}
      />

      <div className="mt-3 rounded-xl border border-arc-border bg-arc-bg-elevated p-3 text-sm">
        <div className="flex justify-between text-arc-text-muted">
          <span>You receive</span>
          <span className="flex items-center gap-1.5 tabular-nums text-arc-text">
            {side === "buy"
              ? formatToken(estimatedOut, LAUNCHPAD_TOKEN_DECIMALS, 6)
              : formatUSDC(estimatedOut, USDC_DECIMALS, 6)}
            <TokenIcon symbol={side === "buy" ? symbol : "USDC"} image={side === "buy" ? image : undefined} size={16} />
            <span className="text-arc-text-muted">{side === "buy" ? symbol : "USDC"}</span>
          </span>
        </div>
        <div className="mt-1 flex justify-between text-xs text-arc-text-faint">
          <span>Fee</span>
          <span className="tabular-nums">{feeLabel}</span>
        </div>
        <div className="mt-1 flex justify-between text-xs text-arc-text-faint">
          <span>Slippage tolerance</span>
          {curveMode ? (
            <span className="tabular-nums">3%</span>
          ) : (
            <span className="flex gap-1">
              {[50, 100, 300].map((bps) => (
                <button
                  type="button"
                  key={bps}
                  onClick={() => setSlippageBps(bps)}
                  className={cn(
                    "rounded px-1.5 py-0.5",
                    slippageBps === bps ? "bg-arc-primary text-white" : "hover:text-arc-text",
                  )}
                >
                  {bps / 100}%
                </button>
              ))}
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={onTrade}
        disabled={!account || amountRaw === 0n || !feeReady || estimatedOut === 0n || tx.status === "pending"}
        className="arc-button-primary mt-4 w-full py-3 text-base"
      >
        {!account
          ? "Connect wallet"
          : !feeReady
            ? "Loading pool…"
            : amountRaw === 0n
              ? "Enter amount"
              : estimatedOut === 0n
                ? "No quote (retry)"
                : tx.status === "pending"
                  ? `${side === "buy" ? "Buying" : "Selling"}…`
                  : side === "buy"
                    ? `Buy ${symbol}`
                    : `Sell ${symbol}`}
      </button>

      <TxStatus state={tx} className="mt-3" />
    </div>
  );
}
