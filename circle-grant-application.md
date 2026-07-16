# Arcade · Circle Developer Grants Application Draft

Paste-ready answers field by field. Replace every `[FOUNDER FILLS]` marker before submitting.

---

## FIELD: What problem are you solving and why is it important?

Capital formation on EVM rails is structurally broken for stablecoin-denominated assets. Every existing AMM, launchpad, and bonding-curve venue settles in a volatile L1 gas token (ETH, SOL, BNB), which forces founders to price primary issuance, LP fees, and creator royalties in an asset whose value drifts 20 to 40% in a quarter. That volatility is acceptable for retail speculation but disqualifying for the use cases Arc was built for: tokenized treasuries, payroll-backed credit, RWA pools, prediction markets settling in dollars, and serious primary issuance by builders who think in basis points instead of multiples.

Today an institutional builder who wants to bootstrap liquidity for a USDC-quoted asset has no canonical venue: they either use a generic V2 fork on a volatile chain and eat the FX risk, or they wait for centralised market makers that price out long-tail issuance entirely. This is precisely the gap Arc Builders Fund Vertical 1 names: always-on markets and capital formation, perpetuals DEXs, AMMs, CLOBs, private pools, prediction markets.

Arc finally makes USDC the native gas and settlement asset of a Prague-EVM L1, but the application layer needed to actually issue, price, and clear assets in dollars from block zero has not shipped yet. Without it, Arc launches without a primary market.

## FIELD: What is your solution to that problem?

Arcade is the USDC-native capital formation stack for Arc: a Uniswap V2 fork, a V3 fork with permanent locked single-sided LP, a bonding-curve issuance engine, a Twitter-handle reward escrow, and on-chain limit orders, every component quoting and settling in USDC because USDC is the chain's native gas asset.

Issuance flows through a deterministic bonding curve that raises up to 20,000 USDC per token and then migrates atomically into a V2 pool, with the CLANKER_V3 mode parking the migration liquidity in a single-sided V3 position whose fee stream is locked to the creator and treasury in perpetuity. The Twitter handle escrow lets fee streams be attributed to off-chain identities and unlocked via EIP-712 signed claims, opening capital formation to creators who have not yet generated a wallet.

ArcadeMultiSwap aggregates V2 plus V3 routes around a USDC pivot, and the Orbs TWAP integration puts true on-chain limit orders into the same book. A self-hosted unified keeper now settles that book end to end: it bids and fills open limit orders AND dollar-cost-average schedules (a DCA order is a multi-chunk TWAP order, served by the same code), and it auto-relays CCTP bridge-and-buy so a deposit from any source chain completes into a token buy on Arc with no second signature. CCTP V2 is already wired in `web/lib/cctp.ts` using the canonical TokenMessenger and MessageTransmitter addresses, so capital can arrive from Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana into a single USDC denominator at settlement.

Every graduated pair charges a pair-level fee pinned at 0.30% (0.10% to LPs, 0.15% protocol, 0.05% creator), taken input-side so it never silently defeats a trader's minimum-out. The whole stack is governed by a live 2-of-3 Gnosis Safe: treasury, protocol fee sink, factory fee-setter, the V3 locker, the auto-compounder, and the Twitter escrow all resolve to the Safe, and a Ponder indexer serves complete USDC-denominated price history and volume behind the charts.

## FIELD: Why hasn't this problem been solved yet? What are the barriers?

This problem persisted because four structural barriers had to fall at once.

First, every prior EVM L1 charged gas in a volatile asset, so a stablecoin-native AMM was a leaky abstraction: LPs still paid ETH to rebalance, breaking the dollar accounting at the margin.

Second, the dominant bonding-curve venues on Solana and Base were coded as memecoin casinos with custodial off-ramps, which alienated the institutional and RWA capital that Arc is courting and made "launchpad" a slur in serious credit circles.

Third, no canonical stablecoin-native settlement chain existed before Arc, so there was no place to deploy a venue where the gas token, the quote asset, the fee asset, and the migration asset are all the same dollar.

Fourth, Twitter-identity reward attribution was historically off-chain and custodial, blocking any clean on-chain escrow that could pay creator fees to a handle before the handle proves out a wallet.

Arc removes barrier three this year, EIP-712 removes barrier four, and Arcade is the first venue that closes barriers one and two by being designed from the contract level around USDC-only accounting and an anti-memecoin issuance flow that treats every token as a capital instrument.

