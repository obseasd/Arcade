"use client";

import { CheckCircle2, Coins, ExternalLink, Twitter, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Address, formatUnits, isAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { erc20Abi } from "viem";
import { TWITTER_ESCROW_V3_ABI } from "@/lib/abis/twitterEscrowV3";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { removePendingClaim, savePendingClaim } from "@/lib/pendingClaims";
import { ADDRESSES, LAUNCHPAD_TOKEN_DECIMALS, USDC_DECIMALS } from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { cn, formatAddress, formatToken, formatUSDC } from "@/lib/utils";

export default function ClaimPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-2xl px-4 py-16 text-center text-arc-text-muted">Loading…</div>}>
      <ClaimPageInner />
    </Suspense>
  );
}

interface ClaimPayload {
  token: Address;
  positionId: string;
  slotIndex: number;
  recipient: Address;
  pairedToken: Address;
  pairedAmount: string;
  clankerToken: Address;
  clankerAmount: string;
  deadline: string;
  nonce: `0x${string}`;
  sig: `0x${string}`;
  handle: string;
}

function ClaimPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [submitting, setSubmitting] = useState(false);

  // sig-leak-through-browser-history-and-url-bar: claim data is delivered
  // via an HttpOnly cookie consumed by /api/claim/payload. We fetch it
  // once on mount. payloadStatus tracks the consume lifecycle: 'loading'
  // until the fetch lands, 'ready' on success, 'absent' on 404 (the user
  // navigated to /claim directly, no OAuth handshake just happened).
  const [payload, setPayload] = useState<ClaimPayload | null>(null);
  const [payloadStatus, setPayloadStatus] = useState<"loading" | "ready" | "absent">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/claim/payload", {
          credentials: "same-origin",
          // Audit Twitter Escrow H-6: custom header serves as a same-
          // origin XSS exfil guard. Only fetch() from our own app
          // context can set this; passive payload-load attacks (e.g.
          // <img src="/api/claim/payload">) cannot.
          headers: { "x-arcade-claim": "1" },
        });
        if (cancelled) return;
        if (res.status === 404) {
          setPayloadStatus("absent");
          return;
        }
        if (!res.ok) {
          setPayloadStatus("absent");
          return;
        }
        const data = (await res.json()) as ClaimPayload;
        if (cancelled) return;
        setPayload(data);
        setPayloadStatus("ready");
      } catch {
        if (!cancelled) setPayloadStatus("absent");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Error stays in URL params (the audit only flagged the signed data
  // leak, error codes are not sensitive).
  const error = params.get("error");
  const handle = payload?.handle ?? null;
  const token = payload?.token ?? null;
  const positionIdStr = payload?.positionId ?? null;
  const slotIndexStr = payload ? String(payload.slotIndex) : null;
  const recipient = payload?.recipient ?? null;
  const pairedToken = payload?.pairedToken ?? null;
  const pairedAmountStr = payload?.pairedAmount ?? null;
  const clankerToken = payload?.clankerToken ?? null;
  const clankerAmountStr = payload?.clankerAmount ?? null;
  const deadlineStr = payload?.deadline ?? null;
  const nonce = payload?.nonce ?? null;
  const sig = payload?.sig ?? null;

  const hasSigParams =
    token &&
    positionIdStr &&
    slotIndexStr !== null &&
    recipient &&
    pairedToken &&
    pairedAmountStr !== null &&
    clankerToken &&
    clankerAmountStr !== null &&
    deadlineStr !== null &&
    nonce &&
    sig;

  // --------------------------------------------------------------
  // Hooks live BEFORE the early returns. Rules of Hooks: every render
  // must call the same hooks in the same order. The prior layout had
  // these useReadContract() calls after `if (error)` / `if
  // (!hasSigParams)` returns, which means React saw N hooks on the
  // first render (error branch) and N+6 on the second (claim branch),
  // tripping the "rendered more hooks than during the previous render"
  // invariant. Each query is already gated by `query.enabled` so a
  // missing param parks the query in idle state - no extra RPC, no
  // crash, identical user-visible behaviour to the prior version.
  // --------------------------------------------------------------
  const escrow = ADDRESSES.twitterEscrow;
  const positionId = hasSigParams ? BigInt(positionIdStr!) : 0n;
  const slotIndex = hasSigParams ? BigInt(slotIndexStr!) : 0n;
  const pairedAmount = hasSigParams ? BigInt(pairedAmountStr!) : 0n;
  const clankerAmount = hasSigParams ? BigInt(clankerAmountStr!) : 0n;
  const deadline = hasSigParams ? BigInt(deadlineStr!) : 0n;

  const pairedSymbolQ = useReadContract({
    address: pairedToken ?? undefined,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: !!pairedToken && !!hasSigParams },
  });
  const tokenSymbolQ = useReadContract({
    address: token ?? undefined,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: !!token && !!hasSigParams },
  });
  // Check if already claimed on-chain.
  const claimedQ = useReadContract({
    address: escrow,
    abi: TWITTER_ESCROW_V3_ABI,
    functionName: "claimed",
    args: [positionId, slotIndex],
    query: { enabled: !!escrow && !!hasSigParams },
  });
  // Read the on-chain timelock so we can show the user a wait countdown.
  const timelockQ = useReadContract({
    address: escrow,
    abi: TWITTER_ESCROW_V3_ABI,
    functionName: "claimTimelock",
    query: { enabled: !!escrow && !!hasSigParams },
  });
  // Live escrow balances for both pots. If both are zero AND signed amounts
  // are zero too, the user landed here without anyone having called
  // locker.collectFees yet - the fees are sitting in the V3 pool. We then
  // run collectFees from the user's wallet as a "sync" step before the
  // authorize tx, so the contract's M-11 (`balances both 0`) check passes
  // and authorize succeeds. With H-04 sweep semantic the final claimByTwitter
  // transfers whatever balance is credited at that moment, signed amounts
  // act as a minimum (zero here).
  const balancePairedQ = useReadContract({
    address: escrow,
    abi: TWITTER_ESCROW_V3_ABI,
    functionName: "balances",
    args: [positionId, slotIndex, pairedToken ?? ("0x0000000000000000000000000000000000000000" as Address)],
    query: { enabled: !!escrow && !!pairedToken && !!hasSigParams },
  });
  const balanceClankerQ = useReadContract({
    address: escrow,
    abi: TWITTER_ESCROW_V3_ABI,
    functionName: "balances",
    args: [positionId, slotIndex, clankerToken ?? ("0x0000000000000000000000000000000000000000" as Address)],
    query: { enabled: !!escrow && !!clankerToken && !!hasSigParams },
  });

  if (error) {
    return <ErrorState error={error} />;
  }

  // Show a loading spinner while we consume the one-shot cookie. Without
  // this gate the page would briefly render the Lobby ("nothing to claim")
  // before the payload arrives, which is jarring after a successful
  // OAuth handshake.
  if (payloadStatus === "loading") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center text-arc-text-muted">
        Loading claim…
      </div>
    );
  }

  if (!hasSigParams) {
    return <Lobby />;
  }

  const pairedSymbol = (pairedSymbolQ.data as string | undefined) ?? "?";
  const tokenSymbol = (tokenSymbolQ.data as string | undefined) ?? "?";
  const isPairedUsdc = pairedToken!.toLowerCase() === ADDRESSES.usdc.toLowerCase();
  const pairedDecimals = isPairedUsdc ? USDC_DECIMALS : 18;
  const alreadyClaimed = !!(claimedQ.data as boolean | undefined);
  const timelockSec = Number((timelockQ.data as bigint | undefined) ?? 0n);
  const livePaired = (balancePairedQ.data as bigint | undefined) ?? 0n;
  const liveClanker = (balanceClankerQ.data as bigint | undefined) ?? 0n;
  const needsSync = livePaired === 0n && liveClanker === 0n;

  const expired = Date.now() / 1000 > Number(deadline);

  /**
   * V3 escrow flow: 2 tx
   *   1. `authorize(...)` with the EIP-712 sig - commits the claim on-chain,
   *      starts the timelock countdown.
   *   2. `claimByTwitter(nonce)` once `block.timestamp >= executeAfter` -
   *      transfers the tokens to the recipient.
   *
   * Testnet has `claimTimelock = 0` so both fire back-to-back. Mainnet (after
   * `setClaimTimelock(48h)`) will need a separate page revisit after the
   * window elapses; for now we polish only the testnet path.
   */
  const onClaim = async () => {
    if (!account) {
      pushToast({ kind: "error", title: "Connect a wallet first" });
      return;
    }
    if (account.toLowerCase() !== recipient!.toLowerCase()) {
      pushToast({
        kind: "error",
        title: "Wallet mismatch",
        message: "Connect the wallet you started the claim with.",
      });
      return;
    }
    setSubmitting(true);
    try {
      // --- Optional pre-step: sync fees from V3 pool to escrow ---
      // Triggered when nobody has called locker.collectFees yet, so the
      // escrow's per-slot balance is still 0 and a direct authorize would
      // revert with NothingToClaim. The collectFees call is permissionless;
      // the user pays the gas and the locker writes the slot's share into
      // escrow.balances via creditSlot, after which authorize succeeds.
      if (needsSync) {
        pushToast({ kind: "info", title: "Syncing fees from pool…" });
        const syncHash = await writeContractAsync({
          address: ADDRESSES.v3Locker,
          abi: V3_LOCKER_ABI,
          functionName: "collectFees",
          args: [positionId],
        });
        if (publicClient) await publicClient.waitForTransactionReceipt({ hash: syncHash });
        await balancePairedQ.refetch();
        await balanceClankerQ.refetch();
      }

      // --- Step 1: authorize the claim on-chain ---
      const authorizeHash = await writeContractAsync({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "authorize",
        args: [
          positionId,
          slotIndex,
          recipient!,
          pairedToken!,
          pairedAmount,
          clankerToken!,
          clankerAmount,
          deadline,
          nonce!,
          sig!,
        ],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: authorizeHash });

      // Persist the claim so the user can come back after the timelock
      // window elapses. Without this they'd lose the URL params after a
      // redirect and a fresh OAuth would mint a colliding nonce. Keyed by
      // (account, token, slotIndex) so re-running the flow on the same slot
      // overwrites the old entry.
      savePendingClaim({
        account: account as Address,
        token: token!,
        positionId: positionId.toString(),
        slotIndex: slotIndex.toString(),
        recipient: recipient!,
        pairedToken: pairedToken!,
        pairedAmount: pairedAmount.toString(),
        clankerToken: clankerToken!,
        clankerAmount: clankerAmount.toString(),
        deadline: deadline.toString(),
        nonce: nonce!,
        sig: sig!,
        executeAfter: Math.floor(Date.now() / 1000) + timelockSec,
        handle: handle ?? "",
        savedAt: Math.floor(Date.now() / 1000),
      });

      // --- Step 2: execute the claim (if timelock is 0, immediately) ---
      if (timelockSec > 0) {
        pushToast({
          kind: "info",
          title: "Step 1 done — claim authorized",
          message: `Your pending claim is saved. A banner on the token page will let you finalize it in ${Math.ceil(timelockSec / 60)} min.`,
        });
        router.replace(`/launchpad/${token}`);
        return;
      }

      const claimHash = await writeContractAsync({
        address: escrow,
        abi: TWITTER_ESCROW_V3_ABI,
        functionName: "claimByTwitter",
        args: [nonce!],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash: claimHash });
      // Clean up the pending-claim banner now that the claim is settled.
      removePendingClaim(account as Address, token!, slotIndex.toString());
      pushToast({
        kind: "info",
        title: "Claim confirmed",
        message: "Future fees route directly to your wallet.",
      });
      router.replace(`/launchpad/${token}`);
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6">
      <div className="arc-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Twitter className="h-5 w-5 text-arc-cta-hover" />
          <h1 className="text-lg font-semibold">Twitter claim</h1>
        </div>

        <div className="rounded-xl border border-arc-cta-hover/30 bg-arc-cta-hover/5 p-3 text-xs">
          <div className="flex items-center gap-1.5 text-arc-text-muted">
            <CheckCircle2 className="h-3 w-3 text-arc-success" />
            Verified as
            <span className="font-medium text-arc-text">@{handle}</span>
          </div>
          <div className="mt-2 text-arc-text-muted">
            Slot {slotIndex.toString()} of token{" "}
            <Link
              href={`/launchpad/${token}`}
              className="text-arc-text hover:underline"
            >
              ${tokenSymbol}
            </Link>{" "}
            ({formatAddress(token!)})
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {/* Show the LIVE escrow balance for each pot (what the claim will
              actually sweep, per H-04). Signed amounts are floors and may
              be zero when fees still sit in the V3 pool - the sync step
              below brings them in. */}
          <Row label={`${pairedSymbol} pending`} value={
            isPairedUsdc
              ? `$${formatUSDC(livePaired, pairedDecimals, 4)}`
              : `${formatUnits(livePaired, pairedDecimals)} ${pairedSymbol}`
          } />
          <Row label={`${tokenSymbol} pending`} value={`${formatToken(liveClanker, LAUNCHPAD_TOKEN_DECIMALS, 2)} ${tokenSymbol}`} />
          <Row label="Recipient" value={formatAddress(recipient!)} />
          <Row label="Deadline" value={new Date(Number(deadline) * 1000).toLocaleString()} />
        </div>

        {/* twitter-oauth-recipient-not-bound-to-handle: prominent warning
            when the recipient signed into the claim payload doesn't match
            the connected wallet. The contract refuses to settle this
            mismatch (authorize() requires recipient == msg.sender), but
            surfacing the discrepancy in the UI BEFORE the wallet popup
            tells the user they're being phished rather than letting the
            tx revert opaquely. */}
        {account && recipient && account.toLowerCase() !== recipient.toLowerCase() && (
          <div className="mt-4 rounded-xl border border-arc-danger/60 bg-arc-danger/15 p-3 text-xs text-arc-danger">
            <div className="font-semibold">Recipient mismatch</div>
            <div className="mt-1 leading-snug">
              This claim was signed for {formatAddress(recipient)}, but your
              connected wallet is {formatAddress(account)}. The on-chain
              authorize() will revert. If you didn't initiate this claim
              from the address shown above, this is likely a phishing link —
              disconnect and start the claim again from your own dashboard.
            </div>
          </div>
        )}

        {needsSync && !alreadyClaimed && !expired && (
          <div className="mt-4 rounded-xl border border-arc-cta-hover/30 bg-arc-cta-hover/5 p-3 text-xs text-arc-text-muted">
            Fees are still pending in the V3 pool. The claim button below
            will run two wallet transactions: first <span className="font-medium text-arc-text">sync from pool</span>,
            then <span className="font-medium text-arc-text">authorize claim</span>.
            After that the {timelockSec > 0 ? `${Math.ceil(timelockSec / 60)}-min` : "0-min"} timelock starts.
          </div>
        )}

        {alreadyClaimed && (
          <div className="mt-4 rounded-xl border border-arc-warn/30 bg-arc-warn/10 p-3 text-xs text-arc-warn">
            This slot has already been claimed. Future fees route directly to its current recipient.
          </div>
        )}
        {expired && !alreadyClaimed && (
          <div className="mt-4 rounded-xl border border-arc-danger/30 bg-arc-danger/10 p-3 text-xs text-arc-danger">
            Signature expired. Re-run the Twitter login to get a fresh one.
          </div>
        )}

        {(() => {
          const recipientMismatch =
            !!account && !!recipient && account.toLowerCase() !== recipient.toLowerCase();
          const disabled =
            submitting || alreadyClaimed || expired || !account || recipientMismatch;
          return (
            <button type="button"
              onClick={onClaim}
              disabled={disabled}
              className={cn(
                "mt-5 inline-flex w-full items-center justify-center gap-2 py-2.5 text-sm",
                "arc-button-primary",
                disabled && "opacity-60",
              )}
            >
              <Coins className="h-4 w-4" />
              {!account
                ? "Connect wallet to claim"
                : recipientMismatch
                ? "Wallet doesn't match signed recipient"
                : submitting
              ? "Confirming…"
              : alreadyClaimed
                ? "Already claimed"
                : expired
                  ? "Expired"
                  : needsSync
                    ? "Sync & claim fees"
                    : "Claim fees"}
            </button>
          );
        })()}
        <p className="mt-2 text-[10px] text-arc-text-faint">
          Submitting this transaction transfers the pending fees to your wallet and updates the on-chain
          recipient so future fees flow direct.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-arc-text-muted">{label}</span>
      <span className="tabular-nums font-medium text-arc-text">{value}</span>
    </div>
  );
}

