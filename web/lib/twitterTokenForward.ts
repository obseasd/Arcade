import { createWalletClient, http, erc20Abi, keccak256, encodePacked, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ARC_CHAIN, serverPublicClient, serverReadClient } from "@/lib/serverRpc";
import { ADDRESSES } from "@/lib/constants";
import {
    getTokenFwd,
    advanceTokenFwdIf,
    getReplyLaunchByPool,
    acquireForwardLock,
    releaseForwardLock,
} from "@/lib/twitterLaunchPersistence";
import { REPLY_SPLIT_BPS } from "@/lib/twitterLaunch";

const TOKEN_FORWARDER_ABI = [
    { type: "function", name: "tokenForwarder", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Guard the cross-domain invariant: when the hook's on-chain tokenForwarder is
 * SET (non-zero), it MUST equal our forwarder key's address, else the token side
 * lands on a different address than the one we read/sign from -> a silent
 * mis-split during a mainnet rollout window (FORWARDER_PRIVATE_KEY and
 * setTokenForwarder configured out of order / to different addresses). Returns an
 * error string on mismatch, null when OK. tokenForwarder == 0 (or the function
 * absent on the pre-redeploy hook -> read reverts) is legacy mode (feeCreator =
 * msg.sender = the operator for cron launches = forwarderAddress()), left
 * UNGUARDED so testnet and the currently-deployed hook keep working.
 */
export async function forwarderMismatch(): Promise<string | null> {
    const fwd = forwarderAddress();
    if (!fwd) return "forwarder key missing/malformed";
    let onchain: Address;
    try {
        onchain = (await serverReadClient().readContract({
            address: ADDRESSES.arcadeHook as Address,
            abi: TOKEN_FORWARDER_ABI,
            functionName: "tokenForwarder",
        })) as Address;
    } catch {
        return null; // function absent (pre-redeploy hook) or read failed: don't block
    }
    if (onchain.toLowerCase() === ZERO_ADDR) return null; // legacy mode, unguarded
    if (onchain.toLowerCase() !== fwd.toLowerCase()) {
        return `tokenForwarder mismatch: on-chain ${onchain} != forwarder key ${fwd} -- set both to the same address`;
    }
    return null;
}

/** The hook's on-chain tokenForwarder (address(0) = legacy/unconfigured). Lets
 *  callers gate off the DEDICATED-forwarder regime (e.g. the stale sweep is a
 *  no-op until this is set on mainnet). Returns null on a read error. */
export async function onchainTokenForwarder(): Promise<Address | null> {
    try {
        return (await serverReadClient().readContract({
            address: ADDRESSES.arcadeHook as Address,
            abi: TOKEN_FORWARDER_ABI,
            functionName: "tokenForwarder",
        })) as Address;
    } catch {
        return null;
    }
}

/**
 * Token-side fee forwarding. CLANKER fees accrue in BOTH USDC (routed to the
 * handle escrow) and the LAUNCH TOKEN. The token side is sent by the hook direct
 * to the on-chain FeeOwner.creator = the FORWARDER (hook.tokenForwarder, set to
 * the forwarder key's address), so it never reaches the attributed @handle. This
 * forwards the forwarder's accrued token side to the claimant AFTER they've
 * proven ownership (their on-chain USDC claim, verified by the endpoint).
 *
 * HOW WE KNOW THE AMOUNT OWED, WITHOUT SCANNING LOGS: forwarding TRANSFERS the
 * token out of the forwarder, so the forwarder's remaining balance of a given
 * launch token IS the un-forwarded token-side fee for that token (the forwarder
 * gets no CLANKER allocation and never trades, so it holds nothing else of it;
 * the treasury 20% goes to the Safe, the USDC side to the escrow). Total ever
 * accrued = balance + already-forwarded. We split that by the fixed creator2
 * ratio into the two slots and subtract each slot's forwarded cursor.
 *
 * KEY ISOLATION (P2 level 4): the forwarder key custodies ALL handle-launch
 * creator-side fees (token side of every handle launch + the USDC creator2 leg of
 * a reply launch, since the cron passes creator2 = forwarderAddress()). So the
 * bps split below stays valid reading ONE address, and the compounder/keeper
 * operator never touches these fees. Defaults to the operator key when
 * FORWARDER_PRIVATE_KEY is unset (single-key testnet behaviour).
 *
 *   solo launch (creator2Bps 0): slot 0 (launcher) owns 100% of the token cut.
 *   reply launch (creator2Bps 5000, both cuts land on the operator): slots 0/1
 *     each own bps-proportional halves; owed(slot) = slotTotal - slotForwarded.
 *
 * This is O(1) reads (one balanceOf), so it never hits the Arc RPC's 10k-block
 * eth_getLogs cap that made the old log-scan approach time the function out.
 *
 * Idempotent: reserve-then-execute compare-and-set on the DB cursor BEFORE the
 * transfer (rollback on failure), identical to twitterReplyReconcile.
 */

export type ForwardResult =
    | { ok: true; forwarded: false; reason: string }
    | { ok: true; forwarded: true; amountRaw: string; tx: Hex }
    | { ok: false; error: string };

/**
 * The FORWARDER key that custodies ALL handle-launch creator-side fees off-chain
 * (the token side of every handle launch, plus the USDC creator2 leg of a reply
 * launch). Prefer a DEDICATED `FORWARDER_PRIVATE_KEY` so the honeypot of unclaimed
 * fees is isolated from the compounder/keeper operator (P2 key-split, level 4);
 * falls back to COMPOUNDER_OPERATOR_PRIVATE_KEY when unset, which reproduces the
 * pre-split single-key behaviour (testnet). It MUST equal the on-chain
 * `hook.tokenForwarder()` AND the `creator2` the cron passes for reply launches --
 * all three derive from this one function so they cannot drift.
 */
export function forwarderKey(): Hex | null {
    // Use the DEDICATED key only when present AND well-formed; a blank or
    // malformed FORWARDER_PRIVATE_KEY (a defined-but-empty Vercel var) falls back
    // to the operator key CONSISTENTLY -- NOT `??`, which keeps a blank string and
    // would split-brain (off-chain bails while the cron routes to the operator).
    const dedicated = process.env.FORWARDER_PRIVATE_KEY;
    const key = (
        dedicated && /^0x[0-9a-fA-F]{64}$/.test(dedicated)
            ? dedicated
            : process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY
    ) as Hex | undefined;
    return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null;
}

/** Address of the forwarder key (where handle-launch creator-side fees land).
 *  null if the key is unset/malformed. */
export function forwarderAddress(): Address | null {
    const key = forwarderKey();
    return key ? privateKeyToAccount(key).address : null;
}

/** creator2 split (bps) for a pool: REPLY_SPLIT_BPS for a reply-launch, else 0. */
async function creator2BpsFor(poolIdHex: string): Promise<bigint> {
    const reply = await getReplyLaunchByPool(poolIdHex);
    return reply ? BigInt(REPLY_SPLIT_BPS) : 0n;
}

const CLANKER_POS_ABI = [
    {
        type: "function",
        name: "clankerPos",
        stateMutability: "view",
        inputs: [{ type: "address" }],
        outputs: [
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
            { name: "seeded", type: "bool" },
            { name: "launchedAt", type: "uint64" },
        ],
    },
] as const;
const STATE_VIEW_ABI = [
    {
        type: "function",
        name: "getPositionInfo",
        stateMutability: "view",
        inputs: [
            { name: "poolId", type: "bytes32" },
            { name: "positionId", type: "bytes32" },
        ],
        outputs: [
            { name: "liquidity", type: "uint128" },
            { name: "feeGrowthInside0LastX128", type: "uint256" },
            { name: "feeGrowthInside1LastX128", type: "uint256" },
        ],
    },
    {
        type: "function",
        name: "getFeeGrowthInside",
        stateMutability: "view",
        inputs: [
            { name: "poolId", type: "bytes32" },
            { name: "tickLower", type: "int24" },
            { name: "tickUpper", type: "int24" },
        ],
        outputs: [
            { name: "feeGrowthInside0X128", type: "uint256" },
            { name: "feeGrowthInside1X128", type: "uint256" },
        ],
    },
] as const;
const ZERO32 = ("0x" + "0".repeat(64)) as Hex;

/**
 * Pending (un-harvested) launch-TOKEN creator fee sitting in the hook's locked
 * CLANKER position -- exactly what a `collectFees` would move to the forwarder.
 * Reproduces the on-chain harvest math (liquidity * feeGrowth delta >> 128, the
 * creator's 80% cut) via StateView so the claim card can show the FULL claimable
 * token BEFORE the harvest runs. PREVIEW ONLY (the execute path never counts it).
 * Returns 0 on any miss/error so it can only ever ADD to the shown amount.
 */
async function previewPendingCreatorToken(poolIdHex: string, launchToken: Address): Promise<bigint> {
    try {
        const hook = ADDRESSES.arcadeHook as Address;
        const stateView = ADDRESSES.v4StateView as Address;
        const usdc = ADDRESSES.usdc as Address;
        if (!hook || /^0x0*$/.test(hook) || !stateView || /^0x0*$/.test(stateView)) return 0n;
        const client = serverReadClient();
        const pos = (await client.readContract({
            address: hook,
            abi: CLANKER_POS_ABI,
            functionName: "clankerPos",
            args: [launchToken],
        })) as readonly [number, number, boolean, bigint];
        const [tickLower, tickUpper, seeded] = pos;
        if (!seeded) return 0n; // not a seeded CLANKER pool (e.g. a PUMP curve) -> nothing here
        const positionId = keccak256(
            encodePacked(["address", "int24", "int24", "bytes32"], [hook, tickLower, tickUpper, ZERO32]),
        );
        const poolId = poolIdHex as Hex;
        const [info, growth] = await Promise.all([
            client.readContract({
                address: stateView,
                abi: STATE_VIEW_ABI,
                functionName: "getPositionInfo",
                args: [poolId, positionId],
            }) as Promise<readonly [bigint, bigint, bigint]>,
            client.readContract({
                address: stateView,
                abi: STATE_VIEW_ABI,
                functionName: "getFeeGrowthInside",
                args: [poolId, tickLower, tickUpper],
            }) as Promise<readonly [bigint, bigint]>,
        ]);
        const [liquidity, fgi0Last, fgi1Last] = info;
        const [fgi0, fgi1] = growth;
        if (liquidity === 0n) return 0n;
        // The launch token is currency1 iff USDC sorts first (currency0). Same test
        // as useV4PoolPrice / the hook's usdcIsCurrency0.
        const usdcIsCurrency0 = usdc.toLowerCase() < launchToken.toLowerCase();
        const MASK = (1n << 256n) - 1n; // feeGrowth is a wrapping uint256 accumulator
        const delta = usdcIsCurrency0 ? (fgi1 - fgi1Last) & MASK : (fgi0 - fgi0Last) & MASK;
        const uncollected = (liquidity * delta) >> 128n;
        return (uncollected * 8000n) / 10000n; // POST_GRAD_CREATOR_BPS: 80% creator, 20% treasury
    } catch {
        return 0n;
    }
}

/**
 * Compute the launch-token amount owed to (poolId, slotIndex) from the operator's
 * live balance and the per-slot forwarded cursors. Returns { owed, already } so
 * the executing path can reserve the exact delta. Owed is clamped to >= 0.
 *
 * `includePending` (PREVIEW ONLY): also count the un-harvested creator token still
 * in the locked CLANKER position, so the claim card shows the full claimable amount
 * before the harvest. The execute path MUST leave it false (nothing to transfer yet)
 * and keeps the physical-balance clamp.
 */
async function computeOwed(
    poolIdHex: string,
    slotIndex: 0 | 1,
    launchToken: Address,
    includePending = false,
): Promise<{ owed: bigint; already: bigint } | null> {
    const forwarder = forwarderAddress();
    if (!forwarder) return null;
    const cursors = await getTokenFwd(poolIdHex);
    if (!cursors) return null;

    const fwd0 = BigInt(cursors.slot0 || "0");
    const fwd1 = BigInt(cursors.slot1 || "0");

    const client = serverReadClient();
    const balance = (await client.readContract({
        address: launchToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [forwarder],
    })) as bigint;

    // Everything ever accrued to the operator for this token = still-held + already
    // forwarded out, plus (preview only) the un-harvested creator cut still in the LP.
    const pending = includePending ? await previewPendingCreatorToken(poolIdHex, launchToken) : 0n;
    const totalAccrued = balance + pending + fwd0 + fwd1;
    const bps = await creator2BpsFor(poolIdHex);
    const slotTotal =
        slotIndex === 0 ? (totalAccrued * (10_000n - bps)) / 10_000n : (totalAccrued * bps) / 10_000n;
    const already = slotIndex === 0 ? fwd0 : fwd1;
    let owed = slotTotal - already;
    if (owed < 0n) owed = 0n;
    // Execute path only: never try to move more than is physically held (a slot-race
    // / stray deposit would revert). The preview intentionally counts un-harvested
    // fees the forwarder does not hold yet, so it skips this clamp.
    if (!includePending && owed > balance) owed = balance;
    return { owed, already };
}

// Warm-instance cache of computed owed amounts. The Arc RPCs rate-limit Vercel's
// shared IPs, so the balanceOf read intermittently stalls; once ANY request
// computes owed we serve it from here (fresh for TTL, and as a stale fallback if
// a later compute stalls) so the claim page shows the token amount reliably
// instead of flapping to 0. Owed changes only on new trades/harvests, so a short
// TTL is safe. Preview-only; the executing forward always reads fresh.
const owedCache = new Map<string, { value: string; at: number }>();
const OWED_TTL_MS = 60_000;

/**
 * Read-only preview of the launch-token amount still owed to (poolId, slotIndex).
 * Does NOT reserve or transfer, so it is safe to call before the user claims (to
 * show the "+ N TICKER" they will receive). Cache-first, with a stale fallback so
 * a throttled RPC read degrades to the last known value, not 0.
 */
export async function previewTokenSideOwed(
    poolIdHex: string,
    slotIndex: 0 | 1,
    launchToken: Address,
    nowMs = Date.now(),
): Promise<string> {
    const key = `${poolIdHex}:${slotIndex}`;
    const cached = owedCache.get(key);
    if (cached && nowMs - cached.at < OWED_TTL_MS) return cached.value; // fresh hit
    try {
        // includePending=true: show forwarder balance + the un-harvested creator
        // token still in the locked CLANKER LP, so the claim card shows the FULL
        // claimable token before the claim's harvest runs.
        const r = await computeOwed(poolIdHex, slotIndex, launchToken, true);
        const value = r && r.owed > 0n ? r.owed.toString() : "0";
        owedCache.set(key, { value, at: nowMs });
        return value;
    } catch {
        // Compute stalled (throttled RPC): serve the last known value if we have
        // one, even if past TTL, rather than flapping the UI back to 0.
        return cached?.value ?? "0";
    }
}

/**
 * Forward the launch-token creator fees owed to (poolId, slotIndex) to
 * `recipient`. `launchToken` is the token whose fees we forward.
 */
export async function forwardTokenSide(
    poolIdHex: string,
    slotIndex: 0 | 1,
    recipient: Address,
    launchToken: Address,
): Promise<ForwardResult> {
    // Refuse to forward into a mis-split state if the on-chain tokenForwarder
    // disagrees with our key (rollout window). Checked BEFORE the lock so the
    // in-lock hold stays short and the read isn't duplicated (audit item-5).
    const mism = await forwarderMismatch();
    if (mism) return { ok: false, error: mism };

    // Serialize per pool (audit M-1): concurrent forwards (the client claim POST +
    // the delivery cron(s)) must not read the same live balanceOf mid-transfer and
    // mis-split a reply 50/50. A lock loser skips this run; delivery is idempotent so
    // a later run/cron completes it. Neon serverless has no session advisory locks,
    // so this is a DB lease lock. TTL 120s covers the worst-case in-lock hold
    // (computeOwed + transfer + the Q5 receipt-confirm retries, ~30-45s), so a
    // second run can't steal the lease mid-transfer (audit item-5).
    if (!(await acquireForwardLock(poolIdHex, 120))) {
        return { ok: true, forwarded: false, reason: "locked (concurrent forward)" };
    }
    try {
        return await forwardTokenSideInner(poolIdHex, slotIndex, recipient, launchToken);
    } finally {
        await releaseForwardLock(poolIdHex);
    }
}

async function forwardTokenSideInner(
    poolIdHex: string,
    slotIndex: 0 | 1,
    recipient: Address,
    launchToken: Address,
): Promise<ForwardResult> {
    // forwarderMismatch is checked by the caller (forwardTokenSide) before the lock.
    const fwdKey = forwarderKey();
    if (!fwdKey) {
        return { ok: false, error: "forwarder key missing/malformed" };
    }

    let computed: { owed: bigint; already: bigint } | null;
    try {
        computed = await computeOwed(poolIdHex, slotIndex, launchToken);
    } catch (e) {
        return { ok: false, error: `balance read failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!computed) return { ok: true, forwarded: false, reason: "unknown pool / operator" };

    const { owed, already } = computed;
    if (owed <= 0n) return { ok: true, forwarded: false, reason: "nothing new to forward" };

    // Reserve the delta atomically BEFORE the transfer (idempotency + concurrency).
    const reserved = await advanceTokenFwdIf(poolIdHex, slotIndex, already.toString(), (already + owed).toString());
    if (!reserved) return { ok: true, forwarded: false, reason: "already forwarded / concurrent run" };

    const client = serverPublicClient();
    const account = privateKeyToAccount(fwdKey);
    const walletClient = createWalletClient({ account, chain: ARC_CHAIN, transport: http() });
    let tx: Hex | undefined;
    try {
        tx = await walletClient.writeContract({
            address: launchToken,
            abi: erc20Abi,
            functionName: "transfer",
            args: [recipient, owed],
        });
        await client.waitForTransactionReceipt({ hash: tx });
    } catch (e) {
        // waitForTransactionReceipt can TIME OUT on Arc even when the transfer
        // actually mined (documented Arc RPC condition). Rolling the cursor back
        // blindly would then re-forward a landed transfer on the next claim ->
        // mis-split (e.g. 75/25 instead of 50/50) or double-pay. So confirm the
        // real outcome by hash before touching the cursor (audit Q5).
        let outcome: "success" | "reverted" | "unknown" = tx ? "unknown" : "reverted";
        if (tx) {
            for (let i = 0; i < 5 && outcome === "unknown"; i++) {
                try {
                    const r = await client.getTransactionReceipt({ hash: tx });
                    if (r) outcome = r.status === "success" ? "success" : "reverted";
                } catch {
                    /* not mined yet / transient RPC error */
                }
                if (outcome === "unknown") await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
            }
        }
        if (outcome === "success") {
            // The transfer DID land; keep the cursor advanced (do NOT re-forward).
            return { ok: true, forwarded: true, amountRaw: owed.toString(), tx: tx! };
        }
        if (outcome === "reverted") {
            // Genuinely failed (reverted or never sent); roll back so a retry re-attempts.
            await advanceTokenFwdIf(poolIdHex, slotIndex, (already + owed).toString(), already.toString()).catch(() => {});
            return { ok: false, error: `transfer failed: ${e instanceof Error ? e.message : String(e)}` };
        }
        // Indeterminate after retries: do NOT roll back. A delayed under-pay (that a
        // reconciliation can finish) is safer than double-paying a mined tx. Leave
        // the cursor advanced and flag it loudly for manual reconciliation.
        console.error(
            `[token-forward] indeterminate outcome for tx ${tx} (pool ${poolIdHex} slot ${slotIndex}); cursor kept advanced, needs reconciliation`,
        );
        return { ok: false, error: `receipt timeout, outcome unknown for ${tx}` };
    }

    return { ok: true, forwarded: true, amountRaw: owed.toString(), tx };
}
