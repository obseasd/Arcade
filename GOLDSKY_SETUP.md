# Arcade charts — Goldsky subgraph setup

The price charts are backed by a **Goldsky-hosted subgraph** (`subgraph/`) that
indexes launchpad Buy/Sell + every USDC-paired V3 pool Swap and serves complete
USDC price/volume history over GraphQL. This replaces the self-hosted Ponder
indexer (`indexer/`, now superseded — kept only for reference/parity). Goldsky
is an Arc Builders Fund data-infra partner: fully managed, no server, no DB, no
RPC to run.

## Why a subgraph (not self-hosted)
Zero infra to operate, 99.9% uptime, autoscaling GraphQL, and it's the
Arc-recommended path (https://docs.arc.io/arc/tools/data-indexers). The price
math is a verbatim port of the client `useTokenCandles` / the Ponder `price.ts`
(same `newPriceQ64` / `sqrtPriceX96` formulas), so charts stay identical; the
frontend still bucketizes into OHLC in TS and falls back to the client RPC scan
if the subgraph is unset or errors.

## What it indexes
- **Launchpad Buy/Sell** → curve/migrated token trades (price from `newPriceQ64`).
- **V3 Factory `PoolCreated`** → records each USDC-paired pool + spawns a
  `V3Pool` template (the subgraph factory pattern).
- **V3Pool `Swap`** (per created pool) → pool trades (price from `sqrtPriceX96`).

Avoids the Arc EIP-7708 trap by design: it indexes Buy/Sell/Swap topics, never
the 18-decimal system `Transfer` logs.

## Build (local validation)
```sh
cd subgraph
npm install
npm run codegen   # generates ./generated types from schema + ABIs
npm run build     # compiles the AssemblyScript mappings to WASM
```
Both must be green before deploying (already verified in CI-less form here).

## Deploy to Goldsky
1. Install + authenticate the CLI:
   ```sh
   npm install -g @goldsky/cli   # or: curl https://goldsky.com | sh
   goldsky login                 # paste your API key from app.goldsky.com
   ```
2. **VERIFY the Arc network slug.** `subgraph.yaml` uses `network: arc-testnet`
   on all data sources + the template. Confirm Goldsky's slug for Arc testnet
   (dashboard / `goldsky` docs); if it differs, change the three `network:`
   fields. If Goldsky needs a custom chain/RPC config for Arc, set it in their
   dashboard first.
3. Deploy:
   ```sh
   cd subgraph
   goldsky subgraph deploy arcade-charts/v1 --path .
   ```
4. Goldsky returns a **GraphQL query URL** (e.g.
   `https://api.goldsky.com/api/public/project_.../subgraphs/arcade-charts/v1/gn`).
   It backfills from the start blocks (launchpad 52095981, V3 factory 49467254)
   then follows the head. Watch progress in the Goldsky dashboard.

## Test
```sh
curl -s <graphql-url> -H 'content-type: application/json' \
  -d '{"query":"{ trades(first:5, orderBy: blockNumber, orderDirection: desc) { token source price volumeUsdc isBuy blockTime } }"}'
```
You should see recent trades with USDC-scaled `price` and `volumeUsdc`.

## Wire the frontend
Set on **Vercel**:
```
NEXT_PUBLIC_GOLDSKY_URL = <the GraphQL query URL>
```
Redeploy the frontend. Charts switch to full history; unset falls back to the
client scan (never blank). The frontend queries `trades(where: {token, source,
pool}, orderBy: blockNumber)` and bucketizes client-side, paginating by
blockNumber cursor.

## Mainnet (turn-key)
Same subgraph. Before deploying to mainnet:
1. `subgraph.yaml`: set the mainnet Launchpad + V3 Factory addresses + their
   deploy blocks, and the mainnet `network:` slug.
2. `src/mappings.ts`: change the `USDC` constant to the mainnet USDC address.
3. `npm run codegen && npm run build && goldsky subgraph deploy arcade-charts/mainnet`.
4. Point the mainnet `NEXT_PUBLIC_GOLDSKY_URL` at the new endpoint.

## Notes
- `first` is capped at 1000 by the query engine; the frontend pages by a
  `blockNumber_gte` cursor (up to 10 pages) with id-dedup on the boundary block.
- The `indexer/` Ponder project is SUPERSEDED by this subgraph. It still builds
  and its `price.ts` is the parity reference for `web/__tests__/indexer/price.test.ts`;
  delete it once the subgraph is live in production if you want.