// Audit 2026-06-11 FE-4: strict whitelist matching Twitter's documented
// handle charset + length. Same regex the OG image route runs (F-10). An
// invalid handle is silently dropped so an attacker can't share
// `?handle=victim_handle` to phish a user into thinking the slot was
// attributed to that account. The Lobby falls back to the generic
// "Enter the token address" copy when the handle fails validation.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function Lobby() {
  const params = useSearchParams();
  const prefilledToken = params.get("token") ?? "";
  const prefilledSlot = params.get("slot") ?? "0";
  const rawHandle = params.get("handle") ?? "";
  const prefilledHandle = HANDLE_RE.test(rawHandle) ? rawHandle : "";
  const [tokenInput, setTokenInput] = useState(prefilledToken);
  const [slot, setSlot] = useState(prefilledSlot);
  const { address: account } = useAccount();
  const ready = isAddress(tokenInput.trim()) && account;
  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6">
      <div className="arc-card space-y-4 p-6">
        <div className="flex items-center gap-2">
          <Twitter className="h-5 w-5 text-arc-cta-hover" />
          <h1 className="text-lg font-semibold">Twitter claim</h1>
        </div>
        {prefilledHandle ? (
          <div className="rounded-xl border border-arc-cta-hover/30 bg-arc-cta-hover/5 p-3 text-xs">
            <div className="text-arc-text-muted">Slot attributed to</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-base font-semibold text-arc-text">
              <Twitter className="h-3.5 w-3.5 text-arc-cta-hover" />@{prefilledHandle}
            </div>
            <div className="mt-1.5 text-[11px] text-arc-text-faint">
              Login with Twitter as @{prefilledHandle} to receive the accumulated LP fees and
              redirect future fees to your wallet.
            </div>
          </div>
        ) : (
          <p className="text-xs text-arc-text-muted">
            Enter the token address and recipient slot you were attributed. You will be sent to
            Twitter to verify ownership of the @handle, then come back here to confirm the claim.
          </p>
        )}
        {!prefilledToken && (
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="0x token address"
            className="arc-input w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-sm"
            aria-label="Token address"
          />
        )}
        {!prefilledToken && (
          <input
            value={slot}
            onChange={(e) => setSlot(e.target.value.replace(/[^0-9]/g, "") || "0")}
            placeholder="Slot index (usually 0)"
            inputMode="numeric"
            className="arc-input w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-sm"
            aria-label="Slot index"
          />
        )}
        {!account && (
          <p className="text-xs text-arc-warn">Connect your wallet first; the claim will pay to the connected address.</p>
        )}
        <a
          href={
            ready
              ? `/api/twitter-login?token=${tokenInput.trim()}&slotIndex=${slot}&recipient=${account}`
              : "#"
          }
          aria-disabled={!ready}
          className={cn(
            "arc-button-primary block w-full py-2.5 text-center text-sm",
            !ready && "pointer-events-none opacity-50",
          )}
        >
          Login with Twitter
        </a>
      </div>
    </div>
  );
}

