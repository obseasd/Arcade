import {
    Address,
    encodeAbiParameters,
    keccak256,
    toHex,
} from "viem";

/**
 * On-chain launchpad comments via Arc's Memo predeploy.
 *
 * The legacy ArcadeLaunchpad stored comments as expensive on-chain `string`s and
 * gated `postComment` on its `tokens[]` registry, which the V4 hook never
 * populates -> every post on a V4-hook token reverts `UnknownToken()`, so the
 * V4-hook token page shipped with comments disabled.
 *
 * This module brings comments to EVERY launchpad token (curve/CLANKER/graduated)
 * with NO contract redeploy, by reusing the same Memo predeploy the referral
 * attribution already rides (see referralOnchain.ts). The author signs a no-op
 * self-call that emits `Memo(sender = author, memoId = arcade:comment, memo =
 * abi(token, text))`. Because `sender` is the tx signer, the author is
 * unforgeable. The subgraph indexes these into `Comment` entities keyed to the
 * token, and the token page reads them back from Goldsky.
 */

/** Memo predeploy (Arc). Wraps the callFrom precompile; passes memoData through
 *  unchanged into the emitted event's `memo` field. Same address as referrals. */
export const MEMO_ADDRESS: Address =
    "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

/** Namespaced memo id for comments: keccak256("arcade:comment"). Distinct from
 *  the referral id so handleMemo routes the two apart. Kept as a literal in the
 *  subgraph (graph-ts has no keccak at map time) -- keep both in sync. */
export const COMMENT_MEMO_ID = keccak256(toHex("arcade:comment"));
// = 0x58f411c95f54351dd120300e1d77a597298a00f2ca99fa31c7adaa8feae8330b

/** UI + on-chain cap. The memo is event calldata (not storage), so a full
 *  comment is cheap; we keep the legacy 280-char limit for parity. */
export const MAX_COMMENT_LEN = 280;

const MEMO_ABI = [
    {
        type: "function",
        name: "memo",
        stateMutability: "nonpayable",
        inputs: [
            { name: "target", type: "address" },
            { name: "data", type: "bytes" },
            { name: "memoId", type: "bytes32" },
            { name: "memoData", type: "bytes" },
        ],
        outputs: [],
    },
] as const;

/**
 * memoData = abi.encode(address token, string text). This is the head/tail
 * param-list layout that graph-ts `ethereum.decode("(address,string)", ...)`
 * reads directly (no leading offset), so encode and decode stay in lockstep.
 */
export function encodeCommentMemoData(token: Address, text: string): `0x${string}` {
    return encodeAbiParameters(
        [{ type: "address" }, { type: "string" }],
        [token, text],
    );
}

/** writeContract args to post `text` as an on-chain comment on `token`. The
 *  call is a no-op self-call (target = author, empty data) whose only purpose
 *  is to emit the Memo event; the connected wallet must sign it, which is what
 *  makes the `sender`/author field unforgeable. */
export function postCommentCall(account: Address, token: Address, text: string) {
    return {
        address: MEMO_ADDRESS,
        abi: MEMO_ABI,
        functionName: "memo" as const,
        args: [
            account, // target: no-op self-call, just to emit the memo
            "0x" as `0x${string}`, // data: empty (self-call succeeds)
            COMMENT_MEMO_ID,
            encodeCommentMemoData(token, text),
        ] as const,
    };
}

/** Post an on-chain comment. Trims + hard-caps the text, rejects empty. Returns
 *  the tx hash. */
export async function postCommentOnChain(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContractAsync: (args: any) => Promise<`0x${string}`>,
    account: Address,
    token: Address,
    text: string,
    chainId?: number,
): Promise<`0x${string}`> {
    const trimmed = text.trim().slice(0, MAX_COMMENT_LEN);
    if (!trimmed) throw new Error("Empty comment");
    const call = postCommentCall(account, token, trimmed);
    return writeContractAsync(chainId ? { ...call, chainId } : call);
}

export interface OnchainComment {
    id: string;
    author: Address;
    text: string;
    blockTime: number;
    txHash: `0x${string}`;
}

/**
 * Read a token's comments from the Goldsky subgraph (the durable, indexed
 * source). Returns newest-first. Fails soft to [] if the subgraph URL is unset
 * or the `Comment` entity is not on the pointed tag yet (so the UI never
 * crashes before the re-index/re-tag lands).
 */
export async function fetchTokenComments(token: Address): Promise<OnchainComment[]> {
    const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
    if (!url) return [];
    const query = `query($token: Bytes!) {
      comments(where: { token: $token }, orderBy: blockTime, orderDirection: desc, first: 200) {
        id author text blockTime txHash
      }
    }`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, variables: { token: token.toLowerCase() } }),
        });
        if (!res.ok) return [];
        const json = await res.json();
        const rows = json?.data?.comments;
        if (!Array.isArray(rows)) return [];
        return rows.map((r: Record<string, unknown>) => ({
            id: String(r.id),
            author: r.author as Address,
            text: String(r.text ?? ""),
            blockTime: Number(r.blockTime ?? 0),
            txHash: r.txHash as `0x${string}`,
        }));
    } catch {
        return [];
    }
}
