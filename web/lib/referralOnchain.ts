import {
    Address,
    keccak256,
    toHex,
    getAddress,
    parseAbi,
    toEventSelector,
    decodeAbiParameters,
    type PublicClient,
} from "viem";

/**
 * On-chain referral attribution via Arc's Memo contract.
 *
 * The Phase-1 referral flow (see referral.ts) stores first-touch in Postgres
 * through UNAUTHENTICATED /api/referral/* routes, so anyone can land-grab an
 * attribution, inflate accrual, or self-refer (audit 2026-06-28: C-1/H-1/H-2).
 * It is only "safe" because Phase 1 moves no money.
 *
 * This module makes the first-touch link UNFORGEABLE by anchoring it on-chain:
 * the referred user themselves signs a Memo tx tagging their referrer. The
 * Memo contract routes the (no-op self) call through Arc's callFrom precompile
 * and emits `Memo(sender = the signer, memoId, memo = referrer)`. Because
 * `sender` is the tx signer, nobody can register a referral on someone else's
 * behalf, and first-touch = the earliest Memo per sender. Volume/earnings are
 * still computed off these events + swap events by the indexer; the ledger of
 * WHO-referred-WHOM is now on-chain and tamper-proof.
 *
 * Validated on-chain 2026-07-08: a real `memo(self, 0x, id, referrer)` tx
 * emitted the event with sender = signer and memo = referrer.
 */

/** Memo predeploy (Arc testnet). Wraps the callFrom precompile (0x18..03). */
export const MEMO_ADDRESS: Address =
    "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

/** Namespaced memo id so referral tags never collide with other Memo uses. */
export const REFERRAL_MEMO_ID = keccak256(toHex("arcade:ref"));

const MEMO_ABI = parseAbi([
    "function memo(address target, bytes data, bytes32 memoId, bytes memoData)",
]);

// Raw event topic0. We filter/decode by topics + decodeAbiParameters rather
// than viem's `event` getLogs filter: on Arc the event-object filter threw
// "RPC Request failed" on some windows, and parseAbi's event-signature hash
// did not match the on-chain topic0, so the manual path is the reliable one.
// Verified on-chain 2026-07-08 (topic0 = 0xeb15ee72…, decode returns referrer).
const MEMO_EVENT_TOPIC0 = toEventSelector(
    "Memo(address,address,bytes32,bytes32,bytes,uint256)",
);

/** Arc `eth_getLogs` window (documented range cap; mirror stats.ts). */
// Arc's eth_getLogs rejects ranges wider than ~10k blocks with an opaque "HTTP
// request failed" / "Request exceeds defined limit" (verified on-chain
// 2026-07-23: 10k OK, 20k+ errors). The old 45k window therefore FAILED every
// call, and because a failed window was swallowed as [], the whole scan
// silently returned zero attributions -- so no referred wallet was ever seen as
// confirmed and nobody could be paid, even though the Memos were on-chain and
// valid. Stay comfortably under the limit.
const BLOCK_WINDOW = 10_000n;
/** How far back to scan for referral tags (bounded until the indexer lands). */
const MAX_SCAN_BLOCKS = 2_000_000n;
/** Concurrent getLogs in flight. 2M / 10k = ~200 windows; firing them all at
 *  once rate-limits the public RPC, serialising them takes over a minute.
 *  Measured on-chain: 40-wide clears the full 2M scan in ~14s. */
const SCAN_CONCURRENCY = 40;
/** Per-window retries: Arc getLogs is transiently flaky even within the range
 *  limit ("HTTP request failed" on a window that succeeds on retry). */
const WINDOW_RETRIES = 3;

/**
 * writeContract args to register `referrer` as the caller's first-touch
 * referrer on-chain. The call is a no-op self-call (target = the user, empty
 * data) whose only purpose is to emit the Memo event; `memoData` carries the
 * referrer address left-padded to 32 bytes. The connected wallet must sign it,
 * which is exactly what makes the `sender` field unforgeable.
 */
export function registerReferrerCall(account: Address, referrer: Address) {
    return {
        address: MEMO_ADDRESS,
        abi: MEMO_ABI,
        functionName: "memo" as const,
        args: [
            account, // target: no-op self-call, just to emit the memo
            "0x" as `0x${string}`, // data: empty (self-call succeeds)
            REFERRAL_MEMO_ID,
            referrer as `0x${string}`, // memoData: the referrer, ABI-decodes as address
        ] as const,
    };
}

/**
 * Anchor the caller's first-touch referrer on-chain by signing a Memo tx.
 * The connected wallet is the `sender` of the emitted event, which is what
 * makes the attribution unforgeable. Reverts on self-referral. Returns the
 * tx hash.
 */
export async function registerReferrerOnChain(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContractAsync: (args: any) => Promise<`0x${string}`>,
    account: Address,
    referrer: Address,
    chainId?: number,
): Promise<`0x${string}`> {
    if (referrer.toLowerCase() === account.toLowerCase()) {
        throw new Error("You cannot refer yourself");
    }
    const call = registerReferrerCall(account, referrer);
    return writeContractAsync(chainId ? { ...call, chainId } : call);
}