function ErrorState({ error }: { error: string }) {
  const msg = {
    missing_params: "Missing parameters in the callback.",
    invalid_state: "Session expired or invalid.",
    bad_state: "Could not parse session data.",
    invalid_addresses: "Invalid token or recipient address.",
    server_misconfigured: "Server is missing Twitter credentials.",
    token_exchange_failed: "Twitter rejected the authorization code.",
    no_access_token: "No access token returned from Twitter.",
    me_failed: "Could not read your Twitter profile.",
    no_handle: "Could not read your Twitter @handle.",
    slot_not_attributed: "This slot is not Twitter-attributed.",
    handle_mismatch: "The Twitter @handle does not match this slot's attribution.",
    no_position: "Token has no V3 locked position.",
    slot_bps_zero: "Slot has zero share.",
    onchain_read_failed: "Could not read on-chain state.",
    nothing_to_claim:
      "No fees credited to this slot yet. If the token has had trades, the fees are still pending in the V3 pool — visit the token page and click \"Claim Fees\" to flush them into the escrow, then come back here.",
  }[error] ?? error;
  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6">
      <div className="arc-card p-6">
        <div className="flex items-center gap-2 text-arc-danger">
          <XCircle className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Claim failed</h1>
        </div>
        <p className="mt-3 text-sm text-arc-text-muted">{msg}</p>
        <Link href="/claim" className="mt-4 inline-flex items-center gap-1 text-sm text-arc-primary hover:underline">
          Try again <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
