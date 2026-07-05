import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    decodeEventLog,
    encodeFunctionData,
    http,
    isAddress,
    type Address,
    type Hex,
} from "viem";
import {
    MULTICALL3_ADDRESS,
    MULTICALL3_AGGREGATE3_ABI,
} from "@/lib/multicall3";
import { privateKeyToAccount } from "viem/accounts";
import {
    getActivePositions,
    stampLastAction,
    insertEvent,
    enqueueAction,
    markWithdrawn,
    type CompounderPosition,
} from "@/lib/compounderPersistence";
import { isDbConfigured } from "@/lib/db";
import { AUTO_COMPOUNDER_ABI, modeIdFromLabel } from "@/lib/abis/autoCompounder";
import { ADDRESSES } from "@/lib/constants";
import { quoteUsdcValueForPair } from "@/lib/compounderQuote";

/**
 * Compounder cron scanner.
 *
 * Triggered every 5 minutes by .github/workflows/compounder-scan.yml.
 * For each active position:
 *
 *   1. Read pendingFees(tokenId) from the on-chain Compounder so the
 *      decision uses the same state the contract will enforce at
 *      execute-time (no race vs. a stale DB cache).
 *   2. If the max of (fees0, fees1) meets the position's minFeeMicros
 *      threshold AND the 5-minute per-position cooldown has elapsed,
 *      submit the corresponding write (compound() or pushFees()) via
 *      the operator wallet.
 *   3. On success, stamp last_action_at + insert an event row + ack.
 *   4. On revert, log the error in a compounder_actions row marked
 *      'failed' so the dashboard surfaces it without polluting the
 *      successful-action stream.
 *
 * Hard caps on the per-run work:
 *   - MAX_POSITIONS_PER_RUN = 25 so a single scanner cannot run the
 *     operator dry. The GH Actions cadence (every 5 min) covers 300
 *     active positions in 1 hour worst-case; bump the cap when we
 *     exceed that.
 *   - per-action gas budget protection via the operator's standard
 *     wallet client (will simulate first and abort if est > cap).
 *
 * Auth: shared bearer secret COMPOUNDER_CRON_SECRET, same pattern as
 * the stats cron route.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Audit H3 fix: dropped from 25 to 6 to match the per-tx-confirmation
// budget the author's own doc-comment admitted. Per-action cost on Arc
// is ~5s (1 simulation read + 1 write + 1.5s receipt + 4-tier × 2-leg
// quoter fan-out, with H3 batch parallel = ~3s instead of ~8). At 6
// positions × 5s = 30s, well inside the 60s function ceiling with
// slack for cold-start + DB round-trips. With a 5-minute cron cadence
// we can process 6 × 12 = 72 positions/hour — enough for any
// realistic testnet load.
const MAX_POSITIONS_PER_RUN = 6;

// Audit H3 + I8 fix: every RPC read gets a per-call timeout via
// AbortController so a single slow eth_call cannot push the whole
// sweep past the 60s function ceiling. 3s matches the observed Arc
// p99 latency for a single readContract; bumping past that means
// somebody else's RPC issue cost us the budget for an honest action.
const RPC_TIMEOUT_MS = 3_000;

// Arc RPC endpoint list. The dedicated provider URL (Alchemy / thirdweb
// client-id) is prepended via NEXT_PUBLIC_ARC_RPC_URL so the cron stops
// hammering the public rpc.testnet.arc.network endpoint into 429 land.
// The rest of the list stays as fallbacks: viem's http transport with
// multiple URLs round-robins on failure, so a single endpoint outage
// does not break the whole sweep.
const ARC_RPC_LIST: readonly string[] = (() => {
    const out: string[] = [];
    const dedicated = process.env.NEXT_PUBLIC_ARC_RPC_URL;
    if (dedicated) out.push(dedicated);
    out.push("https://rpc.testnet.arc.network");
    out.push("https://5042002.rpc.thirdweb.com");
    return out;
})();

const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
        // Audit I8 fix: fallback RPC list so a single endpoint's
        // outage does not break the whole sweep. viem's http
        // transport with multiple URLs round-robins on failure;
        // adding an explicit thirdweb fallback gives us a second
        // path if rpc.testnet.arc.network goes down (the documented
        // Arc behaviour during prior outages was empty-getLogs +
        // 504s, both of which propagate cleanly through the
        // fallback).
        default: { http: ARC_RPC_LIST },
        public: { http: ARC_RPC_LIST },
    },
} as const;

/// Audit I8 fix: hard ceiling on gas price. Without one, an Arc fee
/// spike (a launchpad surge or a real mainnet incident) drains the
/// operator wallet over a single sweep. 100 gwei is well over the
/// observed Arc steady-state (~20 gwei) and covers the historical
/// p99 we have data for; the cron skips a tick rather than overpay.
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n; // 100 gwei

/// Audit I8 fix: warn-and-skip threshold for the operator's USDC gas
/// balance. Sweeps that fall below this hand back a non-200 response
/// to the cron caller so a GH Actions failure surfaces in the
/// notifications inbox rather than burning the float to zero
/// silently. 1 USDC ≈ 100 average compound calls on Arc, so the alert
/// fires with comfortable headroom for an ops response.
const MIN_OPERATOR_BALANCE_WEI = 1_000_000n; // 1 USDC (6 decimals)

/** Run a promise under a hard timeout. Returns null on timeout (the
 *  caller is expected to treat null as "skip this leg / pool" and
 *  carry on with the rest of the sweep). Implemented with
 *  Promise.race so the underlying RPC call keeps running in the
 *  background and contributes to the next free RPC slot; that is
 *  cheaper than tearing down the viem transport per call. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let cancel: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<null>((resolve) => {
        cancel = setTimeout(() => resolve(null), ms);
    });
    try {
        const v = await Promise.race([p, timer]);
        if (cancel) clearTimeout(cancel);
        return v;
    } catch {
        if (cancel) clearTimeout(cancel);
        return null;
    }
}

interface RunSummary {
    scanned: number;
    triggered: number;
    skipped: number;
    failed: number;
    notes: string[];
}

export async function POST(req: NextRequest) {
    const secret = process.env.COMPOUNDER_CRON_SECRET;
    if (!secret) {
        return NextResponse.json(
            { error: "COMPOUNDER_CRON_SECRET not configured" },
            { status: 500 },
        );
    }
    const auth = req.headers.get("authorization");
    const expected = `Bearer ${secret}`;
    if (!auth || auth.length !== expected.length || auth !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!isDbConfigured()) {
        return NextResponse.json(
            { ran: false, reason: "Postgres not configured" },
            { status: 200 },
        );
    }

    const compounderAddress = ADDRESSES.autoCompounder as Address;
    if (!isAddress(compounderAddress, { strict: false })) {
        return NextResponse.json(
            { ran: false, reason: "NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS not configured" },
            { status: 200 },
        );
    }

    const operatorKey = process.env.COMPOUNDER_OPERATOR_PRIVATE_KEY as
        | Hex
        | undefined;
    // Audit 2026-06-18b M-26: validate the full 0x + 64-hex shape, not
    // just a "0x" prefix. The old check passed "0x", "0xabc", etc.
    // straight into privateKeyToAccount which then threw a cryptic
    // low-level error mid-request; a precise upfront check returns a
    // clear "not configured" instead.
    if (!operatorKey || !/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) {
        return NextResponse.json(
            { ran: false, reason: "COMPOUNDER_OPERATOR_PRIVATE_KEY missing or malformed" },
            { status: 200 },
        );
    }

    const account = privateKeyToAccount(operatorKey);
    const publicClient = createPublicClient({
        chain: ARC_CHAIN,
        transport: http(),
    });
    const walletClient = createWalletClient({
        account,
        chain: ARC_CHAIN,
        transport: http(),
    });

    // Audit I8 fix: low-balance circuit breaker. Read the operator's
    // native gas balance once at the top of the sweep; if it's below
    // MIN_OPERATOR_BALANCE_WEI, abort with a 503 so the GH Actions
    // workflow surfaces the alarm in the notifications inbox. The
    // sweep does NOT silently burn through the last few cents of
    // float on partial work — the operator should be refilled before
    // we keep going.
    const operatorBalance = await publicClient.getBalance({
        address: account.address,
    });
    if (operatorBalance < MIN_OPERATOR_BALANCE_WEI) {
        return NextResponse.json(
            {
                ran: false,
                reason: "Operator balance below threshold — refill USDC",
                balance: operatorBalance.toString(),
                threshold: MIN_OPERATOR_BALANCE_WEI.toString(),
            },
            { status: 503 },
        );
    }

    const active = await getActivePositions();
    const work = active.slice(0, MAX_POSITIONS_PER_RUN);

    const summary: RunSummary = {
        scanned: work.length,
        triggered: 0,
        skipped: 0,
        failed: 0,
        notes: [],
    };

    // Phase 1 — prepare each position (cooldown + fee-bps read + per-mode
    // simulation + skips). Returns the encoded compound()/pushFees() call
    // for positions that should fire; skip paths settle their own DB state.
    const prepared: PreparedCall[] = [];
    for (const position of work) {
        try {
            const p = await prepareOne(
                position,
                compounderAddress,
                publicClient,
                account,
                summary,
            );
            if (p) prepared.push(p);
        } catch (err) {
            summary.failed++;
            summary.notes.push(
                `token=${position.tokenId} error=${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    // Phase 2 — batch every prepared call into ONE Multicall3 transaction
    // (compound/pushFees are permissionless; allowFailure:true so one
    // position whose ticks moved between sim and exec can't revert the
    // others).
    if (prepared.length > 0) {
        const calls = prepared.map((p) => ({
            target: compounderAddress,
            allowFailure: true,
            callData: p.callData,
        }));
        let batchHash: Hex | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let receipt: any = null;
        try {
            batchHash = await walletClient.writeContract({
                address: MULTICALL3_ADDRESS,
                abi: MULTICALL3_AGGREGATE3_ABI,
                functionName: "aggregate3",
                args: [calls],
                chain: ARC_CHAIN,
                account,
                maxFeePerGas: MAX_FEE_PER_GAS_WEI,
            });
            receipt = await publicClient.waitForTransactionReceipt({
                hash: batchHash,
            });
        } catch (err) {
            summary.notes.push(
                `batch-submit error=${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }

        // Phase 3 — settle the DB per position from the SHARED receipt.
        // Success = the position's own Compounded/FeesPushed event is
        // present (an allowFailure subcall that reverted emits no event).
        // The (tx_hash, token_id) unique key (migration 005) lets all N
        // rows share the batch hash.
        if (receipt) {
            for (const p of prepared) {
                await recordOutcome(
                    p,
                    receipt,
                    batchHash as Hex,
                    summary,
                    publicClient,
                    compounderAddress,
                );
            }
        }
    }

    return NextResponse.json({
        ran: true,
        ...summary,
    });
}

interface PreparedCall {
    kind: "compound" | "pushFees";
    position: CompounderPosition;
    fee0: bigint;
    fee1: bigint;
    callData: Hex;
}

async function prepareOne(
    position: CompounderPosition,
    compounderAddress: Address,
    publicClient: ReturnType<typeof createPublicClient>,
    account: ReturnType<typeof privateKeyToAccount>,
    summary: RunSummary,
): Promise<PreparedCall | null> {
    const tokenId = BigInt(position.tokenId);

    // Cooldown read stays cheap. The pendingFees pre-check was REMOVED
    // because pendingFees() in the Compounder returns NPM.tokensOwed
    // verbatim — and tokensOwed is only ever updated when the position
    // is *touched* (mint/burn/collect/decreaseLiquidity). Pure swaps by
    // other traders accumulate in feeGrowthInside but never land in
    // tokensOwed, so the pre-check read 0 even when the real on-chain
    // collect would sync several USDC. The downstream simulateContract
    // on compound() / pushFees() already triggers a full collect under
    // eth_call semantics and surfaces a BELOW_THRESHOLD revert if there
    // truly isn't enough fee accumulation — moving the check there
    // gives us the accurate sync-then-decide flow without an extra
    // round-trip.
    const nextAt = (await publicClient.readContract({
        address: compounderAddress,
        abi: AUTO_COMPOUNDER_ABI,
        functionName: "nextActionAvailableAt",
        args: [tokenId],
    })) as bigint;

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (nextAt > nowSec) {
        summary.skipped++;
        summary.notes.push(`token=${position.tokenId} reason=cooldown`);
        return null;
    }

    // Surface the post-collect amounts in the summary so the
    // "triggered" notes still carry the fee figure the contract acted
    // on. Pulled from the simulation when available; falls back to the
    // stale pendingFees just so the log line isn't empty.
    let fee0 = 0n;
    let fee1 = 0n;

    // Audit M1 + M2 fix: read the live protocol-fee bps and pass it
    // through as the caller's accepted ceiling, plus pass an explicit
    // UNIX deadline. Reading the bps once per position keeps the
    // window between read and write within one block on Arc; any
    // owner-front-run setProtocolFeeBps(higher) lands AFTER our
    // submission and the require inside compound/pushFees rejects
    // before any state change. A 5-minute deadline matches the cron
    // cadence so a stuck mempool tx auto-expires before the next
    // tick would have re-tried it.
    const currentProtocolFeeBps = (await publicClient.readContract({
        address: compounderAddress,
        abi: AUTO_COMPOUNDER_ABI,
        functionName: "protocolFeeBps",
    })) as number;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 5 * 60);

    const modeId = modeIdFromLabel(position.mode);
    if (modeId === 1 /* RECEIVE */) {
        // Simulate pushFees first. Same reasoning as the COMPOUND
        // path: simulateContract triggers NPM.collect under eth_call
        // semantics, which forces a fee sync via pool.burn(0) and
        // returns the actual post-collect (amount0, amount1) the real
        // tx would settle. A BELOW_THRESHOLD revert here means there
        // genuinely aren't enough fees yet; we skip the on-chain tx
        // and try again on the next tick.
        type PushSim = readonly [bigint, bigint];
        type SimResult = PushSim | { skip: string };
        const sim = await withTimeout(
            publicClient
                .simulateContract({
                    address: compounderAddress,
                    abi: AUTO_COMPOUNDER_ABI,
                    functionName: "pushFees",
                    args: [tokenId, currentProtocolFeeBps, deadline],
                    account,
                })
                .then((r): SimResult => r.result as PushSim)
                .catch((err): SimResult => {
                    const msg = err instanceof Error ? err.message : String(err);
                    // Strip down to the short revert reason so logs read
                    // cleanly. Known Compounder reverts:
                    //   BELOW_THRESHOLD   - fees < cfg.minFeeMicros
                    //   NOT_DEPOSITED     - depositor == 0
                    //   WRONG_MODE        - cfg.mode != MODE_RECEIVE
                    //   COOLDOWN          - lastActionAt + cooldown > now
                    //   DEADLINE_PASSED   - deadline < now
                    //   FEE_BPS_OVER_CAP  - protocolFeeBps > ceiling
                    //   TWAP_DEVIATION    - price moved past slippage
                    const KNOWN_REASONS = [
                        "BELOW_THRESHOLD",
                        "NOT_DEPOSITED",
                        "WRONG_MODE",
                        "COOLDOWN",
                        "DEADLINE_PASSED",
                        "FEE_BPS_OVER_CAP",
                        "TWAP_DEVIATION",
                    ];
                    for (const r of KNOWN_REASONS) {
                        if (msg.includes(r)) return { skip: r };
                    }
                    return {
                        skip: `unknown:${msg.slice(0, 120).replace(/\s+/g, " ")}`,
                    };
                }),
            RPC_TIMEOUT_MS,
        );
        if (!sim) {
            summary.skipped++;
            summary.notes.push(
                `token=${position.tokenId} reason=push-sim-timed-out`,
            );
            return null;
        }
        if ("skip" in sim) {
            summary.skipped++;
            summary.notes.push(
                `token=${position.tokenId} reason=push:${sim.skip}`,
            );
            // NOT_DEPOSITED is a permanent state for this tokenId: the
            // user withdrew on-chain but the DB row never got marked
            // withdrawn. Mirror the truth so the cron stops re-scanning
            // it every tick and crowding out real work.
            if (sim.skip === "NOT_DEPOSITED") {
                // 2026-06-15 audit MEDIUM fix: was POSTing to
                // /api/compounder/positions with an unauthenticated
                // body. The route's owner check is skipped when the
                // on-chain depositor reads as zero (the NOT_DEPOSITED
                // case), which gave an attacker a soft-delete vector
                // on rows that legitimately should be withdrawn. Call
                // markWithdrawn directly from the cron - no HTTP hop,
                // no auth surface to defend.
                try {
                    await markWithdrawn(position.tokenId);
                } catch {
                    // best-effort - the reconcile cron will retry
                }
            }
            return null;
        }
        fee0 = sim[0];
        fee1 = sim[1];
        return {
            kind: "pushFees",
            position,
            fee0,
            fee1,
            callData: encodeFunctionData({
                abi: AUTO_COMPOUNDER_ABI,
                functionName: "pushFees",
                args: [tokenId, currentProtocolFeeBps, deadline],
            }),
        };
    }

    if (modeId === 2 /* COMPOUND */) {
        // Audit H1 fix: derive amount0Min / amount1Min off-chain
        // before submitting the real tx. The contract stores
        // cfg.maxSlippageBps but never reads it (see findings H1 +
        // L1), so the only protection against MEV on the cron's
        // compound() comes from the cron itself passing tight mins.
        // Strategy: eth_call (simulateContract) compound(tokenId,
        // 0, 0) to learn the (amount0Used, amount1Used) the pool
        // would actually consume, then apply the position's
        // configured slippage to derive a floor. simulateContract
        // is a free read — no gas spent, no state change — but it
        // does dry-run the underlying NPM.collect + increaseLiquidity
        // sequence so the returned amounts match what the real tx
        // will execute against the same block state.
        //
        // Failure mode: if the simulation reverts (pool moved past
        // a tick boundary between the scanner's pendingFees read
        // and now, or the position is empty), we skip this tick
        // rather than submit a guaranteed-revert tx. The next 5-min
        // tick re-tries against fresh state.
        const slippageBps = BigInt(
            Math.max(0, Math.min(10_000, position.maxSlippageBps ?? 50)),
        );

        type CompoundSim = readonly [bigint, bigint, bigint];
        type CompoundSimResult = CompoundSim | { skip: string };
        const sim = await withTimeout(
            publicClient
                .simulateContract({
                    address: compounderAddress,
                    abi: AUTO_COMPOUNDER_ABI,
                    functionName: "compound",
                    args: [tokenId, 0n, 0n, 500, deadline],
                    account,
                })
                .then((r): CompoundSimResult => r.result as CompoundSim)
                .catch((err): CompoundSimResult => {
                    const msg = err instanceof Error ? err.message : String(err);
                    const KNOWN_REASONS = [
                        "BELOW_THRESHOLD",
                        "NOT_DEPOSITED",
                        "WRONG_MODE",
                        "COOLDOWN",
                        "DEADLINE_PASSED",
                        "FEE_BPS_OVER_CAP",
                        "TWAP_DEVIATION",
                    ];
                    for (const r of KNOWN_REASONS) {
                        if (msg.includes(r)) return { skip: r };
                    }
                    return {
                        skip: `unknown:${msg.slice(0, 120).replace(/\s+/g, " ")}`,
                    };
                }),
            RPC_TIMEOUT_MS,
        );

        if (!sim) {
            summary.skipped++;
            summary.notes.push(
                `token=${position.tokenId} reason=compound-sim-timed-out`,
            );
            return null;
        }
        if ("skip" in sim) {
            summary.skipped++;
            summary.notes.push(
                `token=${position.tokenId} reason=compound:${sim.skip}`,
            );
            if (sim.skip === "NOT_DEPOSITED") {
                // Reconcile directly against the DB (mirror of the RECEIVE
                // path). The previous cross-service HTTP hop to the
                // UNAUTHENTICATED /api/compounder/positions endpoint added a
                // rate-limit/503 failure mode and a missing-ownerAddress
                // inconsistency for no benefit.
                try {
                    await markWithdrawn(position.tokenId);
                } catch {
                    // best-effort - the reconcile cron will retry
                }
            }
            return null;
        }

        // sim = [liquidityAdded, amount0Used, amount1Used]
        const amount0Used = sim[1];
        const amount1Used = sim[2];
        const amount0Min = (amount0Used * (10_000n - slippageBps)) / 10_000n;
        const amount1Min = (amount1Used * (10_000n - slippageBps)) / 10_000n;

        return {
            kind: "compound",
            position,
            fee0,
            fee1,
            callData: encodeFunctionData({
                abi: AUTO_COMPOUNDER_ABI,
                functionName: "compound",
                args: [
                    tokenId,
                    amount0Min,
                    amount1Min,
                    currentProtocolFeeBps,
                    deadline,
                ],
            }),
        };
    }

    // NORMAL mode should never reach here because getActivePositions
    // filters them out, but defend in depth in case the SQL gets
    // edited in a way that breaks the invariant.
    summary.skipped++;
    summary.notes.push(`token=${position.tokenId} reason=mode-normal`);
    return null;
}