## FIELD: Why are you and your team uniquely suited to solve this problem?

Arcade is built by a solo founder, pseudonymous publicly and doxxed to the Arc team through a hackathon win, available for KYC under a confidentiality side letter with Circle compliance. The honest framing is velocity, not headcount.

The project has shipped and verified the full USDC-native stack on Arc testnet: V2 Factory/Router with a pair-level fee, the PUMP/CLANKER/CLANKER_V3 Launchpad with atomic migration, a V3 Factory/Router/Quoter/NPM/Locker with permanent single-sided LP, a keeper-driven V3 auto-compounder, the MultiSwap aggregator with per-leg slippage floors, a periphery migrated-router, the EIP-712 Twitter-handle escrow, and the Orbs TWAP surface for on-chain limit orders. Beyond the contracts, three pieces of live infrastructure ship the "always-on markets" thesis: (1) a self-hosted unified keeper that actually settles the limit-order/DCA book and auto-relays CCTP bridge-and-buy, (2) a Ponder indexer serving complete USDC price/volume history behind the charts, and (3) a 2-of-3 Gnosis Safe governing treasury, fees, and every admin role, live on-chain.

Security is a standing practice, not a one-off: production code has gone through many rounds of adversarial internal audit (multi-agent refuting reviewers that default to "broken" and must prove a regression test fails on the reverted fix). Recent examples include a full offensive exploit sweep, a governance-transfer review, a 4-round audit-and-fix loop on the keeper (a HIGH "DCA dead-on-arrival at defaults" and a no-op allowlist precheck both caught and closed), and a 2-round loop on the indexer. Findings are closed with executable regression tests; the residual mainnet-gated HIGH items are documented for the external review.

The next external milestone is a Pashov Audit Group private review, bottlenecked only on grant capital rather than scope or readiness.

Hackathon context: **[FOUNDER FILLS — exact hackathon name and month/year of the Arc team win]**

## FIELD: Is your project currently live in production?

Not yet in mainnet production. Arcade is live end-to-end on Arc testnet (chainId 5042002) with the full USDC-native stack (20+ verified contracts) deployed and Safe-governed, a public frontend at arcade.trading, a /stats dashboard surfacing cumulative USDC gas, a Ponder price/volume indexer and a unified settlement keeper both code-complete, and CCTP V2 bridging from Sepolia. Mainnet deploy is committed for Arc mainnet day one, Summer 2026, contingent only on Arc mainnet opening.

## FIELD: Are you live on Arc?

Yes, live on Arc testnet (chainId 5042002). The full stack is deployed and verified: V2 Factory and Router, V3 Factory, Router, Quoter, and Locker, ArcadeLaunchpad (PUMP, CLANKER, CLANKER_V3 modes), ArcadeTokenVault, ArcadeMultiSwap aggregator, ArcadeTwitterEscrowV3, and the Orbs TWAP / ExchangeV2 settlement adapter. Frontend at arcade.trading runs against Arc testnet today. Arc mainnet day-1 deploy is committed for Summer 2026.

## FIELD: Have you deployed any smart contracts?

Yes. The full stack (20+ contracts) is deployed and verified on Arc testnet (chainId 5042002), covering the DEX (V2 + V3 forks with a pair-level fee), the bonding-curve launchpad, the permanent V3 locker, a keeper-driven auto-compounder, the token vault, the MultiSwap aggregator, the migrated-route periphery router, the EIP-712 Twitter-handle escrow, and the Orbs TWAP limit-order surface, all governed by a 2-of-3 Safe. Every contract quotes and settles in USDC, the native gas asset on Arc. Key addresses are listed in the next field; the complete set is in `web/public/deployments.json`.

## FIELD: Smart contract addresses

All deployed on Arc testnet (chainId 5042002):

Current generation (redeployed 2026-07-16, Safe-governed from construction). Full set in `web/public/deployments.json`.

