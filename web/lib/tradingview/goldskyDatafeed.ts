import type { Address } from "viem";
import { fetchTradesFromGoldsky, type GoldskyTrade } from "@/lib/goldskyTrades";
import { bucketize, resolutionToSeconds, type Candle } from "@/lib/ohlc";

/**
 * TradingView Advanced Charts datafeed backed by the Goldsky subgraph.
 *
 * Implements the TradingView "IBasicDataFeed" surface (onReady / resolveSymbol /
 * getBars / subscribeBars / unsubscribeBars) so the licensed Charting Library
 * can render Arcade tokens using OUR OHLC data -- the same Goldsky trades +
 * bucketize the lightweight-charts path uses, so both charts agree.
 *
 * The Charting Library is NOT bundled (it is license-gated), so this file is
 * typed loosely (no `charting_library` import) and compiles standalone. Once you
 * add the library, you can annotate the return value as `IBasicDataFeed` and the
 * callbacks against its types -- the runtime shape already matches.
 *
 * Usage (in the chart component, once the library is loaded):
 *   const widget = new window.TradingView.widget({
 *     symbol: token,
 *     datafeed: createGoldskyDatafeed({
 *       url: process.env.NEXT_PUBLIC_GOLDSKY_URL, token, mode, pool,
 *     }),
 *     library_path: "/charting_library/",
 *     interval: "5", container: "tv_chart", ...
 *   });
 */

const SUPPORTED_RESOLUTIONS = ["1S", "1", "5", "15", "60", "240", "1D"] as const;
// How often subscribeBars polls the subgraph for the live bar.
const POLL_MS = 15_000;

interface DatafeedOpts {
    url: string | undefined;
    token: Address;
    /** 2 => CLANKER_V3 (v3 pool swaps); else curve (launchpad Buy/Sell). */
    mode: number;
    /** The exact V3 pool to chart (for mode==2). */
    pool?: Address;
    /** Display symbol/description; defaults to the token address. */
    symbolName?: string;
    /**
     * 10^decimals for price display. Launchpad token prices are tiny (USDC per
     * whole token, ~1e-6 and below), so a large scale is needed to show digits.
     */
    priceScale?: number;
}

// TradingView bar shape.
interface TvBar {
    time: number; // MILLISECONDS
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

function candleToBar(c: Candle): TvBar {
    return {
        time: c.time * 1000, // TV wants milliseconds
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    };
}

export function createGoldskyDatafeed(opts: DatafeedOpts) {
    // One fetch of the trade history, cached and reused across resolutions and
    // getBars range requests (TradingView calls getBars repeatedly as the user
    // scrolls). The subgraph fetch already returns the recent window newest-
    // first, sorted oldest-first.
    let tradesPromise: Promise<GoldskyTrade[] | null> | null = null;
    function loadTrades(): Promise<GoldskyTrade[] | null> {
        if (!tradesPromise) {
            tradesPromise = fetchTradesFromGoldsky(
                opts.url,
                opts.token,
                opts.mode,
                opts.pool,
            );
        }
        return tradesPromise;
    }

    const priceScale = opts.priceScale ?? 100_000_000; // 1e8 default
    const pollers = new Map<string, ReturnType<typeof setInterval>>();

    return {
        onReady(callback: (config: unknown) => void): void {
            // Must be async per the TV contract.
            setTimeout(
                () =>
                    callback({
                        supported_resolutions: SUPPORTED_RESOLUTIONS,
                        supports_time: true,
                        exchanges: [],
                        symbols_types: [],
                    }),
                0,
            );
        },

        resolveSymbol(
            _symbolName: string,
            onResolve: (info: unknown) => void,
        ): void {
            setTimeout(
                () =>
                    onResolve({
                        name: opts.symbolName ?? opts.token,
                        ticker: opts.token,
                        description: opts.symbolName ?? "Arcade token",
                        type: "crypto",
                        session: "24x7",
                        timezone: "Etc/UTC",
                        exchange: "Arcade",
                        listed_exchange: "Arcade",
                        format: "price",
                        minmov: 1,
                        pricescale: priceScale,
                        has_intraday: true,
                        has_seconds: true,
                        seconds_multipliers: ["1"],
                        supported_resolutions: SUPPORTED_RESOLUTIONS,
                        volume_precision: 2,
                        data_status: "streaming",
                    }),
                0,
            );
        },

        async getBars(
            _symbolInfo: unknown,
            resolution: string,
            periodParams: { from: number; to: number; firstDataRequest: boolean },
            onResult: (bars: TvBar[], meta: { noData: boolean }) => void,
            onError: (reason: string) => void,
        ): Promise<void> {
            try {
                const trades = await loadTrades();
                if (!trades || trades.length === 0) {
                    onResult([], { noData: true });
                    return;
                }
                const bucketSec = resolutionToSeconds(resolution);
                const candles = bucketize(trades, bucketSec);
                // TV asks for a [from, to] window (seconds). Return the bars in
                // range; empty-in-range with older data present => noData:false
                // so TV knows history exists (it just paged past our window).
                const bars = candles
                    .filter((c) => c.time >= periodParams.from && c.time <= periodParams.to)
                    .map(candleToBar);
                const haveOlder = candles.length > 0 && candles[0].time < periodParams.from;
                onResult(bars, { noData: bars.length === 0 && !haveOlder });
            } catch (e) {
                onError(e instanceof Error ? e.message : "getBars failed");
            }
        },

        subscribeBars(
            _symbolInfo: unknown,
            resolution: string,
            onTick: (bar: TvBar) => void,
            listenerGuid: string,
        ): void {
            const bucketSec = resolutionToSeconds(resolution);
            const tick = async () => {
                // Re-fetch fresh (bypass the history cache) so the live bar
                // reflects new trades. Cheap: the subgraph query is paginated
                // + capped.
                const trades = await fetchTradesFromGoldsky(
                    opts.url,
                    opts.token,
                    opts.mode,
                    opts.pool,
                );
                if (!trades || trades.length === 0) return;
                const candles = bucketize(trades, bucketSec);
                if (candles.length > 0) onTick(candleToBar(candles[candles.length - 1]));
            };
            const id = setInterval(() => void tick(), POLL_MS);
            pollers.set(listenerGuid, id);
            void tick(); // prime immediately
        },

        unsubscribeBars(listenerGuid: string): void {
            const id = pollers.get(listenerGuid);
            if (id) {
                clearInterval(id);
                pollers.delete(listenerGuid);
            }
        },
    };
}
