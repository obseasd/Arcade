"use client";

import { useEffect, useMemo, useState } from "react";
import { Address, erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI } from "@/lib/abis/dex";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { AmountInput } from "@/components/ui/AmountInput";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { formatToken, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
  address: ADDRESSES.usdc,
  symbol: "USDC",
  name: "USD Coin",
  decimals: USDC_DECIMALS,
  pinned: true,
};

export function AddLiquidityCard() {
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

  // If pool exists, recompute B from A
  useEffect(() => {
    if (!reserves.data || !tokenB) return;
    const [r0, r1] = reserves.data as [bigint, bigint, number];
    if (r0 === 0n || r1 === 0n) return;
    if (!amountA) return;
    try {
      const decA = tokenA.decimals ?? 18;
      const decB = tokenB.decimals ?? 18;
      const aRaw = parseUnits(amountA, decA);
      const t0 = token0.data as Address | undefined;
      const isAFirst = t0 && t0.toLowerCase() === tokenA.address.toLowerCase();
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

  const onAdd = async () => {
    if (!account || !tokenB || !amountA || !amountB) return;
    try {
      const decA = tokenA.decimals ?? 18;
      const decB = tokenB.decimals ?? 18;
      const aRaw = parseUnits(amountA, decA);
      const bRaw = parseUnits(amountB, decB);
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
          (aRaw * 99n) / 100n,
          (bRaw * 99n) / 100n,
          account,
          BigInt(Math.floor(Date.now() / 1000) + 600),
        ],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setTx({ status: "success", message: "Liquidity added" });
      setAmountA("");
      setAmountB("");
      balanceA.refetch();
      balanceB.refetch();
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Failed" });
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
                ? "Adding…"
                : "Add liquidity"}
      </button>

      <TxStatus state={tx} className="mt-3" />

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
