import {
    verifyTypedData,
    createPublicClient,
    createWalletClient,
    http,
    parseUnits,
    erc20Abi,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getSql, isDbConfigured } from "@/lib/db";
import { arcTestnet } from "@/lib/chains";
import { ADDRESSES } from "@/lib/constants";
import { scanReferralAttribution } from "@/lib/referralOnchain";
import { getReferralBaselines } from "@/lib/referralPersistence";

/**
 * Earnings model (Phase 2). Referral pays 10% of the PROTOCOL fee a referred
 * wallet paid. We credit the wallet's on-chain USDC trade volume (from the
 * Goldsky subgraph's per-Trader running total) times the protocol-fee bps times
 * the 10% share:
 *   earnings = volume * PROTOCOL_FEE_BPS/10000 * REFERRAL_SHARE_BPS/10000
 * PROTOCOL_FEE_BPS defaults to 15 (0.15%, the graduated pair's LAUNCH_PROTOCOL_BPS)
 * -- a CONSERVATIVE floor: the curve take is higher (1%), so this under-credits
 * rather than over-pays. Tune via env once the exact per-source split is pinned.
 * The hard safety is elsewhere: only on-chain-VERIFIED referred wallets count,
 * and every payout is bounded by the funded REFERRAL_PAYOUT_PRIVATE_KEY budget
 * wallet (a transfer beyond its balance simply reverts).
 */
// Clamped to [0, 100] bps: 100 bps (1%) is the curve's full TRADE_FEE_BPS, so
// the protocol PORTION can never exceed it. Prevents a misconfigured env from
// over-crediting (defensive; the funded budget wallet is still the hard cap).
// CANONICAL fee basis for the ENTIRE referral system (audit C-3). Every place
// that turns trade volume into a referral "earned" number -- the payout math
// here AND the display accrual in /api/referral/track -- MUST derive from this
// one constant (via computeReferralEarningsMicros) so the number a user SEES
// can never disagree with the number a claim PAYS. Before this, /track used a
// hardcoded 5 bps while the payout used 15, so the dashboard showed one figure
// and the claim settled another.
export const PROTOCOL_FEE_BPS = (() => {
    let v = 15n;
    try {
        v = BigInt(process.env.REFERRAL_PROTOCOL_FEE_BPS ?? "15");
    } catch {
        v = 15n;
    }
    if (v < 0n) return 0n;
    return v > 100n ? 100n : v;
})();
export const REFERRAL_SHARE_BPS = 1000n; // 10%
// Cap the wallets summed per claim so a huge downlist can't blow the request.
const MAX_REFERRED_WALLETS = 500;

/**
 * Referral PAYOUT layer (Phase 2). Disabled by default and built so the two
 * indexer/operator-dependent pieces are the ONLY things left to wire:
 *
 *   1. getVerifiedEarningsUsdMicros() - recompute earnings from ON-CHAIN
 *      events (NOT the forgeable referral_activity table). This is the audit
 *      C-1/H-1 fix: without it, payout = treasury drain.
 *   2. sendUsdcFromTreasury() - the actual USDC transfer from a payout
 *      signer.
 *
 * Until BOTH are wired and REFERRAL_PAYOUT_ENABLED is set, every claim path
 * short-circuits to "not enabled", so no money can move from unverified data.
 */

const norm = (a: string) => a.trim().toLowerCase();

/** Max signature lifetime. Both verifiers promised "cannot be replayed
 *  forever" while only checking `deadline >= now`, so a signature with
 *  deadline = 2**256-1 replayed forever and the docblocks were false. */
const MAX_DEADLINE_SECONDS = 900n;
const deadlineOk = (d: bigint) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return d >= now && d <= now + MAX_DEADLINE_SECONDS;
};
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

/** Master kill-switch. Payout code only runs when this is explicitly on. */
export function isReferralPayoutEnabled(): boolean {
    return process.env.REFERRAL_PAYOUT_ENABLED === "true";
}