async function recordOutcome(
    p: PreparedCall,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    receipt: any,
    batchHash: Hex,
    summary: RunSummary,
    publicClient: ReturnType<typeof createPublicClient>,
    compounderAddress: Address,
): Promise<void> {
    // Settle THIS position's outcome from the SHARED batch receipt. With
    // allowFailure:true a reverted subcall emits no event for its tokenId,
    // so the presence of the position's Compounded / FeesPushed event is
    // the per-position success signal. compound() returns liquidity used —
    // not fees — so the real fees come off the event (2026-06-15 audit
    // HIGH#1); pushFees uses the sim figures already captured in p.fee*.
    const eventNameForKind = p.kind === "compound" ? "Compounded" : "FeesPushed";
    let succeeded = false;
    let resolvedFee0 = p.fee0;
    let resolvedFee1 = p.fee1;
    // LOW-3 (fee audit 2026-07-02): protocol cut recorded per event so
    // Compounded rows are stored NET (same basis as FeesPushed, which the
    // contract already returns net). pushFees carries no separate cut here
    // (p.fee* is already net), so these stay 0 for the FeesPushed path.
    let resolvedProtocolFee0 = 0n;
    let resolvedProtocolFee1 = 0n;
    for (const lg of receipt.logs) {
        // Audit 2026-06-29 (HIGH): only trust logs EMITTED BY the compounder.
        // Without this, a malicious token (compoundable since V3 createPool is
        // permissionless) can emit a forged Compounded log from its OWN address
        // into the shared Multicall3 receipt, overwriting another in-batch
        // position's fee accounting or marking a reverted compound as
        // succeeded. viem's decodeEventLog matches purely on topic0, so a
        // foreign log decodes cleanly without this emitter gate.
        if (!lg.address || lg.address.toLowerCase() !== compounderAddress.toLowerCase()) continue;
        try {
            const decoded = decodeEventLog({
                abi: AUTO_COMPOUNDER_ABI,
                data: lg.data,
                topics: lg.topics,
                eventName: eventNameForKind,
            });
            const args = decoded.args as unknown as {
                tokenId: bigint;
                fee0Collected?: bigint;
                fee1Collected?: bigint;
                protocolFee0?: bigint;
                protocolFee1?: bigint;
            };
            if (args && args.tokenId === BigInt(p.position.tokenId)) {
                succeeded = true;
                if (p.kind === "compound") {
                    // Compounded emits GROSS collected fees + the protocol cut
                    // separately; store NET (gross - cut) so it lines up with
                    // FeesPushed, and keep the cut for the breakdown columns.
                    resolvedProtocolFee0 = args.protocolFee0 ?? 0n;
                    resolvedProtocolFee1 = args.protocolFee1 ?? 0n;
                    const gross0 = args.fee0Collected ?? p.fee0;
                    const gross1 = args.fee1Collected ?? p.fee1;
                    resolvedFee0 = gross0 > resolvedProtocolFee0 ? gross0 - resolvedProtocolFee0 : 0n;
                    resolvedFee1 = gross1 > resolvedProtocolFee1 ? gross1 - resolvedProtocolFee1 : 0n;
                }
                break;
            }
        } catch {
            // not this event on this log — keep scanning.
        }
    }

    if (!succeeded) {
        summary.failed++;
        await enqueueAction(p.position.tokenId, p.kind, {
            error: "subcall-reverted-in-batch",
            txHash: batchHash,
            blockNumber: receipt.blockNumber.toString(),
        });
        return;
    }

    summary.triggered++;
    await stampLastAction(p.position.tokenId, new Date().toISOString());
    // USDC-equivalent of the fees (V3 quoter) + chain-authoritative block
    // timestamp. Both .catch to a safe default so a quoting / timestamp
    // failure never erases the event row (the metric we care about is the
    // receipt-decoded fee amounts, not the USD quote).
    const [usdValueMicros, chainBlockAtIso] = await Promise.all([
        quoteUsdcValueForPair(
            publicClient,
            p.position.token0Address,
            p.position.token1Address,
            resolvedFee0,
            resolvedFee1,
        ).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(
                "[cron] quoteUsdcValueForPair threw, defaulting to 0",
                p.position.tokenId,
                err,
            );
            return 0n;
        }),
        withTimeout(
            publicClient
                .getBlock({ blockNumber: receipt.blockNumber })
                .then(
                    (b: { timestamp: bigint }) =>
                        new Date(Number(b.timestamp) * 1000).toISOString() as string,
                )
                .catch((): string | null => null),
            RPC_TIMEOUT_MS,
        )
            .then((v) => (v as string | null) ?? null)
            .catch(() => null as string | null),
    ]);
    // insertEvent keys on (tx_hash, token_id) (migration 005), so all N
    // positions sharing the batch hash each get their own row. Throw is
    // caught — the reconcile cron heals a missing row on its next sweep.
    try {
        await insertEvent({
            tokenId: p.position.tokenId,
            eventType: p.kind === "compound" ? "Compounded" : "FeesPushed",
            amount0: resolvedFee0.toString(),
            amount1: resolvedFee1.toString(),
            protocolFee0: resolvedProtocolFee0.toString(),
            protocolFee1: resolvedProtocolFee1.toString(),
            usdValueMicros: usdValueMicros.toString(),
            txHash: batchHash,
            blockNumber: receipt.blockNumber.toString(),
            chainBlockAtIso,
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
            "[cron] insertEvent throw — row missing, will reconcile later:",
            p.position.tokenId,
            batchHash,
            err,
        );
    }
}

// quoteUsdcValueForPair moved to @/lib/compounderQuote (imported at the top
// of this file) so the reconcile worker computes the SAME usd_value_micros
// this cron does. Previously reconcile/backfill wrote events with usd = 0,
// permanently undercounting the "Total claimed" USD headline (fee audit
// 2026-07-02 MEDIUM-1).

