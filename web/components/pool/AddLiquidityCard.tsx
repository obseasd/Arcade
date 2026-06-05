"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { pushToast } from "@/lib/toast";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { type TxState } from "@/components/ui/TxStatus";
import { formatLpBalance, formatToken, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
  address: ADDRESSES.usdc,
  symbol: "USDC",
  name: "USD Coin",
  decimals: USDC_DECIMALS,
  pinned: true,
};

interface AddLiquidityCardProps {
  /** Fires after the addLiquidity tx is confirmed. Used by the parent to
   *  close the wrapping modal AND trigger a position-list refetch so the
   *  new row shows up without a manual page reload. */
  onSuccess?: () => void;
}

export function AddLiquidityCard({ onSuccess }: AddLiquidityCardProps = {}) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v2Tokens } = useV2Tokens();
  const { writeContractAsync } = useWriteContract();

  const allTokens: TokenOption[] = useMemo(() => [USDC_TOKEN, ...v2Tokens], [v2Tokens]);
  const [tokenA, setTokenA] = useState<TokenOption>(USDC_TOKEN);
  const [tokenB, setTokenB] = useState<TokenOption | null>(null);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [picker, setPicker] = useState<"a" | "b" | null>(null);

  // Default B
  useEffect(() => {
    if (!tokenB && v2Tokens.length > 0) setTokenB(v2Tokens[0]);
  }, [v2Tokens, tokenB]);

  // Find existing pair & reserves so we can compute the optimal other-side amount
  const pairAddr = useReadContract({
    address: ADDRESSES.factory,
    abi: FACTORY_ABI,
    functionName: "getPair",
    args: tokenB ? [tokenA.address, tokenB.address] : undefined,
    query: { enabled: !!tokenB },
  });
  const pair = pairAddr.data as Address | undefined;
  const reserves = useReadContract({
    address: pair,
    abi: PAIR_ABI,
    functionName: "getReserves",
    query: { enabled: !!pair && pair !== "0x0000000000000000000000000000000000000000" },
  });
  const token0 = useReadContract({
    address: pair,
    abi: PAIR_ABI,
    functionName: "token0",
    query: { enabled: !!pair && pair !== "0x0000000000000000000000000000000000000000" },
  });

  const balanceA = useReadContract({
    address: tokenA.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account },
  });
  const balanceB = useReadContract({
    address: tokenB?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: !!account && !!tokenB },
  });

  // If pool exists, recompute B from A. Audit low [16]: gate on token0
  // BEING RESOLVED before doing the orientation flip — otherwise the first
  // pass races the token0 read, defaults isAFirst to false, and shows an
  // INVERTED counter-amount until the second pass lands. Users routinely
  // hit "Add" during that window and over- or under-deposit one side.
  useEffect(() => {
    if (!reserves.data || !tokenB) return;
    if (!token0.data) return; // wait for the orientation read.
    const [r0, r1] = reserves.data as [bigint, bigint, number];
    if (r0 === 0n || r1 === 0n) return;
    if (!amountA) return;
    try {
      const decA = tokenA.decimals ?? 18;
      const decB = tokenB.decimals ?? 18;
      const aRaw = parseUnits(amountA, decA);
      const t0 = token0.data as Address;
      const isAFirst = t0.toLowerCase() === tokenA.address.toLowerCase();
      const [reserveA, reserveB] = isAFirst ? [r0, r1] : [r1, r0];
      if (reserveA === 0n) return;
      const bRaw = (aRaw * reserveB) / reserveA;
      setAmountB(formatUnits(bRaw, decB));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountA, reserves.data, token0.data]);

  const { ensureAllowance: approveA } = useApproveIfNeeded(tokenA.address, ADDRESSES.router);
  const { ensureAllowance: approveB } = useApproveIfNeeded(tokenB?.address, ADDRESSES.router);

  // Audit low [7]/[25]: slippage is now per-add and clamped to a sane
  // [0.05%, 5%] range so a fat-finger "50" can't sign a 50% min. 0.5%
  // (50 bps) matches the standalone /positions/add default.
  const [slippageBps, setSlippageBps] = useState<number>(50);

  const onAdd = async () => {
    if (!account || !tokenB || !amountA || !amountB) return;
    try {
      const decA = tokenA.decimals ?? 18;
      const decB = tokenB.decimals ?? 18;
      const aRaw = parseUnits(amountA, decA);
      const bRaw = parseUnits(amountB, decB);
      // Clamp the slip bps tighter than the input does (defence in depth):
      // refuse > 5% so a stale state with a bad value can't slip through.
      const safeSlipBps = Math.min(500, Math.max(5, slippageBps));
      const slipDen = 10_000n - BigInt(safeSlipBps);
      setTx({ status: "pending", message: "Approving tokens…" });
      await Promise.all([approveA(aRaw), approveB(bRaw)]);
      setTx({ status: "pending", message: "Adding liquidity…" });
      const hash = await writeContractAsync({
        address: ADDRESSES.router,
        abi: ROUTER_ABI,
        functionName: "addLiquidity",
        args: [
          tokenA.address,
          tokenB.address,
          aRaw,
          bRaw,
          (aRaw * slipDen) / 10_000n,
          (bRaw * slipDen) / 10_000n,
          account,
          BigInt(Math.floor(Date.now() / 1000) + 600),
        ],
      });

      // Read the new LP balance off the pair so the toast shows the actual
      // receipt rather than a placeholder. Pair address might be 0x0 on the
      // first-LP path, so we resolve it from getPair after the receipt.
      // Throw on a reverted receipt so the success toast never fires for a
      // no-op tx (waitForTransactionReceipt returns receipts for both
      // success and revert; status is the only safe signal).
      let lpFormatted = "—";
      let resolvedPair = pair;
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(
            `Add liquidity reverted on-chain (tx ${hash.slice(0, 10)}…). Common causes: slippage too tight (try bumping in Settings) or the pool ratio moved between read and execution.`,
          );
        }
        if (!resolvedPair || resolvedPair === "0x0000000000000000000000000000000000000000") {
          try {
            resolvedPair = (await publicClient.readContract({
              address: ADDRESSES.factory,
              abi: FACTORY_ABI,
              functionName: "getPair",
              args: [tokenA.address, tokenB.address],
            })) as Address;
          } catch {
            /* ignore */
          }
        }
        if (resolvedPair && resolvedPair !== "0x0000000000000000000000000000000000000000") {
          try {
            const lp = (await publicClient.readContract({
              address: resolvedPair,
              abi: PAIR_ABI,
              functionName: "balanceOf",
              args: [account],
            })) as bigint;
            lpFormatted = formatLpBalance(lp);
          } catch {
            /* ignore */
          }
        }
      }
      pushToast({
        kind: "liquidity",
        token0: { address: tokenA.address, symbol: tokenA.symbol },
        token1: { address: tokenB.address, symbol: tokenB.symbol },
        amount0Formatted: amountA,
        amount1Formatted: amountB,
        lpFormatted,
        poolHref:
          resolvedPair && resolvedPair !== "0x0000000000000000000000000000000000000000"
            ? `/pool/${resolvedPair}`
            : "/positions",
        explorerUrl: `${arcTestnet.blockExplorers?.default.url}/tx/${hash}`,
      });

      setTx({ status: "idle" });
      setAmountA("");
      setAmountB("");
      balanceA.refetch();
      balanceB.refetch();
      // Tell the parent: close the wrapping modal AND kick a position-list
      // refetch so the new row appears without a hard reload.
      onSuccess?.();
    } catch (e: any) {
      setTx({ status: "idle" });
      pushToast({
        kind: "error",
        title: "Add liquidity failed",
        message: e?.shortMessage || e?.message || "Failed",
      });
    }
  };

  const bal = (b: bigint | undefined, dec: number) =>
    b !== undefined ? (dec === USDC_DECIMALS ? formatUSDC(b, dec, 2) : formatToken(b, dec, 4)) : "0";

  return (
    <div>
      <AmountInput
        label="Token A"
        value={amountA}
        onChange={setAmountA}
        symbol={tokenA.symbol ?? "?"}
        balanceLabel={account ? `Balance: ${bal(balanceA.data as bigint, tokenA.decimals ?? 18)}` : undefined}
        onMax={
          account && balanceA.data
            ? () => setAmountA(formatUnits(balanceA.data as bigint, tokenA.decimals ?? 18))
            : undefined
        }
        rightAccessory={
          <button
            onClick={() => setPicker("a")}
            className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-medium hover:bg-arc-surface-3"
          >
            <TokenIcon symbol={tokenA.symbol} size={20} />
            {tokenA.symbol ?? "Select"}
          </button>
        }
      />

      <div className="my-2 text-center text-arc-text-muted">+</div>

      <AmountInput
        label="Token B"
        value={amountB}
        onChange={setAmountB}
        symbol={tokenB?.symbol ?? "?"}
        balanceLabel={
          account && tokenB ? `Balance: ${bal(balanceB.data as bigint, tokenB.decimals ?? 18)}` : undefined
        }
        onMax={
          account && balanceB.data && tokenB
            ? () => setAmountB(formatUnits(balanceB.data as bigint, tokenB.decimals ?? 18))
            : undefined
        }
        rightAccessory={
          <button
            onClick={() => setPicker("b")}
            className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-medium hover:bg-arc-surface-3"
          >
            {tokenB ? (
              <>
                <TokenIcon symbol={tokenB.symbol} size={20} />
                {tokenB.symbol}
              </>
            ) : (
              "Select"
            )}
          </button>
        }
      />

      {!pair || pair === "0x0000000000000000000000000000000000000000" ? (
        <div className="mt-3 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
          No pool exists yet - you&apos;ll be the first liquidity provider. The ratio you set defines the initial
          price.
        </div>
      ) : (
        <div className="mt-3 text-xs text-arc-text-muted">
          Existing pool - amount B is computed from current reserves to avoid swap-on-add.
        </div>
      )}

      {/* Audit low [25]: per-add slippage selector. Default 0.5% mirrors
          the standalone /positions/add page; 3% bucket is for sketchy
          fresh pairs where the seed ratio can shift between read and exec. */}
      <div className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span className="text-arc-text-muted">Slippage tolerance</span>
        <div className="flex items-center gap-1">
          {[
            { label: "0.1%", bps: 10 },
            { label: "0.5%", bps: 50 },
            { label: "1%", bps: 100 },
            { label: "3%", bps: 300 },
          ].map((opt) => (
            <button
              key={opt.bps}
              onClick={() => setSlippageBps(opt.bps)}
              className={
                "rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors " +
                (slippageBps === opt.bps
                  ? "bg-arc-cta text-white"
                  : "bg-arc-surface text-arc-text-muted hover:text-arc-text")
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={onAdd}
        disabled={!account || !tokenB || !amountA || !amountB || tx.status === "pending"}
        className="arc-button-primary mt-4 w-full py-3 text-base"
      >
        {!account
          ? "Connect wallet"
          : !tokenB
            ? "Select tokens"
            : !amountA || !amountB
              ? "Enter amounts"
              : tx.status === "pending"
                ? tx.message || "Adding…"
                : "Add liquidity"}
      </button>

      <TokenSelectModal
        open={picker !== null}
        onClose={() => setPicker(null)}
        tokens={allTokens}
        onSelect={(t) => {
          if (picker === "a") setTokenA(t);
          else setTokenB(t);
        }}
        excludeAddress={picker === "a" ? tokenB?.address : tokenA.address}
      />
    </div>
  );
}
