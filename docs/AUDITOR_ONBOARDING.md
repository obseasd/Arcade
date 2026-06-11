# Auditor onboarding — Arcade

> Single doc to hand a contracted auditor (Pashov / Spearbit / Cantina /
> C4) on day 1. Combines scope, threat model, invariants, known issues,
> and prep checklist so the audit can start producing findings instead
> of reverse-engineering context.

Last updated: 2026-06-11. Maintain alongside `AUDIT_PROGRESS.md`.

## Project at a glance

Arcade is a DEX + bonding-curve launchpad on **Arc testnet** (chainId
**5042002**, Circle's EVM L1 where USDC is the gas token). Three
surfaces an auditor scopes:

1. **V2 DEX** — UniswapV2 fork (factory + router + pair), 0.30 % fee.
   Used for post-graduation token trading.
2. **V3 DEX** — UniswapV3 fork in solc 0.7.6 (factory + pool + NPM +
   quoter + router) plus an Arcade-specific anti-sniper hook on the
   router. Used for CLANKER_V3 single-sided locked-LP launches.
3. **Launchpad** — pump.fun-style bonding curve with three modes (PUMP,
   CLANKER, CLANKER_V3) and a Twitter-handle escrow for fee
   attribution to the original creator's Twitter @handle.

Cross-chain bridge surface (CCTP V2 — Avalanche Fuji + Arbitrum Sepolia
+ Base Sepolia + Optimism Sepolia + Sepolia → Arc) is implemented at
the **frontend only**; the on-chain primitives are Circle's canonical
TokenMessenger contracts.

## Scope

**In scope** for an audit:

- All Solidity in `contracts/src/`
  - `launchpad/ArcadeLaunchpad.sol`
  - `launchpad/ArcadeTwitterEscrowV3.sol`
  - `launchpad/ArcadeLaunchToken.sol`
  - `launchpad/TokenVault.sol`
  - `v2/ArcadeV2Factory.sol`, `ArcadeV2Pair.sol`, `ArcadeV2Router.sol`
  - `swap/ArcadeMultiSwap.sol`
- All Solidity in `contracts/v3src/` (0.7.6 profile)
  - `ArcadeV3SwapRouter.sol` (anti-sniper hook lives here)
  - `ArcadeV3Locker.sol`
  - `ArcadeV3Zap.sol`
  - `ArcadeV3PositionManager.sol`, `ArcadeV3PositionDescriptor.sol`,
    `ArcadeV3Quoter.sol`
- All `app/api/**/route.ts` in `web/`
  - `twitter-login` + `twitter-callback` (OAuth + EIP-712 sign)
  - `claim/payload` (one-shot cookie + HMAC)
  - `ens/forward` + `ens/reverse` (mainnet ENS reads)
  - `og` + `og/brand` (Open Graph image generator)
  - `pin/file` + `pin/json` (Pinata pinning)
  - `stats/snapshot` (RPC scan stats)
  - `telemetry` (Sentry sink)
- The backend signer key custody story (currently Vercel env var,
  migration to AWS KMS in progress — see `RUNBOOK_INCIDENT.md`).
- Permit2 + Universal Router integration in `web/lib/permit2.ts` +
  `web/lib/routing/universalRouter.ts`.

**Out of scope**:

- Vendored Uniswap v2-core and v3-core / v3-periphery (in `contracts/lib/`).
- Vendored OpenZeppelin (`contracts/lib/openzeppelin-contracts/` and
  `lib/oz-v3/`).
- The V4 prototype (`contracts/v4src/`) and `app/launchpad/v4*` pages —
  shipping in a follow-on after the V4 sunset/relaunch (see
  `docs/V4_SUNSET_PLAN.md`).
- Third-party DEX integrations (Synthra / UnitFlow / XyloNet) — we
  consume them via Universal Router as untrusted.

## Architecture summary

```
   ┌───────────────────────┐         ┌───────────────────────┐
   │  Next.js 14 frontend  │────────▶│  Arc testnet (5042002)│
   │  wagmi + RainbowKit   │  RPC    │  USDC = gas token     │
   └─────────┬─────────────┘         └───────────┬───────────┘
             │ OAuth                              │
             ▼                                    ▼
   ┌───────────────────────┐         ┌───────────────────────┐
   │  /api/twitter-callback│ signs   │  ArcadeLaunchpad      │
   │  EIP-712 Claim        │ ──────▶ │  + ArcadeTwitterEscrow│
   │  ARCADE_BACKEND_PRIV  │         │  + V3Locker           │
   └───────────────────────┘         └───────────────────────┘
                                                 │
                                                 ▼
                                       ┌───────────────────┐
                                       │  Uniswap V3 fork  │
                                       │  (solc 0.7.6)     │
                                       └───────────────────┘
```

Full architecture diagram + module-by-module breakdown lives in
`docs/architecture.md`. Read that AFTER this doc.

## Trust boundaries

| Boundary | Authority | Notes |
|----------|-----------|-------|
| Deployer (creates launchpad) | EOA `0x3a0D...324A` | Single-shot `setV3Infra`; becomes inert after. |
| Treasury | EOA `0x3a0D...324A` | Migration to Gnosis Safe 3-of-5 BEFORE mainnet. |
| Owner of escrow | EOA same as Treasury | Powers: pause, setTrustedSigner (timelocked 24 h), rotate locker fields, forfeit stale claims, rescue free balance, pullFromLocker. Cannot touch credited user balances. |
| Trusted signer | EOA `0xa314...82Eda` (Vercel-held key) | Signs EIP-712 Claim payloads. Compromise lets attacker forge claims; bounded by 24 h L-3 timelock + owner veto. Migration to AWS KMS in progress. |
| User (token creator / claimant / trader) | self | No custodial dependencies. |
| Anti-sniper window | smart contract | First N seconds after launch carry a decaying skim on buys + sells. Skim accrues to treasury. |

## Critical invariants

Maintain a written list in `contracts/SECURITY.md`. Highlights:

- `creditedTotal[token]` ≤ `IERC20(token).balanceOf(escrow)` at all
  times. `rescue` and `forfeitStaleClaim` MUST debit
  `creditedTotal` BEFORE the transfer.
- `(recipient == twitterEscrow) ⇔ (admin == twitterEscrow)` on every
  locker slot at all times (audit L-4). The atomic `rotateSlot`
  (gen 9) enforces this only on the FINAL state to permit the
  legitimate (esc,esc)→(user,user) transition that `claimByTwitter`
  drives.
- `tokens[token].migrated` is set EXACTLY ONCE, and only via
  `_migrate`. Once set, V2 pool has irrevocably been seeded and the
  LP burned.
- Bonding curve: `realUsdcReserve` increases monotonically on buys
  and decreases monotonically on sells; never below zero (MATH-001 /
  MATH-002 fix).
- Sniper skim is `0` outside the configured window and
  `currentSnipeBps(token)` is the canonical read.

## Known issues / accepted risks (DO NOT re-report)

Up-to-date list in `AUDIT_PROGRESS.md` § "Skipped — Recovery plan
documented". Highlights:

1. **L-5** `swapMigratedRoute` USDT-clean approval — accepted because
   USDC is the only allowed input on the route. Mainnet-deferred.
2. **L-7** Treasury setter — `treasury` is immutable. Rotation requires
   a redeploy. Accepted; covered by Gnosis Safe migration plan.
3. **V3-5 / V3-7** Quoter math approximations — quote-side only, no
   security impact. Quoter v2 rewrite planned.
4. **V3-8** ERC721Permit domain pins canonical Uniswap name — required
   for cross-tooling compat. Documented in code.
5. **A-1 partial SwapCard refactor** — quality not security. 2-3 days
   to finish; deferred to post-mainnet.
6. **E-02 Creator pre-buy self-tax loophole** — arming snipe before the
   creator buy breaks the 25 % slippage check on launches with
   `snipeStartBps > 25 %`. Deferred to gen 10 redesign (audit v2 ack).

## Audit prep checklist (give the auditor)

- [ ] This file (`docs/AUDITOR_ONBOARDING.md`)
- [ ] `docs/architecture.md`
- [ ] `contracts/SECURITY.md` (threat model + invariant list)
- [ ] `AUDIT_2026-06-10.md` (prior 8-agent internal pass)
- [ ] `AUDIT_PROGRESS.md` (shipped + accepted)
- [ ] `.research/AUDIT_2026-06-11_V2_INDEX.md` (latest 13-agent v2 pass)
- [ ] All per-topic `.research/audit-2026-06-11-v2-*.md`
- [ ] `contracts/DEPLOY_GEN9.md` (deploy runbook with smoke tests)
- [ ] `docs/RUNBOOK_INCIDENT.md` (incident response playbook)
- [ ] `docs/V4_SUNSET_PLAN.md` (V4 prototype status)
- [ ] Read-only `git tag pre-audit-pashov-2026-06-XX` so the audit is
      pinned to a commit hash the deliverable can reference.

## Audit budget guidance

Based on prior internal passes:

- **Solidity-only scope** (no frontend): ~120 contract LoC × `find`
  multiplier. Pashov-tier audits at this size run 2-4 weeks for $30-80 k.
- **Frontend + backend signer review**: add 1 week. Anything that
  touches the EIP-712 signer key path needs auditor scrutiny.
- **Cross-chain bridge UI review**: optional; CCTP V2 backend is
  Circle's. We're a relayer-free UI on top.

## Quick smoke test for an auditor

If the auditor wants to verify the local environment matches prod:

```bash
cd contracts
forge build --sizes 2>&1 | grep ArcadeLaunchpad
# expect: 24,482 / 24,576 (under EIP-170)

forge test --no-match-path "*v4*"
# expect: 120 / 120 pass

cd ../web
npm ci
npm test
# expect: 23 / 23 vitest pass
npx tsc --noEmit
# expect: clean
NEXT_PUBLIC_DEFAULT_CHAIN=arc NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000 NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=00000000000000000000000000000000 npm run build
# expect: 33 / 33 pages build
```

## Contact + escalation

- Primary: operator's GitHub handle (see commit history).
- Owner / Treasury custodian: same.
- For pre-mainnet auditor coordination, file a public GitHub issue
  tagged `auditor-question` or reach via the email in the GitHub
  profile.
