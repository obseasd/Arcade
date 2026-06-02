# Arcade · Grant Applications Drafts

Two applications ready to submit:
1. **Arc Builders Fund** (arc.io/builders-fund) · Circle Ventures SAFE+T track
2. **Circle Developer Grants** (circle.questbook.app) · milestone-based USDC

Each draft is self-contained. Copy-paste, adjust the personal fields (founder name / contacts), and submit.

---

## 1. Arc Builders Fund · Application

**Project Name:** Arcade

**One-line pitch:** Capital formation for stablecoin-native markets on Arc. USDC-settled AMM + fair-launch token issuance engine, live on Arc testnet since day one.

**Website:** arcade.fun (testnet)

**Vertical match:** Vertical 1 (Always-on markets and capital formation: AMMs, launchpads)

---

### Problem we solve

Stablecoin-native chains need stablecoin-native capital formation primitives. On every other EVM chain, token issuance happens against volatile gas tokens (ETH, MATIC, BNB) which forces issuers to manage two-asset treasuries from day one. On Arc, with USDC as native gas, token issuance can finally settle in a single stable unit of account end to end: the bonding curve, the AMM liquidity, the trading fees, the migration capital, the protocol revenue. Arcade is built to be that primitive.

### What we built

Arcade is a USDC-native fair-launch tokenization engine plus an AMM, deployed on Arc testnet (chainId 5042002) since Q1 2026. Two stages:

1. **Fair-launch bonding curve.** Issuers create a token, pay no upfront capital, and trades execute against a constant-product curve denominated in USDC. Trade fee 1%. Once the curve raises 2,500 USDC, the token graduates.
2. **AMM with locked LP.** At graduation, liquidity migrates atomically to an Arcade V2 pool (Uniswap V2 fork) with a 0.30% swap fee split 0.25% to LPs / 0.05% to protocol. LP positions are locked in a Clanker-style V3 single-sided vault that streams fees to creators and the platform.

Adjacent products live on the same stack:

- **CCTP V2 integration** for cross-chain USDC inflow (Sepolia → Arc testnet today, mainnet sources at Arc mainnet).
- **Twitter reward escrow** with EIP-712 signed claims, distributing LP fees to verified Twitter handles for creator distribution.
- **V4 launchpad prototype** (ArcadeV4Launchpad + anti-sniper hook) already scaffolded against Uniswap V4 core, gated on Prague EVM availability which we have confirmed on Arc.

### Why Arc specifically

- **USDC as native gas** is the only environment where this stack is coherent. Every fee, every settlement, every accounting line stays in USDC. No FX leg, no token-of-the-month treasury management for issuers.
- **Deterministic sub-second finality** (under 350ms with 20 validators) matches the UX expectations of bonding-curve trading and AMM swaps far better than L1 Ethereum or even most rollups.
- **Prague EVM with EIP-1153 transient storage** unblocks Uniswap V4 hooks, which is our Track B roadmap to collapse the entire 5-contract stack into a single V4 pool with hooks.
- **Native MEV protection** (encrypted mempools, sealed-bid block-builder auctions) means we do not have to build Flashbots-style middleware to protect launchpad token launches from sniping.
- **Circle ecosystem composability**: CCTP V2 is already integrated, Circle Wallets is on our roadmap, Circle Paymaster is under evaluation.

### Traction (Arc testnet, as of June 2026)

- Smart contracts deployed and verified on Arc testnet: 5 (ArcadeV2Router, ArcadeV2Factory, ArcadeLaunchpad, ArcadeTwitterEscrowV3, ArcadeV4Launchpad)
- Tokens launched via the bonding curve: [insert count from testnet]
- Cumulative USDC swap volume routed: [insert]
- Cumulative USDC gas paid through Arcade contracts: [insert from /stats dashboard]
- Unique testnet wallets: [insert]
- CCTP V2 bridges completed into Arc testnet via Arcade: [insert]

A live dashboard is hosted at arcade.fun/stats with weekly snapshots posted to @Arcade_fun and tagged @arc @circle.

### Team

Solo founder. Pseudonymous publicly, doxxed to the Arc team via the [hackathon name] win in [month/year]. Public GitHub at github.com/[handle]/arcade with verifiable commit history dating to [first commit date]. Prior background: [insert short bio].

