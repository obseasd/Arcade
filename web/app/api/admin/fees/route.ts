import { parseAbiItem, type Address } from "viem";
import { serverReadClient } from "@/lib/serverRpc";
import { bad, ok } from "@/lib/agent/http";
import deployments from "../../../../public/deployments.json";

/**
 * Admin fee-history API.
 *
 * Scans USDC `Transfer` event logs where `to == treasury` over a recent
 * block window and categorizes each inbound transfer by its `from` address
 * into a human "reason" (launchpad fee, locked-LP fee, compounder fee, or
 * other). Browser-side ETH RPC is blocked by ad-blockers on Arc, so this
 * scan MUST run server-side here, never in the client component.
 *
 * Arc RPC caps getLogs block ranges, so we scan only the most recent window
 * in safe chunks and surface a partial result rather than 500ing if a chunk
 * fails. Full all-time history is better served by the Goldsky subgraph.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Chunked getLogs across a 500k-block window for the treasury scan + RoyaltyPaid;
// give it headroom over the platform default.
export const maxDuration = 60;

// Block window per eth_getLogs call. Arc RPCs HARD-CAP getLogs at 10_000 blocks
// (arc.network returns error -32614, thirdweb silently empties), so 9k stays
// safely inside the cap. (An earlier 45k value silently over-ranged and every
// chunk failed -> truncated results.)
const BLOCK_WINDOW = 9_000n;

// Hard cap on total blocks scanned per request. ~500k blocks at Arc's block
// time covers roughly the last few days of activity, enough to surface the
// recent fee stream while keeping the route fast. Older history lands with
// the indexer.
const MAX_TOTAL_BLOCKS = 500_000n;

// Fresh-start baseline: never count fees before this block, so the dashboard
// reads $0 at reset and only accrues from here. Bump ADMIN_FEES_BASELINE_BLOCK
// (env) to reset again without a code change. Set 2026-07-21 to "now".
const BASELINE_BLOCK = BigInt(process.env.ADMIN_FEES_BASELINE_BLOCK ?? "52951264");

const TRANSFER_EVENT = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// Launchpad TokenCreated, used only to collect the tx hashes of real token
// creations so a $3.000000 transfer is recognized as a creation fee only when
// it shares a tx with one of these (fee audit 2026-07-02 LOW-1).
const TOKEN_CREATED_EVENT = parseAbiItem(
    "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);

// V4 hook post-graduation protocol fee. RoyaltyPaid logs treasuryAmount (the 20%
// protocol cut) EXPLICITLY, so we sum that instead of scanning USDC transfers to
// hook.TREASURY -- the treasury is the operator EOA which also TRADES, so a
// transfer-based scan would over-count its trade proceeds as fees. Currency-
// filtered to USDC (the always-USDC capture). Curve-platform / migration /
// creation fees are separate and not summed here (noted in the response).
const ROYALTY_PAID_EVENT = parseAbiItem(
    "event RoyaltyPaid(bytes32 indexed poolId, address indexed creator, uint256 creatorAmount, uint256 treasuryAmount, address currency)",
);

const lc = (a: string) => a.toLowerCase();

// Warm-instance cache. This route is UNAUTHENTICATED (the /admin/fees client page
// calls it directly from the browser) and each miss runs several chunked getLogs
// passes, so cache the result briefly to cap the RPC cost from repeated/abusive
// hits without breaking the page. Fee data moves slowly; 60s is plenty.
let feesCache: { at: number; payload: Record<string, unknown> } | null = null;
const FEES_TTL_MS = 60_000;

/** Format a 6-decimal USDC raw bigint into a human string (e.g. "12.50"). */
function fmtUsdc(raw: bigint): string {
    const neg = raw < 0n;
    const a = neg ? -raw : raw;
    const base = 1_000_000n;
    const whole = a / base;
    const frac = (a % base).toString().padStart(6, "0");
    return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export async function GET() {
    if (feesCache && Date.now() - feesCache.at < FEES_TTL_MS) {
        return ok({ ...feesCache.payload, cached: true });
    }
    const addrs = deployments.addresses;
    const treasury = addrs.treasury as Address | undefined;
    const usdc = addrs.USDC as Address | undefined;
    if (!treasury || !usdc) {
        return bad("treasury or USDC address missing from deployments.json", {
            status: 500,
            code: "CONFIG",
        });
    }

    // The fixed launchpad creation fee is paid creator -> treasury inside
    // createToken, so its `from` is the creator EOA (not the launchpad). We
    // recognize it by its exact amount.
    let creationFeeRaw = 0n;
    try {
        creationFeeRaw = BigInt(deployments.constants?.creationFeeUsdc ?? "0");
    } catch {
        creationFeeRaw = 0n;
    }

    // Set of tx hashes (lowercased) that emitted a launchpad TokenCreated in
    // the scanned window. Populated below, before the classify pass runs.
    // Fee audit 2026-07-02 LOW-1: the creation fee used to be recognized by
    // its exact $3.000000 amount ALONE, so any inbound transfer of exactly
    // $3 (a trade proceed, a round-number send) to the treasury EOA inflated
    // the headline as a phantom "creation fee". We now require the transfer
    // to share a tx with an actual TokenCreated event.
    const creationTxHashes = new Set<string>();

    // Categorize an inbound transfer by its `from` address + amount + tx.
    // Transfers FROM a recognized Arcade fee contract, OR of exactly the
    // creation fee AND emitted in a real token-creation tx, count as protocol
    // fees. On testnet the treasury is the deployer EOA, also used for
    // trading, so other inbound USDC (trade proceeds, direct sends) is listed
    // but NOT summed into the fee total.
    const classify = (
        from: string,
        amount: bigint,
        txHash: string,
    ): { reason: string; isFee: boolean } => {
        const f = lc(from);
        if (f === lc(addrs.launchpad)) {
            return { reason: "Launchpad fee (migration / snipe skim)", isFee: true };
        }
        if (f === lc(addrs.v3Locker)) return { reason: "Locked-LP protocol fee", isFee: true };
        if (f === lc(addrs.autoCompounder)) return { reason: "Auto-compounder protocol fee", isFee: true };
        // V4 hook protocol fees (curve platform 50%, post-grad treasury 20%,
        // migration fee). NOTE: only captured here if the hook's TREASURY is set
        // to `treasury` (deployments.treasury). It currently points at the
        // operator EOA instead, so these land elsewhere until re-pointed via
        // hook.setTreasury(Safe) -- see the fee-destination audit.
        if (addrs.arcadeHook && f === lc(addrs.arcadeHook)) {
            return { reason: "V4 hook fee (curve platform / royalty / migration)", isFee: true };
        }
        if (
            creationFeeRaw > 0n &&
            amount === creationFeeRaw &&
            txHash &&
            creationTxHashes.has(lc(txHash))
        ) {
            return { reason: "Launchpad token creation fee", isFee: true };
        }
        return { reason: "Direct transfer / trade proceeds (not a protocol fee)", isFee: false };
    };

    // Resilient thirdweb-first fallback client (arc.network rate-limits Vercel's
    // shared IPs, which was causing chunk failures / truncated results).
    const client = serverReadClient();

    let head: bigint;
    try {
        head = await client.getBlockNumber();
    } catch {
        return bad("could not read chain head from Arc RPC", {
            status: 502,
            code: "RPC",
            retryable: true,
        });
    }
    // Rolling window, floored at the fresh-start baseline so nothing before the
    // reset is ever counted.
    const windowStart = head > MAX_TOTAL_BLOCKS ? head - MAX_TOTAL_BLOCKS : 0n;
    const fromBlock = windowStart > BASELINE_BLOCK ? windowStart : BASELINE_BLOCK;

    // Topic-filtered Transfer scan: indexed `to == treasury`. We pass the
    // `args.to` filter so the RPC narrows at the topics[2] level and we only
    // pull inbound transfers.
    type TransferLog = Awaited<ReturnType<typeof scanChunk>>[number];
    const scanChunk = (from: bigint, to: bigint) =>
        client.getLogs({
            address: usdc,
            event: TRANSFER_EVENT,
            args: { to: treasury },
            fromBlock: from,
            toBlock: to,
        });

    const logs: TransferLog[] = [];
    let truncated = false;

    for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
        const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
        try {
            const chunk = await scanChunk(from, to);
            logs.push(...chunk);
        } catch (e) {
            // Resilient: skip the failing chunk, flag partial, keep going.
            truncated = true;
            console.warn(`[admin/fees] getLogs ${from}..${to} failed:`, e);
        }
    }

    // V4 hook post-graduation protocol fees: scan RoyaltyPaid on the hook and
    // sum treasuryAmount for USDC-denominated royalties. Independent of the
    // treasury address, so it works even though hook.TREASURY is the operator EOA.
    const usdcLc = lc(usdc);
    type RoyaltyLog = Awaited<ReturnType<typeof scanRoyalty>>[number];
    const scanRoyalty = (from: bigint, to: bigint) =>
        client.getLogs({
            address: addrs.arcadeHook as Address,
            event: ROYALTY_PAID_EVENT,
            fromBlock: from,
            toBlock: to,
        });
    const royaltyLogs: RoyaltyLog[] = [];
    if (addrs.arcadeHook) {
        for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
            const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
            try {
                royaltyLogs.push(...(await scanRoyalty(from, to)));
            } catch (e) {
                truncated = true;
                console.warn(`[admin/fees] RoyaltyPaid getLogs ${from}..${to} failed:`, e);
            }
        }
    }

    // Resolve block timestamps once per unique block (cheap dedupe).
    const uniqueBlocks = Array.from(
        new Set([...logs.map((l) => l.blockNumber), ...royaltyLogs.map((l) => l.blockNumber)]),
    ).filter((b): b is bigint => b !== null);
    const tsByBlock = new Map<bigint, number>();
    await Promise.all(
        uniqueBlocks.map(async (b) => {
            try {
                const blk = await client.getBlock({ blockNumber: b });
                tsByBlock.set(b, Number(blk.timestamp));
            } catch {
                tsByBlock.set(b, 0);
            }
        }),
    );

    // Populate creationTxHashes: scan the launchpad's TokenCreated events over
    // the same window. Only the current launchpad is scanned; a token created
    // on an older generation within the window (right after a redeploy) would
    // be listed as "not a fee" rather than falsely counted -- the safe
    // direction (a small under-count beats the $3-trade over-count this fixes).
    if (creationFeeRaw > 0n && addrs.launchpad) {
        const launchpad = addrs.launchpad as Address;
        for (let from = fromBlock; from <= head; from += BLOCK_WINDOW) {
            const to = from + BLOCK_WINDOW - 1n > head ? head : from + BLOCK_WINDOW - 1n;
            try {
                const created = await client.getLogs({
                    address: launchpad,
                    event: TOKEN_CREATED_EVENT,
                    fromBlock: from,
                    toBlock: to,
                });
                for (const c of created) {
                    if (c.transactionHash) creationTxHashes.add(lc(c.transactionHash));
                }
            } catch (e) {
                truncated = true;
                console.warn(`[admin/fees] TokenCreated getLogs ${from}..${to} failed:`, e);
            }
        }
    }

    let feeRaw = 0n; // only recognized protocol fees
    let grossRaw = 0n; // every inbound transfer (incl. trades / direct)
    const treasuryItems = logs.map((l) => {
        const amount = l.args.value ?? 0n;
        const fromAddr = (l.args.from ?? "0x0000000000000000000000000000000000000000") as string;
        const block = l.blockNumber ?? 0n;
        const txHash = l.transactionHash ?? "";
        const { reason, isFee } = classify(fromAddr, amount, txHash);
        grossRaw += amount;
        if (isFee) feeRaw += amount;
        return {
            txHash,
            block: Number(block),
            timestamp: tsByBlock.get(block) ?? 0,
            amountUsdc: fmtUsdc(amount),
            from: fromAddr,
            reason,
            isFee,
        };
    });

    // V4 post-grad protocol fees, from RoyaltyPaid.treasuryAmount (USDC only).
    let v4FeeRaw = 0n;
    const v4Items = royaltyLogs
        .filter((l) => lc((l.args.currency ?? "0x") as string) === usdcLc)
        .map((l) => {
            const amount = (l.args.treasuryAmount ?? 0n) as bigint;
            const block = l.blockNumber ?? 0n;
            v4FeeRaw += amount;
            feeRaw += amount;
            grossRaw += amount;
            return {
                txHash: l.transactionHash ?? "",
                block: Number(block),
                timestamp: tsByBlock.get(block) ?? 0,
                amountUsdc: fmtUsdc(amount),
                from: (addrs.arcadeHook ?? "") as string,
                reason: "V4 hook post-grad protocol fee (RoyaltyPaid treasury cut)",
                isFee: true,
            };
        })
        .filter((i) => i.amountUsdc !== "0.000000");

    const items = [...treasuryItems, ...v4Items].sort((a, b) => b.block - a.block);
    const feeCount = items.filter((i) => i.isFee).length;

    const payload = {
        ok: true,
        treasury,
        fromBlock: Number(fromBlock),
        toBlock: Number(head),
        // Headline = recognized protocol fees only. grossUsdc is every inbound
        // transfer (which on testnet includes the treasury EOA's own trades).
        totalUsdc: fmtUsdc(feeRaw),
        grossUsdc: fmtUsdc(grossRaw),
        // V4 post-grad protocol fees (from RoyaltyPaid), broken out of the total.
        v4FeesUsdc: fmtUsdc(v4FeeRaw),
        count: feeCount,
        grossCount: items.length,
        truncated,
        baselineBlock: Number(BASELINE_BLOCK),
        note: "Reset baseline: only fees at/after block " +
            BASELINE_BLOCK.toString() +
            " are counted (fresh start). Headline = V2/V3 protocol fees (transfers from the launchpad / locker / compounder to the governance treasury) PLUS V4 post-grad protocol fees (RoyaltyPaid.treasuryAmount from the hook, which land on the operator EOA, not this treasury). V4 curve-platform / migration / creation fees are NOT yet summed (they also route to the operator and can't be cleanly separated from its trades via transfers). Rolling recent window; full history via the Goldsky subgraph.",
        items,
    };
    // Only cache complete scans; a truncated (partial) result shouldn't stick.
    if (!truncated) feesCache = { at: Date.now(), payload };
    return ok(payload);
}
