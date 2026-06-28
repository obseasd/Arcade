import { getSql, isDbConfigured } from "@/lib/db";

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
 * ⛔ STUB — REPLACE WITH THE INDEXER.
 *
 * Must return the referrer's TOTAL lifetime VERIFIED earnings in USD micros,
 * computed ONLY from on-chain data:
 *   for each wallet this referrer referred (attribution proven on-chain),
 *   sum 10% of the protocol fees that wallet ACTUALLY PAID on-chain,
 *   capped at fees actually collected, with sybil/circular netting
 *   (exclude wallets funded by / trading only against the referrer).
 *
 * Returning anything derived from referral_activity.earned_usd_micros here
 * reintroduces audit C-1 (unbounded forged accrual) and H-1 (self/circular
 * wash farming). Hence the hard 0 default: no verified earnings until the
 * indexer fills this in.
 */
export async function getVerifiedEarningsUsdMicros(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    referrer: string,
): Promise<bigint> {
    // TODO(indexer): query on-chain Swap / fee events, attribute to referrer,
    // cap at collected fees, sybil-net, return the verified total.
    return 0n;
}

/** Sum of everything already paid to this referrer (status = 'paid'). */
export async function getClaimedUsdMicros(referrer: string): Promise<bigint> {
    if (!isDbConfigured() || !isAddr(referrer)) return 0n;
    const sql = getSql();
    const rows = (await sql`
        SELECT COALESCE(SUM(amount_usd_micros), 0) AS claimed
        FROM referral_claims
        WHERE referrer_address = ${norm(referrer)} AND status = 'paid'
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

/** Persist a settled claim so future claimable amounts subtract it. */
export async function recordClaim(
    referrer: string,
    amountUsdMicros: bigint,
    txHash: string | null,
): Promise<void> {
    if (!isDbConfigured() || !isAddr(referrer) || amountUsdMicros <= 0n) return;
    const sql = getSql();
    await sql`
        INSERT INTO referral_claims (referrer_address, amount_usd_micros, tx_hash)
        VALUES (${norm(referrer)}, ${amountUsdMicros.toString()}::bigint, ${txHash})
    `;
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
