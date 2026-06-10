"use client";

import { ArrowDownUp, ChevronDown } from "lucide-react";
import Image from "next/image";
import { useRef } from "react";
import { useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useReadContracts, useWriteContract, usePublicClient } from "wagmi";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V3_QUOTER_ABI, V3_ROUTER_ABI } from "@/lib/abis/v3";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { TransactionSettings } from "@/components/ui/TransactionSettings";
import { QuickButton } from "@/components/swap/QuickButton";
import { useApproveIfNeeded } from "@/lib/hooks/useApproveIfNeeded";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { useUsdValue } from "@/lib/hooks/useTokenUsdPrice";
import { useSwapRoute } from "@/lib/hooks/useSwapRoute";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { AutoTokenIcon } from "@/components/ui/AutoTokenIcon";
import { TokenSelectModal, TokenOption } from "@/components/ui/TokenSelectModal";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import { SwapConfirmModal } from "./SwapConfirmModal";
import { SwapTabs, type SwapTab } from "./SwapTabs";
import { V4RoutingNotice } from "./V4RoutingNotice";
import { SwapRoutes } from "./SwapRoutes";
import { useRouteQuotes } from "@/lib/routing/useRouteQuotes";
import type { RouteQuote } from "@/lib/routing/types";
import {
    usePermit2Approval,
    usePermit2AllowanceFor,
    useSignPermit2,
} from "@/lib/permit2";
import { encodePermit2PermitInput } from "@/lib/routing/universalRouter";
import { cn, formatToken, formatUSDC } from "@/lib/utils";

const USDC_TOKEN: TokenOption = {
  address: ADDRESSES.usdc,
  symbol: "USDC",
  name: "USD Coin",
  decimals: USDC_DECIMALS,
  pinned: true,
};

// EURC used to be pinned here. Audit 2026-06-06 flagged that it carried a
// hardcoded $1.08 price (useTokenPrices.ts), which surfaced as a fake quote
// in the swap dropdown. EURC is unlisted until a real EUR/USD feed lands.

const PRESETS_BPS = [10, 50, 100];
const DEFAULT_BPS = 10;

type Side = "in" | "out";

interface SwapCardProps {
  /** Active tab - used by the in-card tab strip in the header. */
  tab: SwapTab;
  onTabChange: (t: SwapTab) => void;
}