Available for KYC under a confidentiality side letter with Circle compliance (Arc team only, not the broader Circle Ventures partner network).

### Security posture

- Internal multi-agent security audit completed. 7 of 8 HIGH-severity findings closed. 11 of 14 MEDIUM-severity findings closed. Two HIGH findings (H-02, H-07) are documented and deferred pre-mainnet with explicit mitigation strategies.
- Permissionless bug bounty vault on Hats Finance covering all 5 contract scopes (active since [date], URL: [insert]).
- SECURITY.md published at [repo URL] documenting known accepted risks.
- All contracts use OpenZeppelin Ownable2Step, ReentrancyGuard, Pausable, ECDSA. EIP-712 typehash cached at deploy.

### Ask

We are seeking a Builders Fund check of **$250k - $500k** under a SAFE+T structure (post-money SAFE plus a token side letter, pro-rata of company reserve method). Use of funds:

- **$25k - $50k pre-mainnet security audit.** Recommended deployment: Pashov Audit Group private review on the highest-risk pieces (escrow + bonding curve + locker, ~1,700 LoC), plus a maintained Hats Finance vault for the V2 fork. Audit budget is the single largest funding gap and a documented Circle pillar ("audited templates").
- **$120k - $180k twelve-month founder salary.** Allows full-time focus through Arc mainnet launch (summer 2026) and the V4 migration that follows.
- **$50k - $100k mainnet ops runway.** Cloud infrastructure for indexer (Ponder on Railway), keeper for limit-order settlement, Postgres for off-chain order book, monitoring, gas float for keeper hot wallet, CCTP V2 attestation infra.
- **$30k - $50k marketing and BD.** Launch campaign at Arc mainnet, content production, ecosystem partner outreach with other Arc protocols.

We are also requesting that the Builders Fund track explicitly clarify whether participation includes an ARC ecosystem-token allocation. We are flexible on whether this is bundled into the SAFE+T or kept as a separate side letter.

### Why now

Arc mainnet ships summer 2026. Arcade is one of very few EVM DEXes already live on Arc testnet with verified contracts, a working frontend at arcade.fun, and a measurable share of testnet activity. Day-one mainnet deploy is a credible airdrop and grants-eligibility multiplier across every L1 ecosystem we have studied (Base Builder Grants, Hyperliquid Season 1, Sui DeFi initiative). Arcade is positioned to be a reference DEX + capital formation template for Arc, and the Builders Fund is the cleanest path to make sure mainnet ship is audited and well-marketed.

### Links

- Live testnet: arcade.fun
- Live dashboard: arcade.fun/stats
- GitHub: github.com/[handle]/arcade
- Docs: arcade.fun/docs
- Twitter: @Arcade_fun
- Hats bug bounty: [insert URL once spun up]

### Contact

[founder handle / email / Telegram for Circle Ventures BD]

---

## 2. Circle Developer Grants · Application

**Project Name:** Arcade

**Submission via:** circle.questbook.app

**Vertical:** Capital formation primitives on Arc. Closest published Circle Grants vertical: prediction markets / FX-adjacent (we are open to repositioning if Circle adds an AMM/DEX vertical).

**Tier requested:** $25k - $75k milestone-based USDC

---

### Project summary

Arcade is a USDC-native AMM plus fair-launch tokenization engine, deployed on Arc testnet since Q1 2026. The product enables anyone to issue a token via a bonding curve denominated in USDC, trade it during the curve phase, and on graduation migrate liquidity atomically to an AMM pool with locked LP. The full stack settles in USDC end to end. Adjacent products on the same stack include CCTP V2 cross-chain inflow, Twitter-handle reward escrow with EIP-712 signed claims, and a Uniswap V4 prototype gated on Arc's Prague EVM.

### Meaningful use of Circle products

The grant program eligibility language requires "meaningful use of Circle products like USDC, Wallets, CCTP, or Gateway." Arcade qualifies on three out of four already, with the fourth on the roadmap:

1. **USDC as the only settlement asset across the entire protocol.** Every fee, every reward, every migration capital pool, every protocol revenue line is denominated and settled in USDC. We do not hold any non-USDC treasury reserves.
2. **CCTP V2 integration is live on testnet.** Arcade bridges USDC from Sepolia (Ethereum testnet) to Arc testnet using the canonical TokenMessenger v2 and MessageTransmitter v2 contracts. Mainnet sources to expand at Arc mainnet (Ethereum, Base, Solana, Arbitrum, Optimism).
3. **Circle Wallets on the roadmap.** Embedded wallet flow for launchpad creators to onboard without an external wallet. Milestone listed below.
4. **Circle Paymaster under evaluation.** Sponsoring user gas on the bonding curve to remove friction for first-time creators. Conditional on the published USDC-to-ARC oracle.