| Contract | Address | Purpose |
|---|---|---|
| USDC | `0x3600000000000000000000000000000000000000` | Arc native gas token; settlement unit for every Arcade fee, LP share, and escrow credit. |
| Treasury / Governance Safe (2-of-3) | `0x0bDE09e3Bfc9b2Ee7b94e56A6A06e0a14706195D` | Gnosis Safe that owns treasury, protocol-fee sink, factory fee-setter, V3 locker, auto-compounder, and Twitter escrow. |
| ArcadeV2Factory | `0x3a404154A7Ac320C93BB09A539BcF9B27Fc63067` | Uniswap V2 fork factory deploying USDC-quoted pairs with a pair-level 0.30% fee. |
| ArcadeV2Router | `0xae744C9Acdc1E80F83B5895ba2C060dB921A6Aa5` | Stateless router for V2 swaps and add/remove liquidity, USDC-quoted. |
| ArcadeLaunchpad | `0xB6c9bD475EE6596342c1c49DE6513C9451f8C7e4` | Bonding-curve token issuance engine (PUMP, CLANKER, CLANKER_V3 modes) raising USDC then atomic migration. |
| ArcadeMultiSwap | `0x3D8fE90dE69Ba09b922880f5179b36bA3c1fa5c0` | Aggregator routing USDC-pivot multi-token swaps across V2 and V3 pools in one tx, per-leg minOut. |
| ArcadeMigratedRouter | `0xa8E5BA23efA319BF286977942BA164683DACEd7C` | Periphery router for graduated-token buys/sells with a mid-leg sandwich floor (extracted to fit EIP-170). |
| ArcadeV3Factory | `0x7E875574062613de8A4d43cDA21628368914c01A` | V3 fork factory for concentrated-liquidity USDC pools backing CLANKER_V3. |
| ArcadeV3Locker | `0xBaAfC02fEAd665D398Cf8f53bE9C713c321c9eEB` | Permanent single-sided LP vault locking CLANKER_V3 positions and streaming fees to creator + treasury forever. |
| ArcadeV3Router | `0xc2d2829caFb2763D1f4aDD95591FE5775EAade68` | V3 swap router executing exactInput / exactOutput trades against V3 pools. |
| ArcadeV3Quoter | `0x77264120b8155aFfbcDD6B0E23d5F47264052656` | Off-chain quote helper for V3 pricing used by the frontend route builder. |
| ArcadeV3PositionManager (NPM) | `0x9A0955174A200FcaFA232c9A2111771B8Ee4100b` | V3 NonfungiblePositionManager fork minting/managing concentrated LP NFTs. |
| ArcadeAutoCompounder | `0x2DC0ABb9945506F78bf2490332329BA05E6541a8` | Keeper-driven V3 LP auto-compounder; Safe-owned, 10% protocol fee on collected fees only. |
| ArcadeTokenVault | `0xF5F15Bfd59E2bf6dD7026fEEe21E57e2ade6a569` | Custodial vault holding curve-issued tokens between bond completion and migration. |
| ArcadeTwitterEscrowV3 | `0x0E6140b3b8B2fD92A5F2F7FE82F02FA8979525aE` | EIP-712 signed-claim escrow attributing creator USDC fee streams to Twitter handles before wallet creation. |
| Orbs ExchangeV2 (dLIMIT) | `0xC34e4dfAd598E70Ae59cf47ce98211EeEB42357d` | Orbs settlement adapter wiring TWAP limit-order fills into ArcadeV2Router. |
| Orbs TWAP (book) | `0xb4b7B2ea8C033484921993cBBE3f61f1658D6102` | On-chain limit-order book (TWAP.book[]) holding live USDC-quoted limit orders + DCA schedules on Arc. |
| ArcadeV4PoolManager (prototype) | `0x71CCed1c397EC974E74C350eBA6DBa98DE8e8e25` | Uniswap V4 PoolManager fork for the single-pool-lifecycle prototype. |
| ArcadeHook / AntiSniper (prototype) | `0x90b7D816862f9ca2E2Fa8B8Dde2BF855E623BecE` | V4 hook: bonding curve, atomic graduation, locked LP, per-block buy caps. Not in production traffic yet. |

## FIELD: Which other chain(s) are you currently live on?

Only Arc testnet today. Arc mainnet day-1 deploy planned for Summer 2026. CCTP V2 bridges connect Sepolia to Arc testnet today and will expand to Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana on Arc mainnet day one.

## FIELD: Which Circle products are currently integrated?

**USDC** (Arc native gas, `0x3600000000000000000000000000000000000000`): USDC is both the gas asset and the universal settlement unit across Arcade. Every protocol fee, V2 LP fee, V3 locker fee stream, creator royalty, bonding-curve raise (up to 20,000 USDC per token), launchpad migration fee, MultiSwap routing fee, and Twitter handle escrow credit denominates in USDC. There is no wrapped-ETH pivot anywhere in the system; pairs quote against USDC directly, which makes Arcade a pure USDC-velocity surface on Arc.

