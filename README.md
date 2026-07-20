# Arcade

USDC-native DEX + fair-launch engine on **Arc** (Circle's EVM L1). Live on Arc testnet (`5042002`) and Arc mainnet (`5042`).

Every fee, settlement, and protocol-revenue line is denominated in USDC. Arcade bundles a Uniswap V2/V3/V4 fork DEX with a bonding-curve + direct-launch launchpad, a Goldsky-indexed data layer, a CCTP bridge-and-buy, and an agent-accessible API.

## Layout

```
Arcade/
├── contracts/    Foundry: DEX + launchpad Solidity, multi-solc profiles, tests, deploy scripts
├── web/          Next.js 14 (App Router) frontend — wagmi v2 + RainbowKit
├── subgraph/     Goldsky subgraph (ArcLens): charts, stats, fees, TVL, holders
└── agent-mcp/    npm-published MCP server for agent-driven trading + launches
```

## Tech

| Layer | Stack |
|---|---|
| Contracts | Foundry, multi-profile solc — `default` 0.8.24 (via_ir), `v4` 0.8.26/cancun, `v3` 0.7.6, `orbs` 0.8.16; OpenZeppelin v5 |
| DEX | Uniswap **V2** fork (Factory/Pair/Router) + **V3** fork (locked single-sided LP, NPM, auto-compounder) + **V4** — canonical PoolManager on mainnet, `ArcadeHook` for launch pools |
| Launchpad | **PUMP** (bonding curve → graduates to the AMM at ~$60k) and **CLANKER** (direct single-sided locked-LP launch via `ArcadeHook`). 3 USDC creation fee; graduated-pool fees split 80/20 creator/treasury with an anti-sniper auction and Twitter-handle reward escrow |
| Indexer | Goldsky subgraph — OHLC charts, `/stats`, per-category fees, per-pool volume/APR, TVL, holders, referral volume |
| Frontend | Next.js 14, wagmi v2, RainbowKit, Tailwind (dark theme), Sentry |

## Launchpad

- **Create** at `/launchpad/create` — pick PUMP or CLANKER, fee tier, start market cap, and a fee recipient (your wallet, another wallet, or a Twitter @handle claimable later).
- **Tweet-to-launch** — mention **@ArcadeSwap** on X with a launch command; an operator relays a CLANKER launch on your behalf (gas + fee sponsored), attributing creator fees to your @handle. Reply to someone's tweet to split fees 50/50 with them.
- **Fees** — post-graduation trading fees accrue to the creator (or their handle escrow) and the treasury; `ArcadeTwitterEscrowV4` lets an OAuth-verified handle owner claim accumulated fees at `/claim`.

## Quickstart

### Contracts
```bash
cd contracts
forge build                              # default (0.8.24) profile
FOUNDRY_PROFILE=v4 forge build           # V4 hook layer (0.8.26)
forge test
```

### Frontend
```bash
cd web
npm install
cp .env.local.example .env.local         # fill RPC, subgraph URL, keys
npm run dev                               # http://localhost:3000
```
Deployed contract addresses are read from `web/public/deployments.json` (the single source of truth).

### Subgraph
```bash
cd subgraph
npx graph codegen && npx graph build
goldsky subgraph deploy arcade-charts/<version> --path .   # then tag `prod`
```

## Pages

| Route | Purpose |
|---|---|
| `/swap` | Token swap (V2/V3/V4 routing, aggregated) |
| `/launchpad` · `/launchpad/create` | Discover / launch tokens |
| `/launchpad/[address]` · `/launchpad/v4hook/[address]` | Token detail — chart, trades, holders, comments, buy/sell |
| `/explore` | All pools — TVL, volume, daily fees, APR (live from the indexer) |
| `/positions` · `/pool/[address]` | Liquidity positions + pool detail |
| `/bridge` | CCTP bridge-and-buy |
| `/earn` | USYC yield (ERC-4626) |
| `/my-tokens` | Portfolio — holdings, P/L, activity |
| `/claim` | Claim Twitter-handle-attributed creator fees |
| `/stats` · `/admin/fees` | Protocol stats + fee breakdown by category |
| `/agents` · `/docs` | Agent API / MCP + docs |

## Networks

| Field | Testnet | Mainnet |
|---|---|---|
| Chain ID | `5042002` | `5042` |
| RPC | `https://rpc.testnet.arc.network` | (see `web/lib/chains.ts`) |
| Explorer | `https://testnet.arcscan.app` | Arcscan |
| Gas token | USDC | USDC |
| CCTP domain | testnet | `26` |

> Arc uses USDC as the native gas token. On mainnet there is **no canonical WETH**; USDC is the universal quote asset.
