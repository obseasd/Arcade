"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_POOL_ABI, V3_QUOTER_ABI, V3_ROUTER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS } from "@/lib/constants";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { pushToast } from "@/lib/toast";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

interface Props {
  /** The Clanker token (mode=2). */
  token: Address;
  symbol: string;
  /** V3 pool address (stored in state.v2Pair for Clanker tokens). */
  pool: Address;
  image?: string;
}

/**
 * Buy/sell a Clanker (V3 locked-LP) token directly on the V3 router/quoter.
 * Falls back to a "Open on Swap" link for WETH-paired pools (we don't expose
 * WETH balance/approve flows in this focused panel — the Swap page does).
 */
export function ClankerTradePanel({ token, symbol, pool, image }: Props) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  // Pool fee + paired-token detection (USDC vs WETH).
  const poolInfo = useReadContracts({
    contracts: [
      { address: pool, abi: V3_POOL_ABI, functionName: "fee" as const },
      { address: pool, abi: V3_POOL_ABI, functionName: "token0" as const },
      { address: pool, abi: V3_POOL_ABI, functionName: "token1" as const },
    ],
    query: { enabled: !!pool },
  });
  const fee = Number(poolInfo.data?.[0]?.result ?? 0);
  const t0 = poolInfo.data?.[1]?.result as Address | undefined;
  const t1 = poolInfo.data?.[2]?.result as Address | undefined;
  const paired = t0 && t1 ? (t0.toLowerCase() === token.toLowerCase() ? t1 : t0) : undefined;
  const isUsdcPaired = paired?.toLowerCase() === ADDRESSES.usdc.toLowerCase();

  const usdcBalance = useReadContract({
    address: ADDRESSES.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account && isUsdcPaired },
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

  // Anti-sniper soft skim: the router skims `currentSnipeBps` from a USDC→token
  // buy before swapping, so we quote on the post-skim amount to keep `minOut`
  // honest. Only applies to buys.
  const snipeBpsQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "currentSnipeBps",
    args: [token],
    query: { enabled: side === "buy" && isUsdcPaired },
  });
  const snipeBps = side === "buy" ? ((snipeBpsQ.data as bigint | undefined) ?? 0n) : 0n;
  const netAmountIn = amountRaw - (amountRaw * snipeBps) / 10_000n;

  // V3 quote (USDC↔token, single hop at this pool's fee tier).
  const quote = useReadContract({
    address: ADDRESSES.v3Quoter,
    abi: V3_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args:
      isUsdcPaired && fee > 0 && netAmountIn > 0n
        ? side === "buy"
          ? [ADDRESSES.usdc, token, fee, netAmountIn]
          : [token, ADDRESSES.usdc, fee, netAmountIn]
        : undefined,
    query: { enabled: isUsdcPaired && fee > 0 && netAmountIn > 0n },
  });
  const estimatedOut = (quote.data as bigint | undefined) ?? 0n;
  const minOut = (estimatedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const snipeSkim = amountRaw - netAmountIn;

  const { ensureAllowance } = useApproveIfNeeded(side === "buy" ? ADDRESSES.usdc : token, ADDRESSES.v3Router);
  const { writeContractAsync } = useWriteContract();

  const onTrade = async () => {
    if (!account || amountRaw === 0n || !isUsdcPaired || fee === 0) return;
    setTx({ status: "pending", message: "Approving…" });
    try {
      await ensureAllowance(amountRaw);
      setTx({ status: "pending", message: "Submitting trade…" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const args =
        side === "buy"
          ? ([ADDRESSES.usdc, token, fee, account, amountRaw, minOut, deadline] as const)
          : ([token, ADDRESSES.usdc, fee, account, amountRaw, minOut, deadline] as const);
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Router,
        abi: V3_ROUTER_ABI,
        functionName: "exactInputSingle",
        args,
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setTx({ status: "idle" });
      setAmount("");
      usdcBalance.refetch();
      tokenBalance.refetch();
      const outTokenSymbol = side === "buy" ? symbol : "USDC";
      const outDecimals = side === "buy" ? LAUNCHPAD_TOKEN_DECIMALS : USDC_DECIMALS;
      pushToast({
        kind: "swap",
        tokenAddress: side === "buy" ? token : ADDRESSES.usdc,
        tokenSymbol: outTokenSymbol,
        tokenImage: side === "buy" ? image : undefined,
        amountFormatted:
          side === "buy"
            ? formatToken(estimatedOut, outDecimals, 6)
            : formatUSDC(estimatedOut, outDecimals, 6),
      });
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Trade failed" });
    }
  };

  // WETH-paired Clanker: trade it on the Swap page (we don't show WETH balance/
  // approve flows in this focused panel).
  if (paired && !isUsdcPaired) {
    return (
      <div className="arc-card space-y-3 p-5">
        <div className="text-sm font-semibold">Trade {symbol}</div>
        <p className="text-xs text-arc-text-muted">
          This Clanker is paired with <b>WETH</b>. Trade it on the Swap page.
        </p>
        <Link
          href={`/swap?out=${token}`}
          className="arc-button-primary block w-full py-2.5 text-center text-sm"
        >
          Open on Swap →
        </Link>
      </div>
    );
  }

  const sideToken = side === "buy" ? "USDC" : symbol;
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
        <button
          onClick={() => {
            setSide("buy");
            setAmount("");
          }}
          className={cn(
            "rounded-lg py-2 text-sm font-medium transition-colors",
            side === "buy" ? "bg-arc-primary text-white" : "text-arc-text-muted hover:text-arc-text",
          )}
        >
          Buy
        </button>
        <button
          onClick={() => {
            setSide("sell");
            setAmount("");
          }}
          className={cn(
            "rounded-lg py-2 text-sm font-medium transition-colors",
            side === "sell" ? "bg-arc-primary text-white" : "text-arc-text-muted hover:text-arc-text",
          )}
        >
          Sell
        </button>
      </div>

      <AmountInput
        label={side === "buy" ? "You pay" : "You sell"}
        value={amount}
        onChange={setAmount}
        symbol={sideToken}
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
        {snipeSkim > 0n && (
          <div className="mt-1 flex justify-between text-arc-text-muted">
            <span>Anti-sniper tax</span>
            <span className="tabular-nums text-arc-warn">
              {formatUSDC(snipeSkim, USDC_DECIMALS, 4)} USDC ({(Number(snipeBps) / 100).toFixed(1)}%)
            </span>
          </div>
        )}
        <div className="mt-1 flex justify-between text-xs text-arc-text-faint">
          <span>Slippage tolerance</span>
          <span className="flex gap-1">
            {[50, 100, 300].map((bps) => (
              <button
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
        {fee > 0 && (
          <div className="mt-2 text-[11px] text-arc-text-faint">
            V3 fee: {fee / 10_000}% (creator 80% / platform 20%)
          </div>
        )}
      </div>

      <button
        onClick={onTrade}
        disabled={!account || amountRaw === 0n || fee === 0 || tx.status === "pending"}
        className={cn(
          "mt-4 w-full py-3 text-base",
          side === "buy" ? "arc-button-primary" : "arc-button-secondary",
        )}
      >
        {!account
          ? "Connect wallet"
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
