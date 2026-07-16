# Arcade indexer (Ponder) — setup & ops

A Ponder indexer in `indexer/` that replaces the client-side RPC log scan behind
the price charts. It indexes every launchpad Buy/Sell and every USDC-paired V3
pool Swap into Postgres and serves OHLC candles + raw trades over HTTP.

## Why it exists

`web/lib/hooks/useTokenCandles.ts` scans logs in the browser, capped at 500
trades and a bounded block window, and returns nothing for WETH-paired V3 pools.
The indexer gives **complete history, real block timestamps, no cap, and full
V3 coverage** while keeping the exact same price + OHLC math (ported verbatim to
`indexer/src/lib/price.ts`; a parity test in `web/__tests__/indexer/price.test.ts`
locks the two in step).

## What it indexes

- **Launchpad Buy/Sell** → curve/migrated token trades (price from `newPriceQ64`).
- **Every V3 pool the factory created** (Ponder `factory()` auto-discovery) →
  Swap trades (price from `sqrtPriceX96`), for USDC-paired pools only. The
  factory's `PoolCreated` teaches each pool's token0 orientation first.

## API (served by `ponder start`)

- `GET /trades?token=0x..` → raw trades oldest-first. The frontend uses this as
  the historical base and keeps its own live-WS append + bucketize.
- `GET /candles?token=0x..&tf=1m` → OHLC candles (tf ∈ 1s,1m,5m,1h,1d).
- `GET /health` → `{ ok: true }`.

## One-time setup

1. `cd indexer && npm install`
2. `cp .env.example .env.local` and fill it:
   - `PONDER_RPC_URL_5042002` — a DEDICATED Arc RPC (the public one rate-limits
     the historical backfill).
   - `DATABASE_URL` — a **separate** Neon database/branch from the app's, so a
     re-sync never touches app tables.
   - `LAUNCHPAD_ADDRESS`, `V3_FACTORY_ADDRESS`, `USDC_ADDRESS` — from
     `web/public/deployments.json` (current-gen defaults are pre-filled).
   - `LAUNCHPAD_START_BLOCK`, `V3_START_BLOCK` — deploy blocks (pre-filled for
     the Arc-testnet current gen, found 2026-07-16). For a new gen, re-run:
     `node scripts/find-start-block.mjs <address> <rpcUrl>`.
3. `npm run dev` (local, hot-reload) or `npm start` (production). Ponder
   backfills from the start blocks then follows the head.

## Deploy (host it)

Ponder is a long-running Node process + Postgres. Host on Railway / Render /
Fly / a VM:
- Run `npm start` with the `.env.local` values as env vars.
- Point it at the dedicated Neon `DATABASE_URL`.
- Expose the HTTP port publicly (read-only price data; CORS is already open).

Then set on **Vercel** (web):
- `NEXT_PUBLIC_INDEXER_URL = https://<indexer-host>` — the frontend prefers it
  for chart history and **falls back to the client RPC scan** on any error or
  when unset, so charts never go blank if the indexer is down.

## Mainnet (turn-key)

Same code. Set the mainnet RPC, the mainnet contract addresses + their deploy
blocks (via `find-start-block.mjs`), a mainnet Neon DB, and the mainnet
`NEXT_PUBLIC_INDEXER_URL`. Nothing in the indexer is testnet-specific.

## Re-sync / reset

`npm run db -- reset` (or drop the indexer DB) then `npm start` re-backfills from
the start blocks. Because the app DB is separate, this is always safe.

## Notes / limits

- The `/trades` and `/candles` responses are capped at 50k rows per token
  (`MAX_TRADES`) — far past any realistic single-token trade count on testnet;
  raise it (and add pagination) if a token ever approaches it at mainnet scale.
- Timeframe bucketing happens per request from the raw trades, so any timeframe
  is served from one dataset without pre-aggregation.
