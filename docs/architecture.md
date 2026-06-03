# Arcade Architecture

> Living document. Last updated 2026-06-03. Reflects the production codebase
> on the `main` branch of the Arcade monorepo. The V4 stack described in
> Section 8 is design-frozen but not deployed.

Arcade is a USDC-native capital formation stack on Arc, the USDC-as-gas L1.
This document maps the contracts, frontend, and external dependencies that
together produce the live system at [arcade.trading](https://arcade.trading).

## Table of contents

1. System overview
2. Repository layout
3. Smart contract layer
4. Frontend layer
5. External dependencies
6. Data flow diagrams
7. Security model
8. V4 migration target
9. Mainnet readiness checklist

---

## 1. System overview

```
                              ARCADE
                              ──────
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
   Issuance               Spot trading              Cross-chain in
   ─────────              ────────────              ──────────────
   Launchpad              V2 AMM fork               CCTP V2 bridge
   (3 modes)              V3 single-sided           (Sepolia → Arc)
                          MultiSwap router          (mainnet matrix M2)
                          Orbs TWAP limits
                                 │
                                 ▼
                       USDC settlement
                       USDC gas reimbursement
                       USDC-quoted everything
```

Every fee, every quote, every reserve, every migration is denominated in
USDC because USDC is Arc's native gas asset. No wrapped-ETH pivot exists
anywhere in the codebase.

The system is split across three layers:

| Layer       | Tech                                                        | Lives at                |
|-------------|-------------------------------------------------------------|-------------------------|
| Contracts   | Solidity 0.8.24 (Arcade), 0.8.16 (vendored Orbs TWAP)       | `contracts/src/`        |
| Frontend    | Next.js 15 App Router, wagmi v2, viem, RainbowKit           | `web/`                  |
| Infra       | Vercel, Pinata IPFS, public Arc RPC, Iris sandbox           | external                |

## 2. Repository layout

```
Arcade/
├── contracts/                         Foundry workspace
│   ├── src/
│   │   ├── dex/                       V2 fork (Factory, Pair, Router, ERC20)
│   │   ├── v3/                        V3 fork (Quoter, PriceMath, interfaces)
│   │   ├── launchpad/                 Launchpad + Vault + TwitterEscrow(V3)
│   │   ├── swap/                      ArcadeMultiSwap aggregator
│   │   └── mocks/                     MockUSDC, MockWETH for local tests
│   ├── orbs/                          Vendored Orbs TWAP (MIT, Solidity 0.8.16)
│   ├── v4src/                         V4 hook prototype (scaffolded, not live)
│   ├── script/                        Deploy scripts (DeployTestnet, DeployTWAP)
│   ├── test/                          Foundry tests + curve fixture vectors
│   ├── foundry.toml                   Multi-profile config (default + orbs + v4)
│   └── V4_HOOK_SPEC.md                Frozen design for ArcadeHook
├── web/                               Next.js frontend
│   ├── app/                           App Router pages
│   ├── components/                    React components by domain
│   ├── lib/                           Hooks, ABIs, utils, constants
│   └── public/                        Static assets (token icons, route arrows)
├── docs/                              Living technical documentation
├── audit/                             Internal multi-agent audit reports
├── circle-grant-application.md        Circle Developer Grants submission
└── v4-migration-scoping.md            Phase 0-6 V4 migration plan
```

## 3. Smart contract layer

### 3.1 Deployed contracts (Arc testnet)

11 production contracts plus 3 vendored (Orbs TWAP + ExchangeV2 + Lens).
Full address list is maintained in [`web/lib/constants.ts`](../web/lib/constants.ts)
and committed in project memory.

| Module        | Contract                       | Purpose                                            |
|---------------|--------------------------------|----------------------------------------------------|
| V2 AMM        | `ArcadeV2Factory`              | Creates V2 pairs, tracks all pools                 |
| V2 AMM        | `ArcadeV2Pair`                 | Per-pool constant-product reserves, LP token       |
| V2 AMM        | `ArcadeV2Router`               | User-facing add/remove/swap entrypoint             |
| V2 AMM        | `ArcadeV2ERC20`                | LP token base for `ArcadeV2Pair`                   |
| V3 AMM        | `ArcadeV3PriceMath`            | Tick math helpers shared by Quoter + Locker        |
| Launchpad     | `ArcadeLaunchpad`              | Bonding curve, 3 modes, atomic graduation          |
| Launchpad     | `ArcadeLaunchToken`            | 1B-supply ERC20 minted per token launch            |
| Launchpad     | `ArcadeTokenVault`             | Vested team allocations (linear vesting)           |
| Escrow        | `ArcadeTwitterEscrowV3`        | EIP-712 signed claim of @handle-attributed fees    |
| Aggregator    | `ArcadeMultiSwap`              | Multi-token routing around USDC pivot (V2 + V3)    |
| Limit orders  | Orbs `TWAP`                    | On-chain order book (vendored MIT, Solidity 0.8.16)|
| Limit orders  | Orbs `ExchangeV2`              | V2 settlement adapter for taker fills              |
| Limit orders  | Orbs `Lens`                    | Read-only helpers for the order book               |

### 3.2 Bonding curve math (LIVE)

`ArcadeLaunchpad` implements a constant-product AMM with virtual reserves,
denominated entirely in USDC.

```
Invariant:   K = (virtualUsdcReserve + realUsdcReserve)
               * (virtualTokenReserve - tokensSold)
             = 5_000e6 * 1_000_000_000e18
             = 5e36

Curve range: tokensSold: 0 → 800M  (CURVE_SUPPLY)
             raised USDC: 0 → 20_000e6
             spot price:  $0.000005 → $0.000125 per token  (25x)

Graduation (PUMP / CLANKER modes):
  At tokensSold = CURVE_SUPPLY:
    1. Take MIGRATION_FEE (2_500e6 USDC) to treasury
    2. Seed V2 pool with (20_000 − 2_500) USDC + 200M reserved tokens
    3. Mint LP, burn to 0xdead → permanent locked liquidity
    4. Set status = Graduated, emit Migrated event

CLANKER_V3 mode (no curve):
  At creation: deploy V3 pool, lock 1B tokens in single-sided position,
  fees stream perpetually 80% creator / 20% treasury.
```

Trade fee splits:

| Mode        | Platform | Creator | Notes                                          |
|-------------|---------:|--------:|------------------------------------------------|
| PUMP        |    50%   |    50%  | Fair-launch default                            |
| CLANKER     |    70%   |    30%  | Optional secondary creator split via creator2  |
| CLANKER_V3  |    20%   |    80%  | Applied to V3 LP fees, perpetual               |

Post-migration royalty (V2-routed swaps via `ArcadeMultiSwap`):

| Layer           | bps  | Recipient        |
|-----------------|-----:|------------------|
| V2 LP fee       |  25  | Locked in pool   |
| V2 protocol fee |   5  | Treasury (if on) |
| Arcade platform |  20  | Treasury         |
| Arcade creator  |  10  | Creator(s)       |
| **Total**       |  60  | (0.60%)          |

Direct V2 router swaps bypass the Arcade royalty (0.30% to LP holders only).
This is an accepted limitation — the UI defaults to MultiSwap so creators
collect royalties on the common path.

### 3.3 Twitter handle escrow (LIVE)

`ArcadeTwitterEscrowV3` lets a creator allocate fee streams to a Twitter
`@handle` before that handle is linked to a wallet. The escrow holds the
balance per-handle. When the handle owner authenticates (Twitter OAuth),
a backend service signs an EIP-712 message that the handle owner submits
on-chain to claim accumulated USDC.

Trust model: a single backend signer key (held in Vercel server-side env)
attests to handle ownership. Multisig planned pre-mainnet; threshold and
signer set TBD.

### 3.4 Limit orders (LIVE)

Vendored Orbs TWAP (MIT, Solidity 0.8.16) deployed at
`contracts/orbs/`. The TWAP contract stores maker `Ask` orders in an
on-chain `book[]` array. Takers bid on each order via English auction
with a minimum bid delay of 30 seconds.

Arcade's role:
- Frontend constructs the `Ask` struct and signs `twap.ask(ask)`.
- Orbs `ExchangeV2` adapter routes settlement through Arcade's V2 Router.
- A keeper bot (Orbs L3 or self-hosted) bids when pool price meets the
  trigger. If no L3 extension to Arc, Arcade ships an in-house keeper.

### 3.5 ArcadeMultiSwap (LIVE)

Aggregator that routes a single source token through any combination of
V2 and V3 pools around a USDC pivot. Used by:
- `/swap` Multi Token Swap tab (split USDC across N tokens in one tx).
- Post-graduation Arcade-royalty-aware swaps.

## 4. Frontend layer

### 4.1 Stack

```
Next.js 15.x (App Router)
└─ wagmi v2 + viem (RPC + contract calls)
   └─ RainbowKit (wallet connector)
      └─ TanStack Query (caching, refetches)
         └─ Tailwind CSS (Arcade design system)
```

### 4.2 Routes

| Route                            | Purpose                                                  |
|----------------------------------|----------------------------------------------------------|
| `/`                              | Landing page                                             |
| `/swap`                          | Swap + Limit + MultiSwap (tabbed)                        |
| `/launchpad`                     | Token discovery grid                                     |
| `/launchpad/create`              | 3-mode launch form (PUMP, CLANKER, CLANKER_V3)           |
| `/launchpad/[address]`           | Per-token detail page (curve chart, trade panel)         |
| `/launchpad/v4`                  | V4 prototype discovery (gated by feature flag)           |
| `/bridge`                        | CCTP V2 burn/mint UI (Sepolia → Arc)                     |
| `/my-tokens`                     | Portfolio (Overview / Tokens / Creator / Activity)       |
| `/claim`                         | Twitter handle escrow claim flow (OAuth + EIP-712)       |
| `/stats`                         | Public USDC gas attribution dashboard                    |
| `/admin/escrow`                  | Owner-only escrow signer management                      |
| `/positions`                     | LP position management (V2 + V3)                         |
| `/lp-simulator`                  | LP returns calculator                                    |
| `/docs`                          | In-app architecture + API docs                           |

### 4.3 Critical hooks (`web/lib/hooks/`)

| Hook                       | Reads                                                     |
|----------------------------|-----------------------------------------------------------|
| `useV2Tokens`              | All V2 pair addresses + non-USDC token metadata           |
| `useV3Tokens`              | All CLANKER_V3 launches + their pool fee tiers            |
| `useLaunchpadTokens`       | Token list with mode + migration state                    |
| `useApproveIfNeeded`       | Allowance check + ensureAllowance write                   |
| `useCCTPBridge`            | CCTP V2 burn → Iris poll → mint orchestrator              |
| `useOrbsTwap`              | Order book reads, ask/cancel writes                       |

### 4.4 External services consumed by the frontend

| Service              | Used for                                       | Auth model           |
|----------------------|------------------------------------------------|----------------------|
| Arc testnet RPC      | All contract reads + writes                    | Public, rate-limited |
| Iris attestation API | CCTP V2 attestation polling                    | Public, unmetered    |
| Pinata IPFS          | Token icon uploads at launch                   | JWT (server-only)    |
| Vercel               | Hosting, env var management, ISR cache         | Vercel auth          |
| Twitter OAuth        | Handle verification for escrow claims          | OAuth 2.0 PKCE       |

## 5. External dependencies

### 5.1 Arc testnet (chainId 5042002)

USDC is the native gas asset. Block time ~0.5s. Prague EVM. EIP-1153
transient storage CONFIRMED. CCTP V2 endpoints CONFIRMED:

| Component            | Address                                                  |
|----------------------|----------------------------------------------------------|
| USDC (gas + ERC20)   | published in `web/lib/constants.ts`                      |
| CCTP TokenMessenger v2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`           |
| CCTP MessageTransmitter v2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`       |
| Iris (testnet)       | `https://iris-api-sandbox.circle.com`                    |
| Iris (mainnet)       | `https://iris-api.circle.com`                            |

Known RPC quirks tracked in [project memory: arc chain issues].
Most important: `eth_getLogs` silently truncates at 50,000 blocks, which
breaks the cumulative `/stats` page after ~30 days of mainnet history.
ArcLens (Milestone 3) replaces the naive scan with a Ponder indexer.

### 5.2 CCTP V2 flow

```
User (Sepolia)
   │
   │ depositForBurn(USDC, amount, destDomain=Arc, mintRecipient, ...)
   ▼
TokenMessenger v2 ─→ burns USDC, emits MessageSent event
   │
   │ Iris polls Sepolia events, signs the attestation
   ▼
GET /v2/messages/{messageHash}
   │
   │ Returns { attestation: 0x...sig }
   ▼
User (Arc)
   │
   │ receiveMessage(message, attestation)
   ▼
MessageTransmitter v2 ─→ mints native USDC on Arc
```

A `destinationCaller` hook (Milestone 2) will atomically route the freshly
minted USDC into a Launchpad buy, a MultiSwap trade, or a TWAP ask in the
same call, so the user signs once on the source chain and lands directly
in their target position on Arc.

## 6. Data flow diagrams

### 6.1 Token launch (CLANKER mode)

```
Creator (wallet)
  │
  │ POST /launchpad/create  →  uploads icon to Pinata IPFS
  │
  │ launchpad.createToken(name, symbol, mode=CLANKER, creator2, bps)
  ▼
ArcadeLaunchpad
  ├─ deploys ArcadeLaunchToken(1B supply, mints to launchpad)
  ├─ stores CurveState (mode=CLANKER, status=Curving)
  └─ emits TokenLaunched(token, creator, mode)
  │
  ▼
Token detail page (live, chart starts, trade UI enabled)
```

### 6.2 Bonding-curve buy

```
Buyer (wallet)
  │
  │ usdc.approve(launchpad, amount + 1% fee)
  │
  │ launchpad.buyExactUsdcIn(token, usdcIn, minTokensOut, recipient)
  ▼
ArcadeLaunchpad
  ├─ take 1% trade fee (split per mode: platform / creator(s))
  ├─ compute tokensOut from K_CONSTANT invariant
  ├─ update CurveState: realUsdcReserve += net, tokensSold += out
  ├─ transfer tokens to buyer
  └─ if tokensSold >= CURVE_SUPPLY: trigger Graduation (atomic)
       ├─ take MIGRATION_FEE (2_500 USDC) → treasury
       ├─ deploy V2 pair via ArcadeV2Factory
       ├─ seed with (raised − fee) USDC + 200M tokens
       ├─ mint LP → burn to 0xdead
       └─ status = Graduated
```

### 6.3 Limit order placement (Orbs TWAP)

```
Maker (wallet)
  │
  │ Frontend computes Ask{srcToken, dstToken, srcAmount,
  │                       srcBidAmount = srcAmount (single-chunk),
  │                       dstMinAmount = expectedOut * (1 - slippage),
  │                       deadline, bidDelay=30s, fillDelay=0}
  │
  │ erc20.approve(twap, srcAmount)
  │ twap.ask(Ask)
  ▼
Orbs TWAP
  ├─ store Ask in book[orderId]
  ├─ index orderId in ordersByMaker[maker]
  └─ emit OrderCreated(orderId, maker)
  │
  ▼
Frontend /swap (Limit tab)
  ├─ LimitOrdersPanel reads orderIdsByMaker(account) every 15s
  ├─ batch reads order(id) for each id
  └─ user can cancel via twap.cancel(orderId)
  │
  ▼ (off-chain)
Keeper bot watches pool price
  └─ when price ≥ trigger: twap.bid(orderId) → wait bidDelay → twap.fill(orderId)
```

### 6.4 CCTP V2 bridge (Sepolia → Arc)

```
1. User signs Sepolia tx:
   tokenMessenger.depositForBurn(
     amount=1e6 (1 USDC),
     destDomain=ARC_DOMAIN,
     mintRecipient=user_padded_to_bytes32,
     burnToken=USDC_sepolia,
     destinationCaller=0x0,        // M2: address of Arcade router
     maxFee=...,
     minFinalityThreshold=...,
   )
2. Sepolia tx emits MessageSent(message)
3. Frontend computes messageHash = keccak256(message)
4. Frontend polls GET iris-api-sandbox.circle.com/v2/messages/{hash}
   until response.attestation is non-empty
5. User signs Arc tx:
   messageTransmitter.receiveMessage(message, attestation)
6. Arc tx mints native USDC to mintRecipient
7. (M2) If destinationCaller was an Arcade contract, it auto-routes
   the minted USDC into a buy / swap / limit ask in the same tx.
```

## 7. Security model

### 7.1 Trust assumptions

| Role              | Power                                         | Mainnet target            |
|-------------------|-----------------------------------------------|---------------------------|
| Launchpad owner   | Pause launches, update treasury, set fees     | 3/5 multisig (TBD)        |
| Twitter signer    | Sign EIP-712 handle ownership attestations    | Multisig with rotation    |
| Backend keeper    | Submit TWAP bids/fills if Orbs L3 not on Arc  | Separate hot wallet       |
| Arc validators    | L1 finality, USDC gas pricing                 | Arc team                  |
| Circle Iris       | CCTP V2 attestation signing                   | Circle infrastructure     |

The user trusts: Arc validators, Circle for CCTP attestations, the
launchpad owner for global config, the Twitter signer for escrow claims.

The user does NOT trust: token creators (LP is burned at migration so
creators cannot rug post-graduation), other traders, keeper bots
(TWAP is permissionless).

### 7.2 Internal audit status

An internal multi-agent audit ran on commit `16afe44`. Findings:

- 8 HIGH severity findings → 7 closed, 1 deferred (H-02 documented)
- 14 MEDIUM severity findings → 11 closed, 3 deferred
- 22 LOW / informational findings → triaged

Deferred findings are explicitly out-of-scope for mainnet day-1 and are
documented in [`audit/`](../audit/). External audit (Pashov private
review, Milestone 1 of the Circle grant) blocks the mainnet deploy.

### 7.3 Privileged operations

| Operation                        | Contract              | Guard                  |
|----------------------------------|-----------------------|------------------------|
| `setTreasury`                    | ArcadeLaunchpad       | onlyOwner              |
| `pauseLaunches`                  | ArcadeLaunchpad       | onlyOwner              |
| `setSigner`                      | ArcadeTwitterEscrowV3 | onlyOwner              |
| `setFeeTo`                       | ArcadeV2Factory       | onlyFeeToSetter        |
| `cancelOrder`                    | Orbs TWAP             | onlyMaker              |

All ownership is held by an EOA on testnet, transitioning to a Safe
multisig pre-mainnet.

## 8. V4 migration target (designed, not deployed)

`contracts/V4_HOOK_SPEC.md` describes the frozen design for `ArcadeHook`,
a single Uniswap V4 hook that collapses the V2 + V3 + Launchpad stack:

```
V2 stack (current)                  V4 stack (Milestone 4)
──────────────────                  ──────────────────────
ArcadeV2Factory      ─┐
ArcadeV2Pair         ─┤
ArcadeV2ERC20        ─┼─── REPLACED BY ───→  PoolManager (canonical)
ArcadeV2Router       ─┘                       + ArcadeHook (~1100 LoC)
                                              + ArcadeV4SwapRouter (210 LoC)
ArcadeLaunchpad      ──→ absorbed into ArcadeHook (beforeSwap + afterSwap)
ArcadeV3Locker       ──→ deprecated (ERC-6909 + LOCKED_VAULT replace NFT lock)
```

Hook permission bitmap: `0x3EEC` (10 callbacks enabled, 6 disabled).
Anti-sniper protection runs in `beforeSwap`: per-block buy caps decay
linearly over 50 blocks post-launch. Curve math MUST match the test
vectors at `contracts/test/fixtures/curve-vectors.json` bit-identically.

EIP-1153 transient storage is the prerequisite; CONFIRMED on Arc testnet.

Phase 1 (this sprint) ships `ArcadeAntiSniperHook.sol` as the first
production hook + a property-based test suite matching the curve fixture.

## 9. Mainnet readiness checklist

A live checklist tracking what blocks Arcade from shipping on Arc mainnet.

### 9.1 Contracts

- [x] V2 fork deployed + verified on Arc testnet
- [x] V3 fork (Quoter + Locker) deployed + verified
- [x] Launchpad + Vault + TwitterEscrowV3 deployed + verified
- [x] MultiSwap aggregator deployed + verified
- [x] Orbs TWAP + ExchangeV2 + Lens vendored + deployed + verified
- [x] Internal multi-agent audit closed (16afe44)
- [ ] External audit complete (Pashov private review, M1 grant blocker)
- [ ] Mainnet deploy scripts in `script/DeployMainnet.s.sol`
- [ ] Ownership migrated to Safe multisig pre-deploy

### 9.2 Frontend

- [x] All routes live on Arc testnet
- [x] CCTP V2 testnet bridge live (Sepolia → Arc)
- [x] Limit orders shipping (Orbs TWAP integration)
- [x] Portfolio view (`/my-tokens`)
- [x] Stats dashboard (`/stats`)
- [ ] Mainnet RPC switch (env-aware in `web/lib/constants.ts`)
- [ ] CCTP V2 mainnet matrix (Milestone 2)
- [ ] Circle Wallets embedded onboarding (Milestone 5)
- [ ] Mobile audit pass on /swap, /launchpad, /bridge

### 9.3 Indexer + observability

- [ ] ArcLens Ponder schema deployed
- [ ] GraphQL endpoint at `api.arcade.trading`
- [ ] Grafana dashboards (USDC gas, volume, launches)
- [ ] Sentry alerting on contract revert spikes
- [ ] PostHog event tracking on key user flows

### 9.4 Trust + ops

- [ ] Twitter escrow signer multisig (replace single EOA)
- [ ] Keeper bot deployed (if Orbs L3 not on Arc)
- [ ] Public `SECURITY.md` with disclosure contact
- [ ] Public `RISK.md` with deferred audit findings
- [ ] Bounty program (Cantina or Hats Finance, TBD)

---

## Cross-references

- [V4_HOOK_SPEC.md](../contracts/V4_HOOK_SPEC.md) — V4 design freeze
- [v4-migration-scoping.md](../v4-migration-scoping.md) — Phase 0-6 plan
- [circle-grant-application.md](../circle-grant-application.md) — Funding request
- [audit/](../audit/) — Internal audit reports
- [web/lib/constants.ts](../web/lib/constants.ts) — Live contract addresses
- [web/lib/cctp.ts](../web/lib/cctp.ts) — CCTP V2 integration code