/**
 * The wallets this referrer PROVABLY referred, read ONLY from on-chain Memo
 * events (`scanReferralAttribution`). This is the attribution half of the
 * payout invariant, and it is deliberately a separate, exported function so
 * the earnings half below is STRUCTURALLY forced to start from on-chain data.
 *
 * Why this exists (audit 2026-07-11 B-2): `/api/referral/register` is
 * unauthenticated and the caller picks BOTH addresses, while attribution is
 * first-touch-wins and permanent. So anyone can POST {referred: <every wallet
 * on the chain>, referrer: <self>} ahead of organic registration and
 * permanently own the entire user base's attribution in `referral_activity`.
 * That table is therefore a DISPLAY/funnel cache and MUST NEVER decide money.
 *
 * A Memo tag cannot be forged: `registerReferrerCall` makes the REFERRED
 * wallet itself send the tx (a no-op self-call whose only effect is emitting
 * the tag), and the Memo event records `sender` = that signer. A third party
 * cannot emit it on someone else's behalf.
 */
export async function getVerifiedReferredWallets(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    referrer: string,
): Promise<string[]> {
    if (!isAddr(referrer)) return [];
    const tags = await scanReferralAttribution(publicClient, {
        referrer: referrer as Address,
    });
    // scanReferralAttribution already does first-touch + drops self-referral.
    return tags
        .map((t) => norm(t.referred))
        .filter((w) => w !== norm(referrer));
}

/** Parse a 6-dp decimal string ("123.456789") to exact micros, trimming any
 *  stray extra fractional digit. Returns 0n on a malformed value. */
function usdcStringToMicros(v: string): bigint {
    const [wholePart, fracRaw] = String(v ?? "0").split(".");
    const frac = (fracRaw ?? "").slice(0, 6);
    try {
        return parseUnits(`${wholePart || "0"}.${frac || "0"}`, 6);
    } catch {
        return 0n;
    }
}

// Cap the per-wallet trade pagination so a hyperactive wallet can't make a claim
// scan unbounded. 5 pages x 1000 = up to 5000 most-recent trades summed (skip
// stays within the subgraph's skip ceiling); older trades beyond that are not
// counted, which can only UNDER-credit, never over-pay.
const VOL_PAGE = 1000;
const VOL_MAX_PAGES = 5;

/**
 * Sum a single wallet's on-chain USDC trade volume (micros) SINCE `sinceUnix`,
 * read from the Goldsky Trade entity (blockTime-windowed). This is the
 * post-referral window: only volume the wallet traded after it was referred
 * counts, even if its Memo verification landed later (audit C-2). `sinceUnix = 0`
 * counts all of the wallet's history (used only when no baseline is known).
 */
async function getWalletVolumeSinceMicros(wallet: string, sinceUnix: number): Promise<bigint> {
    const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
    if (!url) return 0n;
    const w = norm(wallet);
    const since = Math.max(0, Math.floor(sinceUnix));
    let total = 0n;
    try {
        for (let page = 0; page < VOL_MAX_PAGES; page++) {
            const query = `{ trades(first: ${VOL_PAGE}, skip: ${page * VOL_PAGE}, orderBy: blockNumber, orderDirection: desc, where: { trader: "${w}", blockTime_gte: ${since} }) { volumeUsdc } }`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query }),
            });
            if (!res.ok) break;
            const json = (await res.json()) as { data?: { trades?: { volumeUsdc: string }[] } };
            const rows = json?.data?.trades;
            if (!Array.isArray(rows) || rows.length === 0) break;
            for (const r of rows) total += usdcStringToMicros(r.volumeUsdc);
            if (rows.length < VOL_PAGE) break;
        }
    } catch {
        return 0n;
    }
    return total;
}

/**
 * Sum the post-referral USDC volume (micros) across a referrer's verified
 * wallets. Each wallet is windowed by its own "referred since" baseline
 * (`baselines`), so pre-referral trades never count (audit C-2). A wallet with
 * no baseline (Memo-tagged but never touched the link) falls back to its full
 * history -- rare, and the normal UI always writes a first-touch row.
 */
async function getWalletsVolumeMicros(
    wallets: string[],
    baselines: Map<string, number>,
): Promise<bigint> {
    if (wallets.length === 0) return 0n;
    let total = 0n;
    for (const wallet of wallets.slice(0, MAX_REFERRED_WALLETS)) {
        const since = baselines.get(norm(wallet)) ?? 0;
        total += await getWalletVolumeSinceMicros(wallet, since);
    }
    return total;
}

