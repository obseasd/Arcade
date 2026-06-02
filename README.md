# Arcade

USDC-native AMM and fair-launch tokenization engine on **Arc testnet** (Circle's EVM L1, chain `5042002`).

Capital formation primitive for stablecoin-native markets: bonding-curve token issuance, Uniswap V2 fork AMM, locked single-sided V3 LP for migrated tokens, and Twitter-handle reward escrow. Every fee, every settlement, every protocol revenue line is denominated in USDC. A (non-official) WETH is wired in as an optional Clanker pool pairing.

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
| Launchpad | 3 modes — Pump (curve 50/50), Arcade (curve 70/30), Clanker (locked single-sided V3 LP, 80/20). Fixed 1B supply, 1% curve trade fee, **3 USDC** creation fee, LP burned/locked |
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
