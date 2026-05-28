"use client";

import { Crown, Pencil, Coins } from "lucide-react";
import { useMemo, useState } from "react";
import { Address, isAddress } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { V3_LOCKER_ABI } from "@/lib/abis/v3";
import { ADDRESSES } from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { Modal } from "@/components/ui/Modal";
import { cn, formatAddress } from "@/lib/utils";

interface Props {
  /** Clanker token (mode=2). */
  token: Address;
  symbol: string;
}

interface Recipient {
  recipient: Address;
  admin: Address;
  bps: number;
  tokenPref: number;
}

/**
 * Shown on the token detail page when the connected wallet is a recipient or
 * admin on this Clanker's locked position. Lets you:
 *   - Claim accrued LP fees (permissionless; pays each recipient their bps share).
 *   - Rotate your recipient payout address (admin-only per slot).
 *   - Rotate your admin (admin-only per slot).
 *
 * BPS splits are immutable post-launch (by contract design).
 */
export function CreatorTokenPanel({ token, symbol }: Props) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [editing, setEditing] = useState<{ index: number; kind: "recipient" | "admin" } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 1) positionId for this token.
  const posIdQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "positionIdByToken",
    args: [token],
    query: {
      enabled: ADDRESSES.v3Locker !== ("0x0000000000000000000000000000000000000000" as Address),
    },
  });
  const positionId = (posIdQ.data as bigint | undefined) ?? 0n;

  // 2) Recipients list.
  const recsQ = useReadContract({
    address: ADDRESSES.v3Locker,
    abi: V3_LOCKER_ABI,
    functionName: "getRecipients",
    args: [positionId],
    query: { enabled: positionId > 0n },
  });
  const recipients = (recsQ.data as Recipient[] | undefined) ?? [];

  // 3) My membership.
  const { isMine, mySlots } = useMemo(() => {
    if (!account) return { isMine: false, mySlots: [] as number[] };
    const acc = account.toLowerCase();
    const slots: number[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (r.recipient.toLowerCase() === acc || r.admin.toLowerCase() === acc) slots.push(i);
    }
    return { isMine: slots.length > 0, mySlots: slots };
  }, [account, recipients]);

  if (positionId === 0n) return null;

  const claim = async () => {
    if (!account) {
      pushToast({ kind: "error", title: "Connect a wallet to claim" });
      return;
    }
    setClaiming(true);
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Locker,
        abi: V3_LOCKER_ABI,
        functionName: "collectFees",
        args: [positionId],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "info", title: "Fees claimed", message: `${symbol} LP fees distributed` });
    } catch (e: any) {
      pushToast({ kind: "error", title: "Claim failed", message: e?.shortMessage || e?.message });
    } finally {
      setClaiming(false);
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    if (!isAddress(editValue.trim())) {
      pushToast({ kind: "error", title: "Invalid address" });
      return;
    }
    setEditSubmitting(true);
    try {
      const fn = editing.kind === "recipient" ? "updateRecipient" : "updateAdmin";
      const hash = await writeContractAsync({
        address: ADDRESSES.v3Locker,
        abi: V3_LOCKER_ABI,
        functionName: fn,
        args: [positionId, BigInt(editing.index), editValue.trim() as Address],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      pushToast({
        kind: "info",
        title: editing.kind === "recipient" ? "Recipient updated" : "Admin updated",
      });
      setEditing(null);
      setEditValue("");
      recsQ.refetch();
    } catch (e: any) {
      pushToast({ kind: "error", title: "Update failed", message: e?.shortMessage || e?.message });
    } finally {
      setEditSubmitting(false);
    }
  };

  const tokenPrefLabel = (p: number) => (p === 0 ? "Both" : p === 1 ? "Paired" : "Clanker");

  return (
    <div className="arc-card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Crown className="h-4 w-4 text-arc-cta-hover" />
        <h3 className="text-base font-semibold">Creator panel</h3>
      </div>
      <p className="mb-4 text-xs text-arc-text-muted">
        {isMine
          ? "You're a recipient on this Clanker's locked V3 position. Claim accrued LP fees; rotate your payout/admin address per slot (BPS splits are immutable on-chain)."
          : "Anyone can trigger a claim — LP fees always route to the registered recipients below, never to the caller."}
      </p>

      <div className="space-y-2">
        {recipients.map((r, i) => {
          const isMineSlot = mySlots.includes(i);
          const acc = account?.toLowerCase() ?? "";
          const iAmAdmin = acc.length > 0 && r.admin.toLowerCase() === acc;
          const iAmRecipient = acc.length > 0 && r.recipient.toLowerCase() === acc;
          const isTreasury = r.recipient.toLowerCase() === ADDRESSES.usdc.toLowerCase()
            ? false
            : i === recipients.length - 1 && r.bps === 2000;
          return (
            <div
              key={i}
              className={cn(
                "rounded-xl border p-3 text-xs",
                isMineSlot
                  ? "border-arc-cta-hover/40 bg-arc-cta-hover/5"
                  : "border-arc-border bg-arc-bg-elevated",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-arc-text">{formatAddress(r.recipient)}</span>
                  {iAmRecipient && (
                    <span className="rounded-full bg-arc-cta-hover/15 px-1.5 py-0.5 text-[10px] font-medium text-arc-text">
                      You
                    </span>
                  )}
                  {isTreasury && (
                    <span className="rounded-full bg-arc-surface-2 px-1.5 py-0.5 text-[10px] text-arc-text-muted">
                      Platform
                    </span>
                  )}
                </div>
                <span className="tabular-nums font-medium text-arc-text">
                  {(r.bps / 100).toFixed(r.bps % 100 === 0 ? 0 : 1)}%
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-arc-text-faint">
                <span>
                  Admin: <span className="font-mono">{formatAddress(r.admin)}</span>
                  {iAmAdmin && <span className="ml-1 text-arc-cta-hover">(you)</span>}
                </span>
                <span>Pref: {tokenPrefLabel(r.tokenPref)}</span>
              </div>
              {iAmAdmin && !isTreasury && (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => {
                      setEditing({ index: i, kind: "recipient" });
                      setEditValue(r.recipient);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-arc-border bg-arc-surface-2 px-2 py-1 text-[11px] hover:bg-arc-surface-3"
                  >
                    <Pencil className="h-3 w-3" /> Recipient
                  </button>
                  <button
                    onClick={() => {
                      setEditing({ index: i, kind: "admin" });
                      setEditValue(r.admin);
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-arc-border bg-arc-surface-2 px-2 py-1 text-[11px] hover:bg-arc-surface-3"
                  >
                    <Pencil className="h-3 w-3" /> Admin
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={claim}
        disabled={claiming}
        className={cn(
          "mt-4 inline-flex w-full items-center justify-center gap-2 py-2.5 text-sm",
          "arc-button-primary",
          claiming && "opacity-60",
        )}
      >
        <Coins className="h-4 w-4" />
        {claiming ? "Claiming…" : "Claim LP fees"}
      </button>
      <p className="mt-2 text-[10px] text-arc-text-faint">
        Claiming is permissionless and pays every recipient their bps share.
      </p>

      <Modal
        open={editing !== null}
        onClose={() => {
          if (!editSubmitting) {
            setEditing(null);
            setEditValue("");
          }
        }}
        widthClassName="max-w-sm"
      >
        <div className="space-y-4 p-5">
          <h3 className="text-base font-semibold">
            {editing?.kind === "recipient" ? "Update payout address" : "Update admin"}
          </h3>
          <p className="text-xs text-arc-text-muted">
            {editing?.kind === "recipient"
              ? "Where future LP-fee claims for your slot get sent."
              : "Who can rotate this slot's recipient/admin in the future. Be careful: setting this transfers control."}
          </p>
          <input
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder="0x…"
            className="arc-input w-full rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 font-mono text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!editSubmitting) {
                  setEditing(null);
                  setEditValue("");
                }
              }}
              disabled={editSubmitting}
              className="arc-button-secondary flex-1 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={submitEdit}
              disabled={editSubmitting || !isAddress(editValue.trim())}
              className="arc-button-primary flex-1 py-2 text-sm"
            >
              {editSubmitting ? "Updating…" : "Confirm"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
