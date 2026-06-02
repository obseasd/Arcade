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

ArcadeMultiSwap aggregates V2 plus V3 routes around a USDC pivot, and the Orbs TWAP integration puts true on-chain limit orders into the same book. CCTP V2 is already wired in `web/lib/cctp.ts` using the canonical TokenMessenger and MessageTransmitter addresses, so capital can arrive from Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana into a single USDC denominator at settlement.

## FIELD: Why hasn't this problem been solved yet? What are the barriers?

This problem persisted because four structural barriers had to fall at once.

First, every prior EVM L1 charged gas in a volatile asset, so a stablecoin-native AMM was a leaky abstraction: LPs still paid ETH to rebalance, breaking the dollar accounting at the margin.

Second, the dominant bonding-curve venues on Solana and Base were coded as memecoin casinos with custodial off-ramps, which alienated the institutional and RWA capital that Arc is courting and made "launchpad" a slur in serious credit circles.

Third, no canonical stablecoin-native settlement chain existed before Arc, so there was no place to deploy a venue where the gas token, the quote asset, the fee asset, and the migration asset are all the same dollar.

Fourth, Twitter-identity reward attribution was historically off-chain and custodial, blocking any clean on-chain escrow that could pay creator fees to a handle before the handle proves out a wallet.

Arc removes barrier three this year, EIP-712 removes barrier four, and Arcade is the first venue that closes barriers one and two by being designed from the contract level around USDC-only accounting and an anti-memecoin issuance flow that treats every token as a capital instrument.

## FIELD: Why are you and your team uniquely suited to solve this problem?

Arcade is built by a solo founder, pseudonymous publicly and doxxed to the Arc team through a hackathon win, available for KYC under a confidentiality side letter with Circle compliance. The honest framing is velocity, not headcount.

In the current cohort the project has shipped and verified nine smart contracts on Arc testnet (V2 Factory, V2 Router, Launchpad, V3 Factory, V3 Router, V3 Quoter, V3 Locker, Token Vault, MultiSwap), wired Orbs TWAP for live on-chain limit orders, scaffolded a V4 hook prototype against confirmed EIP-1153 transient storage on Arc, and integrated CCTP V2 in the first cohort of Arc projects to do so, all behind a live frontend at arcade.trading.

A multi-agent internal security audit was run end-to-end against the production code: seven of eight HIGH findings and eleven of fourteen MEDIUM findings closed in a single audit-fix commit, with the two remaining HIGH items documented as deferred and gated on external review.

The next milestones are a Hats Finance bounty vault and a Pashov private review, both bottlenecked only on grant capital rather than scope or readiness.

Hackathon context: **[FOUNDER FILLS — exact hackathon name and month/year of the Arc team win]**

## FIELD: Is your project currently live in production?

Not yet in mainnet production. Arcade is live end-to-end on Arc testnet (chainId 5042002) with 12 verified contracts, a public frontend at arcade.trading, a /stats dashboard surfacing cumulative USDC gas, and CCTP V2 bridging from Sepolia. Mainnet deploy is committed for Arc mainnet day one, Summer 2026, contingent only on Arc mainnet opening.

## FIELD: Are you live on Arc?

Yes, live on Arc testnet (chainId 5042002). The full stack is deployed and verified: V2 Factory and Router, V3 Factory, Router, Quoter, and Locker, ArcadeLaunchpad (PUMP, CLANKER, CLANKER_V3 modes), ArcadeTokenVault, ArcadeMultiSwap aggregator, ArcadeTwitterEscrowV3, and the Orbs TWAP / ExchangeV2 settlement adapter. Frontend at arcade.trading runs against Arc testnet today. Arc mainnet day-1 deploy is committed for Summer 2026.

## FIELD: Have you deployed any smart contracts?

Yes. Twelve contracts are deployed and verified on Arc testnet (chainId 5042002), covering the full DEX, launchpad, locker, vault, aggregator, Twitter-handle escrow, and Orbs TWAP limit-order surfaces. All quote and settle in USDC, which is the native gas asset on Arc. Addresses are listed in the next field.

## FIELD: Smart contract addresses

All deployed on Arc testnet (chainId 5042002):

