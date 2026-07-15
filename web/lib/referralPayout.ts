import { verifyTypedData, type Address } from "viem";
import { getSql, isDbConfigured } from "@/lib/db";
import { arcTestnet } from "@/lib/chains";
import { scanReferralAttribution } from "@/lib/referralOnchain";

/**
 * Referral PAYOUT layer (Phase 2). Disabled by default and built so the two
 * indexer/operator-dependent pieces are the ONLY things left to wire:
 *
 *   1. getVerifiedEarningsUsdMicros() — recompute earnings from ON-CHAIN
 *      events (NOT the forgeable referral_activity table). This is the audit
 *      C-1/H-1 fix: without it, payout = treasury drain.
 *   2. sendUsdcFromTreasury() — the actual USDC transfer from a payout
 *      signer.
 *
 * Until BOTH are wired and REFERRAL_PAYOUT_ENABLED is set, every claim path
 * short-circuits to "not enabled", so no money can move from unverified data.
 */

const norm = (a: string) => a.trim().toLowerCase();
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

/**
 * ⛔ STUB — the EARNINGS half. REPLACE WITH THE INDEXER.
 *
 * Attribution is already solved above and is NOT what is missing. What is
 * missing is, for each on-chain-verified referred wallet, the protocol fees it
 * ACTUALLY PAID on-chain, so we can pay 10% of that, capped at fees actually
 * collected, with sybil/circular netting (exclude wallets funded by / trading
 * only against the referrer).
 *
 * Reading `referral_activity.earned_usd_micros` here reintroduces audit C-1
 * (unbounded forged accrual: that table is fed by an unauthenticated,
 * replayable endpoint) and H-1 (self/circular wash farming). Hence the hard 0:
 * no verified earnings until the indexer fills this in. Note the table is also
 * numerically wrong regardless (it accrues a flat 5bp of volume, which is 10x
 * to 14x under the launchpad's real take and phantom on V3).
 */
export async function getVerifiedEarningsUsdMicros(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    referrer: string,
): Promise<bigint> {
    // TODO(indexer): start from getVerifiedReferredWallets(publicClient,
    // referrer), then sum each wallet's on-chain paid protocol fees, cap at
    // fees actually collected, sybil-net, return the verified total.
    return 0n;
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
    if (args.deadline < BigInt(Math.floor(Date.now() / 1000))) return false;
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
 * ⛔ STUB — REPLACE WITH A PAYOUT SIGNER.
 *
 * Transfer `amountUsdMicros` of USDC from the referral-payout treasury wallet
 * to `to`, returning the tx hash. Requires a server-side signer
 * (REFERRAL_PAYOUT_PRIVATE_KEY) holding ONLY the referral budget — NEVER a
 * key with broader funds. Throws until wired so a misconfigured enable can't
 * silently no-op a "successful" claim.
 */
export async function sendUsdcFromTreasury(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    to: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountUsdMicros: bigint,
): Promise<`0x${string}`> {
    // TODO(operator): build a viem walletClient from REFERRAL_PAYOUT_PRIVATE_KEY
    // and call USDC.transfer(to, amount); return the tx hash.
    throw new Error("referral payout signer not wired (Phase 2)");
}
