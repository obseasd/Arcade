"use client";

import { useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS } from "@/lib/constants";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useTradeMemo } from "@/lib/hooks/useTradeMemo";
import { MEMO_ABI, MEMO_ADDRESS } from "@/lib/abis/memo";
import { encodeFunctionData } from "viem";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

interface Props {
  token: Address;
  symbol: string;
  migrated: boolean;
  /** Optional token logo (from metadata) for the buy/sell rows. */
  image?: string;
  /** Fired after a successful buy/sell so the parent can refetch derived state (volume, etc.). */
  onTradeSuccess?: () => void;
}

export function TradePanel({ token, symbol, migrated, image, onTradeSuccess }: Props) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100); // 1% default for curve
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  // Both pre- and post-migration swaps go through the Launchpad contract now
  // (post-migration uses `buyMigrated`/`sellMigrated` which take a royalty for
  // the creator + platform on top of the V2 LP fee).
  const spender = ADDRESSES.launchpad;

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

  // Curve quote
  const curveBuyQuote = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "quoteBuy",
    args: amountRaw > 0n ? [token, amountRaw] : undefined,
    query: { enabled: !migrated && side === "buy" && amountRaw > 0n },
  });
  const curveSellQuote = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "quoteSell",
    args: amountRaw > 0n ? [token, amountRaw] : undefined,
    query: { enabled: !migrated && side === "sell" && amountRaw > 0n },
  });

  // DEX quote (when migrated)
  const dexQuote = useReadContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args:
      amountRaw > 0n
        ? [
            amountRaw,
            side === "buy" ? [ADDRESSES.usdc, token] : [token, ADDRESSES.usdc],
          ]
        : undefined,
    query: { enabled: migrated && amountRaw > 0n },
  });

  let estimatedOut = 0n;
  let refund = 0n;
  if (!migrated) {
    if (side === "buy") {
      // quoteBuy returns (tokensOut, actualGrossPaid, refund) after the audit
      // fix; we still surface tokensOut + refund the same way.
      const r = curveBuyQuote.data as [bigint, bigint, bigint] | undefined;
      estimatedOut = r?.[0] ?? 0n;
      refund = r?.[2] ?? 0n;
    } else {
      estimatedOut = (curveSellQuote.data as bigint | undefined) ?? 0n;
    }
  } else {
    estimatedOut = (dexQuote.data as bigint[] | undefined)?.[1] ?? 0n;
  }

  const minOut = (estimatedOut * BigInt(10_000 - slippageBps)) / 10_000n;

  const { ensureAllowance } = useApproveIfNeeded(side === "buy" ? ADDRESSES.usdc : token, spender);
  const { writeContractAsync } = useWriteContract();
  const memo = useTradeMemo();

  const onTrade = async () => {
    if (!account || amountRaw === 0n) return;
    setTx({ status: "pending", message: "Approving…" });
    try {
      await ensureAllowance(amountRaw);
      setTx({ status: "pending", message: "Submitting trade…" });

      const fn = migrated
        ? side === "buy"
          ? "buyMigrated"
          : "sellMigrated"
        : side === "buy"
          ? "buy"
          : "sell";
      // Migrated paths now require a deadline (audit Medium #6). Use 10 min.
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const args = migrated
        ? ([token, amountRaw, minOut, deadline] as const)
        : ([token, amountRaw, minOut] as const);
      // When the URL carries ?ref or ?campaign, wrap the launchpad
      // call through the Memo contract. callFrom preserves msg.sender
      // so the launchpad still sees the EOA; the Memo event lets the
      // off-chain indexer attribute the trade. Bare call otherwise so
      // un-attributed buys don't pay the wrapping overhead.
      const hash = memo
        ? await writeContractAsync({
            address: MEMO_ADDRESS,
            abi: MEMO_ABI,
            functionName: "memo",
            args: [
              ADDRESSES.launchpad,
              encodeFunctionData({
                abi: LAUNCHPAD_ABI,
                functionName: fn,
                args: args as unknown as readonly [`0x${string}`, bigint, bigint],
              }),
              memo.id,
              memo.data,
            ],
          })
        : await writeContractAsync({
            address: ADDRESSES.launchpad,
            abi: LAUNCHPAD_ABI,
            functionName: fn,
            args: args as unknown as readonly [`0x${string}`, bigint, bigint],
          });
      // Audit 2026-06-11 UX-C-1: receipt.status check. waitForTransactionReceipt
      // returns a receipt for both success and revert; without this gate a
      // reverted tx still cleared the form, pushed a green toast, and wrote
      // a buy/sell entry to the activity feed.
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(
            `${side === "buy" ? "Buy" : "Sell"} reverted on-chain (tx ${hash.slice(0, 10)}…). Common causes: slippage too tight, deadline passed, pool ratio moved between read and exec.`,
          );
        }
      }
      setTx({ status: "idle" });
      setAmount("");
      usdcBalance.refetch();
      tokenBalance.refetch();
      onTradeSuccess?.();
      const outFormatted = side === "buy"
        ? formatToken(estimatedOut, LAUNCHPAD_TOKEN_DECIMALS, 6)
        : formatUSDC(estimatedOut, USDC_DECIMALS, 6);
      if (account) {
        addActivity({
          type: side,
          account,
          token,
          label: side === "buy" ? `Bought $${symbol}` : `Sold $${symbol}`,
          value: side === "buy" ? `${outFormatted} ${symbol}` : `${outFormatted} USDC`,
          txHash: hash,
        });
      }
      pushToast({
        kind: "swap",
        tokenAddress: side === "buy" ? token : ADDRESSES.usdc,
        tokenSymbol: side === "buy" ? symbol : "USDC",
        tokenImage: side === "buy" ? image : undefined,
        amountFormatted: outFormatted,
      });
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Trade failed" });
    }
  };

  const sideToken = side === "buy" ? "USDC" : symbol;
  const sideDecimals = side === "buy" ? USDC_DECIMALS : LAUNCHPAD_TOKEN_DECIMALS;
  const inBalance = side === "buy" ? (usdcBalance.data as bigint | undefined) : (tokenBalance.data as bigint | undefined);
  const inBalanceFmt = inBalance
    ? side === "buy"
      ? formatUSDC(inBalance, USDC_DECIMALS, 2)
      : formatToken(inBalance, LAUNCHPAD_TOKEN_DECIMALS, 4)
    : "0";

  return (
    <div className="arc-card p-5">
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-arc-border bg-arc-bg-elevated p-1">
        <button type="button"
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
        <button type="button"
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
        onMax={
          account && inBalance ? () => setAmount(formatUnits(inBalance, sideDecimals)) : undefined
        }
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
        {refund > 0n && (
          <div className="mt-1 flex justify-between text-arc-text-muted">
            <span>Refund (overshoot)</span>
            <span className="tabular-nums text-arc-warn">{formatUSDC(refund, USDC_DECIMALS, 6)} USDC</span>
          </div>
        )}
        <div className="mt-1 flex justify-between text-xs text-arc-text-faint">
          <span>Slippage tolerance</span>
          <span className="flex gap-1">
            {[50, 100, 300].map((bps) => (
              <button type="button"
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
        {!migrated && (
          <div className="mt-2 text-[11px] text-arc-text-faint">
            Trade fee: 1% (0.5% platform · 0.5% creator)
          </div>
        )}
        {migrated && <div className="mt-2 text-[11px] text-arc-text-faint">DEX fee: 0.3% to LPs</div>}
      </div>

      <button type="button"
        onClick={onTrade}
        disabled={!account || amountRaw === 0n || tx.status === "pending"}
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
