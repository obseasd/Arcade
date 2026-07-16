# TradingView Advanced Charts — setup

Goal: the pump.fun / Jupiter-style pro chart (drawing tools, indicators, multi-
timeframe) rendered by **TradingView Advanced Charts** (the licensed Charting
Library), fed by OUR Goldsky OHLC — the same data the lightweight-charts chart
uses, so both agree.

## What is already built (code-complete on `main`)
- `web/lib/ohlc.ts` — the canonical `bucketize` + `resolutionToSeconds` (shared
  by both chart paths so the numbers match).
- `web/lib/tradingview/goldskyDatafeed.ts` — `createGoldskyDatafeed({url, token,
  mode, pool})`, a full TradingView datafeed (onReady / resolveSymbol / getBars /
  subscribeBars / unsubscribeBars) reading from the Goldsky subgraph. Unit-tested
  (`web/__tests__/tradingview/`), compiles standalone (no library needed yet).

The ONLY missing piece is the licensed library binary itself, which cannot be
committed (see below), plus swapping the chart component to use it.

## What YOU must do

### 1. Apply for the Charting Library (free, ~a few business days)
- Go to https://www.tradingview.com/advanced-charts/ → **Get the library**.
- Fill the form (company = Arcade, URL = arcade.trading). You agree to their
  license (free; you self-host the files; you keep the "TradingView" attribution
  link on the chart).
- They grant your **GitHub username** access to a private repo
  `tradingview/charting_library` with the library files.

### 2. Add the library to the app (once approved)
- From the private repo, copy the `charting_library/` folder into
  `web/public/charting_library/` (so it serves at `/charting_library/`).
- Do NOT commit it — the license forbids redistribution. It's gitignored
  (`web/public/charting_library/`). Each deploy needs the files present at build
  time: either commit to a PRIVATE mirror, add them in CI from a secret, or
  vendor them in a private submodule. (For a quick start, dropping them in
  `web/public/charting_library/` locally + on Vercel via a build step works.)
- Tell me when they're in place and I wire the component (step 3).

### 3. Wire the component (I do this — trivial once the files exist)
Replace the lightweight-charts render in `web/components/launchpad/PriceChart.tsx`
with the TV widget:
```ts
// after loading /charting_library/charting_library.standalone.js
const widget = new (window as any).TradingView.widget({
  container: containerRef.current,
  library_path: "/charting_library/",
  symbol: token,
  interval: "5",
  datafeed: createGoldskyDatafeed({
    url: process.env.NEXT_PUBLIC_GOLDSKY_URL,
    token, mode, pool,
    symbolName: `${tokenSymbol}/USDC`,
    priceScale: 1e9, // tune per token price magnitude
  }),
  autosize: true,
  theme: "dark",
  timezone: "Etc/UTC",
});
```
The datafeed does the rest (history from Goldsky, live via a 15s poll).

## Notes / decisions
- **Price scale**: launchpad token prices are tiny (USDC per whole token). The
  datafeed defaults `pricescale` to 1e8; bump to 1e9/1e12 for very small prices,
  or compute it per token from the first bars.
- **Keep lightweight-charts as the fallback** for anyone without the library at
  build time, or drop it once TV is live. `NEXT_PUBLIC_GOLDSKY_URL` powers both.
- **Live updates**: the datafeed polls Goldsky every 15s for the current bar. If
  you want sub-second live, wire `subscribeBars` to the existing on-chain WS
  events instead of the poll (the lightweight path already has them).
- Alternative if you never get library access: **KLineCharts** (open-source, no
  license, similar toolset) — the same `bucketize`/datafeed data works with a
  thin adapter.