/**
 * Per-wallet POST-REFERRAL volume (micros) for a referrer's downline, from the
 * same windowed subgraph source the claimable uses. The DB's `referral_activity`
 * volume is a fire-and-forget client report: it silently misses any trade where
 * the tab closed, the POST failed, or the trade ran outside the app, so a wallet
 * that really traded could show 0 and be filtered out of the dashboard. This is
 * the trustworthy figure to DISPLAY.
 */
export async function getPerWalletVolumeSinceMicros(
    referrer: string,
    wallets: string[],
): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    if (!isAddr(referrer) || wallets.length === 0) return out;
    const baselines = await getReferralBaselines(referrer);
    const keys = wallets.slice(0, MAX_REFERRED_WALLETS).map(norm);
    // Parallel: this runs inside a user-facing request, and serialising one
    // paginated subgraph scan per wallet made the dashboard crawl.
    const vols = await Promise.all(
        keys.map((k) => getWalletVolumeSinceMicros(k, baselines.get(k) ?? 0)),
    );
    keys.forEach((k, i) => {
        out[k] = vols[i];
    });
    return out;
}

/**
 * The EARNINGS half. For each ON-CHAIN-VERIFIED referred wallet, credit 10% of
 * the protocol fee it paid, derived from its indexed USDC trade volume (Goldsky
 * per-Trader total) * PROTOCOL_FEE_BPS * REFERRAL_SHARE_BPS. See the earnings-
 * model docblock at the top of this file.
 *
 * Safety: starts from getVerifiedReferredWallets (on-chain Memo proof, self-
 * referral already dropped), never the forgeable referral_activity table (audit
 * C-1/H-1), and the payout is ultimately bounded by the funded budget wallet.
 * Deeper sybil-netting (excluding wallets the referrer funded / only trades
 * against) is a follow-up; the verified-wallet requirement already forces a
 * sybil to emit a per-wallet on-chain Memo tag (real gas per fake wallet).
 */
export async function getVerifiedEarningsUsdMicros(
    referrer: string,
): Promise<bigint> {
    if (!isAddr(referrer)) return 0n;
    // A server-side reader to resolve the on-chain verified attribution.
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
    const wallets = await getVerifiedReferredWallets(publicClient, referrer);
    if (wallets.length === 0) return 0n;

    // Window each wallet by its "referred since" time so pre-referral volume is
    // never credited (audit C-2). Baselines come from referrals.created_at.
    const baselines = await getReferralBaselines(referrer);
    const volumeMicros = await getWalletsVolumeMicros(wallets, baselines);
    return computeReferralEarningsMicros(volumeMicros);
}

/**
 * earnings = volume * PROTOCOL_FEE_BPS/1e4 * REFERRAL_SHARE_BPS/1e4 (integer
 * micros). Pure + exported for tests. Floors (BigInt division), so it can only
 * ever under-credit by sub-micro dust -- never over-pay.
 */
export function computeReferralEarningsMicros(
    volumeMicros: bigint,
    protocolFeeBps: bigint = PROTOCOL_FEE_BPS,
): bigint {
    if (volumeMicros <= 0n) return 0n;
    return (volumeMicros * protocolFeeBps * REFERRAL_SHARE_BPS) / 100_000_000n;
}

/**
 * Sum of everything paid OR in-flight for this referrer. Counts BOTH 'paid'
 * and 'pending' (fee audit 2026-07-02): a reserved-but-not-yet-settled claim
 * must reduce claimable so two concurrent claim requests can't each see the
 * full amount and both send. A pending row is only ever released (deleted)
 * when the payout provably never submitted, so counting it here can never
 * strand funds.
 */
export async function getClaimedUsdMicros(referrer: string): Promise<bigint> {
    if (!isDbConfigured() || !isAddr(referrer)) return 0n;
    const sql = getSql();
    const rows = (await sql`
        SELECT COALESCE(SUM(amount_usd_micros), 0) AS claimed
        FROM referral_claims
        WHERE referrer_address = ${norm(referrer)}
          AND status IN ('paid', 'pending')
    `) as { claimed: string | number }[];
    return BigInt(rows[0]?.claimed ?? 0);
}

/** Claimable = verified (on-chain) earnings − already claimed. Never trusts
 *  the display-only referral_activity table. */