**CCTP V2** (live in `web/lib/cctp.ts`): TokenMessenger v2 at `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` and MessageTransmitter v2 at `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` (canonical deterministic addresses across CCTP V2 domains). The /bridge frontend route burns USDC on Sepolia, polls the Iris attestation service at `iris-api-sandbox.circle.com`, and mints natively on Arc testnet so new users can fund Arc gas plus Arcade trading from any CCTP V2 domain in a single flow.

## FIELD: Which Circle products do you plan to integrate?

**CCTP V2 mainnet source-chain matrix expansion** (gated on Arc mainnet day-1): the same TokenMessenger v2 / MessageTransmitter v2 deterministic addresses are reused; the frontend domain map flips from Sepolia-only to Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana on the day Arc mainnet opens, giving Arcade a same-day cross-chain USDC on-ramp from every CCTP V2 domain.

**Circle Wallets** (embedded onboarding, target: ship within 6 weeks of Arc mainnet): replace the connect-wallet gate for first-time creators on the launchpad with a Circle Wallets email/social signup so a creator can mint a Clanker token and seed a pool without ever installing a browser wallet. Stretch: progressive upgrade path to self-custody once a creator's accrued USDC fee stream crosses a threshold.

**Circle Paymaster** (post-mainnet evaluation, target: 4 to 8 weeks after mainnet stabilisation, co-shipped with the V4 migration): sponsor USDC-denominated gas for the first N swaps per new wallet so onboarding from CCTP V2 deposits is fully gasless. Activation gated on the published USDC-to-ARC oracle behavior so the paymaster economics can be modeled before mainnet exposure.

## FIELD: Milestones

### Milestone 1: Pre-mainnet external security audit on highest-risk Arcade contracts

**Scope:** Commission a private security review of the highest-risk ~1,700 LoC across ArcadeLaunchpad, ArcadeV3Locker, ArcadeTokenVault, ArcadeTwitterEscrowV3, and the V2 Factory/Router/Pair fork. Engagement target is a Pashov Audit Group private review (quoted at $25k to $45k for the 1,700 LoC scope). If the review surfaces a wider blast radius than expected, the residual budget is reserved to extend the scope to ArcadeMultiSwap and the Orbs TWAP vendored copy. Findings will be triaged into HIGH/MEDIUM/LOW, fixes shipped on a dedicated audit-fix branch, and a remediation diff plus auditor sign-off published under `contracts/audits/` before any mainnet deployment.

**Acceptance criteria:** (1) signed engagement letter with auditor, (2) final report PDF committed to the repo, (3) zero unresolved HIGH findings at mainnet tag, (4) every MEDIUM either fixed or documented with an explicit risk-accept note signed by the founder, (5) a public post-audit summary on arcade.trading/security linking the artifact and the fix commits, (6) regression tests for every finding added to `forge test` so the audit becomes executable.

**Circle integration angle:** Arcade is the first USDC-native AMM plus fair-launch engine on Arc, so every dollar of protocol fee, LP fee, creator royalty, migration fee, Twitter escrow credit, and gas reimbursement is denominated in USDC. A breach of the Launchpad or V3Locker drains USDC directly from Circle's mainnet user base, so an external audit is the single highest-leverage spend Circle can underwrite to protect the Arc rollout. Audit scope explicitly covers the USDC-handling paths (migration to V2, V3 fee collection, escrow EIP-712 claim verification).

**USDC ask:** $35,000 USDC (mid-range Pashov quote, leaves a $5k buffer for a one-round re-review of the audit-fix branch).

**Timeline:** 5 weeks. Week 1 scope freeze and engagement signing, weeks 2 to 4 audit window, week 5 remediation plus re-review.

### Milestone 2: CCTP V2 mainnet matrix, 6 source chains with one-tx bridge-then-trade UX

