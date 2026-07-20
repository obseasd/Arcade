"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { ARCADE_HOOK_ABI } from "@/lib/abis/arcadeHook";
import { V4_ROUTER_ABI } from "@/lib/abis/v4Router";
import { V4_QUOTER_ABI } from "@/lib/abis/v4Quoter";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS } from "@/lib/constants";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
import { reportReferralTrade } from "@/lib/referral";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

interface Props {
  /** The CLANKER V4 token (mode = CLANKER). */
  token: Address;
  symbol: string;
  image?: string;
  /** Fired after a successful trade so the parent can refetch derived state. */
  onTradeSuccess?: () => void;
}

// The hook builds every launch pool with a fixed tick spacing of 200 and itself
// as the hook (see ArcadeHook._buildPoolKey). The fee is the CLANKER tier, read
// on-chain from poolFeeOf(token).
const TICK_SPACING = 200;

/**
 * Buy/sell a CLANKER V4 token on the canonical Uniswap V4 pool via the
 * ArcadeV4SwapRouter. CLANKER launches have NO bonding curve: the full supply
 * is seeded single-sided in a locked V4 LP at creation, tradable immediately.
 * Trading therefore goes through the V4 router (exactInputSingle), NOT the
 * hook's curve buy/sell (which only exists for PUMP pre-graduation).
 *
 * PoolKey mirrors the hook exactly: currencies sorted (USDC, token), fee =
 * poolFeeOf(token) (the 1/2/3% tier), tickSpacing 200, hooks = arcadeHook. The
 * router pulls the input via transferFrom(payer), so approval targets the
 * router. sqrtPriceLimitX96 = 0 => the callback resolves it to the full range.
 */
export function ClankerV4TradePanel({ token, symbol, image, onTradeSuccess }: Props) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  // Single-sided concentrated liquidity moves price sharply per trade and can
  // drift between quote and execution; 3% default mirrors the V3 CLANKER panel.
  const [slippageBps, setSlippageBps] = useState(300);
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [estimatedOut, setEstimatedOut] = useState(0n);
  const [quoting, setQuoting] = useState(false);

  // The pool's fee tier (10000/20000/30000 = 1/2/3%), set at launch.
  const feeQ = useReadContract({
    address: ADDRESSES.arcadeHook,
    abi: ARCADE_HOOK_ABI,
    functionName: "poolFeeOf",
    args: [token],
    query: { enabled: token !== zeroAddress },
  });
  const fee = Number((feeQ.data as bigint | number | undefined) ?? 0);

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

  // Off-chain quote. The V4 quoter isn't `view` (it reverts to unwind state),
  // so we simulate it. Debounced via the amount/side/fee deps.
  useEffect(() => {
    let cancelled = false;
    if (!publicClient || amountRaw === 0n || fee === 0) {
      setEstimatedOut(0n);
      return;
    }
    setQuoting(true);
    publicClient
      .simulateContract({
        address: ADDRESSES.v4Quoter,
        abi: V4_QUOTER_ABI,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey,
            zeroForOne,
            exactAmount: amountRaw,
            hookData: "0x",
          },
        ],
      })
      .then((res) => {
        if (cancelled) return;
        const out = (res.result as readonly [bigint, bigint])[0];
        setEstimatedOut(out);
      })
      .catch(() => {
        if (!cancelled) setEstimatedOut(0n);
      })
      .finally(() => {
        if (!cancelled) setQuoting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicClient, amountRaw, zeroForOne, fee, poolKey]);

  const minOut = (estimatedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const { allowance, ensureAllowance } = useApproveIfNeeded(
    side === "buy" ? ADDRESSES.usdc : token,
    ADDRESSES.v4Router,
  );
  const { writeContractAsync } = useWriteContract();

  const onTrade = async () => {
    if (!account || amountRaw === 0n || fee === 0) return;
    setTx({ status: "pending", message: "Approving…" });
    try {
      if (allowance < amountRaw) {
        await ensureAllowance(amountRaw);
      }
      setTx({ status: "pending", message: "Submitting trade…" });
      const hash = await writeContractAsync({
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
          <span>You receive{quoting ? " (quoting…)" : ""}</span>
          <span className="flex items-center gap-1.5 tabular-nums text-arc-text">
            {side === "buy"
              ? formatToken(estimatedOut, LAUNCHPAD_TOKEN_DECIMALS, 6)
              : formatUSDC(estimatedOut, USDC_DECIMALS, 6)}
            <TokenIcon symbol={side === "buy" ? symbol : "USDC"} image={side === "buy" ? image : undefined} size={16} />
            <span className="text-arc-text-muted">{side === "buy" ? symbol : "USDC"}</span>
          </span>
        </div>
        <div className="mt-1 flex justify-between text-xs text-arc-text-faint">
          <span>Fee tier</span>
          <span className="tabular-nums">{fee > 0 ? `${fee / 10_000}%` : "…"}</span>
        </div>
        <div className="mt-1 flex justify-between text-xs text-arc-text-faint">
          <span>Slippage tolerance</span>
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
        </div>
      </div>

      <button
        type="button"
        onClick={onTrade}
        disabled={!account || amountRaw === 0n || fee === 0 || tx.status === "pending"}
        className="arc-button-primary mt-4 w-full py-3 text-base"
      >
        {!account
          ? "Connect wallet"
          : fee === 0
            ? "Loading pool…"
            : amountRaw === 0n
              ? "Enter amount"
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