export async function getClaimableUsdMicros(referrer: string): Promise<bigint> {
    const verified = await getVerifiedEarningsUsdMicros(referrer);
    const claimed = await getClaimedUsdMicros(referrer);
    return verified > claimed ? verified - claimed : 0n;
}

/**
 * Reserve a claim BEFORE sending USDC. Inserts a 'pending' row; the partial
 * unique index uq_referral_claims_one_pending (migration 008) means at most
 * one pending claim can exist per referrer, so a concurrent or retried
 * request that races here gets `null` (the INSERT violates the index) and the
 * caller MUST NOT send. Returns the new claim id on success, null when a
 * claim is already in flight or on any failure (fail-closed: never pay).
 */
export async function reserveClaim(
    referrer: string,
    amountUsdMicros: bigint,
): Promise<number | null> {
    if (!isDbConfigured() || !isAddr(referrer) || amountUsdMicros <= 0n) return null;
    const sql = getSql();
    try {
        const rows = (await sql`
            INSERT INTO referral_claims (referrer_address, amount_usd_micros, status)
            VALUES (${norm(referrer)}, ${amountUsdMicros.toString()}::bigint, 'pending')
            RETURNING id
        `) as { id: string | number }[];
        return rows.length > 0 ? Number(rows[0].id) : null;
    } catch {
        // Unique-index violation (a pending claim already exists) or any other
        // error: treat as "cannot reserve" so no payout is sent.
        return null;
    }
}

