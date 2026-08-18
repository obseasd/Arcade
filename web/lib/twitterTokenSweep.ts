import { createWalletClient, http, erc20Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ARC_CHAIN, serverPublicClient, serverReadClient } from "@/lib/serverRpc";
import { ADDRESSES } from "@/lib/constants";
import { forwarderKey, forwarderAddress, forwarderMismatch } from "@/lib/twitterTokenForward";

/**
 * Stale token-side sweep (P2 level 4, item C). The forwarder custodies the
 * launch-token side of every handle launch's fees until the @ owner claims. If a
 * handle is NEVER claimed, that token sits on the forwarder forever -- the token
 * side has NO on-chain forfeit, unlike the USDC side which the owner reclaims via
 * escrow.forfeitStaleClaim after FORFEIT_DELAY. This caps that honeypot: sweep the
 * forwarder's remaining balance of a launch token to the treasury Safe
 * (hook.TREASURY()) once the escrow's slot-0 forfeit clock (forfeitAnchorAt,
 * anchored at first credit, RESET on every successful claim) has elapsed PLUS a
 * grace buffer.
 *
 * WHY THE GRACE (audit MEDIUM-1): the USDC side stays claimable indefinitely
 * (claimByTwitter has no staleness gate; forfeitStaleClaim is discretionary
 * onlyOwner), while this sweep is automated. Sweeping at exactly the USDC window
 * would let a late-but-valid claimant (claiming USDC at, say, T+200d, still
 * allowed) find the token side already gone. Sweeping at FORFEIT_DELAY + GRACE
 * (270d > the 180d USDC window) guarantees the token side is NEVER forfeited
 * before the USDC side. An actively-claimed slot resets the anchor and never
 * reaches the window.
 *
 * Idempotent: after a sweep balanceOf(forwarder) is 0, so a re-run skips.
 * NOT COVERED (funds safe on the controlled forwarder EOA; move manually):
 *   - a slot whose USDC was already owner-forfeited (anchor reset to 0);
 *   - a launch whose harvested fees have been TOKEN-SIDE ONLY so far (no USDC
 *     credit -> anchor still 0), until its first USDC-fee buy is harvested;
 *   - token balances left on a PRIOR forwarder after setTokenForwarder rotates.
 * Reuses the forwarder-identity guard so a mis-configured rollout never sweeps
 * against the wrong balance; the CALLER gates on a non-zero on-chain
 * tokenForwarder so this is fully dormant in legacy/testnet mode.
 */

const FORFEIT_DELAY = 180n * 24n * 60n * 60n; // 180 days, matches the escrow constant
// Grace beyond the USDC forfeit window so the token side is never forfeited first
// (audit MEDIUM-1). Total sweep threshold = 270d from the last claim.
const SWEEP_GRACE = 90n * 24n * 60n * 60n; // 90 days

const ESCROW_ANCHOR_ABI = [
    {
        type: "function",
        name: "forfeitAnchorAt",
        stateMutability: "view",
        inputs: [{ type: "uint256" }, { type: "uint256" }],
        outputs: [{ type: "uint64" }],
    },
] as const;
const HOOK_TREASURY_ABI = [
    { type: "function", name: "TREASURY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export type SweepResult =
    | { ok: true; swept: false; reason: string }
    | { ok: true; swept: true; amountRaw: string; to: Address; tx: Hex }
    | { ok: false; error: string };

/**
 * Sweep the forwarder's balance of one launch token to the Safe, IF the escrow
 * slot-0 forfeit clock has elapsed (handle abandoned). Safe to call on any pool;
 * no-ops when not stale / nothing held.
 */
export async function sweepStaleTokenSide(
    poolIdHex: string,
    token: Address,
    nowSec: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<SweepResult> {
    const fwdKey = forwarderKey();
    if (!fwdKey) return { ok: false, error: "forwarder key missing/malformed" };
    const forwarder = forwarderAddress();
    if (!forwarder) return { ok: false, error: "forwarder address unresolved" };
    // Never sweep against the wrong balance if the on-chain tokenForwarder and
    // our key disagree (rollout window).
    const mism = await forwarderMismatch();
    if (mism) return { ok: false, error: mism };

    const escrow = ADDRESSES.twitterEscrow as Address;
    const hook = ADDRESSES.arcadeHook as Address;
    if (!escrow || escrow === "0x0000000000000000000000000000000000000000") {
        return { ok: false, error: "escrow not configured" };
    }

    const client = serverReadClient();
    const positionId = BigInt(poolIdHex);

    // Staleness: the escrow's slot-0 forfeit clock. 0 = never credited or already
    // claimed/forfeited-and-reset (skip); otherwise stale once anchor+180d passed.
    let anchor: bigint;
    try {
        anchor = (await client.readContract({
            address: escrow,
            abi: ESCROW_ANCHOR_ABI,
            functionName: "forfeitAnchorAt",
            args: [positionId, 0n],
        })) as bigint;
    } catch (e) {
        return { ok: false, error: `anchor read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (anchor === 0n) return { ok: true, swept: false, reason: "no forfeit anchor (never credited / reset)" };
    // FORFEIT_DELAY + grace, so the token side is never forfeited before the USDC
    // side (which stays claimable past 180d). See MEDIUM-1 above.
    if (nowSec < anchor + FORFEIT_DELAY + SWEEP_GRACE) {
        return { ok: true, swept: false, reason: "not stale yet (< 270d)" };
    }

    // Balance held for this token. Nothing to do if already claimed/swept.
    let balance: bigint;
    try {
        balance = (await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [forwarder],
        })) as bigint;
    } catch (e) {
        return { ok: false, error: `balance read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (balance === 0n) return { ok: true, swept: false, reason: "nothing to sweep" };

    // Destination = the treasury Safe (same authority the USDC forfeit targets).
    let safe: Address;
    try {
        safe = (await client.readContract({
            address: hook,
            abi: HOOK_TREASURY_ABI,
            functionName: "TREASURY",
        })) as Address;
    } catch (e) {
        return { ok: false, error: `treasury read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!safe || safe === "0x0000000000000000000000000000000000000000") {
        return { ok: false, error: "treasury unresolved" };
    }

    const pub = serverPublicClient();
    const account = privateKeyToAccount(fwdKey);
    const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() });
    let tx: Hex;
    try {
        tx = await walletClient.writeContract({
            address: token,
            abi: erc20Abi,
            functionName: "transfer",
            args: [safe, balance],
        });
        await pub.waitForTransactionReceipt({ hash: tx });
    } catch (e) {
        return { ok: false, error: `sweep transfer failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, swept: true, amountRaw: balance.toString(), to: safe, tx };
}

/**
 * Enumerate every handle-launch pool from the subgraph (HandleAttribution is
 * created for each FeeAttributedToHandle, so this includes NEVER-claimed UI
 * launches that have no DB row -- exactly the honeypot to sweep). Returns
 * [{ poolId, token }].
 */
export async function listHandleLaunchPools(): Promise<{ poolId: string; token: Address }[]> {
    const url = process.env.NEXT_PUBLIC_GOLDSKY_URL;
    if (!url) return [];
    try {
        const q = `{ handleAttributions(first: 1000) { id token } }`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: q }),
        });
        if (!res.ok) return [];
        const json = (await res.json()) as {
            data?: { handleAttributions?: { id: string; token: string }[] };
        };
        const rows = json?.data?.handleAttributions ?? [];
        return rows
            .filter((r) => r.token && /^0x0*[1-9a-fA-F]/.test(r.token)) // non-zero token
            .map((r) => ({ poolId: r.id, token: r.token as Address }));
    } catch {
        return [];
    }
}
