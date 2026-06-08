"use client";

import { ChevronDown, Plus } from "lucide-react";
import { CrossIcon, DownArrowBigIcon } from "@/components/ui/MaskIcon";
import { useEffect, useMemo, useRef, useState } from "react";
import { Address, erc20Abi, formatUnits, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
} from "wagmi";
import { MULTISWAP_ABI } from "@/lib/abis/multiSwap";
import { ADDRESSES, MULTISWAP_MAX_INPUTS, USDC_DECIMALS } from "@/lib/constants";
import { TransactionSettings } from "@/components/ui/TransactionSettings";
import { QuickButton } from "@/components/swap/QuickButton";
import { useV2Tokens } from "@/lib/hooks/useV2Tokens";
import { useV3Tokens } from "@/lib/hooks/useV3Tokens";
import { V3_QUOTER_ABI } from "@/lib/abis/v3";
import { pushToast } from "@/lib/toast";
import { addActivity } from "@/lib/activityFeed";
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
const DEFAULT_BPS = 10;

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
  const { tokens: v3Tokens, isV3Token, feeOf } = useV3Tokens();
  const { writeContractAsync } = useWriteContract();

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
    const out: { token: Address; amount: bigint }[] = [];
    for (const row of inputs) {
      const decimals = row.token.decimals ?? 18;
      try {
        if (!row.amountStr) continue;
        const raw = parseUnits(row.amountStr, decimals);
        if (raw === 0n) continue;
        out.push({ token: row.token.address, amount: raw });
      } catch {
        /* swallow parse error */
      }
    }
    return out;
  }, [inputs]);

  const quoteQ = useReadContract({
    address: ADDRESSES.multiSwap,
    abi: MULTISWAP_ABI,
    functionName: "quoteSwapToSingle",
    args:
      outputToken && tupleArgs.length > 0
        ? [tupleArgs, outputToken.address]
        : undefined,
    query: { enabled: !!outputToken && tupleArgs.length > 0 },
  });
  const quoteData = quoteQ.data as readonly [bigint, readonly bigint[]] | undefined;

  // The contract's quoteSwapToSingle returns 0 for legs that touch a V3
  // Clanker token (the comment in the contract spells this out: V3 routes
  // need a separate quoter call, UI fills in). We fan out a V3 quoter call
  // per leg whose input OR output is a V3 token, and merge the results
  // into the totals below.
  const v3QuoteContracts = useMemo(() => {
    if (!outputToken) return [] as const;
    const out: {
      address: Address;
      abi: typeof V3_QUOTER_ABI;
      functionName: "quoteExactInputSingle" | "quoteExactInputThroughUsdc";
      args: readonly [Address, Address, number, bigint];
    }[] = [];
    for (const t of tupleArgs) {
      const inIsV3 = isV3Token(t.token);
      const outIsV3 = isV3Token(outputToken.address);
      if (!inIsV3 && !outIsV3) {
        out.push(null as never); // placeholder so indices line up with tupleArgs
        continue;
      }
      const v3Token = inIsV3 ? t.token : outputToken.address;
      const fee = feeOf(v3Token);
      const isUsdcHop =
        t.token.toLowerCase() === ADDRESSES.usdc.toLowerCase() ||
        outputToken.address.toLowerCase() === ADDRESSES.usdc.toLowerCase();
      out.push({
        address: ADDRESSES.v3Quoter,
        abi: V3_QUOTER_ABI,
        functionName: isUsdcHop
          ? ("quoteExactInputSingle" as const)
          : ("quoteExactInputThroughUsdc" as const),
        args: [t.token, outputToken.address, fee, t.amount],
      });
    }
    return out;
  }, [tupleArgs, outputToken, isV3Token, feeOf]);

  const v3QuoteCalls = useReadContracts({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: v3QuoteContracts.filter(Boolean) as any,
    query: {
      enabled:
        ADDRESSES.v3Quoter !== "0x0000000000000000000000000000000000000000" &&
        v3QuoteContracts.some((c) => !!c),
    },
  });

  // Merge: for each leg, prefer the V3 quoter result when this leg involves
  // a V3 token, otherwise use the contract's perInput value.
  const mergedQuote = useMemo(() => {
    const per = quoteData?.[1];
    const v3Results = v3QuoteCalls.data;
    let total = 0n;
    const perOut: bigint[] = [];
    let v3Cursor = 0;
    for (let i = 0; i < tupleArgs.length; i++) {
      const v3Spec = v3QuoteContracts[i];
      if (v3Spec) {
        const r = v3Results?.[v3Cursor];
        v3Cursor += 1;
        const v3Amount =
          r?.status === "success" ? ((r.result as bigint) ?? 0n) : 0n;
        perOut.push(v3Amount);
        total += v3Amount;
      } else {
        const fallback = per?.[i] ?? 0n;
        perOut.push(fallback);
        total += fallback;
      }
    }
    return { total, perOut };
  }, [quoteData, v3QuoteCalls.data, v3QuoteContracts, tupleArgs.length]);

  const totalOutRaw: bigint = mergedQuote.total;
  // Note: `perInput` indexes into `tupleArgs`, not `inputs` (zero-amount rows were filtered).
  // We re-map back so each visible row knows its contribution.
  const perRowOut: (bigint | undefined)[] = useMemo(() => {
    const per = mergedQuote.perOut;
    if (per.length === 0) return inputs.map(() => undefined);
    const out: (bigint | undefined)[] = [];
    let cursor = 0;
    for (const row of inputs) {
      try {
        const raw = row.amountStr ? parseUnits(row.amountStr, row.token.decimals ?? 18) : 0n;
        if (raw === 0n) out.push(undefined);
        else {
          out.push(per[cursor]);
          cursor += 1;
        }
      } catch {
        out.push(undefined);
      }
    }
    return out;
  }, [inputs, mergedQuote.perOut]);

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
    !quoteQ.isFetching &&
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
  const removeRow = (i: number) =>
    setInputs((prev) => prev.filter((_, idx) => idx !== i));
  const setRowAmount = (i: number, v: string) =>
    setInputs((prev) => prev.map((row, idx) => (idx === i ? { ...row, amountStr: v } : row)));

  // ----- Execute -----
  const onSwap = async () => {
    if (!account || !outputToken || tupleArgs.length === 0) return;
    setTx({ status: "pending", message: "Checking approvals…" });
    try {
      // Approve each input token to the multi-swap contract if needed.
      for (let i = 0; i < tupleArgs.length; ++i) {
        const t = tupleArgs[i];
        const allowance = (await publicClient!.readContract({
          address: t.token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, ADDRESSES.multiSwap],
        })) as bigint;
        if (allowance < t.amount) {
          setTx({ status: "pending", message: `Approving ${shortSym(t.token, inputs)} (${i + 1}/${tupleArgs.length})…` });
          const approveHash = await writeContractAsync({
            address: t.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [ADDRESSES.multiSwap, maxUint256],
          });
          await publicClient!.waitForTransactionReceipt({ hash: approveHash });
        }
      }
      setTx({ status: "pending", message: "Submitting multi-swap…" });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const hash = await writeContractAsync({
        address: ADDRESSES.multiSwap,
        abi: MULTISWAP_ABI,
        functionName: "swapToSingle",
        args: [tupleArgs, outputToken.address, minTotalOut, deadline],
      });
      await publicClient!.waitForTransactionReceipt({ hash });
      setTx({ status: "idle" });
      setInputs([]);
      balanceCalls.refetch();
      const outFormatted = formatTokenAmount(totalOutRaw, decimalsOut, 6);
      addActivity({
        type: tupleArgs.length > 1 ? "multiswap" : "swap",
        account,
        token: outputToken.address,
        label: tupleArgs.length > 1
          ? `Multi-swap to $${outputToken.symbol}`
          : `Swapped to $${outputToken.symbol}`,
        value: `${outFormatted} ${outputToken.symbol}`,
        txHash: hash,
      });
      pushToast({
        kind: "swap",
        tokenAddress: outputToken.address,
        tokenSymbol: outputToken.symbol,
        amountFormatted: outFormatted,
      });
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Multi-swap failed" });
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
              row={row}
              balance={balancesRaw[i] ?? 0n}
              insufficient={insufficientByIndex[i]}
              onAmountChange={(v) => setRowAmount(i, v)}
              onRemove={() => removeRow(i)}
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
          <DownArrowBigIcon size={18} className="bg-white" />
        </span>
      </div>

      {/* Output box */}
      <OutputBox
        token={outputToken}
        amountStr={outputAmountStr}
        onTokenClick={() => setPickerOpen("output")}
      />

      {/* Status line */}
      {hasAnyAmount && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="text-arc-text-muted">
            {quoteQ.isFetching ? (
              <span>Fetching prices…</span>
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
                  : quoteQ.isFetching
                    ? "Fetching prices…"
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

function InputBox({
  row,
  balance,
  insufficient,
  onAmountChange,
  onRemove,
}: {
  row: InputRow;
  balance: bigint;
  insufficient: boolean;
  onAmountChange: (v: string) => void;
  onRemove: () => void;
}) {
  const decimals = row.token.decimals ?? 18;
  const balLabel =
    decimals === USDC_DECIMALS ? formatUSDC(balance, decimals, 2) : formatToken(balance, decimals, 4);

  return (
    <div
      className={cn(
        "group relative rounded-2xl border bg-white/[0.015] p-4 transition-colors focus-within:border-arc-border-strong",
        insufficient ? "border-arc-danger/50" : "border-arc-border",
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
            onAmountChange(v);
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
            onClick={onRemove}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-arc-surface-2/60 text-arc-text-muted opacity-70 transition-all hover:bg-arc-danger/20 hover:text-arc-danger hover:opacity-100 sm:h-6 sm:w-6"
            title="Remove this token"
          >
            <CrossIcon size={12} />
          </button>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className={cn("tabular-nums", insufficient ? "text-arc-danger" : "text-arc-text-muted")}>
          {balLabel} {row.token.symbol}
        </span>
        <div className="flex items-center gap-1.5">
          <QuickButton
            onClick={() => onAmountChange(formatUnits(balance / 2n, decimals))}
            disabled={balance === 0n}
          >
            HALF
          </QuickButton>
          <QuickButton
            onClick={() => onAmountChange(formatUnits(balance, decimals))}
            disabled={balance === 0n}
          >
            MAX
          </QuickButton>
        </div>
      </div>
    </div>
  );
}

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

function OutputBox({
  token,
  amountStr,
  onTokenClick,
}: {
  token: TokenOption | null;
  amountStr: string;
  onTokenClick: () => void;
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
}

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