/** Settle a reserved claim after the USDC transfer landed. */
export async function settleClaim(id: number, txHash: string): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        UPDATE referral_claims
        SET status = 'paid', tx_hash = ${txHash}
        WHERE id = ${id}::bigint AND status = 'pending'
    `;
}

/**
 * Release a reserved claim. Call ONLY when the payout transfer provably never
 * submitted (sendUsdcFromTreasury threw before broadcasting). A
 * submitted-but-unconfirmed transfer must NOT be released: the signer is
 * required to return its tx hash so the claim settles instead, otherwise the
 * pending row correctly blocks a re-claim until an operator reconciles.
 */
export async function releaseClaim(id: number): Promise<void> {
    if (!isDbConfigured()) return;
    const sql = getSql();
    await sql`
        DELETE FROM referral_claims WHERE id = ${id}::bigint AND status = 'pending'
    `;
}

/**
 * Verify an EIP-712 signature proving the signer controls `referred`, i.e.
 * that the REFERRED wallet itself declares who referred it.
 *
 * This is the cheap half of the audit-2026-07-11 B-2 fix. Registration is
 * unauthenticated and first-touch-wins is permanent, so without a proof anyone
 * can POST {referred: <every wallet that ever touched Arcade>, referrer: self}
 * and permanently own the attribution -- and a rate limit does NOT stop it: the
 * attacker only has to match your SIGNUP RATE (not the chain's size), has no
 * deadline so a slow drip works, and rotates IPs for pennies.
 *
 * A signature costs the user NOTHING: no gas, no transaction, no chain
 * interaction -- one wallet popup. That is the whole point of using it rather
 * than the on-chain Memo tag ([[registerReferrerCall]]), which needs a real tx.
 * Since WE pay from OUR treasury, a signature our backend verified is enough;
 * we don't need public verifiability, only to not be defrauded. The Memo stays
 * available as the stronger, publicly auditable tier.
 *
 * `deadline` keeps a captured signature from being replayed forever.
 */
export async function verifyRegisterSignature(args: {
    referred: string;
    referrer: string;
    deadline: bigint;
    signature: string;
}): Promise<boolean> {
    if (!isAddr(args.referred) || !isAddr(args.referrer)) return false;
    if (norm(args.referred) === norm(args.referrer)) return false; // self-referral
    if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) return false;
    if (!deadlineOk(args.deadline)) return false;
    try {
        return await verifyTypedData({
            address: args.referred as Address,
            domain: {
                name: "ArcadeReferral",
                version: "1",
                chainId: arcTestnet.id,
            },
            types: {
                Register: [
                    { name: "referred", type: "address" },
                    { name: "referrer", type: "address" },
                    { name: "deadline", type: "uint256" },
                ],
            },
            primaryType: "Register",
            message: {
                referred: args.referred as Address,
                referrer: args.referrer as Address,
                deadline: args.deadline,
            },
            signature: args.signature as `0x${string}`,
        });
    } catch {
        return false;
    }
}

/**
 * Verify an EIP-712 signature proving the caller controls `referrer`. The
 * claim recipient is always `referrer` itself, so funds can't be redirected;
 * this gate stops a third party from triggering / griefing someone else's
 * payout (draining the referral budget on their behalf) and enforces a
 * short-lived deadline so a captured signature can't be replayed forever.
 */
export async function verifyClaimSignature(args: {
    referrer: string;
    deadline: bigint;
    signature: string;
}): Promise<boolean> {
    if (!isAddr(args.referrer)) return false;
    if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) return false;
    // Audit 2026-07-11 F-6: the deadline was signed but never validated here,
    // despite the docblock above promising it. Both current callers happen to
    // check independently; enforce it at the source so the next caller can't
    // inherit a signature that replays forever.
    if (!deadlineOk(args.deadline)) return false;
    try {
        return await verifyTypedData({
            address: args.referrer as Address,
            domain: {
                name: "ArcadeReferral",
                version: "1",
                chainId: arcTestnet.id,
            },
            types: {
                Claim: [
                    { name: "referrer", type: "address" },
                    { name: "deadline", type: "uint256" },
                ],
            },
            primaryType: "Claim",
            message: {
                referrer: args.referrer as Address,
                deadline: args.deadline,
            },
            signature: args.signature as `0x${string}`,
        });
    } catch {
        return false;
    }
}

/**
 * The PAYOUT SIGNER. Transfers `amountUsdMicros` of USDC (6dp = micros = raw
 * USDC units on Arc) from the dedicated referral-budget wallet
 * (REFERRAL_PAYOUT_PRIVATE_KEY) to `to`, returning the tx hash.
 *
 * The key MUST hold ONLY the referral budget -- never a key with broader funds.
 * Throws on a missing/malformed key or a zero/invalid amount so a misconfigured
 * enable can't silently no-op a "successful" claim. A transfer beyond the
 * wallet's balance reverts on-chain, which is the ultimate cap on payouts.
 */
export async function sendUsdcFromTreasury(
    to: string,
    amountUsdMicros: bigint,
): Promise<`0x${string}`> {
    if (!isAddr(to)) throw new Error("referral payout: invalid recipient");
    if (amountUsdMicros <= 0n) throw new Error("referral payout: non-positive amount");
    const key = process.env.REFERRAL_PAYOUT_PRIVATE_KEY as Hex | undefined;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error("REFERRAL_PAYOUT_PRIVATE_KEY missing or malformed");
    }
    const usdc = ADDRESSES.usdc as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(usdc)) {
        throw new Error("USDC address not configured");
    }
    const account = privateKeyToAccount(key);
    const walletClient = createWalletClient({
        account,
        chain: arcTestnet,
        transport: http(),
    });
    // USDC on Arc is 6 decimals, so amountUsdMicros IS the raw transfer amount.
    const hash = await walletClient.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as Address, amountUsdMicros],
        chain: arcTestnet,
        account,
    });

    // The claim route settles a returned hash as 'paid' and releases the
    // reservation on a THROW. writeContract resolves at BROADCAST, so a tx that
    // reverts (e.g. the budget wallet is out of USDC) would be marked paid and
    // strand the claim. Await the receipt to decide:
    //   - success        -> return the hash (caller settles as paid).
    //   - definitive revert -> THROW so the caller RELEASES (funds did NOT move,
    //                          so re-claiming is safe -- no double-pay).
    //   - receipt timeout (unknown) -> return the hash so the caller settles as
    //     paid. The tx was broadcast and most likely lands; marking it paid
    //     blocks a re-claim, so we NEVER double-pay. If it truly never lands, an
    //     operator reconciles the one stranded claim (safe under-pay direction).
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
    try {
        const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: 30_000,
        });
        if (receipt.status !== "success") {
            throw new Error(`referral payout reverted on-chain: ${hash}`);
        }
        return hash;
    } catch (e) {
        if (e instanceof Error && e.message.includes("reverted on-chain")) throw e;
        // Timeout / transient RPC error while waiting: assume in-flight and let
        // the caller settle it (blocks re-claim; reconcile if it never lands).
        return hash;
    }
}