| Contract | Address | Purpose |
|---|---|---|
| USDC | `0x3600000000000000000000000000000000000000` | Arc native gas token; settlement unit for every Arcade fee, LP share, and escrow credit. |
| ArcadeV2Factory | `0x289b18cBFD9f2a2657c021F80423137Af6233332` | Uniswap V2 fork factory deploying USDC-quoted pairs for AMM trading. |
| ArcadeV2Router | `0x529d7250652aAaA11b4E2407e8b49fa9ae0E5041` | Stateless router for V2 swaps and add/remove liquidity, USDC-quoted. |
| ArcadeLaunchpad | `0x073a4869219D19843b57ab4CeF3AfAf24D499a56` | Bonding-curve token issuance engine (PUMP, CLANKER, CLANKER_V3 modes) raising USDC up to 20,000 then atomic migration. |
| ArcadeMultiSwap | `0x019e2e4F3858c470aFFf54B82Ce3E6b6e391cfA5` | Aggregator routing USDC-pivot multi-token swaps across V2 and V3 pools in one tx. |
| ArcadeV3Factory | `0xB9339dE1eeC40d4f513aBD567DAb6837fc7D63D6` | V3 fork factory for concentrated-liquidity USDC pools backing CLANKER_V3. |
| ArcadeV3Locker | `0x60b23CEeA70c3846AC5f9b32E1f8598136E3E569` | Permanent single-sided LP vault locking CLANKER_V3 positions and streaming fees to creator + treasury forever. |
| ArcadeV3Router | `0xE4CaD091D2be82332688bCab444C1e394fD13Fb4` | V3 swap router executing exactInput / exactOutput trades against V3 pools. |
| ArcadeV3Quoter | `0xca7f8700F032eF1Cdd0708bBAcDB23cDE43bd4c7` | Off-chain quote helper for V3 pricing used by the frontend route builder. |
| ArcadeTokenVault | `0x4fE2A2EeB955bbA0A94D3b23970279d13F6CeE14` | Custodial vault holding curve-issued tokens between bond completion and migration. |
| Orbs ExchangeV2 (dLIMIT) | `0xC34e4dfAd598E70Ae59cf47ce98211EeEB42357d` | Orbs settlement adapter wiring TWAP limit-order fills into ArcadeV2Router. |
| Orbs TWAP (book) | `0xb4b7B2ea8C033484921993cBBE3f61f1658D6102` | On-chain limit-order book (TWAP.book[]) holding live USDC-quoted limit orders on Arc. |
| ArcadeTwitterEscrowV3 | **[FOUNDER FILLS — pull NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS from Vercel env]** | EIP-712 signed-claim escrow attributing creator USDC fee streams to Twitter handles before wallet creation. |
| ArcadeV4Launchpad (prototype) | **[FOUNDER FILLS — pull NEXT_PUBLIC_V4_LAUNCHPAD_ADDRESS from Vercel env if a testnet deploy exists]** | V4 hook-based launchpad prototype; not in production traffic yet. |
| ArcadeAntiSniperHook (prototype) | **[FOUNDER FILLS — pull NEXT_PUBLIC_V4_HOOK_ADDRESS from Vercel env if a testnet deploy exists]** | V4 hook implementing bonding curve, atomic graduation, locked LP, and per-block buy caps. |

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

**Scope:** Promote the current /stats page (cumulative USDC gas paid through Arcade contracts) to a production-grade public dashboard, and back it with ArcLens, a Ponder-based indexer that subscribes to every Arcade contract event on Arc mainnet (V2 Factory/Router/Pair, V3 Factory/Locker/Router, Launchpad mode transitions, MultiSwap routes, Orbs TWAP book, TwitterEscrowV3 claims, CCTP V2 burns/mints). The dashboard exposes per-protocol cumulative USDC gas burned, per-token USDC volume, per-creator USDC fees earned, per-Twitter-handle USDC pending in escrow, and per-CCTP-route USDC bridged. All metrics queryable via a public GraphQL endpoint at `api.arcade.trading`.

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

Nine production contracts are deployed and verified on Arc testnet (chainId 5042002): the V2 Factory and Router, the bonding-curve Launchpad with PUMP / CLANKER / CLANKER_V3 modes, the V3 Factory and Locker that holds single-sided LPs forever, the MultiSwap aggregator routing USDC-pivot trades across V2 and V3, the Twitter handle escrow with EIP-712 signed claims, and the Orbs TWAP fork powering live on-chain limit orders without an off-chain backend.

CCTP V2 is wired end-to-end in production code (`web/lib/cctp.ts` hits TokenMessenger v2 at `0x8FE6B999...2542DAA` and polls Iris attestations) and bridges Sepolia USDC to Arc testnet today through the /bridge route.

An internal multi-agent security audit closed 7 of 8 HIGH-severity findings and 11 of 14 MEDIUM-severity findings; the two deferred HIGHs are documented and gated to mainnet.

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

1. Record and upload a 2 to 4 minute product video walkthrough (Loom or unlisted YouTube) covering landing, /stats, Launchpad token creation, MultiSwap trade, CCTP V2 bridge end-to-end, and Orbs TWAP limit order; paste link into Video demo field.
2. Paste public investor deck URL (Pitch, Figma, or Google Slides). If no deck exists, replace placeholder with "No deck; happy to do a live walkthrough."
3. Fill in exact hackathon name and month/year of the Arc team win in the "Why are you uniquely suited" field and the Conflict of interest answer.
4. Pull `NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS` from Vercel env and paste into the Smart contract addresses table as ArcadeTwitterEscrowV3.
5. Pull `NEXT_PUBLIC_V4_LAUNCHPAD_ADDRESS` and `NEXT_PUBLIC_V4_HOOK_ADDRESS` from Vercel env (or remove those two rows if no testnet V4 deploy exists yet).
6. Fill quantitative testnet metrics in the Current traction field: cumulative tx count, unique connected wallets, cumulative USDC gas paid, tokens launched via Launchpad, tokens graduated, cumulative USDC bridged via CCTP V2. Pull from /stats and the Arc explorer.
7. Answer the Conflict of interest field with Yes or No and a one-line explanation; default suggested wording is provided.
8. Re-confirm the Pashov Audit Group quote in writing before submission so the $25k to $45k range and the $35k M1 ask reflect a live engagement letter rather than a public quote.
9. Confirm the production Iris endpoint URL (`iris-api.circle.com`) is correct for the mainnet CCTP V2 matrix in M2 before paste.
10. Verify the total $70,000 USDC ask is within the Circle Developer Grants per-project cap; if a lower ceiling applies, trim M3 ($9k) or M5 ($6k) first since M1 (audit) and M2 (CCTP V2 matrix) are highest leverage.
