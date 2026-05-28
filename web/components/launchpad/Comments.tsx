"use client";

import { useEffect, useState } from "react";
import { Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES } from "@/lib/constants";
import { formatAddress } from "@/lib/utils";
import { pushToast } from "@/lib/toast";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";

interface Props {
  token: Address;
}

interface CommentItem {
  author: Address;
  timestamp: bigint;
  text: string;
}

export function Comments({ token }: Props) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [text, setText] = useState("");
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const countQ = useReadContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "getCommentsCount",
    args: [token],
  });

  const count = Number((countQ.data as bigint | undefined) ?? 0n);

  useEffect(() => {
    if (!publicClient || count === 0) {
      setComments([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const result = (await publicClient.readContract({
          address: ADDRESSES.launchpad,
          abi: LAUNCHPAD_ABI,
          functionName: "getComments",
          args: [token, 0n, BigInt(count)],
        })) as CommentItem[];
        if (!cancelled) {
          // Reverse: newest first
          setComments([...result].reverse());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, token, count]);

  const { writeContractAsync } = useWriteContract();
  const onPost = async () => {
    if (!account || !text.trim()) return;
    setTx({ status: "pending", message: "Posting comment…" });
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.launchpad,
        abi: LAUNCHPAD_ABI,
        functionName: "postComment",
        args: [token, text.trim()],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      setText("");
      setTx({ status: "idle" });
      countQ.refetch();
      pushToast({ kind: "info", title: "Comment posted" });
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Failed" });
    }
  };

  return (
    <div className="arc-card p-5">
      <h3 className="mb-3 text-base font-semibold">Comments</h3>
      <div className="mb-4">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 280))}
          rows={2}
          placeholder={account ? "Say something… (280 chars max)" : "Connect a wallet to comment"}
          disabled={!account}
          className="arc-input w-full resize-none rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-arc-text-faint">{text.length}/280</span>
          <button
            onClick={onPost}
            disabled={!account || !text.trim() || tx.status === "pending"}
            className="arc-button-primary px-4 py-1.5 text-sm"
          >
            Post
          </button>
        </div>
        <TxStatus state={tx} className="mt-2" />
      </div>

      <div className="space-y-3">
        {loading && <div className="text-sm text-arc-text-muted">Loading comments…</div>}
        {!loading && comments.length === 0 && (
          <div className="rounded-xl border border-dashed border-arc-border py-6 text-center text-sm text-arc-text-muted">
            No comments yet. Be the first.
          </div>
        )}
        {comments.map((c, i) => {
          const isSelf = account && c.author.toLowerCase() === account.toLowerCase();
          return (
            <div key={i} className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3">
              <div className="flex items-center justify-between text-xs text-arc-text-muted">
                <span className={isSelf ? "font-medium text-arc-primary" : "tabular-nums"}>
                  {isSelf ? "You" : formatAddress(c.author)}
                </span>
                <span>{new Date(Number(c.timestamp) * 1000).toLocaleString()}</span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm">{c.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
