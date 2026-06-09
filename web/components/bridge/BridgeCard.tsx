"use client";

import { ArrowDownUp, ChevronDown, Loader2, CheckCircle2, Pencil } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { erc20Abi, formatUnits, parseUnits } from "viem";
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
  MESSAGE_TRANSMITTER_V2_ABI,
  TOKEN_MESSENGER_V2_ABI,
  addressToBytes32,
  fetchAttestation,
  getCctpChain,
  parseCctpV2Message,
} from "@/lib/cctp";
import { Address } from "viem";
import { ChainIcon } from "@/components/ui/ChainIcon";
import { ChainSelectModal } from "@/components/ui/ChainSelectModal";
import { TokenIcon } from "@/components/ui/TokenIcon";
import { RecipientEditModal } from "./RecipientEditModal";
import { cn, formatAddress, formatUSDC } from "@/lib/utils";
import {
  clearPendingBridge,
  loadPendingBridge,
  savePendingBridge,
} from "@/lib/pendingBridge";
import { recordBridge, updateBridge, updateBridgeByBurnTx } from "@/lib/bridgeHistory";
import { BridgeStepsProgress } from "./BridgeStepsProgress";
import { pushToast } from "@/lib/toast";

const ARC_CHAIN_ID = 5_042_002;
const ETH_SEPOLIA_ID = 11_155_111;

/** Arcade fee on bridges. Currently shown as preview only; will be charged
 * on-chain once we deploy the fee router on all source chains for mainnet. */
