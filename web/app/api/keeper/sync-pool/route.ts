import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    createWalletClient,
    http,
    isAddress,
    getAddress,
    type Address,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ADDRESSES } from "@/lib/constants";
import { arcActive } from "@/lib/chains";
import { rateLimit, rateLimitGlobal } from "@/lib/apiGuard";
import { tryAcquireKeeperLease, releaseKeeperLease } from "@/lib/keeperPersistence";

export const maxDuration = 30;

const ZERO = "0x0000000000000000000000000000000000000000";
// Match the cron's gas ceiling so an on-demand sync is priced identically and
// not left to default estimation on Arc.
const MAX_FEE_PER_GAS_WEI = 100_000_000_000n; // 100 gwei
// Brief lease: it only has to cover one tx submission (nonce consumption), then
// it's released so a waiting cron run isn't blocked for the full TTL.
const SYNC_POOL_LEASE_SECONDS = 20;

const POOL_ABI = [
    {
        type: "function",
        name: "slot0",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { type: "uint160" },
            { type: "int24" },
            { type: "uint16" },
            { type: "uint16" },
            { type: "uint16" },
            { type: "uint8" },
            { type: "bool" },
        ],
    },
    { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const MANAGER_ABI = [
    {
        type: "function",
        name: "isLaunchPool",
        stateMutability: "view",
        inputs: [{ name: "pool", type: "address" }],
        outputs: [{ type: "bool" }],
    },
    {
        type: "function",
        name: "sync",
        stateMutability: "nonpayable",
        inputs: [{ name: "pool", type: "address" }],
        outputs: [],
    },
] as const;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * POST /api/keeper/sync-pool  { pool: "0x..." }
 *
 * On-demand activation of the V3 platform fee on a freshly created ORDINARY
 * pool, so the ~2-6min cron gap is cut to ~seconds. The keeper cron is the
 * backstop: anything this misses (or that fails here) is re-scanned + synced
 * within a couple ticks, and the on-chain state is the source of truth, so this
 * is a pure latency optimisation -- never load-bearing.
 *
 * Abuse is bounded by design, NOT by auth (the caller is the public frontend):
 *  - per-IP + global rate limits cap the request volume;
 *  - every branch that would cost gas is gated behind READ-only pre-checks, so a
 *    garbage / foreign / already-synced / launch pool costs zero on-chain (no
 *    tx is ever sent unless the pool is genuinely one of OUR ordinary V3 pools
 *    that is initialized and still at feeProtocol 0);
 *  - `sync` is permissionless and idempotent, and `manager.sync` reverts on a
 *    pool from another factory anyway (the manager only owns OUR factory), so
 *    the worst case is one wasted-gas tx which the factory() pre-check prevents.
 * Net: an attacker must CREATE a real ordinary pool (paying for it) to trigger
 * at most ONE sync tx (~$0.0012), which is exactly the intended behaviour.
 */
export async function POST(req: NextRequest) {
    const rl = rateLimit(req, "sync-pool", 10, 60_000) ?? rateLimitGlobal("sync-pool", 30, 60_000);
    if (rl) return rl;

    let pool: Address;
    try {
        const body = (await req.json()) as { pool?: string };
        if (!body?.pool || !isAddress(body.pool)) {
            return NextResponse.json({ ran: false, reason: "bad pool" }, { status: 400 });
        }
        pool = getAddress(body.pool);
    } catch {
        return NextResponse.json({ ran: false, reason: "bad body" }, { status: 400 });
    }

    const manager = ADDRESSES.feeProtocolManager as Address;
    const factory = ADDRESSES.v3Factory as Address;
    if (manager === ZERO || factory === ZERO) {
        return NextResponse.json({ ran: false, reason: "manager not wired" });
    }
    const keeperKey = process.env.KEEPER_OPERATOR_PRIVATE_KEY as Hex | undefined;
    if (!keeperKey || !/^0x[0-9a-fA-F]{64}$/.test(keeperKey)) {
        return NextResponse.json({ ran: false, reason: "no keeper key" });
    }

    const publicClient = createPublicClient({ chain: arcActive, transport: http() });

    // --- READ-only pre-checks: no tx unless it's OUR ordinary, initialized,
    //     not-yet-synced pool. Each early-return costs zero gas. ---
    const poolFactory = (await publicClient
        .readContract({ address: pool, abi: POOL_ABI, functionName: "factory" })
        .catch(() => null)) as Address | null;
    if (!poolFactory) return NextResponse.json({ ran: false, reason: "not a v3 pool" });
    if (getAddress(poolFactory) !== getAddress(factory)) {
        return NextResponse.json({ ran: false, reason: "foreign factory" });
    }

    const slot0 = (await publicClient
        .readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" })
        .catch(() => null)) as readonly [bigint, number, number, number, number, number, boolean] | null;
    if (!slot0) return NextResponse.json({ ran: false, reason: "no slot0" });
    if (slot0[0] === 0n) return NextResponse.json({ ran: false, reason: "pool not initialized" });
    if (slot0[5] !== 0) {
        return NextResponse.json({ ran: true, reason: "already synced", feeProtocol: slot0[5] });
    }

    const isLaunch = (await publicClient
        .readContract({ address: manager, abi: MANAGER_ABI, functionName: "isLaunchPool", args: [pool] })
        .catch(() => null)) as boolean | null;
    if (isLaunch === true) return NextResponse.json({ ran: false, reason: "launch pool, stays at 0" });

    // --- Simulate BEFORE taking the lease / sending. The read pre-checks above
    //     read attacker-CONTROLLABLE view functions (factory/slot0), so a fake
    //     contract can pass them; simulateContract runs the REAL sync (incl. the
    //     manager's _isCanonicalPool factory.getPool round-trip + tier check), so
    //     a fake / foreign / unmanaged-tier pool reverts HERE at zero gas and
    //     WITHOUT touching the shared lease (audit: fake-pool gas-drain + cron
    //     lease starvation). ---
    const account = privateKeyToAccount(keeperKey);
    try {
        await publicClient.simulateContract({
            address: manager,
            abi: MANAGER_ABI,
            functionName: "sync",
            args: [pool],
            account,
        });
    } catch (e) {
        return NextResponse.json({ ran: false, reason: "sync would revert (skipped)", error: errMsg(e) });
    }

    // --- Send under the SHARED keeper lease so this can't collide with a
    //     concurrent cron run on the shared wallet's nonce. If the cron (or
    //     another sync-pool call) holds the lease we DON'T send: the cron's leg-C
    //     scan syncs this pool within a tick, so deferring is correct. ---
    const holder = `sync-pool-${globalThis.crypto?.randomUUID?.() ?? String(Date.now())}`;
    const gotLease = await tryAcquireKeeperLease(SYNC_POOL_LEASE_SECONDS, holder).catch(() => false);
    if (!gotLease) {
        return NextResponse.json({ ran: false, reason: "keeper busy (cron will sync)" });
    }
    try {
        const walletClient = createWalletClient({ account, chain: arcActive, transport: http() });
        const hash = await walletClient.writeContract({
            address: manager,
            abi: MANAGER_ABI,
            functionName: "sync",
            args: [pool],
            chain: arcActive,
            account, // local account object -> local signing (eth_sendRawTransaction)
            maxFeePerGas: MAX_FEE_PER_GAS_WEI,
        });
        return NextResponse.json({ ran: true, synced: true, hash });
    } catch (e) {
        // Non-fatal: the cron re-scans + syncs this pool within a couple ticks.
        return NextResponse.json({ ran: false, reason: "sync tx failed (cron will retry)", error: errMsg(e) });
    } finally {
        // Release once the tx is submitted (nonce already consumed on-chain) so a
        // waiting cron run isn't blocked for the full lease TTL.
        await releaseKeeperLease(holder).catch(() => {});
    }
}
