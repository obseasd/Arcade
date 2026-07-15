"use client";

import { ArrowDownUp, ChevronDown, Loader2, CheckCircle2, Pencil } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { encodeAbiParameters, erc20Abi, formatUnits, isAddress, parseUnits, zeroAddress } from "viem";
import { getPublicClient } from "@wagmi/core";
import {
  useAccount,
  useChainId,
  useConfig,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import {
  CCTP_V2_MESSAGE_TRANSMITTER,
  CCTP_V2_TOKEN_MESSENGER,
  CCTP_BUY_RECEIVER_ABI,
  MESSAGE_TRANSMITTER_V2_ABI,
  TOKEN_MESSENGER_V2_ABI,
  addressToBytes32,
  mintRecipientFromMessage,
  fetchAttestation,
  fetchAttestationDetailed,
  getCctpChain,
  parseCctpV2Message,
  isSolanaBridgeId,
  SOLANA_BRIDGE_ID,
  SOLANA_PSEUDO_CHAIN,
} from "@/lib/cctp";
import { Address, type EIP1193Provider } from "viem";
import {
  executeKitBridge,
  getPhantom,
  getSolanaUsdcBalance,
} from "@/lib/fx/bridgeKit";
import { ChainIcon } from "@/components/ui/ChainIcon";
import { ChainSelectModal } from "@/components/ui/ChainSelectModal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { RecipientEditModal } from "./RecipientEditModal";
import { cn, formatAddress, formatUSDC } from "@/lib/utils";
import { ADDRESSES } from "@/lib/constants";
import { TokenSelectModal, type TokenOption } from "@/components/ui/TokenSelectModal";
import { ROUTER_ABI } from "@/lib/abis/dex";
import { V3_QUOTER_ABI } from "@/lib/abis/v3";

/** Feature flag for the CCTP "bridge and buy" flow. On by default; set
 *  NEXT_PUBLIC_BRIDGE_BUY_ENABLED="false" to remove it entirely (clean
 *  fallback to the plain bridge — the toggle simply never renders). */
const BRIDGE_BUY_ENABLED = process.env.NEXT_PUBLIC_BRIDGE_BUY_ENABLED !== "false";
import {
  clearPendingBridge,
  loadPendingBridge,
  recipientForBurn,
  savePendingBridge,
} from "@/lib/pendingBridge";
import {
  BRIDGE_HISTORY_CHANGE_EVENT,
  loadBridgeHistory,
  recordBridge,
  updateBridge,
  updateBridgeByBurnTx,
} from "@/lib/bridgeHistory";
import { BridgeStepsProgress } from "./BridgeStepsProgress";
import { pushToast } from "@/lib/toast";

const ARC_CHAIN_ID = 5_042_002;
const ETH_SEPOLIA_ID = 11_155_111;

/** Arcade fee on bridges. Currently shown as preview only; will be charged
 * on-chain once we deploy the fee router on all source chains for mainnet. */
const ARCADE_BRIDGE_FEE_BPS = 5n; // 0.05%
// Upper bound we authorise Circle to charge for a Fast Transfer. This is a
// CEILING, not the price: Circle only ever takes its published `minimumFee`.
// It MUST stay >= that minimum or the burn cannot be served fast and silently
// degrades to standard finality (slow) despite the user picking Fast.
// Live Iris values into Arc (domain 26): 1bp from Ethereum, but 1.3bp from
// Base and Arbitrum -- the previous 1n bound was BELOW the latter and broke
// fast transfers on those routes. 2bp covers every current route with room;
// the exact price is still whatever Circle charges, attested as `feeExecuted`.
const CCTP_FAST_MAX_FEE_BPS = 2n;

/** The receiver generation this bytes32 mintRecipient belongs to, if any.
 *  Returns its message sizes too: hookData grew across redeploys (96 -> 128 ->
 *  192 bytes), so recognising the ADDRESS is not enough to route the claim --
 *  an allowlist keyed on address alone would admit an old in-flight message
 *  past the gates and then fail to route it, which is worse than rejecting it. */
function receiverFor32(mintRecipient32: string) {
  const target = mintRecipient32.toLowerCase();
  return ADDRESSES.cctpBuyReceivers.find(
    (r) =>
      r.address !== zeroAddress &&
      addressToBytes32(r.address).toLowerCase() === target,
  );
}

function isKnownReceiver32(mintRecipient32: string): boolean {
  return !!receiverFor32(mintRecipient32);
}
const BPS_DENOMINATOR = 10_000n;

/** Formats an elapsed-second count like "1m 24s" or "47s". Used by the
 *  attestation step's "Still waiting" indicator. */
function formatElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Human-readable ETA per source chain. Ethereum Sepolia waits for 2 epochs of finality. */
function etaLabel(srcChainId: number, fast: boolean): string {
  if (fast) return "~10-30s";
  switch (srcChainId) {
    case 11_155_111: // Ethereum Sepolia - 2 epochs ≈ 13-19 min
      return "~15-20 min";
    case 84_532: // Base Sepolia
    case 421_614: // Arbitrum Sepolia
    case 11_155_420: // OP Sepolia
      return "~1-3 min";
    case 43_113: // Avalanche Fuji
      return "~30-60s";
    case 5_042_002: // Arc Testnet
      return "~30-60s";
    default:
      return "~1-3 min";
  }
}

type Step =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "burning" }
  | { kind: "attesting"; burnTxHash: `0x${string}`; srcDomain: number; dstId: number }
  | {
      kind: "minting";
      burnTxHash: `0x${string}`;
      message: `0x${string}`;
      attestation: `0x${string}`;
      dstId: number;
    }
  | { kind: "done"; mintTxHash: `0x${string}`; dstId: number }
  | { kind: "error"; message: string };

/**
 * Upper-bound on how long Circle's attestation can take per source
 * chain. Beyond this we tell the user we're still polling. Module-scope
 * so it's not rebuilt on every BridgeCard render.
 */
function expectedAttestUpperSec(srcChainId: number, fast: boolean): number {
  if (fast) return 45; // ~10-30s + buffer
  switch (srcChainId) {
    case 11_155_111: return 25 * 60; // Eth Sepolia 15-20 min + buffer
    case 84_532:
    case 421_614:
    case 11_155_420:
      return 4 * 60; // 1-3 min + buffer
    case 43_113:
    case 5_042_002:
      return 90; // 30-60s + buffer
    default:
      return 4 * 60;
  }
}