### Milestones (proposed)

Each milestone is a discrete, verifiable deliverable. Funding released on completion.

#### Milestone 1: Pre-mainnet external security audit · $25,000 USDC

Deliverable: External audit report from Pashov Audit Group on the highest-risk Arcade contracts (Twitter escrow, bonding curve, V3 locker, ~1,700 LoC). Public report posted at arcade.fun/security with all critical and high findings remediated and a remediation pass signed off.

Why: Circle's grant docs cite "audited templates" as a core pillar. Arcade aims to be the reference DEX + launchpad template for Arc, and an external audit lifts it from "internal multi-agent audit pass" to "third-party signed off." Estimated cost $25-45k based on Pashov's published quoting model.

Acceptance: PDF audit report linked from arcade.fun/security, no Critical or High findings unresolved, change log on GitHub showing remediation commits.

#### Milestone 2: CCTP V2 mainnet integration with full source-chain matrix · $10,000 USDC

Deliverable: At Arc mainnet, CCTP V2 inflow from Ethereum, Base, Arbitrum, Optimism, Polygon, Solana, and any additional source domain Circle adds at mainnet. Smooth bridge-then-trade UX inside the Arcade frontend (single transaction simulation, attestation polling, automatic destination-side mint, optional auto-swap on arrival).

Why: CCTP V2 is the canonical Circle cross-chain primitive. A polished implementation by a deployed protocol drives USDC throughput to Arc and demonstrates real composability with Circle's stack.

Acceptance: Bridge flow live at arcade.fun/bridge supporting all listed source domains. End-to-end tested with at least one bridge completed per source domain. Public Dune query or arcade.fun/stats page tracking CCTP volume routed via Arcade.

#### Milestone 3: USDC-gas-attribution dashboard live and indexed by ArcLens · $10,000 USDC

Deliverable: Public arcade.fun/stats page surfacing cumulative USDC gas paid through Arcade contracts, share of total Arc USDC gas burnt, transactions routed, unique wallets, tokens launched, swap volume, CCTP volume. Self-hosted Ponder indexer, weekly tweet automation, OG image rendering. Listed on ArcLens as a tracked protocol.

Why: USDC-as-gas is the single most differentiated activity Circle has stated it tracks. A public attribution dashboard demonstrates Arcade's contribution to Arc's deflationary pressure on ARC and makes that contribution visible to Circle, partners, and the broader Arc ecosystem.

Acceptance: Live page at arcade.fun/stats with refresh under 60 seconds. Verified by ArcLens. Weekly tweet automation drafting (not auto-posting) into a private channel for review.

#### Milestone 4: Uniswap V4 production deployment on Arc · $15,000 USDC

Deliverable: ArcadeV4Launchpad + ArcadeAntiSniperHook deployed to Arc mainnet using Uniswap V4 PoolManager with anti-sniper protections. Launchpad creators have the option to use V4 pools instead of V2 at token graduation.

Why: V4 hooks + transient storage + native MEV protection are first-class Arc features (Prague EVM, encrypted mempool, sealed-bid auctions). Arcade aims to be one of the first V4 hook deployments on Arc, demonstrating composability with Uniswap as a named Arc ecosystem partner.

Acceptance: Verified contracts on Arc mainnet, public source on GitHub, at least one token migrated to a V4 pool via the launchpad, anti-sniper hook activations logged.

#### Milestone 5: Circle Wallets embedded onboarding flow · $10,000 USDC

Deliverable: Optional embedded Circle Wallets flow at arcade.fun/launchpad/create allowing creators to onboard with email or social auth, without an external wallet. Wallet provisioned, USDC funded via on-ramp, token created in a single guided flow.

Why: Circle Wallets is one of the named meaningful-integration Circle products. Embedded wallets remove the largest UX friction for first-time creators, especially the non-crypto-native audience that capital formation primitives need to reach.

