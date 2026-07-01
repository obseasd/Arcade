"use client";

import { ArrowDown, ChevronDown, Plus } from "lucide-react";
import { CrossIcon } from "@/components/ui/MaskIcon";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Address,
  erc20Abi,
  formatUnits,
  maxUint256,
  parseUnits,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { runSequential, type SequentialCall } from "@/lib/routing/runSequential";
import { quoteBestLeg, quoteBestLegs } from "@/lib/routing/multiLegQuote";
import type { RouteQuote } from "@/lib/routing/types";
import { useSignPermit2, PERMIT2_ADDRESS } from "@/lib/permit2";
import { encodePermit2PermitInput } from "@/lib/routing/universalRouter";
import { ADDRESSES, MULTISWAP_MAX_INPUTS, USDC_DECIMALS } from "@/lib/constants";
import { TransactionSettings } from "@/components/ui/TransactionSettings";
import { QuickButton } from "@/components/swap/QuickButton";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
import { reportReferralTrade } from "@/lib/referral";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { MultiTokenSelectModal } from "@/components/ui/MultiTokenSelectModal";
import { TokenSelectModal, type TokenOption } from "@/components/ui/TokenSelectModal";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { SwapTabs, type SwapTab } from "./SwapTabs";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
  address: ADDRESSES.usdc,
  symbol: "USDC",
  name: "USD Coin",
  decimals: USDC_DECIMALS,
  pinned: true,
};

// EURC removed from the picker until a real EUR/USD feed lands; see
// SwapCard.tsx for the rationale (audit 2026-06-06).

const PRESETS_BPS = [10, 50, 100];
// 0.5% default: the multi-swap routes the pooled USDC through whichever DEX
// prices the output best, which on testnet can be a mispriced + actively
// arbitraged pool (e.g. Synthra USDC/USDT drifting toward 1:1). A 0.1%
// tolerance reverts (V3TooLittleReceived) when the price drifts during the
// Permit2 sign + send latency; 0.5% absorbs that without being loose.
const DEFAULT_BPS = 50;

interface InputRow {
  token: TokenOption;
  amountStr: string;
}

interface MultiSwapCardProps {
  /** Active tab - used by the in-card tab strip in the header. */
  tab: SwapTab;
  onTabChange: (t: SwapTab) => void;
}