export function BridgeCard() {
  const { address: account, connector } = useAccount();
  const chainId = useChainId();
  const config = useConfig();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [srcChainId, setSrcChainId] = useState<number>(ETH_SEPOLIA_ID);
  const [dstChainId, setDstChainId] = useState<number>(ARC_CHAIN_ID);
  const [amountStr, setAmountStr] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  /** localStorage id of the current bridge's history entry. Set after burn,
   *  used to patch the entry to "minted" once the mint confirms. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [picker, setPicker] = useState<"from" | "to" | null>(null);
  const [fastTransfer, setFastTransfer] = useState(false);
  const [recipientOverride, setRecipientOverride] = useState<Address | null>(null);
  const [recipientModalOpen, setRecipientModalOpen] = useState(false);
  // CCTP "bridge and buy": opt-in per transfer (default off), only for Arc dest.
  const [buyOnArrival, setBuyOnArrival] = useState(false);
  const [buyToken, setBuyToken] = useState<TokenOption | null>(null);
  const [buyTokenPickerOpen, setBuyTokenPickerOpen] = useState(false);
  // True iff the active step machine was rehydrated from a previous session.
  // We use this to show a recovery banner instead of the normal new-burn UI.
  const [resumedFromStorage, setResumedFromStorage] = useState(false);

  // If the user refreshed mid-bridge, restore the burn so they can still
  // claim. We only restore once per mount, and the in-memory step takes
  // priority if they're already in the middle of a fresh bridge.
  // BRIDGE-MULTITAB-DOUBLE-MINT-REVERT: listen for sibling-tab mint
  // broadcasts so two tabs both holding the same pending burn don't both
  // sign a `receiveMessage` and revert one of the two.
  //
  // Audit B-4: deps depend only on [account]. The previous [account, step]
  // dep recreated the channel on every step transition (idle -> attesting
  // -> minting -> idle), which on some browsers leaks MessagePorts under
  // rapid transitions. The handler reads `step` from a ref kept in sync
  // by the next effect below so it never sees a stale closure.
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("arcade-bridge-mint");
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { burnTxHash?: string; account?: string };
      if (!data?.burnTxHash) return;
      if (data.account?.toLowerCase() !== account?.toLowerCase()) return;
      // Audit Bridge C-3: BroadcastChannel payloads come from any
      // same-origin script (XSS / 3rd-party widget). NEVER delete the
      // persisted pendingBridge entry from an inbound message - that
      // would erase the user's only resume path. Only drop the local
      // UI step; the persisted state still surfaces on reload if the
      // other tab didn't actually mint.
      const cur = stepRef.current;
      if (cur.kind === "attesting" || cur.kind === "minting") {
        if (cur.burnTxHash?.toLowerCase() === data.burnTxHash.toLowerCase()) {
          setStep({ kind: "idle" });
        }
      }
    };
    channel.addEventListener("message", onMsg);
    return () => {
      channel.removeEventListener("message", onMsg);
      channel.close();
    };
  }, [account]);

  useEffect(() => {
    if (step.kind !== "idle") return;
    // BRIDGE-INJ-PENDING-MINT-GRIEF: only resume the entry that belongs to
    // the currently connected wallet. Without this gate, an attacker who
    // can write a forged entry to localStorage (same-origin XSS, shared
    // computer) would have the next wallet that signs in pay gas to mint
    // USDC into the attacker-chosen recipient.
    if (!account) return;
    const saved = loadPendingBridge(account);
    if (!saved) return;
    // Audit Bridge M-5: validate the persisted dstChainId is still in
    // CCTP_CHAINS before restoring. A chain removed between bridge time
    // and resume would otherwise deref to undefined and the non-null
    // assertion at the destination chain read would throw.
    if (!getCctpChain(saved.dstId) || !getCctpChain(saved.srcChainId)) {
      clearPendingBridge(account);
      return;
    }
    setSrcChainId(saved.srcChainId);
    setDstChainId(saved.dstId);
    setAmountStr(formatUnits(BigInt(saved.amountRaw6), 6));
    setStep({
      kind: "attesting",
      burnTxHash: saved.burnTxHash,
      srcDomain: saved.srcDomain,
      dstId: saved.dstId,
    });
    setResumedFromStorage(true);
    // Run on first mount with a connected account, and also when the
    // wallet switches so the new wallet's own pending entry surfaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Audit Bridge H-3: listen for retry events dispatched from
  // BridgeHistory when the user clicks Retry on a failed row. Rehydrate
  // the form + re-enter the attestation poll so the user doesn't have
  // to fish the burnTxHash out of the explorer to recover.
  //
  // Audit B-8: cross-check the retry payload against the user's own
  // bridge history before trusting it. Without this, ANY same-origin
  // script can dispatch `arcade-bridge-retry` with arbitrary
  // burnTxHash + srcChainId + dstChainId and coerce the connected
  // wallet into entering the attestation poll for an attacker's burn.
  // Combined with the now-fixed B-1 (recipient bypass when account is
  // briefly undefined), that path used to be a real way to make a
  // victim mint someone else's burn. Now we refuse retries whose
  // burnTxHash isn't in `loadBridgeHistory(account)` for the connected
  // wallet — i.e. this user is the one who initiated that burn.
  useEffect(() => {
    const onRetry = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | {
            burnTxHash?: `0x${string}`;
            srcChainId?: number;
            dstChainId?: number;
            amountRaw6?: string;
          }
        | undefined;
      if (!detail?.burnTxHash || !detail.srcChainId || !detail.dstChainId) return;
      const srcCfg = getCctpChain(detail.srcChainId);
      const dstCfg = getCctpChain(detail.dstChainId);
      if (!srcCfg || !dstCfg) return;
      // B-8: require the burnTxHash to be in this wallet's history.
      const history = loadBridgeHistory(account);
      const entry = history.find(
        (h) => h.burnTxHash?.toLowerCase() === detail.burnTxHash!.toLowerCase(),
      );
      if (!entry) return;
      setSrcChainId(detail.srcChainId);
      setDstChainId(detail.dstChainId);
      // Restore the custom recipient from history (pages audit 2026-07-02:
      // the retry dropped it, so the mint-time recipient check's
      // expectedRecipient fell back to the connected wallet, never matched
      // the burn's mintRecipient, and the attestation poll ran forever for
      // custom-recipient burns).
      if (
        entry.recipient &&
        isAddress(entry.recipient) &&
        (!account || entry.recipient.toLowerCase() !== account.toLowerCase())
      ) {
        setRecipientOverride(entry.recipient as Address);
      } else {
        setRecipientOverride(null);
      }
      if (detail.amountRaw6) {
        try {
          setAmountStr(formatUnits(BigInt(detail.amountRaw6), 6));
        } catch {
          /* ignore */
        }
      }
      setStep({
        kind: "attesting",
        burnTxHash: detail.burnTxHash,
        srcDomain: srcCfg.cctpDomain,
        dstId: detail.dstChainId,
      });
    };
    window.addEventListener("arcade-bridge-retry", onRetry as EventListener);
    return () => window.removeEventListener("arcade-bridge-retry", onRetry as EventListener);
  }, [account]);

  // RACE-010 + audit BRIDGE-NO-ACCOUNT-BINDING: reset transient form
  // state when the connected wallet changes. Without this, user A picks
  // a custom recipient (Alice), disconnects on a shared computer, and
  // user B connects in the same SPA session — B's burn would mint to
  // Alice's address. Distinguish:
  //   - undefined -> X (initial connect): keep step (resume flow runs)
  //   - X -> undefined (disconnect): keep step (connector hiccup, common
  //     recovery action; user re-connects with same wallet)
  //   - X -> Y where X != Y (wallet switch): hard reset step so wallet
  //     B does NOT inherit wallet A's in-flight Claim button.
  const prevAccountRef = useRef<typeof account>(undefined);
  useEffect(() => {
    const prev = prevAccountRef.current;
    prevAccountRef.current = account;
    // Audit Bridge H-1: only clear recipientOverride on the HARD-RESET
    // branch (X -> Y). A connector hiccup (X -> undefined -> X) was
    // silently reverting the user's custom recipient to their wallet
    // address with no UI signal - if they were mid-form they may have
    // already mentally committed to "I am sending to Alice" while the
    // form silently re-targeted their own wallet.
    setHistoryId(null);
    setRecipientModalOpen(false);
    if (prev && account && prev.toLowerCase() !== account.toLowerCase()) {
      // Hard reset: wallet B connected after wallet A had a burn in flight.
      setRecipientOverride(null);
      setStep({ kind: "idle" });
      setAmountStr("");
      setResumedFromStorage(false);
    }
  }, [account]);

  // Effective recipient = override if set, otherwise the connected wallet.
  const recipient: Address | undefined = recipientOverride ?? account;

  // Solana is non-EVM; getCctpChain returns undefined for its sentinel id,
  // so fall back to a display-only pseudo-config. EVM reads/writes below
  // are all gated on `!solanaMode`, so the dummy fields never drive an op.
  const srcChain = useMemo(
    () => getCctpChain(srcChainId) ?? SOLANA_PSEUDO_CHAIN,
    [srcChainId],
  );
  const dstChain = useMemo(
    () => getCctpChain(dstChainId) ?? SOLANA_PSEUDO_CHAIN,
    [dstChainId],
  );

  const isArcDest = dstChainId === ARC_CHAIN_ID;
  // "Bridge and buy" targets: a fixed whitelist of canonical Arc tokens
  // (USDC is the input, so it is never a target). Zero-address entries (an
  // unconfigured token) are dropped.
  const buyTokenOptions = useMemo<TokenOption[]>(
    () =>
      (
        [
          { address: ADDRESSES.seedEth, symbol: "ETH", name: "Ether", decimals: 18 },
          { address: ADDRESSES.eurc, symbol: "EURC", name: "Euro Coin", decimals: 6 },
          { address: ADDRESSES.cirBtc, symbol: "cirBTC", name: "Circle Wrapped BTC", decimals: 8 },
        ] as TokenOption[]
      ).filter((t) => !!t.address && t.address !== zeroAddress),
    [],
  );
  // Whether this transfer will fold a buy into the arrival claim (standard EVM
  // burn path only — not the Solana source flow).
  const useBuyHook =
    BRIDGE_BUY_ENABLED &&
    buyOnArrival &&
    !!buyToken &&
    // Never fold a USDC->USDC "buy" (no-op that just refunds).
    buyToken.address.toLowerCase() !== ADDRESSES.usdc.toLowerCase() &&
    isArcDest &&
    !isSolanaBridgeId(srcChainId);

  // Plain bridge (no buy) that still owes the fast-transfer fee: route it
  // through the receiver so the fee is skimmed on arrival and the remainder
  // forwarded. Standard transfers are free, so they keep the cheaper direct
  // mint (no extra contract in the path).
  //
  // The receiver re-checks the finality threshold on the ATTESTED message, so
  // the fee cannot be FAKED (understated) once the mint lands here. It can
  // still be DODGED: mintRecipient is chosen at burn time on the source chain,
  // so anyone calling depositForBurn directly with mintRecipient = their own
  // wallet never puts the receiver in the path and pays us nothing (audit
  // 2026-07-11 F-3). Treat this fee as voluntary/UI-only. Making it
  // unavoidable needs the skim on the SOURCE chain, per the fee-router note on
  // ARCADE_BRIDGE_FEE_BPS above.
  const useFeeHook =
    !useBuyHook &&
    fastTransfer &&
    isArcDest &&
    !isSolanaBridgeId(srcChainId) &&
    ADDRESSES.cctpBuyReceiver !== zeroAddress;

  // Solana bridge mode: one side is the Solana sentinel. App Kit only
  // bridges Solana <-> Arc, so the pickers force Arc on the opposite side.
  const solanaMode =
    isSolanaBridgeId(srcChainId) || isSolanaBridgeId(dstChainId);
  const solanaDirection: "arc-to-solana" | "solana-to-arc" = isSolanaBridgeId(
    dstChainId,
  )
    ? "arc-to-solana"
    : "solana-to-arc";
  const [solAddress, setSolAddress] = useState<string | null>(null);
  const [solBusy, setSolBusy] = useState(false);
  const [solMsg, setSolMsg] = useState<string>("");
  const [solBalance, setSolBalance] = useState<number | null>(null);
  // Visual progress for the App Kit Solana bridge: "burn" = in-flight,
  // "done" = settled. (App Kit is a single call, so we show the first step
  // active for the whole bridge then mark all done on success.)
  const [solStep, setSolStep] = useState<"idle" | "burn" | "done">("idle");

  // Source-chain USDC balance
  const srcBalance = useReadContract({
    address: srcChain.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: srcChain.id,
    query: {
      enabled: !!account && !isSolanaBridgeId(srcChainId),
      refetchInterval: 10_000,
    },
  });
  const balRaw = (srcBalance.data as bigint | undefined) ?? 0n;

  // Destination-chain USDC balance (for display in the "To" box)
  const dstBalance = useReadContract({
    address: dstChain.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: dstChain.id,
    query: {
      enabled: !!account && !isSolanaBridgeId(dstChainId),
      refetchInterval: 10_000,
    },
  });
  const dstBalRaw = (dstBalance.data as bigint | undefined) ?? 0n;

  // Solana-side USDC (SPL) balance, fetched whenever Solana is involved
  // (source or destination) and Phantom is connected.
  const srcIsSolana = isSolanaBridgeId(srcChainId);
  const dstIsSolana = isSolanaBridgeId(dstChainId);
  useEffect(() => {
    if (!(srcIsSolana || dstIsSolana) || !solAddress) {
      setSolBalance(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      getSolanaUsdcBalance(solAddress).then((b) => {
        if (!cancelled) setSolBalance(b);
      });
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [srcIsSolana, dstIsSolana, solAddress]);
  const solBalRaw =
    solBalance != null ? BigInt(Math.floor(solBalance * 1e6)) : 0n;
  // Balance shown in the From box: Solana SPL balance when Solana is the
  // source, otherwise the EVM-read USDC balance.
  const effBalRaw = srcIsSolana ? solBalRaw : balRaw;

  const amountRaw = useMemo(() => {
    try {
      return amountStr ? parseUnits(amountStr, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amountStr]);

  const insufficient = balRaw > 0n && amountRaw > balRaw;
  const sameChain = srcChainId === dstChainId;

  // Preview the AMM output on Arc so the user sees the rate BEFORE bridging
  // (a mispriced/thin pool can pay far less than 1:1 — the testnet USDC/EURC
  // pool prices EURC at ~31 USDC). Reverts for a pure curve token (no V2 pair);
  // then buyQuoteOut stays 0 and the launchpad curve handles it with no floor.
  // Quote USDC->token on each V2-style venue and keep the best. The Arcade V2
  // pool can be broken/mispriced for some pairs (the testnet USDC/EURC pool
  // pays ~0.13 EURC for 2 USDC) while XyloNet's stable pool pays ~1.47, so we
  // route the buy through whichever quotes higher and pass that router in the
  // hook. Reverts (no pair) leave the quote at 0 -> launchpad curve handles it.
  const quoteArgs =
    useBuyHook && buyToken
      ? ([amountRaw, [ADDRESSES.usdc, buyToken.address]] as const)
      : undefined;
  const arcadeQuoteQ = useReadContract({
    address: ADDRESSES.router,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: quoteArgs,
    chainId: ARC_CHAIN_ID,
    query: { enabled: useBuyHook && amountRaw > 0n },
  });
  const xyloQuoteQ = useReadContract({
    address: ADDRESSES.xyloRouter,
    abi: ROUTER_ABI,
    functionName: "getAmountsOut",
    args: quoteArgs,
    chainId: ARC_CHAIN_ID,
    query: { enabled: useBuyHook && amountRaw > 0n },
  });
  // Some targets (ETH / SeedETH) have no V2 pair and live only on a V3 pool;
  // quote USDC->token via the Arcade V3 quoter at the token's fee tier and let
  // the receiver route through the V3 router when it wins.
  const V3_BUY_FEE: Record<string, number> = useMemo(
    () => ({ [ADDRESSES.seedEth.toLowerCase()]: 500 }),
    [],
  );
  const buyV3Fee = buyToken ? (V3_BUY_FEE[buyToken.address.toLowerCase()] ?? 0) : 0;
  const v3QuoteQ = useReadContract({
    address: ADDRESSES.v3Quoter,
    abi: V3_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args:
      buyV3Fee && buyToken
        ? [ADDRESSES.usdc, buyToken.address, buyV3Fee, amountRaw]
        : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: useBuyHook && amountRaw > 0n && buyV3Fee !== 0 },
  });
  const { buyQuoteOut, buyRouter, buyV3Router, buyV3FeeOut } = useMemo(() => {
    const last = (d: unknown) => {
      const a = d as readonly bigint[] | undefined;
      return a && a.length > 0 ? a[a.length - 1] : 0n;
    };
    const arcOut = last(arcadeQuoteQ.data);
    const xylOut = last(xyloQuoteQ.data);
    const v3Out = (v3QuoteQ.data as bigint | undefined) ?? 0n;
    // V3 wins: route through the V3 router (ammRouter unused), carry the fee.
    if (buyV3Fee !== 0 && v3Out > 0n && v3Out >= arcOut && v3Out >= xylOut) {
      return {
        buyQuoteOut: v3Out,
        buyRouter: zeroAddress as Address,
        buyV3Router: ADDRESSES.v3Router,
        buyV3FeeOut: BigInt(buyV3Fee),
      };
    }
    return xylOut > arcOut
      ? {
          buyQuoteOut: xylOut,
          buyRouter: ADDRESSES.xyloRouter,
          buyV3Router: zeroAddress as Address,
          buyV3FeeOut: 0n,
        }
      : {
          buyQuoteOut: arcOut,
          buyRouter: ADDRESSES.router,
          buyV3Router: zeroAddress as Address,
          buyV3FeeOut: 0n,
        };
  }, [arcadeQuoteQ.data, xyloQuoteQ.data, v3QuoteQ.data, buyV3Fee]);
  const buyQuoteLoading =
    arcadeQuoteQ.isLoading || xyloQuoteQ.isLoading || v3QuoteQ.isLoading;
  // Tolerance for price drift during the bridge. This was 15% for a bridge the
  // very same comment described as "~30-60s" -- 15% is not drift over a minute,
  // it is the band the claim needed because the claim was UNBOUNDED: the
  // message stayed valid forever and anyone could redeem it, so a sandwicher
  // could wait for a favourable setup and extract the full 15% (it lands on the
  // beneficiary, who receives exactly minOut while the bot pockets the rest).
  // The band is what caps that extraction, so bounding the window with
  // BRIDGE_BUY_DEADLINE_SECONDS is what lets it shrink. 5% over 30 minutes is
  // still generous for the intended minute-long hop.
  //
  // Failing this check is SAFE, not a loss: the receiver's routes are in
  // try/catch, so a buy that can no longer clear 5% falls through to a plain
  // USDC refund on Arc, where USDC is the native gas token and fully usable.
  // "We did not fill you 10% worse than quoted, here is your USDC" is the
  // correct outcome.
  const buyMinOut = buyQuoteOut > 0n ? (buyQuoteOut * 95n) / 100n : 0n;
  // How long AFTER the attestation is expected to land the quote stays good.
  // This, not the total, is the number that matters: it is simultaneously the
  // user's window to come back and sign, and a bot's window to wait for a
  // favourable setup. Keeping it constant keeps the sandwich exposure constant
  // across transfer modes.
  const BRIDGE_BUY_CLAIM_SLACK_SECONDS = 30 * 60;

  // Fees only apply to Fast Transfer; Standard is free on both sides.
  // The on-chain receiver PINS the all-in cost to ARCADE_BRIDGE_FEE_BPS of the
  // burned amount: it skims exactly the gap Circle's own fee leaves
  // (fee = amount*5/10000 - feeExecuted). So the user's total is this number
  // whatever Circle charges on the route, and Arcade's share is the remainder.
  // (This replaces the old `arcadeFee + circleMaxFee` sum, which double-counted
  // and quoted 0.07% for what is a 0.05% all-in.)
  const totalFee =
    amountRaw > 0n && fastTransfer
      ? (amountRaw * ARCADE_BRIDGE_FEE_BPS) / BPS_DENOMINATOR
      : 0n;
  const circleMaxFee =
    amountRaw > 0n && fastTransfer ? (amountRaw * CCTP_FAST_MAX_FEE_BPS) / BPS_DENOMINATOR : 0n;
  const arcadeFee = totalFee > circleMaxFee ? totalFee - circleMaxFee : 0n;
  const estReceived = amountRaw > 0n ? amountRaw - totalFee : 0n;
  const isProcessing =
    step.kind === "approving" ||
    step.kind === "burning" ||
    step.kind === "attesting" ||
    step.kind === "minting";

  const flipChains = () => {
    if (isProcessing) return;
    setSrcChainId(dstChainId);
    setDstChainId(srcChainId);
    setStep({ kind: "idle" });
  };

  const handleSrcPick = (id: number) => {
    if (isSolanaBridgeId(id)) {
      // Solana only bridges with Arc → force Arc as destination.
      setSrcChainId(SOLANA_BRIDGE_ID);
      setDstChainId(ARC_CHAIN_ID);
    } else {
      setSrcChainId(id);
      if (isSolanaBridgeId(dstChainId) && id !== ARC_CHAIN_ID) {
        // dst was Solana but new src isn't Arc → not a route, reset to Arc.
        setDstChainId(ARC_CHAIN_ID);
      } else if (id === dstChainId) {
        setDstChainId(srcChainId);
      }
    }
    // Always clear any prior error/done state when chains change so the
    // user can retry immediately without a page refresh.
    setStep({ kind: "idle" });
    setAmountStr("");
  };
  const handleDstPick = (id: number) => {
    if (isSolanaBridgeId(id)) {
      setDstChainId(SOLANA_BRIDGE_ID);
      setSrcChainId(ARC_CHAIN_ID);
    } else {
      setDstChainId(id);
      if (isSolanaBridgeId(srcChainId) && id !== ARC_CHAIN_ID) {
        setSrcChainId(ARC_CHAIN_ID);
      } else if (id === srcChainId) {
        setSrcChainId(dstChainId);
      }
    }
    setStep({ kind: "idle" });
    setAmountStr("");
  };

  const connectPhantom = async () => {
    const sol = getPhantom();
    if (!sol) {
      setSolMsg("Phantom wallet not found — install it to bridge Solana.");
      return;
    }
    try {
      const res = await sol.connect();
      setSolAddress(res.publicKey.toString());
      setSolMsg("");
    } catch {
      setSolMsg("Phantom connection rejected.");
    }
  };

  const doSolanaBridge = async () => {
    if (!account || !solAddress || amountRaw === 0n) return;
    const sol = getPhantom();
    const evmProvider = (await connector?.getProvider?.()) as
      | EIP1193Provider
      | undefined;
    if (!sol || !evmProvider) {
      setSolMsg("Wallet provider unavailable.");
      return;
    }
    setSolBusy(true);
    setSolStep("burn");
    setSolMsg("Confirm in your wallet(s)…");
    const amountSnapshot = amountRaw;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await executeKitBridge({
        direction: solanaDirection,
        evmProvider,
        evmAddress: account,
        solanaProvider: sol,
        solanaAddress: solAddress,
        amount: amountStr,
      });
      setSolStep("done");
      setSolMsg("");
      const destExplorer =
        solanaDirection === "arc-to-solana"
          ? `https://explorer.solana.com/address/${solAddress}?cluster=devnet`
          : `https://testnet.arcscan.app/address/${account}`;
      pushToast({
        kind: "swap",
        action: "Bridge",
        tokenSymbol: "USDC",
        amountFormatted: formatUSDC(amountSnapshot, 6, 2),
        explorerUrl: destExplorer,
        chainId: dstChainId,
      });
      // Record in Recent bridges so the Solana leg shows alongside CCTP.
      try {
        const srcTx =
          res?.steps?.find?.((s: { txHash?: string }) => s?.txHash)?.txHash ??
          res?.sourceTxHash ??
          res?.txHash;
        recordBridge(account, {
          srcChainId,
          dstChainId,
          amountRaw6: amountSnapshot.toString(),
          recipient:
            solanaDirection === "arc-to-solana" ? solAddress : account,
          burnTxHash: (typeof srcTx === "string" && srcTx.startsWith("0x")
            ? srcTx
            : `0x${"0".repeat(64)}`) as `0x${string}`,
          status: "minted",
          burnedAt: Date.now(),
          mintedAt: Date.now(),
        });
        window.dispatchEvent(new Event(BRIDGE_HISTORY_CHANGE_EVENT));
      } catch {
        // history is best-effort; never block the success path
      }
      setAmountStr("");
    } catch (err) {
      setSolStep("idle");
      setSolMsg(err instanceof Error ? err.message : "Bridge failed");
    } finally {
      setSolBusy(false);
    }
  };

  const doBurn = async () => {
    if (!account || amountRaw === 0n || sameChain) return;
    try {
      if (chainId !== srcChain.id) {
        setStep({ kind: "approving" });
        await switchChainAsync({ chainId: srcChain.id });
      }
      setStep({ kind: "approving" });
      // Read from the SOURCE chain's RPC explicitly - the wallet might still
      // be reporting a stale chain right after a switchChain.
      const srcClient = getPublicClient(config, { chainId: srcChain.id });
      if (!srcClient) throw new Error("Could not get source chain client");
      const allowance = (await srcClient.readContract({
        address: srcChain.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, CCTP_V2_TOKEN_MESSENGER],
      })) as bigint;
      if (allowance < amountRaw) {
        const approveHash = await writeContractAsync({
          address: srcChain.usdc,
          abi: erc20Abi,
          functionName: "approve",
          args: [CCTP_V2_TOKEN_MESSENGER, 2n ** 256n - 1n],
          chainId: srcChain.id,
        });
        await srcClient.waitForTransactionReceipt({ hash: approveHash });
      }
      setStep({ kind: "burning" });
      // Use the override recipient if set, otherwise the connected wallet.
      // For "bridge and buy", the mintRecipient is the ArcadeCctpBuyReceiver
      // (USDC lands there and is bought+forwarded on arrival); the beneficiary
      // who receives the bought tokens is encoded in the hook.
      const beneficiary = (recipientOverride ?? account) as Address;
      const mintRecipient32 = addressToBytes32(
        useBuyHook || useFeeHook ? ADDRESSES.cctpBuyReceiver : beneficiary,
      );
      // CRITICAL (audit 2026-07-11 F-1): when the mint lands on the receiver,
      // destinationCaller MUST pin receiveMessage to the receiver itself.
      // Otherwise anyone can take the PUBLIC message + attestation (both are
      // readable: MessageSent on the source chain, Iris is unauthenticated) and
      // call MessageTransmitterV2.receiveMessage DIRECTLY. That mints the USDC
      // into the receiver and burns the nonce, so the user's receiveAndBuy /
      // receiveAndForward then reverts forever on the used nonce and the funds
      // are stranded -- the receiver has no rescue path. Cost to grief: gas.
      // Loss: the whole transfer, for every user, by any observer.
      // Pinning it costs nothing: our entrypoints stay permissionless (msg.sender
      // inside receiveMessage is the RECEIVER, not the caller), so any relayer
      // or the user can still claim. A direct EOA call now reverts.
      const destinationCaller =
        useBuyHook || useFeeHook
          ? addressToBytes32(ADDRESSES.cctpBuyReceiver)
          : (("0x" + "00".repeat(32)) as `0x${string}`);
      // Fast Transfer: short finality + non-zero maxFee (1 bp upper bound; Iris
      // typically charges much less). Standard Transfer: full finality, no fee.
      // Ceiling we allow Circle to charge; must cover the route's minimumFee
      // (1.3bp from Base/Arbitrum) or the transfer silently falls back to
      // standard finality. Circle still only takes its published minimum.
      const maxFee = fastTransfer
        ? (amountRaw * CCTP_FAST_MAX_FEE_BPS) / BPS_DENOMINATOR
        : 0n;
      const minFinality = fastTransfer ? 1000 : 2000;
      // Stamped HERE, at burn time, not at render: a deadline computed when the
      // quote rendered would already be part-spent (or expired) by the time the
      // user finishes reading and signs, silently turning a valid buy into a
      // refund.
      //
      // Derived from the SAME attestation table the UI shows the user, never a
      // flat constant. A flat 30 min was calibrated to Fast (~10-30s) while
      // bridge-and-buy is NOT gated on fastTransfer and the form defaults to
      // Eth Sepolia + STANDARD, whose attestation this app itself budgets at up
      // to 25 min -- so the default buy shipped with ~5 minutes of margin, and a
      // user who took longer than that to return to the tab silently got a USDC
      // refund instead of the token they committed to. Two paths whose latency
      // differs by ~50x cannot share one deadline. Adding the slack ON TOP of
      // the expected attestation keeps the exposure window identical for both.
      const buyDeadline = BigInt(
        Math.floor(Date.now() / 1000) +
          expectedAttestUpperSec(srcChain.id, fastTransfer) +
          BRIDGE_BUY_CLAIM_SLACK_SECONDS,
      );
      // hookData = abi.encode(beneficiary, token, minTokensOut, ammRouter,
      // v3Router, v3Fee, buyDeadline). minOut is the best-venue quote minus 5%;
      // 0 for a pure curve token. When v3Router+v3Fee are set the
      // receiver routes the buy through the V3 pool (ETH); otherwise via the
      // chosen V2-style ammRouter. If arrival slips below minOut, the receiver
      // refunds the USDC to the beneficiary.
      const burnHash = useBuyHook
        ? await writeContractAsync({
            address: CCTP_V2_TOKEN_MESSENGER,
            abi: TOKEN_MESSENGER_V2_ABI,
            functionName: "depositForBurnWithHook",
            args: [
              amountRaw,
              dstChain.cctpDomain,
              mintRecipient32,
              srcChain.usdc,
              destinationCaller,
              maxFee,
              minFinality,
              // MUST stay byte-identical to the receiver's abi.decode. The
              // 7th word (buyDeadline) is the stale-quote guard: buyMinOut is
              // fixed HERE, at burn time, but the message stays claimable
              // forever and claiming is permissionless, so without it a bot
              // could sit on the message and claim at a moment of its choosing,
              // extracting the whole slippage band. Past the deadline the
              // receiver refunds USDC instead of buying at a price quoted in
              // another market.
              encodeAbiParameters(
                [
                  { type: "address" },
                  { type: "address" },
                  { type: "uint256" },
                  { type: "address" },
                  { type: "address" },
                  { type: "uint256" },
                  { type: "uint256" },
                ],
                [
                  beneficiary,
                  buyToken!.address,
                  buyMinOut,
                  buyRouter,
                  buyV3Router,
                  buyV3FeeOut,
                  buyDeadline,
                ],
              ),
            ],
            chainId: srcChain.id,
          })
        : useFeeHook
          ? // Plain FAST bridge: mint to the receiver with a 32-byte hook
            // carrying only the beneficiary. On arrival receiveAndForward
            // skims the fee and forwards the rest. The 32-byte hookData also
            // makes the message shorter than the buy path's, which is how the
            // claim below tells the two apart (and why the contract's two
            // entrypoints use EXACT lengths).
            await writeContractAsync({
              address: CCTP_V2_TOKEN_MESSENGER,
              abi: TOKEN_MESSENGER_V2_ABI,
              functionName: "depositForBurnWithHook",
              args: [
                amountRaw,
                dstChain.cctpDomain,
                mintRecipient32,
                srcChain.usdc,
                destinationCaller,
                maxFee,
                minFinality,
                encodeAbiParameters([{ type: "address" }], [beneficiary]),
              ],
              chainId: srcChain.id,
            })
          : await writeContractAsync({
            address: CCTP_V2_TOKEN_MESSENGER,
            abi: TOKEN_MESSENGER_V2_ABI,
            functionName: "depositForBurn",
            args: [
              amountRaw,
              dstChain.cctpDomain,
              mintRecipient32,
              srcChain.usdc,
              destinationCaller,
              maxFee,
              minFinality,
            ],
            chainId: srcChain.id,
          });
      await srcClient.waitForTransactionReceipt({ hash: burnHash });
      // Persist now - funds are committed on the source chain. If the page
      // refreshes before mint, the user can resume claim from this entry.
      savePendingBridge({
        burnTxHash: burnHash,
        srcDomain: srcChain.cctpDomain,
        srcChainId: srcChain.id,
        dstId: dstChain.id,
        amountRaw6: amountRaw.toString(),
        recipient: (recipientOverride ?? account) as string,
        account: account as string,
        createdAt: Date.now(),
      });
      // Record in long-lived history so it shows up in the "Recent bridges"
      // list below the card.
      const id = recordBridge(account as string, {
        srcChainId: srcChain.id,
        dstChainId: dstChain.id,
        amountRaw6: amountRaw.toString(),
        recipient: (recipientOverride ?? account) as string,
        burnTxHash: burnHash,
        status: "pending",
        burnedAt: Date.now(),
      });
      setHistoryId(id);
      setStep({
        kind: "attesting",
        burnTxHash: burnHash,
        srcDomain: srcChain.cctpDomain,
        dstId: dstChain.id,
      });
    } catch (e: any) {
      setStep({ kind: "error", message: e?.shortMessage || e?.message || "Send failed" });
    }
  };

  // Tracks how long we've been polling Circle for an attestation, so the
  // UI can show "Taking longer than usual" once we pass the expected ETA.
  // Resets to 0 every time we (re)enter the `attesting` step.
  const [attestStartMs, setAttestStartMs] = useState<number | null>(null);
  const [attestElapsedSec, setAttestElapsedSec] = useState(0);

  useEffect(() => {
    if (step.kind !== "attesting") {
      setAttestStartMs(null);
      setAttestElapsedSec(0);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const startedAt = Date.now();
    setAttestStartMs(startedAt);
    setAttestElapsedSec(0);

    const poll = async () => {
      attempts += 1;
      const att = await fetchAttestation(step.srcDomain, step.burnTxHash);
      // Audit 2026-06-18 M-04: drop console.log on every poll. The
      // bridge can poll 30+ times per session and Vercel's free
      // log tier capped quickly under heavy use. Keep telemetry
      // gated behind NODE_ENV=development so testnet debugging
      // still works without flooding prod logs.
      if (process.env.NODE_ENV === "development") {
        // eslint-disable-next-line no-console
        console.log(`[CCTP] poll #${attempts}`, { status: att?.status, hasAtt: !!att });
      }
      if (att && att.status === "complete" && !cancelled) {
        // Audit Bridge C-2: parse the Iris message header and assert
        // sourceDomain / destinationDomain / mintRecipient match what
        // we actually signed. A MITM that returns a real Circle-signed
        // message for a DIFFERENT burn would pass the on-chain signature
        // check but mint USDC into the attacker's recipient at the
        // victim's gas. Reject mismatched payloads here so the user
        // sees an error instead of paying gas to fund the attacker.
        //
        // Audit B-1: when `account` is briefly undefined (wagmi reconnect
        // race, SSR hydration), the old `recipientOverride ?? account ?? ""`
        // fell back to "" and the recipient gate became a no-op. Read
        // the canonical recipient from the persisted pendingBridge entry
        // — that's the address the BURN tx was signed for, so it's the
        // only safe ground truth. Fail closed if neither persisted nor
        // live account is available.
        const dstChainCfg = getCctpChain(step.dstId);
        // Bound to THIS burn: the wallet-scoped entry holds one burn at a time,
        // so reading it unbound let a newer burn's recipient answer for an older
        // one and permanently un-claim it. A stale entry now yields null and we
        // fall back as if there were none.
        const persistedRecipient = recipientForBurn(account, step.burnTxHash);
        const expectedRecipient = persistedRecipient ?? recipientOverride ?? account;
        const parsed = parseCctpV2Message(att.message);
        if (
          !parsed ||
          parsed.sourceDomain !== step.srcDomain ||
          (dstChainCfg && parsed.destinationDomain !== dstChainCfg.cctpDomain) ||
          // B-1: fail closed when expectedRecipient is missing
          !expectedRecipient ||
          // Accept either the user's own mintRecipient OR our receiver (the
          // attestation is already bound to this burnTxHash). The receiver is
          // the mintRecipient for BOTH bridge-and-buy and the plain fast
          // fee-forward path, so this must not be gated on BRIDGE_BUY_ENABLED.
          (parsed.mintRecipient.toLowerCase() !==
            addressToBytes32(expectedRecipient as Address).toLowerCase() &&
            !isKnownReceiver32(parsed.mintRecipient))
        ) {
          // eslint-disable-next-line no-console
          console.warn("[CCTP] Iris payload mismatch, ignoring", { parsed });
          return false;
        }
        // Audit B-3: bail out if the user dismissed this claim mid-poll.
        // The dismissedRef is flipped synchronously by
        // discardPendingClaim; without this check the just-resolved
        // promise would call setStep({kind:"minting"}) and resurrect
        // the claim banner the user explicitly cancelled.
        if (dismissedRef.current) return false;
        // Flip the matching history entry's badge from "Pending" -> "To claim"
        // so the user sees there's an action waiting on them. The mint
        // handler later flips status -> "minted" which supersedes this.
        // Audit 2026-06-11 bug #8: cache the message + signature blobs in
        // history too, so a future second tab opened on the same burn can
        // pick up the result without an extra Iris hit.
        const patch = {
          attestationReady: true,
          attestationMessage: att.message as `0x${string}`,
          attestationSignature: att.attestation as `0x${string}`,
        } as const;
        if (account) {
          if (historyId) updateBridge(account, historyId, patch);
          else updateBridgeByBurnTx(account, step.burnTxHash, patch);
        }
        setStep({
          kind: "minting",
          burnTxHash: step.burnTxHash,
          message: att.message,
          attestation: att.attestation,
          dstId: step.dstId,
        });
        return true;
      }
      return false;
    };
    // Audit 2026-06-18 H-08: replace the fixed 6s setInterval with an
    // exponential-backoff recursive setTimeout. Iris egress is
    // rate-limited on the production endpoint and the previous
    // 6s/forever cadence (= 600 requests/hour against the SAME tx
    // hash) was a guaranteed 429 spiral on mainnet. New cadence:
    //   poll 0 : immediate
    //   poll 1 : 6s
    //   poll 2 : 9s    (× 1.5)
    //   poll 3 : 13s
    //   poll 4 : 20s
    //   ...
    //   cap at 30s/poll once the burn has been pending > 2 minutes.
    // The base 6s cadence is restored on every "missing" / "pending"
    // signal (the burn is making progress); a "transient" signal (5xx,
    // network) only bumps the backoff. The recursive timeout is held
    // in a ref so cleanup can cancel a scheduled-but-not-fired tick.
    const BASE_DELAY_MS = 6_000;
    const MAX_DELAY_MS = 30_000;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let currentDelayMs = BASE_DELAY_MS;
    const schedulePoll = (delayMs: number) => {
      if (cancelled) return;
      pollTimer = setTimeout(async () => {
        if (cancelled) return;
        // fetchAttestationDetailed surfaces transient vs missing vs
        // complete so we can branch backoff intelligently.
        const detailed = await fetchAttestationDetailed(step.srcDomain, step.burnTxHash);
        if (detailed.kind === "transient") {
          // Iris hiccup or network blip. Bump backoff, do NOT call
          // through to poll() which would also fetchAttestation
          // again (double traffic).
          currentDelayMs = Math.min(Math.floor(currentDelayMs * 1.5), MAX_DELAY_MS);
          schedulePoll(currentDelayMs);
          return;
        }
        // Reset backoff on any non-transient result.
        currentDelayMs = BASE_DELAY_MS;
        const done = await poll();
        if (!done) schedulePoll(currentDelayMs);
      }, delayMs);
    };
    // First poll right away so the user sees activity. Use the
    // detailed flavor for parity with the scheduled path.
    (async () => {
      const detailed = await fetchAttestationDetailed(step.srcDomain, step.burnTxHash);
      if (detailed.kind === "transient") {
        currentDelayMs = Math.min(Math.floor(BASE_DELAY_MS * 1.5), MAX_DELAY_MS);
      }
      const done = await poll();
      if (!done) schedulePoll(currentDelayMs);
    })();
    // Independent tick for the UI elapsed counter (1s granularity).
    const tickInterval = setInterval(() => {
      if (cancelled) return;
      setAttestElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(tickInterval);
    };
  }, [step]);

  // Audit 2026-06-11 bug #8: cross-poller sync. The 60s BridgeHistory poll
  // catches Iris attestations faster than our local 6s poll on CCTP V2
  // fast burns (~9-15s vs 30+ s). When that happens, the history badge
  // flips to "To claim" but BridgeCard's `step` stays in "attesting" and
  // the claim button stays disabled — a 2+ minute UX gap. We watch the
  // history change event (same-tab) + the storage event (other-tab) and,
  // if our current burnTxHash now has cached attestation blobs, we
  // re-validate them through the SAME C-2 / B-1 checks the active poller
  // runs (sourceDomain, destinationDomain, mintRecipient) and transition
  // to "minting" with the cached message + signature.
  useEffect(() => {
    if (step.kind !== "attesting" || !account) return;
    const burnLower = step.burnTxHash.toLowerCase();
    const tryCachedAttestation = () => {
      if (dismissedRef.current) return;
      const entry = loadBridgeHistory(account).find(
        (e) => e.burnTxHash.toLowerCase() === burnLower,
      );
      if (!entry || !entry.attestationReady || !entry.attestationMessage || !entry.attestationSignature) {
        return;
      }
      const dstChainCfg = getCctpChain(step.dstId);
      // Bound to THIS burn -- see recipientForBurn. This is the Retry path,
      // which is exactly where a stale entry bites.
      const persistedRecipient = recipientForBurn(account, step.burnTxHash);
      const expectedRecipient = persistedRecipient ?? recipientOverride ?? account;
      const parsed = parseCctpV2Message(entry.attestationMessage);
      if (
        !parsed ||
        parsed.sourceDomain !== step.srcDomain ||
        (dstChainCfg && parsed.destinationDomain !== dstChainCfg.cctpDomain) ||
        !expectedRecipient ||
        // The receiver is a valid mintRecipient for both the buy path and the
        // plain fast fee-forward path, so this is not gated on BRIDGE_BUY_ENABLED.
        (parsed.mintRecipient.toLowerCase() !==
          addressToBytes32(expectedRecipient as Address).toLowerCase() &&
          !isKnownReceiver32(parsed.mintRecipient))
      ) {
        return;
      }
      setStep({
        kind: "minting",
        burnTxHash: step.burnTxHash,
        message: entry.attestationMessage,
        attestation: entry.attestationSignature,
        dstId: step.dstId,
      });
    };
    // Check immediately in case the history poll already finished before
    // this effect ran (refresh-mid-attest case).
    tryCachedAttestation();
    const handler = () => tryCachedAttestation();
    window.addEventListener(BRIDGE_HISTORY_CHANGE_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(BRIDGE_HISTORY_CHANGE_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, [step, account, recipientOverride]);

  /**
   * Upper bound (in seconds) of the "normal" attestation window per source
   * chain - duplicated comment from the module-scope helper below.
   */

  const attestingSlow =
    step.kind === "attesting" &&
    attestStartMs !== null &&
    attestElapsedSec > expectedAttestUpperSec(srcChain.id, fastTransfer);

  // Audit Bridge C-1: in-flight guard against double-click on Claim.
  // setStep("minting") is async w.r.t. the wallet popup, so a fast
  // re-click before the popup opens would fire writeContractAsync a
  // second time. The ref is set synchronously at the top of doMint and
  // cleared in the finally below; while it's true, re-entry returns.
  const mintingInFlightRef = useRef(false);
  const doMint = async () => {
    if (step.kind !== "minting" || !account) return;
    if (mintingInFlightRef.current) return;
    mintingInFlightRef.current = true;
    try {
      if (chainId !== step.dstId) {
        await switchChainAsync({ chainId: step.dstId });
      }
      const dstClient = getPublicClient(config, { chainId: step.dstId });
      if (!dstClient) throw new Error("Could not get destination chain client");
      // Audit 2026-06-18 M-06: precheck usedNonces on the destination
      // MessageTransmitter so a duplicate-mint attempt (user clicks
      // Claim twice in two tabs, or polls a stale attestation cache)
      // short-circuits to a friendly UX instead of burning gas on a
      // tx that reverts at the on-chain "AlreadyUsed" check. The
      // precheck is best-effort: if we cannot parse the nonce or the
      // RPC read fails we proceed and the on-chain check stays as
      // the canonical guard.
      const parsedNonceCheck = parseCctpV2Message(step.message);
      if (parsedNonceCheck?.nonceHash) {
        try {
          const used = (await dstClient.readContract({
            address: CCTP_V2_MESSAGE_TRANSMITTER,
            abi: MESSAGE_TRANSMITTER_V2_ABI,
            functionName: "usedNonces",
            args: [parsedNonceCheck.nonceHash],
          })) as bigint;
          if (used > 0n) {
            pushToast({
              kind: "info",
              title: "Already minted",
              message: "Circle attestation already consumed on the destination chain.",
            });
            clearPendingBridge(account);
            setStep({ kind: "idle" });
            return;
          }
        } catch {
          // RPC failure — fall through to the on-chain guard.
        }
      }
      // "Bridge and buy" detection: if the attested message mints to the
      // ArcadeCctpBuyReceiver, claim through receiveAndBuy (mint + buy +
      // forward, atomic) instead of a plain receiveMessage. Derived from the
      // message itself, so it works even after a page refresh with no extra
      // state — and if the receiver isn't wired, we fall back to receiveMessage.
      const claimMintRecipient = mintRecipientFromMessage(step.message);
      // Route ONLY from the ATTESTED message, never from env or the CURRENT
      // ADDRESSES (audit 2026-07-11 HIGH). Both can change between burn and
      // claim -- an operator flipping BRIDGE_BUY_ENABLED during the attestation
      // window, or a receiver redeploy (this repo redeployed the receiver three
      // times in one day) -- and a mis-route is TERMINAL: destinationCaller is
      // pinned to the receiver, the entrypoints length-check exactly, and the
      // receiver has no rescue function. The USDC would be burned on the source
      // chain and permanently unmintable. So: the message decides everything,
      // and we call the mintRecipient the message itself names.
      //
      // NOT redeploy-proof, contrary to what this comment first claimed. The
      // Iris poll gates (:964, :1100) still require mintRecipient to equal the
      // CURRENT ADDRESSES.cctpBuyReceiver, so an in-flight message naming an
      // OLD receiver is rejected there and never reaches this code. Making that
      // true needs an allowlist of historical receiver addresses at those gates.
      // Those same checks are also what keeps calling `claimMintRecipient`
      // safe (it can only ever be our canonical receiver or the user's own
      // recipient), so the two properties trade off and must be fixed together.
      // Ground truth is the PERSISTED recipient, same as the two gates above
      // (:950, :1090) already use. `recipientOverride` alone is wrong: the
      // resume-from-localStorage effect restores step/chains/amount but NOT the
      // override (the retry path at :292 does, and its comment says dropping it
      // was a bug). So after a refresh, a healthy plain bridge to a custom
      // recipient had mintsToSelf go false, matched neither 568 nor 408, and hit
      // the "contact support" refusal -- on a transfer anyone could have claimed
      // (destinationCaller is zero on that path). Two places in one file must
      // not answer the same question differently. (Audit round 3.)
      const selfRecipient = (recipientForBurn(account, step.burnTxHash) ??
        recipientOverride ??
        account) as Address | undefined;
      const mintsToSelf =
        !!claimMintRecipient &&
        !!selfRecipient &&
        claimMintRecipient.toLowerCase() === selfRecipient.toLowerCase();
      // Exact lengths, mirroring the contract: a buy commits a 224-byte
      // hookData on the current build (376 + 224 = 600), a fee-forward a
      // 32-byte one (408). `>=` would send an over-long message to
      // receiveAndBuy, which exact-length-reverts.
      const msgBytes = (step.message.length - 2) / 2;
      // Match against the sizes of the generation the MESSAGE names, not the
      // current receiver's: an in-flight buy from before a redeploy is 472,
      // 504 or 568 bytes, and hardcoding the current size would refuse exactly
      // the transfers the historical allowlist exists to rescue. Never
      // hardcode a length here -- read it from the generation.
      const gen = claimMintRecipient ? receiverFor32(addressToBytes32(claimMintRecipient)) : undefined;
      const isBridgeBuy = !mintsToSelf && !!gen && msgBytes === gen.buyBytes;
      const isFeeForward =
        !mintsToSelf && !!gen && gen.forwardBytes !== 0 && msgBytes === gen.forwardBytes;
      if (!mintsToSelf && !isBridgeBuy && !isFeeForward) {
        // Refuse rather than broadcast a doomed tx: burning the nonce on a
        // reverting call is how a recoverable state becomes a permanent loss.
        pushToast({
          kind: "error",
          title: "Unrecognised transfer",
          message:
            "This bridge does not match any known claim path. Do not retry; contact support with the burn tx.",
        });
        setStep({ kind: "idle" });
        return;
      }
      const hash = isFeeForward
        ? await writeContractAsync({
            // The message's OWN mintRecipient: survives a receiver redeploy.
            address: claimMintRecipient as Address,
            abi: CCTP_BUY_RECEIVER_ABI,
            functionName: "receiveAndForward",
            args: [step.message, step.attestation],
            chainId: ARC_CHAIN_ID,
          })
        : isBridgeBuy
        ? await writeContractAsync({
            address: claimMintRecipient as Address,
            abi: CCTP_BUY_RECEIVER_ABI,
            functionName: "receiveAndBuy",
            args: [step.message, step.attestation],
            chainId: step.dstId,
          })
        : await writeContractAsync({
            address: CCTP_V2_MESSAGE_TRANSMITTER,
            abi: MESSAGE_TRANSMITTER_V2_ABI,
            functionName: "receiveMessage",
            args: [step.message, step.attestation],
            chainId: step.dstId,
          });
      // Audit Bridge H-4: broadcast the burn ONLY after the wallet
      // accepts the submission. Previously the broadcast fired at the
      // top of doMint; if the user rejected the wallet popup, other
      // tabs had already cleared their step + pending entry and the
      // user could not recover the mint UI without a refresh.
      try {
        const channel = new BroadcastChannel("arcade-bridge-mint");
        channel.postMessage({ burnTxHash: step.burnTxHash, account });
        channel.close();
      } catch {
        /* old browser - the worst case is the original UX */
      }
      // BRIDGE-CLEAR-AFTER-MINT-RECEIPT-GAP: clear pendingBridge as soon as
      // the mint tx is BROADCAST (writeContractAsync returns when the user
      // signs + submits). If the user closes the tab between broadcast and
      // confirmation we'd otherwise resume "Claim" on next visit and the
      // user would either (a) double-mint and revert their second tx, or
      // (b) waste gas double-paying for an already-completed mint. The
      // bridgeHistory row stays updated below so the user still sees the
      // pending mint when they come back.
      clearPendingBridge(account);
      const receipt = await dstClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`Mint tx reverted (${hash.slice(0, 10)}...)`);
      }
      const dstChainCfg = getCctpChain(step.dstId)!;
      // Patch the history entry: pending → minted, store the mint tx.
      // Prefer historyId when we still have it (same session); fall back to
      // burnTxHash lookup so a refresh-then-mint flow still flips the entry
      // out of "pending" instead of leaving a stale row.
      const patch = { status: "minted" as const, mintTxHash: hash, mintedAt: Date.now() };
      if (account) {
        if (historyId) {
          updateBridge(account, historyId, patch);
        } else if (step.kind === "minting" && step.burnTxHash) {
          updateBridgeByBurnTx(account, step.burnTxHash, patch);
        }
      }
      setStep({ kind: "done", mintTxHash: hash, dstId: step.dstId });
      pushToast({
        kind: "swap",
        action: "Bridge",
        tokenSymbol: "USDC",
        amountFormatted: formatUSDC(amountRaw, 6, 2),
        explorerUrl: `${dstChainCfg.explorer}/tx/${hash}`,
      });
    } catch (e: any) {
      setStep({ kind: "error", message: e?.shortMessage || e?.message || "Claim failed" });
    } finally {
      // Always clear the in-flight ref so the user can retry on error
      // without a page refresh. Audit Bridge C-1.
      mintingInFlightRef.current = false;
    }
  };

  const reset = () => {
    setStep({ kind: "idle" });
    setAmountStr("");
  };

  // Audit B-3: ref flipped by discardPendingClaim. The attestation
  // poll's closure captures the old `step` value; without this ref, a
  // poll() that resolves AFTER the user clicked dismiss can still call
  // setStep({ kind: "minting" }) and resurrect the claim banner.
  // The poll checks dismissedRef before any setStep so the dismiss
  // wins the race.
  const dismissedRef = useRef(false);

  /** Manually drop a persisted pending claim - used when the user wants to
   * stop watching an old burn (e.g. they already claimed from another tab,
   * or the burn is stale). Does NOT touch on-chain state. */
  const discardPendingClaim = () => {
    dismissedRef.current = true;
    clearPendingBridge(account);
    // BRIDGE-DISCARD-LEAVES-HISTORY-PENDING: also flip the matching
    // history row to "failed" so BridgeHistory's auto-poll doesn't keep
    // re-marking it as attestation-ready (which would resurrect the
    // claim banner the user just dismissed).
    if (account) {
      const patch = { status: "failed" as const, attestationReady: false };
      if (historyId) {
        updateBridge(account, historyId, patch);
      } else if (step.kind === "attesting" && step.burnTxHash) {
        updateBridgeByBurnTx(account, step.burnTxHash, patch);
      } else if (step.kind === "minting" && step.burnTxHash) {
        updateBridgeByBurnTx(account, step.burnTxHash, patch);
      }
    }
    setStep({ kind: "idle" });
  };

  // Reset dismissed ref every time the step transitions back to a fresh
  // attesting cycle (new burn) so a previously-dismissed burn doesn't
  // poison subsequent attempts.
  useEffect(() => {
    if (step.kind === "attesting") {
      dismissedRef.current = false;
    }
  }, [step]);

  // Audit Bridge M-3: hard minimum on fast-transfer bridges. Circle's
  // fast-transfer fee = amount / 10_000; sub-dust bridges hit a maxFee
  // of 0 which Iris may reject. Surface at canBridge level rather than
  // failing at burn time.
  const MIN_BRIDGE_RAW_FAST = 500_000n; // 0.5 USDC at 6dp
  const underMinFast = fastTransfer && amountRaw > 0n && amountRaw < MIN_BRIDGE_RAW_FAST;
  const canBridge =
    !!account &&
    amountRaw > 0n &&
    !insufficient &&
    !sameChain &&
    !underMinFast &&
    // Buy toggled on but no token picked yet -> block the send.
    !(buyOnArrival && !buyToken) &&
    step.kind === "idle";

  return (
    <div className="arc-card relative p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Bridge</h2>
        <div className="flex items-center gap-2">
          {/* Fast Transfer toggle - flash icon turns yellow when active */}
          <button type="button"
            onClick={() => setFastTransfer((f) => !f)}
            disabled={isProcessing}
            title={
              fastTransfer
                ? "Fast Transfer ON - settles in ~10-30s with a tiny Circle fee"
                : "Standard Transfer - free but waits for full finality (slow on Eth)"
            }
            className={cn(
              "rounded-xl border p-2 transition-all active:scale-95 disabled:opacity-50",
              fastTransfer
                ? "border-yellow-500/60 bg-yellow-500/15 shadow-[0_0_18px_-4px_rgba(234,179,8,0.65)]"
                : "border-arc-border bg-arc-surface-2/40 hover:bg-arc-surface-3/60",
            )}
          >
            <Image
              src="/flash.png"
              alt=""
              width={18}
              height={18}
              className={cn(
                "h-4 w-4 transition-[filter]",
                fastTransfer ? "" : "opacity-50 grayscale",
              )}
              style={
                fastTransfer
                  ? { filter: "brightness(0) saturate(100%) invert(78%) sepia(99%) saturate(1500%) hue-rotate(0deg)" }
                  : undefined
              }
            />
          </button>
          <div className="flex items-center gap-2 rounded-xl border border-arc-border bg-arc-surface-2/40 px-3 py-1.5 text-sm font-medium backdrop-blur-md">
            <TokenIcon symbol="USDC" size={20} />
            USDC
          </div>
        </div>
      </div>

      {/* Recovery banner - surfaces a previous-session burn that hasn't been
          claimed yet. The actual progress tracker / Mint button rendering is
          handled by the normal step machine below; this banner just explains
          to the user what they're seeing and offers an escape hatch. */}
      {resumedFromStorage &&
        (step.kind === "attesting" || step.kind === "minting") && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-arc-cta-hover/40 bg-arc-cta-hover/10 p-3 text-xs">
            <div className="flex-1 text-arc-text">
              <div className="font-medium">Resumed bridge claim</div>
              <div className="mt-0.5 text-arc-text-muted">
                A previous burn on {srcChain.name} hasn&apos;t been claimed yet - we&apos;ll
                keep polling Circle and prompt you to mint as soon as it&apos;s ready.
              </div>
            </div>
            <button type="button"
              onClick={discardPendingClaim}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-arc-text-faint hover:bg-arc-surface-2/60 hover:text-arc-text-muted"
              title="Stop watching this burn (does not affect funds - anyone can still mint it on the destination chain)"
            >
              Dismiss
            </button>
          </div>
        )}

      {/* FROM */}
      <ChainBox
        label="From"
        chain={srcChain}
        amount={amountStr}
        onAmountChange={(v) => setAmountStr(v)}
        onChainClick={() => setPicker("from")}
        disabled={isProcessing}
        balanceRaw={effBalRaw}
        showHalfMax
        onHalf={
          effBalRaw > 0n
            ? () => setAmountStr(formatUnits(effBalRaw / 2n, 6))
            : undefined
        }
        onMax={effBalRaw > 0n ? () => setAmountStr(formatUnits(effBalRaw, 6)) : undefined}
      />

      {/* Flip */}
      <div className="relative z-10 -my-2 flex justify-center">
        <button type="button"
          onClick={flipChains}
          disabled={isProcessing}
          className="rounded-xl border border-arc-border bg-arc-surface-2/40 p-2 backdrop-blur-md transition-all hover:bg-arc-surface-3/60 active:scale-95 disabled:opacity-50"
        >
          <ArrowDownUp className="h-4 w-4 text-arc-text" />
        </button>
      </div>

      {/* TO */}
      <ChainBox
        label="To"
        chain={dstChain}
        amount={
          solanaMode
            ? amountStr
            : amountRaw > 0n
              ? formatUnits(estReceived, 6)
              : ""
        }
        onChainClick={() => setPicker("to")}
        disabled={isProcessing}
        balanceRaw={dstIsSolana ? solBalRaw : dstBalRaw}
        readOnlyAmount
        recipientLabel={recipient ? formatAddress(recipient) : undefined}
        onRecipientClick={!isProcessing ? () => setRecipientModalOpen(true) : undefined}
        recipientIsOverride={!!recipientOverride}
      />

      {/* Same-chain warning */}
      {sameChain && (
        <div className="mt-3 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-2 text-xs text-arc-warn">
          Source and destination must be different chains.
        </div>
      )}

      {/* Itemised bridge fee. Previously the fee silently lowered the "You
          receive" estimate with no line explaining it. Standard Transfer is
          free on both sides, so the row only appears for Fast. */}
      {!sameChain && amountRaw > 0n && (
        <div className="mt-3 space-y-1 rounded-xl border border-arc-border bg-white/[0.015] p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-arc-text-muted">
              Bridge fee {fastTransfer ? "(Fast, all-in)" : "(Standard)"}
            </span>
            <span className="tabular-nums text-arc-text">
              {fastTransfer ? `${formatUSDC(totalFee, 6, 4)} USDC (0.05%)` : "Free"}
            </span>
          </div>
          {fastTransfer && (
            <div className="text-[10px] text-arc-text-faint">
              Includes Circle&apos;s fast-transfer fee. Total never exceeds 0.05%.
              Switch to Standard for a free transfer.
            </div>
          )}
        </div>
      )}

      {/* Bridge and buy (opt-in, Arc destination only). Off => plain bridge. */}
      {BRIDGE_BUY_ENABLED && isArcDest && !solanaMode && !sameChain && (
        <div className="mt-3 rounded-xl border border-arc-border bg-white/[0.015] p-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-arc-text">Buy a token on arrival</div>
              <div className="text-xs text-arc-text-muted">
                Bridge + buy in one flow — bought on Arc when the transfer lands.
                If the buy can&apos;t fill, your USDC is delivered instead.
              </div>
            </div>
            <input
              type="checkbox"
              checked={buyOnArrival}
              disabled={isProcessing}
              onChange={(e) => setBuyOnArrival(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-arc-cta-hover"
            />
          </label>
          {buyOnArrival && (
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => setBuyTokenPickerOpen(true)}
              className="mt-2 flex w-full items-center justify-between rounded-lg border border-arc-border bg-arc-bg px-3 py-2 text-sm disabled:opacity-50"
            >
              {buyToken ? (
                <span className="flex items-center gap-2 text-arc-text">
                  <TokenIcon symbol={buyToken.symbol} size={18} />
                  {buyToken.symbol}
                </span>
              ) : (
                <span className="text-arc-text-muted">Select a token to buy</span>
              )}
              <ChevronDown className="h-4 w-4 text-arc-text-muted" />
            </button>
          )}
          {/* Output preview so a mispriced/thin pool is visible before bridging. */}
          {useBuyHook && amountRaw > 0n && (
            <div className="mt-2 text-xs">
              {buyQuoteLoading ? (
                <span className="text-arc-text-muted">Quoting…</span>
              ) : buyQuoteOut > 0n ? (
                <span className="text-arc-text-muted">
                  You receive ~
                  <span className="text-arc-text">
                    {formatUnits(buyQuoteOut, buyToken?.decimals ?? 18)}{" "}
                    {buyToken?.symbol}
                  </span>{" "}
                  (min {formatUnits(buyMinOut, buyToken?.decimals ?? 18)})
                </span>
              ) : (
                <span className="text-arc-text-muted">
                  No AMM pool — will try the launchpad curve, else your USDC is
                  delivered.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Route info line - same style as SwapCard. Always visible when the
          chain pair is valid, even before the user types an amount.
          Fixed height so the row doesn't grow when the flash badge appears,
          which would otherwise push the CTA button down. */}
      {solanaMode && (
        <div className="mt-3 flex h-[18px] items-center justify-between text-xs">
          <div className="flex h-full items-center gap-1.5 text-arc-text-muted">
            <Image src="/route.png" alt="" width={14} height={14} className="h-3.5 w-3.5 opacity-75" />
            <span>via</span>
            <span className="font-medium text-arc-text">Circle App Kit</span>
          </div>
          <div className="text-arc-text-muted">USDC · ~1-2 min</div>
        </div>
      )}
      {!sameChain && !solanaMode && (
        <div className="mt-3 flex h-[18px] items-center justify-between text-xs">
          <div className="flex h-full items-center gap-1.5 text-arc-text-muted">
            <Image src="/route.png" alt="" width={14} height={14} className="h-3.5 w-3.5 opacity-75" />
            <span>via</span>
            <span className="font-medium text-arc-text">CCTP V2</span>
          </div>
          <div className="flex h-full items-center gap-1.5 text-arc-text-muted tabular-nums">
            <Image src="/time.png" alt="" width={14} height={14} className="h-3.5 w-3.5 opacity-75" />
            <span className="text-arc-text">{etaLabel(srcChain.id, fastTransfer)}</span>
            {fastTransfer && (
              <Image
                src="/flash.png"
                alt="Fast"
                width={17}
                height={17}
                className="-ml-px h-[17px] w-[17px] shrink-0"
                style={{
                  filter:
                    "brightness(0) saturate(100%) invert(78%) sepia(99%) saturate(1500%) hue-rotate(0deg)",
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Slow source warning - only when Fast Transfer is OFF */}
      {!fastTransfer && srcChain.id === ETH_SEPOLIA_ID && !sameChain && amountRaw > 0n && (
        <div className="mt-2 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-2 text-[11px] text-arc-warn">
          Ethereum Sepolia takes ~15-20 min for finality. Enable Fast Transfer (flash icon) to
          bridge in seconds for a tiny fee.
        </div>
      )}

      {/* CTA */}
      <div className="mt-4">
        {solanaMode ? (
          <div className="space-y-2">
            {solStep === "done" ? (
              <button
                type="button"
                onClick={() => {
                  setSolStep("idle");
                  setSolMsg("");
                  setAmountStr("");
                }}
                className="arc-button-secondary w-full py-3.5 text-base"
              >
                Bridge another
              </button>
            ) : !solAddress ? (
              <button
                type="button"
                onClick={connectPhantom}
                style={{ backgroundColor: "#AB9FF2", color: "#000" }}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-base font-semibold transition-opacity hover:opacity-90"
              >
                Connect
                <Image
                  src="/phantom.jpg"
                  alt="Phantom"
                  width={20}
                  height={20}
                  className="h-5 w-5 rounded"
                />
              </button>
            ) : (
              <button
                type="button"
                onClick={doSolanaBridge}
                disabled={!account || amountRaw === 0n || solBusy}
                className="arc-button-primary flex w-full items-center justify-center gap-2 py-3.5 text-base"
              >
                {solBusy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Bridging…
                  </>
                ) : !account ? (
                  "Connect wallet"
                ) : amountRaw === 0n ? (
                  "Enter amount"
                ) : (
                  `Bridge to ${dstChain.name}`
                )}
              </button>
            )}
            {solMsg && (
              <p className="text-xs text-arc-text-muted">{solMsg}</p>
            )}
          </div>
        ) : step.kind === "idle" || step.kind === "error" ? (
          <button type="button"
            onClick={doBurn}
            disabled={!canBridge}
            className="arc-button-primary w-full py-3.5 text-base"
          >
            {!account
              ? "Connect wallet"
              : sameChain
                ? "Pick different chains"
                : amountRaw === 0n
                  ? "Enter amount"
                  : insufficient
                    ? "Insufficient USDC"
                    : buyOnArrival && !buyToken
                      ? "Select a token to buy"
                      : useBuyHook
                        ? `Bridge & buy ${buyToken!.symbol}`
                        : `Bridge to ${dstChain.name}`}
          </button>
        ) : step.kind === "minting" ? (
          // Action-required: the attestation is ready and the user has to
          // confirm the mint tx. We wrap the button in a pulsing halo to draw
          // the eye away from the (now-stalled) stepper above.
          <div className="relative">
            <span
              className="pointer-events-none absolute inset-0 -m-1 rounded-2xl bg-arc-success/40 opacity-70 blur-md animate-bridge-pulse"
              aria-hidden
            />
            <button type="button"
              onClick={doMint}
              className="relative inline-flex w-full items-center justify-center gap-2 rounded-xl bg-arc-success py-3.5 text-base font-medium text-white shadow-[0_18px_36px_-8px_rgba(16,185,129,0.55)] transition-colors hover:bg-arc-success/90 ring-2 ring-arc-success/60"
            >
              <CheckCircle2 className="h-4 w-4" /> Claim on {dstChain.name}
            </button>
          </div>
        ) : step.kind === "done" ? (
          <button type="button" onClick={reset} className="arc-button-secondary w-full py-3.5 text-base">
            Bridge another
          </button>
        ) : (
          <button type="button" disabled className="arc-button-primary w-full py-3.5 text-base">
            <Loader2 className="h-4 w-4 animate-spin" />
            {step.kind === "approving" && "Approving USDC…"}
            {step.kind === "burning" && `Sending USDC from ${srcChain.name}…`}
            {step.kind === "attesting" &&
              (attestingSlow
                ? `Waiting for Circle (${formatElapsed(attestElapsedSec)})…`
                : "Waiting for Circle attestation…")}
          </button>
        )}
      </div>

      {/* No App Kit step tracker: bridge() is a single SDK call with no
          per-step callback, so a stepper would just sit on step 1 the whole
          time (misleading). The "Bridging…" spinner conveys progress; the
          toast + Recent bridges confirm completion. */}

      {/* Visual stepper for the burn → attest → mint flow. Replaces the old
          plain text list with connected dots so users on slow chains (eg
          Eth Sepolia attestation ~15-20 min) can see exactly where they are. */}
      {step.kind !== "idle" && step.kind !== "error" && (
        <div className="mt-4">
          <BridgeStepsProgress
            current={
              step.kind === "approving" || step.kind === "burning"
                ? "burn"
                : step.kind === "attesting"
                  ? "attest"
                  : step.kind === "minting"
                    ? "mint"
                    : step.kind === "done"
                      ? "done"
                      : "idle"
            }
            detail={
              step.kind === "approving"
                ? "Approving USDC spend on the source chain…"
                : step.kind === "burning"
                  ? `Sending USDC on ${srcChain.name}…`
                  : step.kind === "attesting"
                    ? attestingSlow
                      ? `Waiting for Circle (${formatElapsed(attestElapsedSec)} elapsed, usual ${etaLabel(srcChain.id, fastTransfer)}). No action needed.`
                      : `Waiting for Circle's attestation (${etaLabel(srcChain.id, fastTransfer)})…`
                    : step.kind === "minting"
                      ? `Ready to claim on ${dstChain.name}. Click the button above.`
                      : undefined
            }
          />
        </div>
      )}

      {step.kind === "error" && (
        <div className="mt-3 rounded-xl border border-arc-danger/40 bg-arc-danger/10 p-3 text-xs text-arc-danger">
          {step.message}
        </div>
      )}

      {/* Recipient edit modal */}
      <RecipientEditModal
        open={recipientModalOpen}
        onClose={() => setRecipientModalOpen(false)}
        current={recipient}
        ownAccount={account}
        onSave={setRecipientOverride}
      />

      {BRIDGE_BUY_ENABLED && (
        <TokenSelectModal
          open={buyTokenPickerOpen}
          onClose={() => setBuyTokenPickerOpen(false)}
          tokens={buyTokenOptions}
          onSelect={(t) => {
            setBuyToken(t);
            setBuyTokenPickerOpen(false);
          }}
          selectedAddress={buyToken?.address}
        />
      )}

      {/* Pickers */}
      <ChainSelectModal
        open={picker === "from"}
        onClose={() => setPicker(null)}
        onSelect={handleSrcPick}
        selectedChainId={srcChainId}
        excludeChainId={dstChainId}
        title="Select source chain"
        extraChains={
          isSolanaBridgeId(dstChainId)
            ? []
            : [{ id: SOLANA_BRIDGE_ID, name: "Solana Devnet" }]
        }
        allowedChainIds={
          isSolanaBridgeId(dstChainId) ? [ARC_CHAIN_ID] : undefined
        }
      />
      <ChainSelectModal
        open={picker === "to"}
        onClose={() => setPicker(null)}
        onSelect={handleDstPick}
        selectedChainId={dstChainId}
        excludeChainId={srcChainId}
        title="Select destination chain"
        extraChains={
          isSolanaBridgeId(srcChainId)
            ? []
            : [{ id: SOLANA_BRIDGE_ID, name: "Solana Devnet" }]
        }
        allowedChainIds={
          isSolanaBridgeId(srcChainId) ? [ARC_CHAIN_ID] : undefined
        }
      />

      {/* Glow at bottom border when ready */}
      {canBridge && (
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

interface ChainBoxProps {
  label: string;
  chain: ReturnType<typeof getCctpChain>;
  amount: string;
  onAmountChange?: (v: string) => void;
  onChainClick: () => void;
  disabled?: boolean;
  balanceRaw: bigint;
  showHalfMax?: boolean;
  onHalf?: () => void;
  onMax?: () => void;
  readOnlyAmount?: boolean;
  recipientLabel?: string;
  onRecipientClick?: () => void;
  recipientIsOverride?: boolean;
}

function ChainBox({
  label,
  chain,
  amount,
  onAmountChange,
  onChainClick,
  disabled,
  balanceRaw,
  showHalfMax,
  onHalf,
  onMax,
  readOnlyAmount,
  recipientLabel,
  onRecipientClick,
  recipientIsOverride,
}: ChainBoxProps) {
  if (!chain) return null;
  const balLabel = formatUSDC(balanceRaw, 6, 2);
  // Since the bridge is USDC-only and USDC ≈ $1, the USD label is just the amount.
  const usdLabel = amount && Number(amount) > 0 ? `~$${Number(amount).toFixed(2)}` : "~$0.00";

  return (
    <div className="rounded-2xl border border-arc-border bg-white/[0.015] p-4 transition-colors focus-within:border-arc-border-strong">
      {/* Header: label + chain chip */}
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm text-arc-text-muted">{label}</span>
        <button type="button"
          onClick={onChainClick}
          disabled={disabled}
          className="group flex items-center gap-2 rounded-xl bg-arc-surface-2 px-3 py-2 text-base font-semibold transition-colors hover:bg-arc-surface-3 disabled:opacity-50"
        >
          <ChainIcon chainId={chain.id} size={24} />
          <span>{chain.name}</span>
          <ChevronDown className="h-4 w-4 text-arc-text-muted transition-transform group-hover:text-arc-text" />
        </button>
      </div>

      {/* Amount. text-3xl on mobile so 6+ digit amounts don't overflow
          the card; bump to text-4xl from sm: where the card is wider. */}
      {readOnlyAmount ? (
        <div className="truncate text-3xl font-medium leading-tight tabular-nums text-arc-text sm:text-4xl">
          {amount || "0.0"}
        </div>
      ) : (
        <input
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, "");
            const parts = v.split(".");
            if (parts.length > 2) return;
            onAmountChange?.(v);
          }}
          className="arc-input w-full truncate bg-transparent text-3xl font-medium leading-tight sm:text-4xl"
          aria-label="Amount"
        />
      )}

      {/* Footer: USD value + (HALF/MAX or recipient).
          flex-wrap so a long recipient pill ("to 0xAbCd...1234") + balance
          + HALF/MAX don't overflow the 343px usable card-interior at 375px. */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-y-1 text-xs">
        <div className="flex items-center gap-2 text-arc-text-muted">
          <span>{usdLabel}</span>
          {recipientLabel &&
            (onRecipientClick ? (
              <button type="button"
                onClick={onRecipientClick}
                className={cn(
                  "group inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors",
                  recipientIsOverride
                    ? "bg-arc-cta/15 text-arc-cta-hover hover:bg-arc-cta/25"
                    : "text-arc-text-faint hover:bg-arc-surface-2/60 hover:text-arc-text-muted",
                )}
                title={
                  recipientIsOverride
                    ? "Custom recipient - click to edit"
                    : "Click to send to a different address"
                }
              >
                <span>to {recipientLabel}</span>
                <Pencil className="h-3 w-3 text-white opacity-60 group-hover:opacity-100" />
              </button>
            ) : (
              <span className="text-arc-text-faint">to {recipientLabel}</span>
            ))}
        </div>
        <div className="flex items-center gap-1.5 text-arc-text-faint">
          <span>
            Balance: <span className="text-arc-text-muted">{balLabel}</span> USDC
          </span>
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
    <button type="button"
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

function Stepper({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full border",
          done
            ? "border-arc-success bg-arc-success/30 text-arc-success"
            : active
              ? "border-arc-cta-hover bg-arc-cta-hover/30 text-arc-cta-hover"
              : "border-arc-border bg-arc-bg text-arc-text-faint",
        )}
      >
        {done ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : active ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : null}
      </span>
      <span className={cn(done || active ? "text-arc-text" : "text-arc-text-muted")}>{label}</span>
    </div>
  );
}