export function SwapCard({ tab, onTabChange }: SwapCardProps) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { tokens: v2Tokens } = useV2Tokens();
  const { tokens: v3Tokens, isV3Token, feeOf } = useV3Tokens();
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

  // Audit high [4]/[8]: a fallback of 18 here would mis-scale parseUnits /
  // formatUnits / minOut by up to 10^12 for any non-hardcoded 6-decimal
  // token. We treat decimals as MANDATORY; if the producer (useV2Tokens,
  // TokenSelectModal, etc.) handed us a TokenOption without decimals, we
  // refuse to render a quote. The disabled CTA + cleared input downstream
  // protect the user from signing a wrongly-scaled swap.
  const decimalsKnown = tokenIn.decimals !== undefined && (!tokenOut || tokenOut.decimals !== undefined);
  const decimalsIn = tokenIn.decimals ?? 0;
  const decimalsOut = tokenOut?.decimals ?? 0;

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
  // V3<->V2 (non-USDC) can't route in one router call - flag as unsupported.
  const v3Unsupported = isV3Swap && !v3DoubleHop && !v3SingleHop;

  // Forward-quote ratio cache: captured every time an in->out quote returns
  // a non-zero result so we can back-derive amountIn when the user types
  // into the For field on a path that has no exact-output quote (V3 single
  // direction quoter, launchpad-routed multi-hops). Keeps the For field
  // editable instead of snapping back to the computed quote.
  const lastForwardRatioRef = useRef<{ amountIn: bigint; amountOut: bigint } | null>(null);

  // Fee tier of the V3 leg (the non-USDC side's pool). Both-V3 uses tokenIn's.
  const v3Fee = inIsV3 ? feeOf(tokenIn.address) : feeOf(tokenOut?.address);

  // Anti-sniper tax: on a USDC→V3-token buy the router skims a decaying % of
  // the input before swapping. Read the live rate so the quote reflects the
  // post-tax amount (otherwise the displayed output overshoots and the swap
  // trips slippage). Only buys (USDC in, single hop) are taxed.
  const isSnipeBuy = isUsdcIn && outIsV3 && !v3DoubleHop;
  const snipeBpsQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "currentSnipeBps",
    args: isSnipeBuy && tokenOut ? [tokenOut.address] : undefined,
    query: { enabled: isSnipeBuy && !!tokenOut },
  });
  const snipeBps: bigint = (isSnipeBuy ? (snipeBpsQ.data as bigint | undefined) : undefined) ?? 0n;
  // Amount the router actually swaps after the skim.
  const v3NetAmountIn = amountInRaw - (amountInRaw * snipeBps) / 10_000n;

  // V3 quote (exact-in). Single-hop or 2-hop-through-USDC depending on the pair.
  const quoteV3 = useReadContract({
    address: ADDRESSES.v3Quoter,
    abi: V3_QUOTER_ABI,
    functionName: v3DoubleHop ? "quoteExactInputThroughUsdc" : "quoteExactInputSingle",
    args:
      isV3Swap && !v3Unsupported && tokenOut && v3NetAmountIn > 0n
        ? [tokenIn.address, tokenOut.address, v3Fee, v3NetAmountIn]
        : undefined,
    query: { enabled: isV3Swap && !v3Unsupported && !!tokenOut && v3NetAmountIn > 0n },
  });
  const v3AmountOut = quoteV3.data as bigint | undefined;

  // V2 router quotes - used for direct routes and as the input estimator for
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

  // Launchpad-router quote - accounts for the post-migration royalty on each
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
  const legacyComputedAmountOut = isV3Swap
    ? v3AmountOut
    : route.useLaunchpadRouter
      ? migratedQuote?.[0]
      : amountsOut?.[amountsOut.length - 1];

  // Multi-DEX route comparison: fan out the same QuoteRequest to every
  // RouteProvider registered in lib/routing/. Each one returns an
  // independent quote + executor; quotes[] is sorted by amountOut desc.
  // Phase 1 (current): purely display. The SwapCard's existing quote
  // pipeline above still drives execution. Phase 2 will wire the active
  // route's executor into writeContract so a Synthra-best route actually
  // executes through SwapRouter02. Disable on launchpad-router paths
  // (post-migration royalty) because the migrated quoter has its own
  // accounting that the generic V2 provider doesn't reproduce.
  const aggregatorEnabled =
    !route.useLaunchpadRouter && !v3Unsupported && decimalsKnown && amountInRaw > 0n && !!tokenOut && !!account;
  const routeQuotes = useRouteQuotes({
    tokenIn: tokenIn.address,
    tokenOut: tokenOut?.address,
    decimalsIn,
    decimalsOut,
    amountIn: amountInRaw,
    recipient: account,
    slippageBps,
    enabled: aggregatorEnabled,
  });
  const [selectedRoute, setSelectedRoute] = useState<RouteQuote | undefined>(undefined);
  // Reset the user's manual pick only when the token PAIR changes (a new
  // pair always has its own provider set). We do NOT reset on amountIn
  // changes — that would wipe the user's selection every single
  // keystroke (audit finding R-3). Instead, watch the live quotes list:
  // if the selected provider drops out (e.g. amount went above its
  // available liquidity), fall back to the auto-best on next render.
  useEffect(() => {
    setSelectedRoute(undefined);
  }, [tokenIn.address, tokenOut?.address]);
  useEffect(() => {
    if (!selectedRoute) return;
    const stillPresent = routeQuotes.quotes.some(
      (q) => q.provider === selectedRoute.provider,
    );
    if (!stillPresent) setSelectedRoute(undefined);
  }, [selectedRoute, routeQuotes.quotes]);

  // The currently-active route: either the user's manual pick or the
  // aggregator's auto-picked best. When non-null and the provider is
  // external (Synthra / UnitFlow / future XyloNet), the SwapCard wires
  // the route's pre-built executor into the writeContract path and
  // takes amountOut directly from it. Arcade routes keep the legacy
  // pipeline since the existing V3/V2 quote + writeContract already
  // handle them (anti-sniper tax, launchpad multi-hop, etc).
  const activeRoute: RouteQuote | null = selectedRoute ?? routeQuotes.best ?? null;
  const isExternalRoute =
    !!activeRoute &&
    (activeRoute.provider === "synthra-v3" ||
      activeRoute.provider === "unitflow-v3" ||
      activeRoute.provider === "xylonet-v1");

  // computedAmountOut drives the For field. When an external route is
  // active, override with its amountOut so the user sees Synthra's /
  // UnitFlow's real number even when the legacy Arcade quoter returns 0
  // (no Arcade pool exists). Arcade routes use the legacy value as-is.
  const computedAmountOut: bigint | undefined = isExternalRoute
    ? activeRoute!.amountOut
    : legacyComputedAmountOut;

  // Capture the latest forward (in->out) ratio whenever it lands. Stays in
  // a ref so future renders that toggle lastEdited still see the last known
  // price and can derive amountIn from a user-typed amountOut without
  // having to fire a new quote.
  useEffect(() => {
    if (lastEdited === "in" && amountInRaw > 0n && computedAmountOut && computedAmountOut > 0n) {
      lastForwardRatioRef.current = { amountIn: amountInRaw, amountOut: computedAmountOut };
    }
  }, [computedAmountOut, amountInRaw, lastEdited]);

  // Derived amountIn for paths where V2 getAmountsIn does not run (V3 quoter
  // is in-only, launchpad-routed multi-hops). Uses the cached forward ratio
  // so the user's For input drives From in real time, matching V2 behavior.
  const derivedAmountIn = useMemo<bigint | undefined>(() => {
    if (lastEdited !== "out") return undefined;
    if (amountOutRawTyped === 0n) return undefined;
    const r = lastForwardRatioRef.current;
    if (!r || r.amountOut === 0n) return undefined;
    return (amountOutRawTyped * r.amountIn) / r.amountOut;
  }, [lastEdited, amountOutRawTyped]);

  const computedAmountIn = amountsIn?.[0] ?? derivedAmountIn;
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
  // Audit A-3: batch the two balanceOf reads via Multicall3 (wired in
  // arcTestnet chain config). Single eth_call instead of two parallel
  // RPC roundtrips — meaningful on Arc's public RPC. Falls back to
  // independent calls on chains without multicall3 (anvil local).
  const balances = useReadContracts({
    contracts: [
      {
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
      },
      {
        address: tokenOut?.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: account ? [account] : undefined,
      },
    ],
    query: { enabled: !!account && !!tokenIn.address && !!tokenOut },
  });
  const balanceIn = { data: balances.data?.[0]?.result as bigint | undefined, refetch: balances.refetch };
  const balanceOut = { data: balances.data?.[1]?.result as bigint | undefined, refetch: balances.refetch };
  const balInRaw = balanceIn.data ?? 0n;
  const balOutRaw = balanceOut.data ?? 0n;

  // USD values
  const inUsd = useUsdValue(tokenIn.address, finalAmountIn, decimalsIn);
  const outUsd = useUsdValue(tokenOut?.address, finalAmountOut, decimalsOut);

  // Fee depends on the route. Normalize everything to PIPS (1_000_000 = 100%):
  //   - V2 fee 0.30% = 3_000 pips
  //   - V3 fee tier comes from feeOf() already in pips (10_000 = 1%)
  //   - swapMigratedRoute: V2 fee on each leg + 0.30% royalty per migrated side
  const feePips: bigint = (() => {
    if (isV3Swap) return BigInt(v3Fee);
    if (route.useLaunchpadRouter) {
      // 2 V2 legs (3_000 pips each) + 3_000 pips per migrated side (royalty).
      let pips = 6_000n;
      if (route.inMigrated) pips += 3_000n;
      if (route.outMigrated) pips += 3_000n;
      return pips;
    }
    return 3_000n; // plain V2
  })();
  const feeRaw = (finalAmountIn * feePips) / 1_000_000n;
  const feeFormatted = formatTokenAmount(feeRaw, decimalsIn);
  const feePct = Number(feePips) / 10_000;
  const feePctLabel = `${feePct.toFixed(feePct < 1 ? 2 : 1)}%`;
  // Total loss % includes price impact + AMM fee (already baked into out amount)
  const lossPct =
    inUsd.usd !== undefined && outUsd.usd !== undefined && inUsd.usd > 0
      ? ((outUsd.usd - inUsd.usd) / inUsd.usd) * 100
      : undefined;

  // Pick the spender to approve based on the route. For external
  // UR + Permit2 routes the user-facing approval is to Permit2 (one
  // time, max) rather than to the route's router directly. For everything
  // else (Arcade V2/V3, launchpad, XyloNet), classic ERC20 approve to
  // the route's router.
  const usesPermit2 = isExternalRoute && !!activeRoute?.permit2;
  const swapSpender = isExternalRoute
    ? activeRoute!.approval.spender
    : isV3Swap
      ? ADDRESSES.v3Router
      : route.useLaunchpadRouter
        ? ADDRESSES.launchpad
        : ADDRESSES.router;
  const { ensureAllowance } = useApproveIfNeeded(tokenIn.address, swapSpender);

  // Permit2 wiring. Always runs (cheap reads) so the hook order stays
  // stable across renders even when the user toggles between Permit2
  // and classic routes.
  const permit2Approval = usePermit2Approval(tokenIn.address, finalAmountIn);
  const permit2Allowance = usePermit2AllowanceFor(
    tokenIn.address,
    activeRoute?.permit2?.permitSpender,
  );
  const signPermit2 = useSignPermit2();

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
      : "-";
  const exactIn = lastEdited === "in";
  const guardKey = exactIn ? "Min. received" : "Max. sent";
  const guardLabel = exactIn
    ? `${formatTokenAmount(minOut, decimalsOut, 6)} ${symOut}`
    : `${formatTokenAmount(maxIn, decimalsIn, 6)} ${symIn}`;

  // External routes (Synthra / UnitFlow / XyloNet) come from the
  // aggregator's parallel fan-out. When one of them has already returned
  // a non-zero quote, the swap is ready to execute — even if a legacy
  // Arcade V3 / V2 quoter is still in-flight. Showing "Fetching price…"
  // for an extra 5 s while Synthra has already priced the trade was the
  // bug the user reported on the routes panel screenshot.
  const externalReady = isExternalRoute && !!activeRoute && activeRoute.amountOut > 0n;
  const fetching =
    !externalReady &&
    (quoteOut.isFetching ||
      quoteIn.isFetching ||
      quoteMigratedOut.isFetching ||
      quoteV3.isFetching);
  const canSwap =
    !!account &&
    !!tokenOut &&
    !v3Unsupported &&
    // Audit high [4]/[8]: never sign with unknown decimals — the entire
    // amount/min math would be off by a factor of 10^(realDec - 18).
    decimalsKnown &&
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
      // Permit2-backed external routes (Synthra UR, UnitFlow UR) need a
      // one-time max approve to Permit2 instead of per-router approves.
      // After that, the per-swap "approval" is an off-chain EIP-712 sig
      // the user signs once per swap and we bake into the executor args.
      // Non-Permit2 routes (Arcade V2/V3, XyloNet, UnitFlow WRAP_ETH
      // variant where USDC is paid via msg.value) still use the legacy
      // ensureAllowance path.
      if (usesPermit2 && activeRoute) {
        if (permit2Approval.needsApproval) {
          setTx({ status: "pending", message: "Approving Permit2 (one-time)…" });
          await permit2Approval.approve();
        }
      } else if (
        activeRoute?.executor.value &&
        activeRoute.executor.value > 0n
      ) {
        // WRAP_ETH variant — no ERC20 allowance needed, value is sent
        // with the tx. Skip ensureAllowance entirely.
      } else {
        await ensureAllowance(exactIn ? finalAmountIn : maxIn);
      }
      setTx({ status: "pending", message: "Submitting swap…" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      let hash: `0x${string}`;
      if (isExternalRoute && activeRoute) {
        // Route the swap through the selected provider's pre-built
        // executor. For UniversalRouter + Permit2 routes we (a) prompt
        // the user to sign the PermitSingle, (b) inject the signed
        // permit into the executor args at the index the provider
        // declared, (c) call execute(). For non-Permit2 externals
        // (XyloNet, UnitFlow WRAP_ETH variant) we call the executor
        // as-is.
        let execArgs = activeRoute.executor.args;
        const p2 = activeRoute.permit2;
        if (p2) {
          setTx({ status: "pending", message: "Signing Permit2…" });
          const { permit, signature } = await signPermit2({
            token: tokenIn.address,
            spender: p2.permitSpender,
            amount: finalAmountIn,
          });
          const encodedPermit = encodePermit2PermitInput(permit, signature);
          // executor.args = [commands, inputs[], deadline]. Clone the
          // inputs[] and rewrite the permit slot. Audit MED-7: bounds-
          // check the index so a misconfigured provider does not silently
          // extend the array with `undefined` (which would ABI-encode
          // as a default value and revert at exec time).
          const inputs = [...(execArgs[1] as `0x${string}`[])];
          if (p2.permitInputIndex < 0 || p2.permitInputIndex >= inputs.length) {
            throw new Error(
              `Provider ${activeRoute.provider} configured an invalid permitInputIndex ${p2.permitInputIndex} for an inputs array of length ${inputs.length}`,
            );
          }
          inputs[p2.permitInputIndex] = encodedPermit;
          execArgs = [execArgs[0], inputs, execArgs[2]];
          setTx({ status: "pending", message: "Submitting swap…" });
        }
        hash = await writeContractAsync({
          address: activeRoute.executor.router,
          abi: activeRoute.executor.abi,
          functionName: activeRoute.executor.functionName,
          args: execArgs,
          value: activeRoute.executor.value,
        });
      } else if (isV3Swap) {
        // CLANKER_V3 token: trade on the V3 pool via our V3 router. Exact-in
        // only (the effect above forces lastEdited="in"). Single hop if one
        // side is USDC, else 2-hop through USDC.
        hash = await writeContractAsync({
          address: ADDRESSES.v3Router,
          abi: V3_ROUTER_ABI,
          functionName: v3DoubleHop ? "exactInputThroughUsdc" : "exactInputSingle",
          // Audit low [5]: the V3 router's exactInputThroughUsdc now takes
          // a usdcMidMin so the mid-leg slippage is bounded independently
          // of the final amountOutMinimum. We pass 0 for now (no extra
          // bound) on the front-end; backend sandwich defence sits in the
          // amountOutMinimum + USDC blocklist. Tightening this to a real
          // mid-quote derived from the V3 quoter is the next iteration.
          args: v3DoubleHop
            ? [tokenIn.address, tokenOut.address, v3Fee, account, finalAmountIn, minOut, 0n, deadline]
            : [tokenIn.address, tokenOut.address, v3Fee, account, finalAmountIn, minOut, deadline],
        });
      } else if (route.useLaunchpadRouter) {
        // Multi-hop through the launchpad's router so post-migration royalties
        // are charged on each leg whose token is a migrated launchpad token.
        // Only exact-in is supported; the effect above forces lastEdited="in".
        // Deadline param added in audit fixes (Medium #6).
        hash = await writeContractAsync({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "swapMigratedRoute",
          args: [tokenIn.address, tokenOut.address, finalAmountIn, minOut, deadline],
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
      // Audit high [26]: viem's waitForTransactionReceipt returns a
      // receipt for BOTH success and revert. Without an explicit status
      // check the swap path used to clear the form, push a green toast,
      // and record an activity entry for a tx that did nothing on-chain.
      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(
            `Swap reverted on-chain (tx ${hash.slice(0, 10)}…). Common causes: slippage too tight, deadline passed, pool ratio moved between read and exec.`,
          );
        }
      }

      // Close the modal immediately and push a toast notification instead
      setConfirmOpen(false);
      setTx({ status: "idle" });
      setAmountInStr("");
      setAmountOutStr("");
      balanceIn.refetch();
      balanceOut.refetch();

      const outFormatted = formatTokenAmount(finalAmountOut, decimalsOut, 6);
      if (account) {
        addActivity({
          type: "swap",
          account,
          token: tokenOut.address,
          label: `Swapped to $${tokenOut.symbol}`,
          value: `${outFormatted} ${tokenOut.symbol}`,
          txHash: hash,
        });
      }
      pushToast({
        kind: "swap",
        tokenAddress: tokenOut.address,
        tokenSymbol: tokenOut.symbol,
        amountFormatted: outFormatted,
      });
    } catch (e: unknown) {
      // Deep-dig the viem error chain so a real revert reason surfaces
      // (cause.reason -> shortMessage -> details -> message).
      const o = e as Record<string, unknown> | null;
      const reason =
        o && typeof o === "object"
          ? ((o.cause as Record<string, unknown> | undefined)?.reason as string | undefined) ??
            (o.shortMessage as string | undefined) ??
            (o.details as string | undefined) ??
            (o.message as string | undefined)
          : undefined;
      const msg = reason || (e instanceof Error ? e.message : "Swap failed");
      setTx({ status: "error", message: msg.slice(0, 200) });
      pushToast({ kind: "error", title: "Swap failed", message: msg.slice(0, 200) });
    }
  };

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
                setAmountInStr(toOneDecimal(balInRaw / 2n, decimalsIn));
              }
            : undefined
        }
        onMax={
          account && balInRaw > 0n
            ? () => {
                setLastEdited("in");
                setAmountInStr(toOneDecimal(balInRaw, decimalsIn));
              }
            : undefined
        }
      />

      {/* Flip button overlapping both */}
      <div className="relative z-10 -my-2 flex justify-center">
        <button type="button"
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
        feeLabel={
          // External routes (Synthra / UnitFlow) carry their own LP fee
          // inside the quote, so showing our Arcade V2 / V3 fee math here
          // would double-count and confuse the user. Only show the fee
          // hint on Arcade-routed swaps.
          !isExternalRoute && feeRaw > 0n
            ? `Fee ${feePctLabel} (${feeFormatted} ${tokenIn.symbol ?? "TOKEN"})`
            : undefined
        }
      />

      {/* V4 tokens trade on a separate pool the V2/V3 aggregator can't
          reach yet - nudge the user to the V4 swap panel instead. */}
      <V4RoutingNotice tokenIn={tokenIn.address} tokenOut={tokenOut?.address} />

      {/* Cross-protocol (V3<->V2) routes can't execute in one tx. */}
      {v3Unsupported && (
        <div className="mt-3 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-2 text-xs text-arc-warn">
          Route through USDC: swap {symIn} → USDC, then USDC → {symOut} separately. Direct{" "}
          {symIn}→{symOut} mixes a V3 and a V2 pool, which isn&apos;t supported in one swap yet.
        </div>
      )}

      {/* Active anti-sniper tax on this buy (decays to 0 shortly after launch). */}
      {snipeBps > 0n && amountInRaw > 0n && (
        <div className="mt-3 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-2 text-xs text-arc-warn">
          Anti-sniper tax active: {(Number(snipeBps) / 100).toFixed(1)}% (
          {formatUSDC((amountInRaw * snipeBps) / 10_000n, USDC_DECIMALS, 2)} USDC) is skimmed from this
          buy and decays to 0 shortly after launch.
        </div>
      )}

      {/* Route + rate row (between For box and Swap button). Hidden on
          external routes — the SwapRoutes panel renders the route info
          (Synthra V3 / UnitFlow V3) right under the swap button, so
          repeating the "via Arcade V3" caption would be wrong and noisy. */}
      {!isExternalRoute && finalAmountIn > 0n && finalAmountOut > 0n && tokenOut && (
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

      {/* Multi-DEX routes comparison. Auto-picks the best, user can tap
          a row to override. usdPricePerOut is derived from Arcade's USDC
          pool when available; for tokens with no Arcade pool (EURC, USDT,
          cirBTC), fall back to deriving it from the trade itself (inUsd
          / out tokens) — anchors the display USD value to the input USD
          even when no spot oracle is reachable. */}
      {aggregatorEnabled && tokenOut && (
        <SwapRoutes
          quotes={routeQuotes.quotes}
          loading={routeQuotes.loading}
          selected={selectedRoute ?? routeQuotes.best ?? undefined}
          onSelect={(q) => setSelectedRoute(q)}
          decimalsOut={decimalsOut}
          symbolOut={symOut}
          usdPricePerOut={
            outUsd.spotUsdPerToken ??
            (inUsd.usd !== undefined &&
            finalAmountOut > 0n &&
            decimalsOut !== undefined
              ? inUsd.usd / (Number(finalAmountOut) / Math.pow(10, decimalsOut))
              : undefined)
          }
        />
      )}

      <button type="button"
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
          inputUsd={inUsd.usd}
          outputUsd={outUsd.usd}
          protocolLabel={
            // When an external route wins, the confirm screen has to
            // reflect that — otherwise the user signs a Synthra tx but
            // reads "Arcade V2", which is a UX trust hit and an audit
            // finding (🟡 R-5). Fall back to the legacy label only when
            // the legacy Arcade pipeline is the executor.
            isExternalRoute && activeRoute
              ? activeRoute.provider === "synthra-v3"
                ? "Synthra V3"
                : activeRoute.provider === "unitflow-v3"
                  ? "UnitFlow V3"
                  : activeRoute.provider === "xylonet-v1"
                    ? "XyloNet"
                    : "External"
              : isV3Swap
                ? "Arcade V3"
                : "Arcade V2"
          }
          protocolLogo={
            isExternalRoute && activeRoute
              ? activeRoute.provider === "synthra-v3"
                ? "/synthra.svg"
                : activeRoute.provider === "unitflow-v3"
                  ? "/unitflow.svg"
                  : activeRoute.provider === "xylonet-v1"
                    ? "/xylonet.svg"
                    : undefined
              : undefined
          }
        />
      )}

      {/* Glow ON the card's bottom border. Bright spot AT the border itself,
          halo fades upward into the card. (v3 - confirmed working) */}
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
        <button type="button"
          onClick={onTokenClick}
          className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-2 text-base font-semibold transition-colors hover:bg-arc-surface-3"
        >
          {token ? (
            <>
              <AutoTokenIcon address={token.address} symbol={token.symbol} size={24} />
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
        className="arc-input w-full bg-transparent text-3xl font-medium leading-tight sm:text-4xl"
        aria-label="Amount"
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

// QuickButton + SlippagePopover used to be inline. Both were duplicated
// across SwapCard / LimitCard / MultiSwapCard with ~85% identical code.
// Now QuickButton lives in components/swap/QuickButton and the slippage
// popover is the shared TransactionSettings in components/ui (also used
// by /positions/add). Audit item 8.

// ===== Helpers =====

function formatTokenAmount(raw: bigint, decimals: number, fraction: number = 6): string {
  if (decimals === USDC_DECIMALS) return formatUSDC(raw, decimals, fraction);
  return formatToken(raw, decimals, fraction);
}

/**
 * Round a raw token amount down to 1 decimal place for the HALF / MAX
 * shortcuts. Per user spec: a balance of 30.616254 USDC becomes "30.6"
 * so the input field reads cleanly. Floor (not round) so the resulting
 * amount can never exceed the actual on-chain balance.
 */
function toOneDecimal(raw: bigint, decimals: number): string {
  const asFloat = Number(formatUnits(raw, decimals));
  if (!isFinite(asFloat) || asFloat <= 0) return "0";
  const floored = Math.floor(asFloat * 10) / 10;
  // Sub-decimal balances (eg 0.05) would floor to 0 and break the swap.
  // Fall back to a tighter 4-decimal floor for these edge cases.
  if (floored === 0) return (Math.floor(asFloat * 10_000) / 10_000).toString();
  return floored.toString();
}
