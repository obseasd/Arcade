"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Address } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatAddress } from "@/lib/utils";
import { pushToast } from "@/lib/toast";
import { TxStatus, type TxState } from "@/components/ui/TxStatus";
import {
  MAX_COMMENT_LEN,
  fetchTokenComments,
  postCommentOnChain,
  type OnchainComment,
} from "@/lib/commentsOnchain";

interface Props {
  token: Address;
}

export function Comments({ token }: Props) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const [text, setText] = useState("");
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const [comments, setComments] = useState<OnchainComment[]>([]);
  const [loading, setLoading] = useState(true);
  // Comments the user just posted, shown optimistically until the subgraph
  // indexes them (keyed by txHash so a later refetch dedupes them out).
  const [pending, setPending] = useState<OnchainComment[]>([]);
  const seen = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    const rows = await fetchTokenComments(token);
    setComments(rows);
    for (const r of rows) seen.current.add(r.txHash.toLowerCase());
    // Drop optimistic entries the subgraph has now caught up on.
    setPending((p) => p.filter((c) => !seen.current.has(c.txHash.toLowerCase())));
    setLoading(false);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const rows = await fetchTokenComments(token);
      if (cancelled) return;
      setComments(rows);
      for (const r of rows) seen.current.add(r.txHash.toLowerCase());
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const { writeContractAsync } = useWriteContract();
  const onPost = async () => {
    if (!account || !text.trim()) return;
    setTx({ status: "pending", message: "Posting comment…" });
    try {
      const body = text.trim().slice(0, MAX_COMMENT_LEN);
      const hash = await postCommentOnChain(writeContractAsync, account, token, body);
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      // Optimistic: show it immediately; the subgraph read will supersede it.
      if (!seen.current.has(hash.toLowerCase())) {
        setPending((p) => [
          {
            id: hash,
            author: account,
            text: body,
            blockTime: Math.floor(Date.now() / 1000),
            txHash: hash,
          },
          ...p,
        ]);
      }
      setText("");
      setTx({ status: "idle" });
      pushToast({ kind: "info", title: "Comment posted on-chain" });
      // Give the indexer a moment, then reconcile.
      setTimeout(() => void load(), 4000);
    } catch (e: any) {
      setTx({ status: "error", message: e?.shortMessage || e?.message || "Failed" });
    }
  };

  // Merge optimistic + indexed, newest first, deduped by txHash.
  const merged: OnchainComment[] = [];
  const dedupe = new Set<string>();
  for (const c of [...pending, ...comments]) {
    const k = c.txHash.toLowerCase();
    if (dedupe.has(k)) continue;
    dedupe.add(k);
    merged.push(c);
  }
  merged.sort((a, b) => b.blockTime - a.blockTime);

  return (
    <div className="arc-card p-5">
      <h3 className="mb-3 text-base font-semibold">Comments</h3>
      <div className="mb-4">
        <textarea
          aria-label="New comment"
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_COMMENT_LEN))}
          rows={2}
          placeholder={
            account ? `Say something… (${MAX_COMMENT_LEN} chars max)` : "Connect a wallet to comment"
          }
          disabled={!account}
          className="arc-input w-full resize-none rounded-xl border border-arc-border bg-arc-bg-elevated px-3 py-2 text-sm"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-arc-text-faint">
            {text.length}/{MAX_COMMENT_LEN}
          </span>
          <button
            type="button"
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
        {!loading && merged.length === 0 && (
          <div className="rounded-xl border border-dashed border-arc-border py-6 text-center text-sm text-arc-text-muted">
            No comments yet. Be the first.
          </div>
        )}
        {merged.map((c) => {
          const isSelf = account && c.author.toLowerCase() === account.toLowerCase();
          const isPending = !seen.current.has(c.txHash.toLowerCase());
          return (
            <div
              key={c.id}
              className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3"
            >
              <div className="flex items-center justify-between text-xs text-arc-text-muted">
                <span className={isSelf ? "font-medium text-arc-primary" : "tabular-nums"}>
                  {isSelf ? "You" : formatAddress(c.author)}
                </span>
                <span className="flex items-center gap-2">
                  {isPending && <span className="text-arc-text-faint">pending…</span>}
                  <span>{new Date(c.blockTime * 1000).toLocaleString()}</span>
                </span>
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words text-sm">{c.text}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
