import type { Address } from "viem";

/**
 * Goldsky subgraph trade fetch for the price charts. Pure + url-injected (no
 * wagmi/env coupling) so the pagination is unit-testable. useTokenCandles wires
 * NEXT_PUBLIC_GOLDSKY_URL and merges the result with its live-WS bucketize path.
 *
 * Pages DESCENDING (newest first) by blockNumber so a token with more than
 * PAGE*MAX_PAGES trades keeps the RECENT price action (the old client scan also
 * took the newest trades), then returns them sorted ASCENDING for bucketize.
 */

export interface GoldskyTrade {
    time: number;
    price: number;
    volumeUsdc: number;
    isBuy?: boolean;
}

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
// The Graph caps `first` at 1000; walk down up to MAX_PAGES pages.
export const GOLDSKY_PAGE = 1000;
export const GOLDSKY_MAX_PAGES = 10; // 10k most-recent trades

interface GoldskyRow {
    blockTime: string | number;
    blockNumber: string | number;
    logIndex: string | number;
    price: string | number;
    volumeUsdc: string | number;
    isBuy: boolean;
}

interface SortRow extends GoldskyTrade {
    _bn: number;
    _li: number;
}

export async function fetchTradesFromGoldsky(
    url: string | undefined,
    token: Address,
    mode: number,
    pool?: Address,
    // Page size / cap are injectable so the pagination is unit-testable without
    // generating 1000+ mock rows; production uses the exported defaults.
    opts?: { pageSize?: number; maxPages?: number },
): Promise<GoldskyTrade[] | null> {
    if (!url) return null;
    const pageSize = opts?.pageSize ?? GOLDSKY_PAGE;
    const maxPages = opts?.maxPages ?? GOLDSKY_MAX_PAGES;
    // Match the client's single-source-per-token behaviour: mode==2 is a
    // CLANKER_V3 token (V3 pool swaps), everything else is a curve token
    // (launchpad Buy/Sell). For V3 we pin the exact pool the client charts (the
    // permissionless factory can index several USDC pools for one token).
    const source = mode === 2 ? "v3" : "curve";
    const wherePool =
        source === "v3" && pool && pool.toLowerCase() !== ZERO_ADDR
            ? `, pool: "${pool.toLowerCase()}"`
            : "";
    try {
        const seen = new Set<string>();
        const out: SortRow[] = [];
        // Upper bound on blockNumber; null = start at the newest. We walk down.
        let cursor: string | null = null;
        for (let page = 0; page < maxPages; page++) {
            const bound = cursor === null ? "" : `, blockNumber_lte: "${cursor}"`;
            const query = `{ trades(first: ${pageSize}, orderBy: blockNumber, orderDirection: desc, where: { token: "${token.toLowerCase()}", source: "${source}"${wherePool}${bound} }) { blockTime blockNumber logIndex price volumeUsdc isBuy } }`;
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query }),
            });
            // On a page failure we KEEP what we have (the newest pages, which is
            // the data that matters) and stop; page-0 failure leaves out empty
            // -> null -> the caller falls back to the client scan.
            if (!res.ok) break;
            const json = (await res.json()) as { data?: { trades?: GoldskyRow[] } };
            const rows = json?.data?.trades;
            if (!Array.isArray(rows)) break;

            let minBlock: number | null = cursor === null ? null : Number(cursor);
            for (const r of rows) {
                const key = `${r.blockNumber}-${r.logIndex}`;
                if (seen.has(key)) continue; // cursor overlap on the boundary block
                seen.add(key);
                const time = Number(r.blockTime);
                const price = Number(r.price);
                const volumeUsdc = Number(r.volumeUsdc);
                const bn = Number(r.blockNumber);
                if (!isFinite(time) || !isFinite(price) || !isFinite(volumeUsdc)) continue;
                out.push({
                    time,
                    price,
                    volumeUsdc,
                    isBuy: typeof r.isBuy === "boolean" ? r.isBuy : undefined,
                    _bn: bn,
                    _li: Number(r.logIndex),
                });
                if (minBlock === null || bn < minBlock) minBlock = bn;
            }
            if (rows.length < pageSize) break; // reached the oldest page
            // Safety: if the whole page sat in one block the cursor can't move
            // down (a single block with >PAGE trades) -> stop with what we have
            // rather than re-fetch the same block forever.
            if (minBlock === null || String(minBlock) === cursor) break;
            cursor = String(minBlock); // walk down; _lte re-includes the boundary (deduped)
        }
        return out.length > 0 ? finalize(out) : null;
    } catch {
        return null;
    }
}

/** (blockTime, blockNumber, logIndex) ascending = true on-chain order (matches
 *  the subgraph/Ponder ordering); strips the sort-only fields for bucketize. */
function finalize(rows: SortRow[]): GoldskyTrade[] {
    rows.sort((a, b) => a.time - b.time || a._bn - b._bn || a._li - b._li);
    return rows.map((r) => ({
        time: r.time,
        price: r.price,
        volumeUsdc: r.volumeUsdc,
        isBuy: r.isBuy,
    }));
}
