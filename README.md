# Arcade

DEX (Uniswap V2 fork) + bonding-curve launchpad on **Arc testnet** (Circle's EVM L1, chain `5042002`).

USDC is the native gas token on Arc and the canonical quote currency for all pools and curves — no WETH wrapper is needed.

## Layout

```
Arcade/
├── contracts/    Foundry: DEX + launchpad Solidity + tests + deploy scripts
└── web/          Next.js 14 (App Router) frontend with wagmi + RainbowKit
```

## Tech

| Layer | Stack |
|---|---|
| Smart contracts | Solidity 0.8.24, Foundry, OpenZeppelin v5 |
| DEX | Uniswap V2 fork (Factory / Pair / Router), USDC quote |
| Launchpad | pump.fun-style bonding curve, fixed 1B supply, 1% trade fee (0.5% platform / 0.5% creator), 1 USDC creation fee, LP burn on migration |
| Frontend | Next.js 14, wagmi v2, RainbowKit, Tailwind, dark theme |

## Quickstart

### Contracts

```bash
cd contracts
forge build
forge test
```

Local deploy on Anvil:

```bash
anvil               # in one terminal
cp .env.example .env
forge script script/DeployLocal.s.sol --rpc-url anvil --broadcast
```

### Frontend

```bash
cd web
npm install
cp .env.local.example .env.local
npm run dev
```

App runs at http://localhost:3000.

## Pages

- `/` — Landing
- `/swap` — Token swap
- `/pool` — Add / remove liquidity, my positions
- `/launchpad` — Discover tokens (new / trending / about-to-migrate / migrated)
- `/launchpad/create` — Launch a new token
- `/launchpad/[address]` — Token detail (chart + buy/sell + comments)

## Network

| Field | Value |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://5042002.rpc.thirdweb.com` |
| Explorer | `https://testnet.arcscan.app/` |
| Gas token | USDC (ERC20) |