export interface OnchainReferral {
    /** The referred wallet (the Memo signer — unforgeable). */
    referred: Address;
    /** The referrer they tagged. */
    referrer: Address;
    /** Block the tag landed in (used for first-touch = earliest). */
    blockNumber: bigint;
}

/**
 * Decode (referred, referrer) from a raw Memo log. topic1 = the signer
 * (referred, unforgeable); the non-indexed data ABI-encodes
 * (bytes32 callDataHash, bytes memo, uint256 memoIndex) where `memo` is the
 * referrer address bytes we passed as memoData. Guards empty/short data
 * (some Memo txs carry no payload).
 */
function decodeMemoLog(log: {
    topics: readonly `0x${string}`[];
    data: `0x${string}`;
    blockNumber: bigint | null;
}): { referred: Address; referrer: Address; blockNumber: bigint } | null {
    try {
        const referredTopic = log.topics[1];
        if (!referredTopic) return null;
        const referred = getAddress(("0x" + referredTopic.slice(26)) as `0x${string}`);
        if (!log.data || log.data === "0x" || log.data.length < 130) return null;
        const [, memo] = decodeAbiParameters(
            [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
            log.data,
        ) as [unknown, `0x${string}`, unknown];
        if (!memo || memo.length < 42) return null;
        const referrer = getAddress(("0x" + memo.slice(2).slice(-40)) as `0x${string}`);
        return { referred, referrer, blockNumber: log.blockNumber ?? 0n };
    } catch {
        return null;
    }
}

/**
 * Scan Memo events tagged with REFERRAL_MEMO_ID and reduce to first-touch
 * attribution (earliest tag per referred wallet wins, self-referral dropped).
 * Optionally filter to a single `referrer` to power their dashboard.
 *
 * Windows are scanned back from head in BLOCK_WINDOW chunks; a failed window
 * is skipped so one flaky range never sinks the whole read. Replace with an
 * indexed GraphQL read once the indexer ships (see indexer roadmap).
 */
export async function scanReferralAttribution(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: PublicClient | any,
    opts?: { referrer?: Address },
): Promise<OnchainReferral[]> {
    const head: bigint = await publicClient.getBlockNumber();
    const from = head > MAX_SCAN_BLOCKS ? head - MAX_SCAN_BLOCKS : 0n;

    const windows: Array<{ from: bigint; to: bigint }> = [];
    for (let f = from; f <= head; f += BLOCK_WINDOW) {
        const to = f + BLOCK_WINDOW - 1n > head ? head : f + BLOCK_WINDOW - 1n;
        windows.push({ from: f, to });
    }

    const scanWindow = async ({ from: f, to }: { from: bigint; to: bigint }) => {
        for (let attempt = 0; attempt < WINDOW_RETRIES; attempt++) {
            try {
                // topic0 = Memo. We pass topic3 = our memoId as a HINT, but Arc's
                // getLogs does NOT honour indexed-topic filters beyond topic0
                // (verified on-chain 2026-07-23: the filtered and unfiltered
                // counts are identical), so every Memo in range comes back and we
                // re-filter by memoId in JS below. Without that re-check, long
                // non-referral memos (agent payloads, order refs) would be decoded
                // into bogus attributions.
                return await publicClient.getLogs({
                    address: MEMO_ADDRESS,
                    fromBlock: f,
                    toBlock: to,
                    topics: [MEMO_EVENT_TOPIC0, null, null, REFERRAL_MEMO_ID],
                });
            } catch {
                // transient: retry; only give up (and return []) after the last
                // attempt. A silently-dropped window under-credits attribution.
            }
        }
        return [] as Awaited<ReturnType<typeof publicClient.getLogs>>;
    };

    // Bounded-concurrency pool over the windows.
    const perWindow: Awaited<ReturnType<typeof publicClient.getLogs>>[] = [];
    for (let i = 0; i < windows.length; i += SCAN_CONCURRENCY) {
        const batch = windows.slice(i, i + SCAN_CONCURRENCY);
        const res = await Promise.all(batch.map(scanWindow));
        perWindow.push(...res);
    }

    const refIdLc = REFERRAL_MEMO_ID.toLowerCase();
    // First-touch: keep the earliest tag per referred wallet.
    const firstByReferred = new Map<string, OnchainReferral>();
    for (const logs of perWindow) {
        for (const log of logs) {
            // Enforce the memoId in JS: Arc returned every memo regardless of the
            // topic3 filter, so this is what actually keeps non-referral memos
            // out of attribution.
            if ((log.topics?.[3] ?? "").toLowerCase() !== refIdLc) continue;
            const decoded = decodeMemoLog(log);
            if (!decoded) continue;
            const { referred, referrer, blockNumber } = decoded;
            if (referrer.toLowerCase() === referred.toLowerCase()) continue; // no self-referral
            const key = referred.toLowerCase();
            const prev = firstByReferred.get(key);
            if (!prev || blockNumber < prev.blockNumber) {
                firstByReferred.set(key, { referred, referrer, blockNumber });
            }
        }
    }

    let out = [...firstByReferred.values()];
    if (opts?.referrer) {
        const r = opts.referrer.toLowerCase();
        out = out.filter((x) => x.referrer.toLowerCase() === r);
    }
    return out;
}