export function MultiSwapCard({ tab, onTabChange }: MultiSwapCardProps) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v2Tokens } = useV2Tokens();
  // Clanker V3 tokens have no V2 pair, so they're absent from useV2Tokens.
  // The MultiSwap contract routes them via the V3SwapRouter (and now V4 too,
  // via the V4 leg added in feat(swap)), so we surface them in the picker.
  const { tokens: v3Tokens } = useV3Tokens();
  const { writeContractAsync } = useWriteContract();
  const signPermit2 = useSignPermit2();

  const allTokens: TokenOption[] = useMemo(() => {
    // Dedup by lowercase address (a token could theoretically have BOTH a
    // V2 pair and V3 pool listed, eg manually migrated tokens).
    const map = new Map<string, TokenOption>();
    [USDC_TOKEN, ...v2Tokens, ...v3Tokens].forEach((t) => {
      const k = t.address.toLowerCase();
      if (!map.has(k)) map.set(k, t);
    });
    return Array.from(map.values());
  }, [v2Tokens, v3Tokens]);

  const [inputs, setInputs] = useState<InputRow[]>([]);
  const [outputToken, setOutputToken] = useState<TokenOption | null>(null);
  const [pickerOpen, setPickerOpen] = useState<"add" | "output" | null>(null);
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_BPS);
  const [slippageCustom, setSlippageCustom] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  // Default the output to the first V2 token once we know what's available.
  useEffect(() => {
    if (!outputToken && v2Tokens.length > 0) setOutputToken(v2Tokens[0]);
  }, [v2Tokens, outputToken]);

  // ----- Balances (one read per unique input token) -----
  const balanceCalls = useReadContracts({
    contracts: account
      ? inputs.map((row) => ({
          address: row.token.address,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [account] as const,
        }))
      : [],
    query: { enabled: !!account && inputs.length > 0 },
  });
  const balancesRaw: (bigint | undefined)[] = useMemo(
    () => (balanceCalls.data ?? []).map((c) => (c.status === "success" ? (c.result as bigint) : undefined)),
    [balanceCalls.data],
  );

  // ----- Quote: build the (token, amount) tuples then call quoteSwapToSingle -----
  // We filter out zero-amount rows so a half-filled UI doesn't revert the read.
  const tupleArgs = useMemo(() => {
    const out: { token: Address; decimals: number; amount: bigint }[] = [];
    for (const row of inputs) {
      const decimals = row.token.decimals ?? 18;
      try {
        if (!row.amountStr) continue;
        const raw = parseUnits(row.amountStr, decimals);
        if (raw === 0n) continue;
        out.push({ token: row.token.address, decimals, amount: raw });
      } catch {
        /* swallow parse error */
      }
    }
    return out;
  }, [inputs]);

  // ----- Quote: CONVERGE every input to USDC, then ONE final swap
  // USDC -> output. This reaches cross-DEX paths the per-leg model can't:
  // ETH has deep USDC liquidity on Arcade V3 while USDT's lives on
  // Synthra, so ETH->USDT only prices well as ETH->USDC (Arcade) +
  // USDC->USDT (Synthra). Each non-USDC input is quoted to USDC across
  // ALL providers (best of); USDC inputs pass through; the pooled USDC is
  // quoted once to the output token. Robust at exec time because the final
  // swap re-reads the ACTUAL USDC received before sizing itself.
  const [inputUsdcRoutes, setInputUsdcRoutes] = useState<(RouteQuote | null)[]>([]);
  const [usdcMid, setUsdcMid] = useState<bigint>(0n);
  const [finalRoute, setFinalRoute] = useState<RouteQuote | null>(null);
  const [quoting, setQuoting] = useState(false);

  const usdcLower = ADDRESSES.usdc.toLowerCase();
  const outIsUsdc =
    !!outputToken && outputToken.address.toLowerCase() === usdcLower;

  const quoteKey = useMemo(
    () =>
      outputToken
        ? `${outputToken.address}|${slippageBps}|${tupleArgs
            .map((t) => `${t.token}:${t.amount}`)
            .join(",")}`
        : "",
    [outputToken, slippageBps, tupleArgs],
  );

  useEffect(() => {
    if (!outputToken || tupleArgs.length === 0 || !publicClient || !account) {
      setInputUsdcRoutes([]);
      setUsdcMid(0n);
      setFinalRoute(null);
      setQuoting(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    setQuoting(true);
    const handle = setTimeout(() => {
      void (async () => {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
        try {
          // Stage 1: every non-USDC input -> USDC (USDC inputs pass through).
          const inRoutes = await quoteBestLegs(
            tupleArgs.map((t) => ({
              tokenIn: t.token,
              decimalsIn: t.decimals,
              amountIn: t.amount,
            })),
            {
              tokenOut: ADDRESSES.usdc,
              decimalsOut: USDC_DECIMALS,
              recipient: account,
              slippageBps,
              deadline,
              signal: ctrl.signal,
            },
            publicClient,
          );
          let usdc = 0n;
          for (let i = 0; i < tupleArgs.length; i++) {
            if (tupleArgs[i].token.toLowerCase() === usdcLower) {
              usdc += tupleArgs[i].amount;
            } else {
              usdc += inRoutes[i]?.amountOut ?? 0n;
            }
          }
          // Stage 2: pooled USDC -> output token (skip when output is USDC).
          let fRoute: RouteQuote | null = null;
          if (!outIsUsdc && usdc > 0n) {
            fRoute = await quoteBestLeg(
              {
                tokenIn: ADDRESSES.usdc,
                decimalsIn: USDC_DECIMALS,
                tokenOut: outputToken.address,
                decimalsOut: outputToken.decimals ?? 18,
                amountIn: usdc,
                recipient: account,
                slippageBps,
                deadline,
                signal: ctrl.signal,
              },
              publicClient,
            );
          }
          if (!cancelled) {
            setInputUsdcRoutes(inRoutes);
            setUsdcMid(usdc);
            setFinalRoute(fRoute);
          }
        } finally {
          if (!cancelled) setQuoting(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, publicClient, account]);

  const totalOutRaw: bigint = outIsUsdc ? usdcMid : finalRoute?.amountOut ?? 0n;

  // Per-row "no route": a non-USDC input with no path to USDC. inputUsdcRoutes
  // is index-aligned with tupleArgs (non-zero legs); USDC inputs never count.
  const noRouteByIndex: boolean[] = useMemo(() => {
    if (quoting || inputUsdcRoutes.length !== tupleArgs.length) {
      return inputs.map(() => false);
    }
    let cursor = 0;
    return inputs.map((row) => {
      let raw = 0n;
      try {
        raw = row.amountStr ? parseUnits(row.amountStr, row.token.decimals ?? 18) : 0n;
      } catch {
        raw = 0n;
      }
      if (raw === 0n) return false;
      const r = inputUsdcRoutes[cursor];
      cursor += 1;
      if (row.token.address.toLowerCase() === usdcLower) return false;
      return r === null;
    });
  }, [inputs, inputUsdcRoutes, tupleArgs.length, quoting, usdcLower]);
  const anyNoRoute = noRouteByIndex.some(Boolean);

  // The output token can't be reached from the pooled USDC (no USDC->out
  // route on any DEX). Blocks the swap with a clear message.
  const outputUnreachable =
    !outIsUsdc && !quoting && usdcMid > 0n && !finalRoute;

  // ----- Slippage helpers -----
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

  const decimalsOut = outputToken?.decimals ?? 18;
  const outputAmountStr = totalOutRaw > 0n ? formatUnits(totalOutRaw, decimalsOut) : "";
  const minTotalOut = (totalOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  // Per-input breakdown shown above the total ("2 USDC -> 1.7 USDT"). Since
  // the swap converges every input to USDC then makes one final swap, each
  // input's share of the output is proportional to the USDC it contributes:
  //   outShare_i = totalOut * (usdc_i / usdcMid).
  const breakdown = useMemo(() => {
    if (
      !outputToken ||
      quoting ||
      usdcMid === 0n ||
      totalOutRaw === 0n ||
      inputUsdcRoutes.length !== tupleArgs.length
    ) {
      return [] as { label: string; outStr: string }[];
    }
    const out: { label: string; outStr: string }[] = [];
    let cursor = 0;
    for (const row of inputs) {
      let raw = 0n;
      try {
        raw = row.amountStr ? parseUnits(row.amountStr, row.token.decimals ?? 18) : 0n;
      } catch {
        raw = 0n;
      }
      if (raw === 0n) continue;
      const usdcValue =
        row.token.address.toLowerCase() === usdcLower
          ? raw
          : inputUsdcRoutes[cursor]?.amountOut ?? 0n;
      cursor += 1;
      const outShare = (totalOutRaw * usdcValue) / usdcMid;
      out.push({
        label: `${row.amountStr} ${row.token.symbol}`,
        outStr: `${formatTokenAmount(outShare, decimalsOut, 4)} ${outputToken.symbol}`,
      });
    }
    return out;
  }, [
    inputs,
    inputUsdcRoutes,
    tupleArgs.length,
    usdcMid,
    totalOutRaw,
    outputToken,
    quoting,
    decimalsOut,
    usdcLower,
  ]);

  // ----- Validation -----
  const hasAnyAmount = tupleArgs.length > 0;
  // True when at least one input row exists with no amount typed (user is
  // mid-edit). We use this to soften the "No valid trades" warning when the
  // user just hasn't finished entering amounts yet, so it doesn't look like
  // a routing error when it's really a "fill the form first" situation.
  const hasEmptyRow = inputs.length > tupleArgs.length;
  const insufficientByIndex = inputs.map((row, i) => {
    try {
      const raw = row.amountStr ? parseUnits(row.amountStr, row.token.decimals ?? 18) : 0n;
      const bal = balancesRaw[i] ?? 0n;
      return raw > 0n && raw > bal;
    } catch {
      return false;
    }
  });
  const anyInsufficient = insufficientByIndex.some(Boolean);

  const canSwap =
    !!account &&
    !!outputToken &&
    hasAnyAmount &&
    !anyInsufficient &&
    !anyNoRoute &&
    !outputUnreachable &&
    !quoting &&
    totalOutRaw > 0n &&
    tx.status !== "pending";

  // ----- Row mutators -----
  const addTokens = (newTokens: TokenOption[]) => {
    setInputs((prev) => {
      const existing = new Set(prev.map((p) => p.token.address.toLowerCase()));
      const filtered = newTokens.filter((t) => !existing.has(t.address.toLowerCase()));
      const capped = [...prev, ...filtered.map((t) => ({ token: t, amountStr: "" }))].slice(
        0,
        MULTISWAP_MAX_INPUTS,
      );
      return capped;
    });
  };
  // Audit 2026-06-18b render-perf: useCallback so the handlers passed to
  // each memoized InputBox keep a stable identity across re-renders.
  // Both use the setState updater form (no captured state), so empty
  // deps are correct with zero stale-closure risk. Combined with the
  // memoized InputBox below, typing in one input no longer re-renders
  // the sibling input rows.
  const removeRow = useCallback(
    (i: number) => setInputs((prev) => prev.filter((_, idx) => idx !== i)),
    [],
  );
  const setRowAmount = useCallback(
    (i: number, v: string) =>
      setInputs((prev) => prev.map((row, idx) => (idx === i ? { ...row, amountStr: v } : row))),
    [],
  );
  // Stable handler for the memoized OutputBox's token-picker trigger.
  const openOutputPicker = useCallback(() => setPickerOpen("output"), []);

  // ----- Execute -----
  // Settle a set of (token, amount, route) legs: every classic-approve leg
  // folds into ONE Multicall3From signature (approve + swap, sender-
  // preserving), then each Permit2 leg settles on its own (sign PermitSingle
  // + execute). Returns the last tx hash.
  const executeLegs = async (
    legs: { token: Address; amount: bigint; route: RouteQuote }[],
    label: string,
  ): Promise<`0x${string}` | undefined> => {
    const classicLegs = legs.filter((l) => !l.route.permit2);
    const permit2Legs = legs.filter((l) => !!l.route.permit2);
    let lastHash: `0x${string}` | undefined;

    // Arc's callFrom precompile is dead, so the old "approve + swap every
    // leg in one signature" Multicall3From batch reverts on-chain. Build
    // the SAME ordered list of calls (per classic leg: approve then swap;
    // per permit2 leg needing it: a Permit2 approve) and run them as
    // sequential direct txs from the user's wallet. msg.sender is the user
    // on each tx for free.
    const calls: SequentialCall[] = [];
    for (const l of classicLegs) {
      if ((l.route.executor.value ?? 0n) > 0n) {
        throw new Error("A value-bearing route can't be batched.");
      }
      calls.push({
        address: l.route.approval.token,
        abi: erc20Abi,
        functionName: "approve",
        // Exact leg amount + 2% buffer, not maxUint256 (defense-in-depth: cap a
        // compromised spender's reach to this leg; buffer absorbs rounding).
        args: [l.route.approval.spender, l.amount + (l.amount * 200n) / 10_000n],
      });
      calls.push({
        address: l.route.executor.router,
        abi: l.route.executor.abi,
        functionName: l.route.executor.functionName,
        args: l.route.executor.args,
      });
    }
    for (const l of permit2Legs) {
      const allowance = (await publicClient!.readContract({
        address: l.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account!, PERMIT2_ADDRESS],
      })) as bigint;
      if (allowance < l.amount) {
        calls.push({
          address: l.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, maxUint256],
        });
      }
    }
    if (calls.length > 0) {
      setTx({ status: "pending", message: `${label}: approve + swap` });
      const h = await runSequential(calls, {
        writeContractAsync,
        publicClient,
      });
      if (h) lastHash = h;
    }
    for (const l of permit2Legs) {
      const p2 = l.route.permit2!;
      setTx({ status: "pending", message: `${label}: sign ${l.route.provider}` });
      const { permit, signature } = await signPermit2({
        token: l.token,
        spender: p2.permitSpender,
        amount: l.amount,
      });
      const encoded = encodePermit2PermitInput(permit, signature);
      const inputs = [...(l.route.executor.args[1] as `0x${string}`[])];
      if (p2.permitInputIndex < 0 || p2.permitInputIndex >= inputs.length) {
        throw new Error(`Provider ${l.route.provider} set an invalid permitInputIndex.`);
      }
      inputs[p2.permitInputIndex] = encoded;
      const execArgs = [l.route.executor.args[0], inputs, l.route.executor.args[2]];
      setTx({ status: "pending", message: `${label}: swap ${l.route.provider}` });
      const h = await writeContractAsync({
        address: l.route.executor.router,
        abi: l.route.executor.abi,
        functionName: l.route.executor.functionName,
        args: execArgs,
        value: l.route.executor.value,
      });
      const r = await publicClient!.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") {
        throw new Error(`${l.route.provider} leg reverted on-chain. Tx: ${h}`);
      }
      lastHash = h;
    }
    return lastHash;
  };

  const onSwap = async () => {
    if (!account || !outputToken || tupleArgs.length === 0 || !publicClient) return;
    setTx({ status: "pending", message: "Finding best routes…" });
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const usdc = ADDRESSES.usdc;
      const outIsUsdcExec = outputToken.address.toLowerCase() === usdcLower;

      // Stage 1 — convert every non-USDC input to USDC (fresh quotes). USDC
      // inputs are counted directly. Snapshot the USDC balance so stage 2
      // can swap the EXACT USDC this multi-swap produced, never the user's
      // other USDC, and never over-pull on a slippage shortfall.
      const nonUsdc = tupleArgs.filter((t) => t.token.toLowerCase() !== usdcLower);
      const usdcInputSum = tupleArgs
        .filter((t) => t.token.toLowerCase() === usdcLower)
        .reduce((s, t) => s + t.amount, 0n);

      const usdcBalBefore = (await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;

      let s1Hash: `0x${string}` | undefined;
      if (nonUsdc.length > 0) {
        const s1Routes = await quoteBestLegs(
          nonUsdc.map((t) => ({ tokenIn: t.token, decimalsIn: t.decimals, amountIn: t.amount })),
          { tokenOut: usdc, decimalsOut: USDC_DECIMALS, recipient: account, slippageBps, deadline },
          publicClient,
        );
        if (s1Routes.some((r) => !r)) {
          throw new Error("No route to USDC for one or more inputs.");
        }
        const s1Legs = nonUsdc.map((t, i) => ({
          token: t.token,
          amount: t.amount,
          route: s1Routes[i] as RouteQuote,
        }));
        s1Hash = await executeLegs(s1Legs, "Convert to USDC");
      }

      const usdcBalAfter = (await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
      const usdcToSwap =
        (usdcBalAfter > usdcBalBefore ? usdcBalAfter - usdcBalBefore : 0n) +
        usdcInputSum;
      if (usdcToSwap === 0n) throw new Error("Nothing to swap.");

      let lastHash: `0x${string}` | undefined;
      let expectedOut: bigint;
      if (outIsUsdcExec) {
        // Output IS USDC — the user already holds the converted USDC.
        expectedOut = usdcToSwap;
        lastHash = s1Hash;
      } else {
        // Stage 2 — pooled USDC -> output, sized to the ACTUAL USDC on hand.
        const fRoute = await quoteBestLeg(
          {
            tokenIn: usdc,
            decimalsIn: USDC_DECIMALS,
            tokenOut: outputToken.address,
            decimalsOut: outputToken.decimals ?? 18,
            amountIn: usdcToSwap,
            recipient: account,
            slippageBps,
            deadline,
          },
          publicClient,
        );
        if (!fRoute) throw new Error("No route from USDC to the output token.");
        expectedOut = fRoute.amountOut;
        lastHash = await executeLegs(
          [{ token: usdc, amount: usdcToSwap, route: fRoute }],
          "Swap to output",
        );
      }

      setTx({ status: "idle" });
      setInputs([]);
      balanceCalls.refetch();
      const outFormatted = formatTokenAmount(expectedOut, decimalsOut, 6);
      addActivity({
        type: tupleArgs.length > 1 ? "multiswap" : "swap",
        account,
        token: outputToken.address,
        label: tupleArgs.length > 1
          ? `Multi-swap to $${outputToken.symbol}`
          : `Swapped to $${outputToken.symbol}`,
        value: `${outFormatted} ${outputToken.symbol}`,
        txHash: lastHash ?? ("0x" as `0x${string}`),
      });
      // Referral accrual (fire-and-forget). usdcToSwap is the pooled USDC =
      // the trade's USD volume.
      if (usdcToSwap > 0n) reportReferralTrade(account, usdcToSwap);
      pushToast({
        kind: "swap",
        tokenAddress: outputToken.address,
        tokenSymbol: outputToken.symbol,
        amountFormatted: outFormatted,
      });
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || "Multi-swap failed";
      setTx({ status: "error", message: msg });
      pushToast({
        kind: "error",
        title: "Multi-swap failed",
        message: msg,
      });
    }
  };

  // ----- Pre-compute excluded tokens for the picker -----
  const inputAddresses = useMemo(() => inputs.map((r) => r.token.address), [inputs]);
  const excludeForAdd: Address[] = useMemo(
    () => (outputToken ? [outputToken.address] : []),
    [outputToken],
  );

  // ----- Render -----

  return (
    <div className="arc-card relative p-5">
      <div className="mb-4 flex items-center justify-between">
        <SwapTabs tab={tab} onTabChange={onTabChange} />
        <TransactionSettings
          open={showSettings}
          onToggle={() => setShowSettings((s) => !s)}
          onClose={() => setShowSettings(false)}
          slippageBps={slippageBps}
          slippageCustom={slippageCustom}
          onPreset={onSlippagePreset}
          onCustom={onSlippageCustom}
        />
      </div>

      {/* Top button - always dashed (it's the "action" CTA). The empty-state
          placeholder rectangle below stays solid so it reads as the primary
          target instead of competing with this button. */}
      <button type="button"
        onClick={() => setPickerOpen("add")}
        disabled={inputs.length >= MULTISWAP_MAX_INPUTS}
        className={cn(
          "mb-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed py-3.5 text-sm font-medium transition-all",
          inputs.length === 0 && "border-arc-border bg-arc-surface-2/40 text-arc-text hover:border-arc-cta-hover/50 hover:bg-arc-cta/10",
          inputs.length > 0 && inputs.length < MULTISWAP_MAX_INPUTS && "border-arc-border bg-arc-surface-2/30 text-arc-text-muted hover:border-arc-cta-hover/50 hover:bg-arc-cta/10 hover:text-arc-text",
          inputs.length >= MULTISWAP_MAX_INPUTS && "cursor-not-allowed border-arc-border text-arc-text-faint",
        )}
      >
        {inputs.length > 0 && <Plus className="h-4 w-4" />}
        {inputs.length === 0
          ? "Select tokens"
          : inputs.length >= MULTISWAP_MAX_INPUTS
            ? `Maximum ${MULTISWAP_MAX_INPUTS} tokens reached`
            : "Add a token"}
      </button>

      {/* Input rows - when no token is selected yet, show a single empty
          placeholder row (matches Hyperswap's idle state) which also opens
          the multi-select picker on click. */}
      <div className="space-y-3">
        {inputs.length === 0 ? (
          <PlaceholderInputBox onClick={() => setPickerOpen("add")} />
        ) : (
          inputs.map((row, i) => (
            <InputBox
              key={row.token.address}
              index={i}
              row={row}
              balance={balancesRaw[i] ?? 0n}
              insufficient={insufficientByIndex[i]}
              noRoute={noRouteByIndex[i] ?? false}
              onAmountChange={setRowAmount}
              onRemove={removeRow}
            />
          ))
        )}
      </div>

      {/* Add-more + arrow. The green "+" only appears once at least one
          token is selected - when empty, we already have the prominent
          "Select tokens" button at the top. */}
      <div className="relative z-10 my-3 flex flex-col items-center gap-1.5">
        {inputs.length > 0 && inputs.length < MULTISWAP_MAX_INPUTS && (
          <button type="button"
            onClick={() => setPickerOpen("add")}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-arc-success/50 bg-arc-success/15 text-arc-success transition-all hover:bg-arc-success/30 active:scale-90"
            title="Add another input token"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
        <span className="rounded-xl border border-arc-border bg-arc-surface-2/40 p-2 backdrop-blur-md">
          <ArrowDown className="h-4 w-4 text-white" />
        </span>
      </div>

      {/* Output box */}
      <OutputBox
        token={outputToken}
        amountStr={outputAmountStr}
        onTokenClick={openOutputPicker}
        breakdown={breakdown}
      />

      {/* Status line */}
      {hasAnyAmount && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="text-arc-text-muted">
            {quoting ? (
              <span>Fetching prices…</span>
            ) : anyNoRoute ? (
              <span className="text-arc-warn">
                Remove the inputs marked &quot;No route found&quot; to continue
              </span>
            ) : outputUnreachable ? (
              <span className="text-arc-warn">
                No route from USDC to {outputToken?.symbol} on any DEX
              </span>
            ) : totalOutRaw === 0n ? (
              hasEmptyRow ? (
                <span>Enter amounts for all inputs</span>
              ) : (
                <span className="text-arc-warn">No valid trades to execute</span>
              )
            ) : (
              <span>
                Min received{" "}
                <span className="font-medium tabular-nums text-arc-text">
                  {formatTokenAmount(minTotalOut, decimalsOut, 4)} {outputToken?.symbol}
                </span>{" "}
                · slippage {(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : 2)}%
              </span>
            )}
          </div>
        </div>
      )}

      <button type="button"
        onClick={onSwap}
        disabled={!canSwap}
        className="arc-button-primary mt-4 w-full py-3.5 text-base"
      >
        {!account
          ? "Connect wallet"
          : inputs.length === 0
            ? "Add a token to start"
            : !outputToken
              ? "Select output token"
              : !hasAnyAmount
                ? "Enter amounts"
                : anyInsufficient
                  ? "Insufficient balance"
                  : quoting
                    ? "Fetching prices…"
                    : anyNoRoute
                      ? "No route for some tokens"
                      : outputUnreachable
                        ? `No route to ${outputToken?.symbol}`
                        : totalOutRaw === 0n
                        ? hasEmptyRow
                          ? "Enter amounts"
                          : "No valid trades to execute"
                        : `Swap ${tupleArgs.length} tokens`}
      </button>

      {tx.status !== "idle" && <TxStatus state={tx} className="mt-3" />}

      {/* Modals */}
      <MultiTokenSelectModal
        open={pickerOpen === "add"}
        onClose={() => setPickerOpen(null)}
        tokens={allTokens}
        initialSelected={inputAddresses}
        excludeAddresses={excludeForAdd}
        maxSelected={MULTISWAP_MAX_INPUTS}
        onConfirm={addTokens}
      />
      <TokenSelectModal
        open={pickerOpen === "output"}
        onClose={() => setPickerOpen(null)}
        tokens={allTokens}
        onSelect={(t) => setOutputToken(t)}
        selectedAddress={outputToken?.address}
        excludeAddress={undefined}
      />

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

// Audit 2026-06-18b render-perf: memoized so typing in one input row
// does not re-render its siblings. The parent passes stable
// (useCallback) handlers + the row's index; row/balance/insufficient
// are referentially stable for unchanged rows because setRowAmount only
// rebuilds the edited row's object. token0-style props are primitives
// compared by value, so React.memo's shallow compare skips correctly.
const InputBox = memo(function InputBox({
  index,
  row,
  balance,
  insufficient,
  noRoute,
  onAmountChange,
  onRemove,
}: {
  index: number;
  row: InputRow;
  balance: bigint;
  insufficient: boolean;
  noRoute: boolean;
  onAmountChange: (i: number, v: string) => void;
  onRemove: (i: number) => void;
}) {
  const decimals = row.token.decimals ?? 18;
  const balLabel =
    decimals === USDC_DECIMALS ? formatUSDC(balance, decimals, 2) : formatToken(balance, decimals, 4);

  return (
    <div
      className={cn(
        "group relative rounded-2xl border bg-white/[0.015] p-4 transition-colors focus-within:border-arc-border-strong",
        noRoute
          ? "border-arc-warn/50"
          : insufficient
            ? "border-arc-danger/50"
            : "border-arc-border",
      )}
    >
      {/* Top: amount on the left, token chip on the right */}
      <div className="flex items-center justify-between">
        <input
          aria-label="Swap amount"
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={row.amountStr}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, "");
            const parts = v.split(".");
            if (parts.length > 2) return;
            onAmountChange(index, v);
          }}
          className={cn(
            "arc-input w-0 min-w-0 flex-1 bg-transparent font-medium leading-tight tabular-nums",
            // Shrink the font as the amount grows so a 18-char balance
            // like 557976.127802551570 stops clipping into the ticker
            // chip. Native input scroll picks up past the smallest step.
            multiInputSize(row.amountStr),
          )}
        />
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-semibold">
            <TokenIcon symbol={row.token.symbol} size={20} />
            {row.token.symbol ?? "-"}
          </span>
          <button type="button"
            onClick={() => onRemove(index)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-arc-surface-2/60 text-arc-text-muted opacity-70 transition-all hover:bg-arc-danger/20 hover:text-arc-danger hover:opacity-100 sm:h-6 sm:w-6"
            title="Remove this token"
          >
            <CrossIcon size={12} />
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-2 flex items-center justify-between text-xs">
        <span
          className={cn(
            "tabular-nums",
            noRoute
              ? "font-medium text-arc-warn"
              : insufficient
                ? "text-arc-danger"
                : "text-arc-text-muted",
          )}
        >
          {noRoute ? "No route found" : `${balLabel} ${row.token.symbol}`}
        </span>
        <div className="flex items-center gap-1.5">
          <QuickButton
            onClick={() => onAmountChange(index, formatUnits(balance / 2n, decimals))}
            disabled={balance === 0n}
          >
            HALF
          </QuickButton>
          <QuickButton
            onClick={() => onAmountChange(index, formatUnits(balance, decimals))}
            disabled={balance === 0n}
          >
            MAX
          </QuickButton>
        </div>
      </div>
    </div>
  );
});

/** Empty-state input row, rendered when no tokens have been selected yet.
 * Visually mirrors a real InputBox so the layout stays stable, but the
 * token chip becomes the picker trigger. Once at least one real token is
 * added, this row is replaced by the actual InputBoxes. */
function PlaceholderInputBox({ onClick }: { onClick: () => void }) {
  return (
    <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4">
      <div className="flex items-center justify-between">
        <span className="text-2xl font-medium leading-tight text-arc-text-faint sm:text-3xl">0.0</span>
        <button type="button"
          onClick={onClick}
          className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-arc-surface-3"
        >
          <span>Select a token</span>
          <ChevronDown className="h-4 w-4 text-arc-text-muted transition-transform group-hover:text-arc-text" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-arc-text-faint">
        <span>$-</span>
        <span>-</span>
      </div>
    </div>
  );
}

const OutputBox = memo(function OutputBox({
  token,
  amountStr,
  onTokenClick,
  breakdown,
}: {
  token: TokenOption | null;
  amountStr: string;
  onTokenClick: () => void;
  breakdown: { label: string; outStr: string }[];
}) {
  return (
    <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-arc-text-muted">For (Estimated)</span>
        <button type="button"
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
      {breakdown.length > 1 && (
        <div className="mb-2 space-y-0.5 text-xs text-arc-text-muted">
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5 tabular-nums">
              <span className="text-arc-text">{b.label}</span>
              <span className="opacity-60">&rarr;</span>
              <span>{b.outStr}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className={cn(
          "min-w-0 overflow-x-auto whitespace-nowrap font-medium leading-tight tabular-nums text-arc-text",
          outputSizeClass(amountStr || "0.0"),
        )}
      >
        {amountStr || "0.0"}
      </div>
    </div>
  );
});

/**
 * Step the output font size down as the rendered amount grows. Mirrors
 * `sizeFromLength` in AmountInput so the output box never overflows the
 * card when a small input swaps to a 1e18-precision token (eg 27,917
 * full-decimals TEST). The whitespace-nowrap + overflow-x-auto on the
 * parent gives the user a horizontal scroll as a last resort below
 * text-base.
 */
function outputSizeClass(s: string): string {
  const n = s.length;
  if (n <= 10) return "text-4xl";
  if (n <= 16) return "text-3xl";
  if (n <= 22) return "text-2xl";
  if (n <= 28) return "text-xl";
  return "text-base";
}

// QuickButton lives in components/swap/QuickButton (audit item 8).

// SlippagePopover replaced by shared TransactionSettings (audit item 8).

// ===== Helpers =====

function formatTokenAmount(raw: bigint, decimals: number, fraction: number = 6): string {
  if (decimals === USDC_DECIMALS) return formatUSDC(raw, decimals, fraction);
  return formatToken(raw, decimals, fraction);
}

function shortSym(tokenAddr: Address, rows: InputRow[]): string {
  const row = rows.find((r) => r.token.address.toLowerCase() === tokenAddr.toLowerCase());
  return row?.token.symbol ?? "token";
}

/** Mirrors AmountInput's sizeFromLength but tuned slightly larger because
 *  the MultiSwap inputs sit in a wider column on desktop. The mobile vs
 *  desktop split is folded in here: small base sizes on phones, the full
 *  3xl reserved for short values on desktop. */
function multiInputSize(s: string): string {
  const n = (s ?? "").length;
  if (n <= 8) return "text-2xl sm:text-3xl";
  if (n <= 12) return "text-xl sm:text-2xl";
  if (n <= 16) return "text-lg sm:text-xl";
  return "text-base sm:text-lg";
}