const ARCADE_BRIDGE_FEE_BPS = 5n; // 0.05%
const CCTP_FAST_MAX_FEE_BPS = 1n; // 0.01% upper bound on Circle's fast transfer fee
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
  const { address: account } = useAccount();
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
  // True iff the active step machine was rehydrated from a previous session.
  // We use this to show a recovery banner instead of the normal new-burn UI.
  const [resumedFromStorage, setResumedFromStorage] = useState(false);

  // If the user refreshed mid-bridge, restore the burn so they can still
  // claim. We only restore once per mount, and the in-memory step takes
  // priority if they're already in the middle of a fresh bridge.
  // BRIDGE-MULTITAB-DOUBLE-MINT-REVERT: listen for sibling-tab mint
  // broadcasts so two tabs both holding the same pending burn don't both
  // sign a `receiveMessage` and revert one of the two.
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
      if (step.kind === "attesting" || step.kind === "minting") {
        if (step.burnTxHash?.toLowerCase() === data.burnTxHash.toLowerCase()) {
          setStep({ kind: "idle" });
        }
      }
    };
    channel.addEventListener("message", onMsg);
    return () => {
      channel.removeEventListener("message", onMsg);
      channel.close();
    };
  }, [account, step]);

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

  const srcChain = useMemo(() => getCctpChain(srcChainId)!, [srcChainId]);
  const dstChain = useMemo(() => getCctpChain(dstChainId)!, [dstChainId]);

  // Source-chain USDC balance
  const srcBalance = useReadContract({
    address: srcChain.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: srcChain.id,
    query: { enabled: !!account, refetchInterval: 10_000 },
  });
  const balRaw = (srcBalance.data as bigint | undefined) ?? 0n;

  // Destination-chain USDC balance (for display in the "To" box)
  const dstBalance = useReadContract({
    address: dstChain.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: dstChain.id,
    query: { enabled: !!account, refetchInterval: 10_000 },
  });
  const dstBalRaw = (dstBalance.data as bigint | undefined) ?? 0n;

  const amountRaw = useMemo(() => {
    try {
      return amountStr ? parseUnits(amountStr, 6) : 0n;
    } catch {
      return 0n;
    }
  }, [amountStr]);

  const insufficient = balRaw > 0n && amountRaw > balRaw;
  const sameChain = srcChainId === dstChainId;

  // Fees only apply when Fast Transfer is enabled: 0.05% Arcade + up to 0.01%
  // Circle. Standard Transfer stays completely free.
  const arcadeFee =
    amountRaw > 0n && fastTransfer ? (amountRaw * ARCADE_BRIDGE_FEE_BPS) / BPS_DENOMINATOR : 0n;
  const circleMaxFee =
    amountRaw > 0n && fastTransfer ? (amountRaw * CCTP_FAST_MAX_FEE_BPS) / BPS_DENOMINATOR : 0n;
  const totalFee = arcadeFee + circleMaxFee;
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
    if (id === dstChainId) setDstChainId(srcChainId);
    setSrcChainId(id);
    // Always clear any prior error/done state when chains change so the
    // user can retry immediately without a page refresh.
    setStep({ kind: "idle" });
    setAmountStr("");
  };
  const handleDstPick = (id: number) => {
    if (id === srcChainId) setSrcChainId(dstChainId);
    setDstChainId(id);
    setStep({ kind: "idle" });
    setAmountStr("");
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
      const mintRecipient32 = addressToBytes32(recipientOverride ?? account);
      const destinationCaller = ("0x" + "00".repeat(32)) as `0x${string}`;
      // Fast Transfer: short finality + non-zero maxFee (1 bp upper bound; Iris
      // typically charges much less). Standard Transfer: full finality, no fee.
      const maxFee = fastTransfer ? amountRaw / 10_000n : 0n; // ≤0.01% of the amount
      const minFinality = fastTransfer ? 1000 : 2000;
      const burnHash = await writeContractAsync({
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
      // eslint-disable-next-line no-console
      console.log(`[CCTP] poll #${attempts}`, { status: att?.status, hasAtt: !!att });
      if (att && att.status === "complete" && !cancelled) {
        // Audit Bridge C-2: parse the Iris message header and assert
        // sourceDomain / destinationDomain / mintRecipient match what
        // we actually signed. A MITM that returns a real Circle-signed
        // message for a DIFFERENT burn would pass the on-chain signature
        // check but mint USDC into the attacker's recipient at the
        // victim's gas. Reject mismatched payloads here so the user
        // sees an error instead of paying gas to fund the attacker.
        const dstChainCfg = getCctpChain(step.dstId);
        const expectedRecipient = recipientOverride ?? account ?? "";
        const parsed = parseCctpV2Message(att.message);
        if (
          !parsed ||
          parsed.sourceDomain !== step.srcDomain ||
          (dstChainCfg && parsed.destinationDomain !== dstChainCfg.cctpDomain) ||
          (expectedRecipient && parsed.mintRecipient.toLowerCase() !==
            addressToBytes32(expectedRecipient as Address).toLowerCase())
        ) {
          // eslint-disable-next-line no-console
          console.warn("[CCTP] Iris payload mismatch, ignoring", { parsed });
          return false;
        }
        // Flip the matching history entry's badge from "Pending" -> "To claim"
        // so the user sees there's an action waiting on them. The mint
        // handler later flips status -> "minted" which supersedes this.
        const patch = { attestationReady: true } as const;
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
    // First poll right away so the user sees activity
    poll();
    const interval = setInterval(async () => {
      if (cancelled) return;
      const done = await poll();
      if (done) clearInterval(interval);
    }, 6_000);
    // Independent tick for the UI elapsed counter (1s granularity).
    const tickInterval = setInterval(() => {
      if (cancelled) return;
      setAttestElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(tickInterval);
    };
  }, [step]);

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
      const hash = await writeContractAsync({
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

  /** Manually drop a persisted pending claim - used when the user wants to
   * stop watching an old burn (e.g. they already claimed from another tab,
   * or the burn is stale). Does NOT touch on-chain state. */
  const discardPendingClaim = () => {
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
        balanceRaw={balRaw}
        showHalfMax
        onHalf={
          account && balRaw > 0n
            ? () => setAmountStr(formatUnits(balRaw / 2n, 6))
            : undefined
        }
        onMax={account && balRaw > 0n ? () => setAmountStr(formatUnits(balRaw, 6)) : undefined}
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
        amount={amountRaw > 0n ? formatUnits(estReceived, 6) : ""}
        onChainClick={() => setPicker("to")}
        disabled={isProcessing}
        balanceRaw={dstBalRaw}
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

      {/* Route info line - same style as SwapCard. Always visible when the
          chain pair is valid, even before the user types an amount.
          Fixed height so the row doesn't grow when the flash badge appears,
          which would otherwise push the CTA button down. */}
      {!sameChain && (
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
        {step.kind === "idle" || step.kind === "error" ? (
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

      {/* Pickers */}
      <ChainSelectModal
        open={picker === "from"}
        onClose={() => setPicker(null)}
        onSelect={handleSrcPick}
        selectedChainId={srcChainId}
        excludeChainId={dstChainId}
        title="Select source chain"
      />
      <ChainSelectModal
        open={picker === "to"}
        onClose={() => setPicker(null)}
        onSelect={handleDstPick}
        selectedChainId={dstChainId}
        excludeChainId={srcChainId}
        title="Select destination chain"
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

      {/* Amount */}
      {readOnlyAmount ? (
        <div className="text-4xl font-medium leading-tight tabular-nums text-arc-text">
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
          className="arc-input w-full bg-transparent text-4xl font-medium leading-tight"
          aria-label="Amount"
        />
      )}

      {/* Footer: USD value + (HALF/MAX or recipient) */}
      <div className="mt-2 flex items-center justify-between text-xs">
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