**Scope:** Expand the existing CCTP V2 integration (`web/lib/cctp.ts`, TokenMessenger v2 at `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitter v2 at `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`, Iris polled at `iris-api-sandbox.circle.com`) from the current Sepolia-to-Arc-testnet pipe to a full mainnet matrix: Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana as sources, Arc as the canonical destination. Ship a one-transaction bridge-then-trade UX so a user on any source chain signs once, CCTP V2 fast-transfer attests, and the same hook auto-routes the freshly minted USDC into either a Launchpad buy, an ArcadeMultiSwap trade, or an Orbs TWAP limit order. Reverse leg (Arc to source) reuses the same component.

**Acceptance criteria:** (1) /bridge page handles all 6 source chains with chain-specific minter/transmitter wiring, (2) Iris attestation polling uses the production `iris-api.circle.com` endpoint with a backoff strategy, (3) end-to-end test harness runs a $1 USDC transfer on all 6 routes weekly via GitHub Actions, (4) bridge-then-trade composes into a single user signature via a `destinationCaller` hook contract on Arc, (5) Solana leg uses the SVM CCTP V2 message format and posts to the same `destinationCaller`, (6) public docs at arcade.trading/bridge explain fees, settlement times, and failure modes.

**Circle integration angle:** This makes Arc the highest-utility CCTP V2 destination in the ecosystem at mainnet launch. Every cross-chain swap into Arc pays Arc gas in USDC, executes a Circle-native CCTP V2 burn-and-mint, and lands in a USDC-quoted pool, so the entire user journey stays inside the Circle stack. This is the showcase deliverable for Arc mainnet day one.

**USDC ask:** $12,000 USDC (covers Solana SDK integration, `destinationCaller` hook audit, weekly e2e harness infra, six-route deploy).

**Timeline:** 6 weeks, parallel with M1.

### Milestone 3: Public USDC-gas attribution dashboard live and ArcLens indexer in production

**Scope:** The core indexer is already built and adversarially audited (a Ponder project in `indexer/`, code-complete on `main`): it auto-discovers every USDC-paired V3 pool via the factory, indexes launchpad Buy/Sell and pool Swaps, and already serves complete USDC price/volume history behind the charts (with a parity-tested price module and a client-scan fallback). This milestone hardens and expands it: promote the current /stats page to a production-grade public dashboard, extend the indexer to the full Arcade event surface (Launchpad mode transitions, MultiSwap routes, Orbs TWAP book + DCA, TwitterEscrowV3 claims, CCTP V2 burns/mints), and run it in production on Arc mainnet with a full genesis backfill. The dashboard exposes per-protocol cumulative USDC gas burned, per-token USDC volume, per-creator USDC fees earned, per-Twitter-handle USDC pending in escrow, and per-CCTP-route USDC bridged, all queryable via a public GraphQL/REST endpoint at `api.arcade.trading`. Because the indexer is already delivered, this milestone is de-risked to hosting + schema expansion rather than greenfield engineering.

**Acceptance criteria:** (1) Ponder indexer in production with 99.5% uptime SLO and Grafana alerting, (2) hot path queries return under 200ms p95, (3) /stats renders the six headline numbers (cumulative USDC gas, cumulative USDC volume, cumulative USDC fees to creators, cumulative USDC bridged via CCTP V2, active tokens, graduated tokens), (4) historical backfill from Arc mainnet block 0 with replay-safety, (5) all-time event history queryable beyond the current 50k-500k block RPC scan cap that hooks/V4 frontend depend on, (6) open-source indexer schema published so other Arc apps can fork it.

**Circle integration angle:** Surfaces the only public number that proves Arc's USDC-as-gas thesis at scale: cumulative USDC gas paid by Arcade users, broken down by contract and by Circle product. Gives Circle marketing, BD, and product teams a citation-quality dashboard they can point at when pitching Arc and CCTP V2 adoption. Indexer also unblocks Circle Wallets embedded onboarding analytics (M5).

**USDC ask:** $9,000 USDC (Ponder hosting for 12 months, Postgres tier, Grafana Cloud, one-time schema design and backfill).

**Timeline:** 4 weeks, starts week 4 so backfill catches the mainnet genesis.

### Milestone 4: ArcadeHook V4 production deployment on Arc mainnet with bonding curve plus locked LP

**Scope:** Ship the V4 prototype currently scaffolded under `contracts/v4src/` (ArcadeV4Launchpad, ArcadeAntiSniperHook, ArcadeV4SwapRouter) to Arc mainnet, replacing the four-contract stack (Launchpad + V2 migration + V3Locker + Vault) with a single Uniswap V4 PoolManager pool plus one Arcade hook. The hook implements: bonding-curve price discovery up to the 20,000 USDC raise threshold, atomic graduation to full-range V4 liquidity, ERC-6909 locked LP positions for the creator/treasury fee streams, and anti-sniper protection (per-block buy caps decaying over 50 blocks). EIP-1153 transient storage is already confirmed on Arc per project memory, so the Cancun blocker is cleared.

**Acceptance criteria:** (1) ArcadeHook V4 deployed and verified on Arc mainnet with a deterministic hook address satisfying the V4 permission flags, (2) one full end-to-end token lifecycle (mint, bond, graduate, fee stream, locked LP claim) executed on mainnet and screencast, (3) gas cost per swap measured below the V2 baseline, (4) anti-sniper hook regression tests cover the first 50 blocks post-graduation, (5) ArcadeV4SwapRouter integrated into ArcadeMultiSwap so V4 pools become routable alongside V2/V3, (6) the `V4_HOOK_SPEC.md` design freeze referenced by the founder is signed off as implemented.

**Circle integration angle:** V4 hooks let a single USDC-quoted pool handle the entire token lifecycle (issuance, price discovery, graduation, perpetual LP locking, fee distribution), all denominated in USDC and paid for in USDC gas. This is the cleanest possible expression of "USDC-native DeFi" on Arc and the architectural template the rest of the Arc ecosystem can fork.

**USDC ask:** $8,000 USDC (hook-specific audit add-on with the M1 auditor, mainnet deploy gas budgeted in USDC, V4 integration testing infra).

**Timeline:** 6 weeks, starts week 6 (after mainnet stabilises, per roadmap).

### Milestone 5: Circle Wallets embedded creator-onboarding flow with USDC on-ramp and one-flow token launch

**Scope:** Integrate Circle Wallets (programmable embedded wallets, `w3s.circle.com` SDK) into arcade.trading so a first-time creator can sign up with email or social, get a Circle-managed wallet provisioned on Arc mainnet, on-ramp USDC directly via Circle's fiat partners, and launch a token through the bonding-curve Launchpad without ever touching a seed phrase, an external wallet, or a separate bridge. Embedded wallet sits behind the existing wagmi connector layer so the rest of the app (swap, bridge, escrow claim) just works. Creators who already have an external wallet keep the existing RainbowKit flow.

**Acceptance criteria:** (1) email plus social (Google, Apple, Twitter/X) sign-in flow live on arcade.trading/launch, (2) Circle Wallets SDK provisions a developer-controlled wallet on first sign-in and offers a smooth upgrade path to user-controlled, (3) USDC on-ramp via Circle's partner widget completes inside the same modal and credits the embedded wallet on Arc, (4) one-flow token creation: a brand-new user can go from sign-up to a live Launchpad token in under 3 minutes with no external dependencies, (5) the embedded-wallet path is feature-flagged so it can be A/B tested against the RainbowKit path, with conversion metrics surfaced on the M3 dashboard, (6) recovery and account-export flow documented under arcade.trading/account.

**Circle integration angle:** Closes the loop on the Circle stack. CCTP V2 (M2) brings existing USDC holders in, Circle Wallets (M5) brings non-crypto-native creators in, and Arc-as-gas plus USDC-quoted pools (M3, M4) keep them inside the Circle product surface for the full lifecycle. Together these four milestones make Arcade a flagship reference integration spanning every shipping Circle product.

**USDC ask:** $6,000 USDC (Circle Wallets SDK integration, on-ramp widget legal review, conversion analytics, account-recovery UX).

**Timeline:** 5 weeks, starts week 8.

**Total grant request across M1 to M5: $70,000 USDC.**

## FIELD: Current traction

Arcade is testnet-only today and the traction numbers reflect that honestly.

The full USDC-native stack is deployed and verified on Arc testnet (chainId 5042002): the V2 Factory and Router with a pair-level fee, the bonding-curve Launchpad with PUMP / CLANKER / CLANKER_V3 modes, the V3 Factory / Router / Quoter / NonfungiblePositionManager and the Locker that holds single-sided LPs forever, a keeper-driven V3 auto-compounder, the MultiSwap aggregator routing USDC-pivot trades across V2 and V3 with per-leg slippage floors, the Twitter handle escrow with EIP-712 signed claims, and the Orbs TWAP fork powering on-chain limit orders and DCA without an off-chain backend. The whole stack is governed by a live 2-of-3 Gnosis Safe (verified on-chain: treasury, fee sink, factory fee-setter, locker, compounder, and escrow all resolve to the Safe).

Two pieces of always-on infrastructure were shipped and adversarially audited this cycle: a self-hosted unified keeper (`/api/keeper/cron`) that bids and fills the limit-order/DCA book and auto-relays CCTP bridge-and-buy so a cross-chain deposit completes into a token buy with no second signature, and a Ponder indexer serving complete USDC price/volume history behind the charts (replacing a client-side scan capped at 500 trades). Both are code-complete on `main`; going live needs only hosting.

CCTP V2 is wired end-to-end in production code (`web/lib/cctp.ts` hits TokenMessenger v2 at `0x8FE6B999...2542DAA` and polls Iris attestations) and bridges Sepolia USDC to Arc testnet today through the /bridge route.

Security is continuous: production code has passed many rounds of adversarial internal audit (offensive exploit sweeps, a governance-transfer review, a 4-round keeper loop, a 2-round indexer loop), each closed with executable regression tests; residual mainnet-gated HIGH items are documented for the external review.

A V4 prototype targeting the Arcade anti-sniper hook is scaffolded on `contracts/v4src/` after confirming EIP-1153 transient storage works on Arc testnet.

The public /stats dashboard surfaces cumulative USDC gas paid through Arcade contracts, which is the most Circle-native metric a USDC-gas chain can report.

Quantitative testnet metrics (as of submission):
- Cumulative testnet transactions through Arcade contracts: **[FOUNDER FILLS — pull from /stats or Arc explorer]**
- Unique connected wallets: **[FOUNDER FILLS — from analytics]**
- Cumulative USDC gas paid through Arcade contracts: **[FOUNDER FILLS — from /stats]**
- Tokens launched via the bonding-curve Launchpad: **[FOUNDER FILLS — count from ArcadeLaunchpad events]**
- Tokens graduated to V2 or V3 pools: **[FOUNDER FILLS — count from migration events]**
- Cumulative testnet USDC bridged via CCTP V2: **[FOUNDER FILLS — from bridge logs]**

## FIELD: Are you funded?

Arcade is currently a solo-founder project. Funding to date has come entirely from a hackathon prize that paid for Arc testnet RPC infrastructure, the arcade.trading domain, Vercel hosting, and roughly six months of focused build time. There has been no venture raise, no token sale, no pre-seed cheque.

The Circle Developer Grants application is being submitted in parallel with the Arc Builders Fund application, since the two programs cover complementary cost centres (Circle covers Circle-product integration depth; Arc Builders covers Arc-native distribution and mainnet launch). No other grants are pending.

## FIELD: Technical Roadmap

The roadmap is organized as five milestones, each tied to a Circle-product integration that the grant directly accelerates.

**Milestone 1 (weeks 0 to 8): external security audit.** Pashov Audit Group private review of the highest-risk ~1,700 LoC (Launchpad, V3 Locker, Twitter escrow, MultiSwap), followed by a Code4rena public contest if budget allows. Deliverable: signed audit report published in the repo and SECURITY.md ship.

**Milestone 2 (weeks 4 to 10): CCTP V2 mainnet matrix.** Extend the existing testnet integration from a single Sepolia-to-Arc route into a full mainnet matrix covering Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana on Arc mainnet day one. Includes Iris production endpoint, fast-finality threshold tuning, and Hooks support for one-click "bridge and swap on Arcade."

**Milestone 3 (weeks 6 to 12): USDC-gas analytics dashboard.** Promote the /stats page into a first-class public dashboard that breaks down cumulative USDC paid as gas through Arcade contracts, per-contract and per-day. Since Arc is USDC-native this is uniquely meaningful to Circle.

**Milestone 4 (weeks 8 to 16): V4 mainnet migration.** Ship the ArcadeAntiSniperHook plus ArcadeV4Launchpad path; one V4 pool replaces today's launchpad, locker, and migration plumbing, cutting protocol surface area roughly in half. Design is already frozen at `contracts/V4_HOOK_SPEC.md`.

**Milestone 5 (weeks 10 to 18): Circle Wallets embedded onboarding.** Wire Circle Wallets into the token-creation flow so first-time creators can launch a token without holding USDC on Arc beforehand, with the embedded wallet funded via CCTP V2 from whatever chain the user arrived from.

Circle Paymaster evaluation is deliberately deferred until the published USDC-to-ARC oracle behavior is stable on mainnet.

## FIELD: How will this grant support your technical roadmap?

Grant funds will be allocated to four hard cost centres, in priority order.

**(1) External audit: $25,000 to $45,000** for a Pashov Audit Group private review of the highest-risk 1,700 LoC across Launchpad, V3 Locker, Twitter escrow, and MultiSwap. If the upper end of the budget is met, a Code4rena public contest at $40,000 to $50,000 follows the private review and is run before mainnet. This is the single largest line item and the one that blocks the Arc mainnet deploy.

**(2) CCTP V2 mainnet rollout engineering:** roughly six to eight weeks of focused build time to extend the existing Sepolia-to-Arc-testnet implementation into the full mainnet matrix (Ethereum, Base, Arbitrum, Optimism, Polygon, Solana to Arc mainnet), wire Iris production attestation, add Hooks for atomic bridge-and-swap, and ship monitoring for fast-finality thresholds.

**(3) Circle Wallets embedded onboarding:** four to six weeks to integrate Circle Wallets into the token-creation flow at /launch, so a creator arriving from any CCTP-supported chain can mint and seed a bonding curve in one signed flow without pre-existing Arc gas.

**(4) V4 hook mainnet deploy:** two to four weeks of engineering plus a focused mini-audit on the V4 hook surface (the ArcadeAntiSniperHook is the only novel V4 code path; the rest is V4-canonical).

Any remaining funds extend solo-founder runway through Arc mainnet stabilisation so external audit findings can be remediated full-time rather than nights-and-weekends. No grant funds will be used for marketing, token incentives, or liquidity bootstrapping; those are explicitly out of scope.

## FIELD: Video demo of the product

**[FOUNDER FILLS — upload a 2 to 4 minute walkthrough covering: (a) arcade.trading landing + /stats, (b) Launchpad token creation in PUMP or CLANKER_V3 mode, (c) a V2 or MultiSwap trade quoting in USDC, (d) /bridge running a CCTP V2 Sepolia-to-Arc transfer end-to-end, (e) an Orbs TWAP limit order being placed. Host on Loom or YouTube unlisted and paste the URL here.]**

## FIELD: Investor deck

**[FOUNDER FILLS — paste the public link to the Arcade deck (Pitch, Figma, or Google Slides). If no deck exists yet, write "No deck; happy to do a live walkthrough" rather than leaving blank.]**

## FIELD: Conflict of interest

**[FOUNDER FILLS — answer Yes or No. Standard answer is "No. Founder has no current or prior employment, equity, consulting, or family relationship with Circle, the Arc team, or any judging-panel member. The only prior contact with the Arc team was a hackathon win in [month/year], which was a competitive open submission."]**

---

## Founder action items before submission

1. Record and upload a 2 to 4 minute product video walkthrough (Loom or unlisted YouTube) covering landing, /stats, Launchpad token creation, MultiSwap trade, CCTP V2 bridge end-to-end, an Orbs TWAP limit order, and (new) a DCA schedule + the auto-settling keeper; paste link into Video demo field.
2. Paste public investor deck URL (Pitch, Figma, or Google Slides). If no deck exists, replace placeholder with "No deck; happy to do a live walkthrough."
3. Fill in exact hackathon name and month/year of the Arc team win in the "Why are you uniquely suited" field and the Conflict of interest answer.
4. Fill quantitative testnet metrics in the Current traction field: cumulative tx count, unique connected wallets, cumulative USDC gas paid, tokens launched via Launchpad, tokens graduated, cumulative USDC bridged via CCTP V2. Pull from /stats and the Arc explorer.
5. Answer the Conflict of interest field with Yes or No and a one-line explanation; default suggested wording is provided.
6. Re-confirm the Pashov Audit Group quote in writing before submission so the $25k to $45k range and the $35k M1 ask reflect a live engagement letter rather than a public quote.
7. Confirm the production Iris endpoint URL (`iris-api.circle.com`) is correct for the mainnet CCTP V2 matrix in M2 before paste.
8. Verify the total $70,000 USDC ask is within the Circle Developer Grants per-project cap; if a lower ceiling applies, trim M3 ($9k) or M5 ($6k) first since M1 (audit) and M2 (CCTP V2 matrix) are highest leverage.

Note: contract addresses in the table are the current Safe-governed testnet generation (2026-07-16) pulled from `web/public/deployments.json`. Re-pull before submission only if a further redeploy has happened since.