Acceptance: Live flow at arcade.fun/launchpad/create with the Circle Wallets option as a toggle. At least 25 creator wallets provisioned through this flow.

#### Total ask: $70,000 USDC

Released across five milestones over approximately 6 months.

### Team

Solo founder. Pseudonymous publicly, doxxed to the Arc team via the [hackathon] win in [month/year]. Available for KYC under a confidentiality side letter with Circle compliance.

### Security and accountability

- Internal multi-agent security audit pass: 7 of 8 HIGH closed, 11 of 14 MEDIUM closed. Deferred items documented.
- Permissionless Hats Finance bug bounty vault active.
- SECURITY.md public.
- All contracts open source on GitHub.
- Public commit history dating to [first commit date].

### Why this serves the broader Arc ecosystem

Arcade aims to be the reference capital formation template on Arc. The audit, dashboard, CCTP integration, and V4 deployment are not just Arcade-specific deliverables. The audit becomes a public artifact other Arc DEX builders can study. The dashboard sets the bar for USDC-gas attribution transparency on Arc. The CCTP integration is reusable Solidity + frontend that other Arc DEXes can fork. The V4 deployment is the first hook deployment on Arc and becomes a reference implementation.

### Links

- Live testnet: arcade.fun
- GitHub: github.com/[handle]/arcade
- Live dashboard: arcade.fun/stats
- Hats bug bounty: [insert]
- Twitter: @Arcade_fun

### Contact

[founder handle / email / Telegram]

---

## Cover letter template (use as the DM intro to Circle / Arc BD)

Subject: Arcade · USDC-native AMM and capital formation engine on Arc (Builders Fund Vertical 1)

Hi [name],

I am [pseudo handle], the solo founder of Arcade, a USDC-native AMM plus fair-launch tokenization engine live on Arc testnet since Q1 2026. We won [hackathon name] in [month/year], at which point your team [insert team contact who knows you] verified my identity under a confidentiality side letter. I am writing to formally submit Arcade for the Arc Builders Fund and Circle Developer Grants tracks in parallel.

Arcade matches Builders Fund Vertical 1 (always-on markets and capital formation: AMMs, launchpads) verbatim. The whole stack settles in USDC end to end: bonding-curve token issuance at 1% trade fee, atomic migration to an AMM at the 2,500 USDC graduation threshold, V2 pool with 0.30% swap fee (0.25% LP / 0.05% protocol), locked LP fee distribution via a Clanker-style V3 vault, and Twitter-handle reward escrow with EIP-712 signed claims. CCTP V2 inflow is integrated. A Uniswap V4 prototype is scaffolded against Arc's Prague EVM. Five contracts are verified on Arc testnet. A live dashboard surfaces cumulative USDC gas paid through Arcade contracts at arcade.fun/stats.

Two attached drafts:

1. Builders Fund application: SAFE+T request, $250k - $500k, with explicit audit-budget line item and a request to clarify whether the track includes an ARC ecosystem-token allocation.
2. Circle Developer Grants application: 5-milestone $70k USDC ask covering external audit, mainnet CCTP rollout, USDC-gas attribution dashboard, V4 production deployment, and Circle Wallets embedded onboarding.

I am available for a call any time this week or next. The pseudonymous-with-confidentiality posture is non-negotiable in public, but I have already shared my identity with [Arc team contact] and am happy to extend the same to Circle Ventures and Circle compliance under a side letter.

Thank you for the time, and for everything the Arc team and Circle are building.

[founder handle]
[telegram / signal / email]

---

## Notes for the founder before submitting

- Fill in every `[insert ...]` placeholder with the real number / name / URL. Do not submit with placeholders.
- Stand up the Hats Finance vault first so the URL is real when these applications go out.
- Make sure arcade.fun/stats is at least a placeholder page with a clear "live numbers shipping soon" message if the indexer is not yet complete.
- Cap the hackathon mention at one short clause. It is a warm-intro signal, not the headline.
- The token allocation Method 1 vs Method 2 negotiation point belongs in the term-sheet conversation, not in the application itself. Bring it up only when Circle Ventures sends a term sheet.
- Audit-budget line item is the single highest-leverage ask. Do not soften it. Frame it as a public-good investment in an Arc reference template, not as Arcade-specific protection.
- Decline any chain-exclusivity clauses if proposed. Arc-priority for 18 months post-mainnet is the acceptable middle.
