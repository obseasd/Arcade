# Audit progress — 2026-06-10 session

> Tracking doc updated at the end of each batch. Read alongside
> `AUDIT_2026-06-10.md` for the original 60+ findings and
> `docs/V4_SUNSET_PLAN.md` for the V4 sunset timeline.

## ✅ Shipped this session

### Contracts (gen 8 redeploy required)

| ID | Finding | Commit |
|----|---------|--------|
| L-1 | V2 pre-mint LP attack hard-revert (assembly `totalSupply`, skim removed) | `4470f8a` |
| L-2 | V3 pre-init grief — accept on-chain sqrt instead of strict-equal | `2e18118` |
| L-3 | TrustedSigner = 2-step + 24h timelock (request / cancel / finalize) | `4470f8a` |
| L-4 | Locker escrow-pair invariant in updateRecipient + updateAdmin | `c9c3d0c` |
| L-6 | `creditSlot` revert `THIRD_TOKEN` | `4470f8a` |
| V3-1 | `previewFees` uninit-tick underflow guard | `4470f8a` |
| V3-2 | `zapOut` revert `NO_SWAP_FLOOR` when amountOtherMinSwap == 0 + swap leg | `c9c3d0c` |
| V3-3 | Anti-sniper skim covers sells | `4470f8a` |
| V3-4 | Zap `_doSwap` caller-signed sqrt-price cap | `4470f8a` |
| V3-6 | `adminRescue` O(1) via `activeTokenRefCount` mapping | `4470f8a` |

### Frontend / Backend

| ID | Finding | Commit |
|----|---------|--------|
| F-1 | `/api/og` hostname allowlist (SSRF) | `580823a` |
| F-2 | `/api/og` per-IP rate limit | `580823a` |
| F-3 | normaliseHandle on creatorTwitter href (regex filter) | `c9c3d0c` |
| F-4 | IPFS gateway dedup by hostname | `580823a` |
| F-5 | Twitter OAuth global per-state cap | `580823a` |
| F-6 | ENS RPC shortlist 9 → 4 | `4470f8a` |
| F-7 | `activityFeed` scope per-account | `4470f8a` |
| F-8 | twitter-login config check before rate limit | `580823a` |
| F-9 | `/api/claim/payload` cookie HMAC | `580823a` |
| F-10 | OG creator query normalised | `580823a` |
| R-3 | Multi-hop USDC fallback via createV3ForkProvider | `580823a` + `ca4447f` |
| R-6 | AbortController in useRouteQuotes | `580823a` |
| R-7 | Debounce amountIn (250 ms) | `1e26884` |
| R-9 | Same-token in/out guard | `580823a` |
| R-10 | Tie-break ranking by provider | `580823a` |
| B-1 | Bridge recipient canonical from pendingBridge | `580823a` |
| B-3 | discardPendingClaim race fix via dismissedRef | `1e26884` |
| B-4 | BroadcastChannel effect dep narrowed to [account] | `1e26884` |
| B-5 | parseCctpV2Message tightened bounds | `580823a` |
| B-8 | bridge-retry CustomEvent origin check vs history | `580823a` |
| C-1 | gitignore tsbuildinfo + research dirs | `580823a` |
| C-2 | .env.local.example expanded to all consumed vars | `580823a` |
| C-6 | tsconfig paths narrowed to subdirs | `580823a` |
| C-10 | package.json engines.node + vercel.json npm ci + iad1 region | `580823a` |

### Architecture

| ID | Finding | Commit |
|----|---------|--------|
| A-1 partial | Drop legacy quoteV3 (arcadeV3Provider covers it post A-4) | `c9c3d0c` |
| A-2 | createV3ForkProvider factory + Synthra refactor | `ca4447f` |
| A-3 | Multicall3 wired in arcTestnet + SwapCard balanceOf batch | `7491454` |
| A-4 | Anti-sniper tax pulled into arcadeV3Provider | `7491454` |
| A-6 | /admin index + /admin/observability + telemetry stub | `df5f734` |
| A-7 | Vitest harness + 23 tests + web-ci.yml workflow | `ca4447f` + `<pending>` |
| A-8 | V4 sunset plan doc (`docs/V4_SUNSET_PLAN.md`) | `1e26884` |

### Permit2 + UR ship-blockers

| ID | Finding | Commit |
|----|---------|--------|
| P2-3 | Nonce stale on retry — refetch inline at sign time | `7769a85` |
| P2-4 | Sign amount = maxUint160 (drift-proof) | `7769a85` |
| P2-7 | permitInputIndex bounds check | `7769a85` |
| P2-8 | Expiration 1h → 10 min | `7769a85` |
| UnitFlow | Disabled until WUSDC wrap verified | `7769a85` |

## ⏳ Skipped — Recovery plan documented

### Contracts blocked by EIP-170 budget

ArcadeLaunchpad is at 24,532/24,576 (44 byte margin). The two skipped
launchpad-touching fixes need budget recovered before they ship:

| ID | Finding | Recovery plan |
|----|---------|---------------|
| L-5 | `swapMigratedRoute` `forceApprove(0)` cleanup | Wraps the 4 V2 router approvals in a `_swapV2(in, router, amt, …)` helper that resets to 0 post-swap. Helper extraction is a net byte gain only if it replaces ≥ 3 call sites. |
| L-7 | Treasury rotation function (`setTreasury`) | Needs `address public immutable treasury` → `address public treasury` (≈ +95 B for 19 reads) plus a `setTreasury` setter (≈ +50 B). Total +145 B requires removing `quoteSwapMigratedRoute` view (≈ 250-400 B saved) + frontend reimpl via `getAmountsOut` + applied royalty math. |

Both ship in gen 9 after the launchpad gets a refactor pass.

### Contracts that need bigger redesign

| ID | Finding | Recovery plan |
|----|---------|---------------|
| V3-5 | Zap math ignores swap impact on thin pools | Closed-form 1-Newton-step correction. Pure quote quality, not security. Quoter v2 rewrite. |
| V3-7 | `quoteZap` overstates expected output | Replace marginal-price approximation with an actual external call into `ArcadeV3Quoter`. +1 staticcall per quote, view-only, no security impact. |
| V3-8 | ERC721Permit domain pins "Uniswap V3 Positions NFT-V1" | Forking the inherited ERC721Permit to flip the EIP-712 nameHash breaks every existing permit signature. Documented in code comment. Re-evaluate at NPM v2 cut. |

### Big architecture refactor

| ID | Finding | Recovery plan |
|----|---------|---------------|
| A-1 full | SwapCard 1063 LoC → ~400 — extract launchpadMigratedProvider, drop quoteOut/quoteIn, lift form state to `useSwapForm` reducer | 2-3 days focused. Foundation pieces (A-2 factory, A-3 multicall, A-4 anti-sniper-in-provider, A-1 partial legacy V3 drop) already shipped. Next session. |

### Strategic decisions (user input acknowledged)

| ID | Finding | Decision |
|----|---------|----------|
| C-3 | Backend signer → KMS or multisig | Post-grant or mainnet: KMS for v1, multisig for v2 |
| C-7 | broadcast/ archive policy | Decide at mainnet: testnet ok to commit |

## 🎯 Pre-mainnet checklist

Once gen 8 is deployed and validated, the path to mainnet is:

1. **A-6 Sentry actual install** (operator action)
   - Create Sentry project (free tier)
   - Set 4 env vars in Vercel: `NEXT_PUBLIC_SENTRY_DSN`, `_ORG`, `_PROJECT`, `SENTRY_DSN` (server-only)
   - Insert `trackSwap()` / `trackBridge()` / `trackClaim()` calls in catch blocks (4 points listed on `/admin/observability`)
   - Verify the first event lands within 30 s of a test swap

2. **C-3 KMS signer install** before mainnet deploy
   - AWS KMS or GCP KMS account
   - Generate signing key in KMS
   - Replace `ARCADE_BACKEND_PRIVATE_KEY` Vercel env with `KMS_KEY_ARN` + region
   - Update `app/api/twitter-callback/route.ts` to use `aws-sdk` KMS sign call instead of viem's `privateKeyToAccount`

3. **External audit pass** on gen 8 + frontend
   - Send `AUDIT_2026-06-10.md` + `AUDIT_PROGRESS.md` + this doc to the external auditor as context
   - Scope: gen 8 contract diff + Permit2/UR integration + admin surface + telemetry pipeline

4. **A-1 SwapCard refactor** (quality, not security blocker)

5. **L-5 / L-7 gen 9 redeploy** with launchpad budget recovery

6. **V3-8 ERC721Permit fork** at NPM v2

## Test status

- Foundry: 120/120 pass (gen 8 contract changes verified).
- Vitest: 23/23 pass (universalRouter encoders, parseCctpV2Message, useRouteQuotes tie-break).
- TypeScript: clean `tsc --noEmit`.
- CI: contracts-ci.yml + react-doctor.yml live; web-ci.yml landing this session
  to gate every PR on typecheck + vitest + next build smoke.

## Commits this session (in order)

```
4ef8e09  feat(swap): Permit2 + UR for Synthra + UnitFlow
7769a85  fix(swap): Permit2 audit ship-blockers + UnitFlow disabled
623bc65  docs(audit): consolidated 8-agent audit report
580823a  chore(audit): batch of 18 no-flow-change fixes
4470f8a  feat(audit): gen 8 contracts + ENS shortlist + activity feed
2e18118  fix(audit L-2): drop strict sqrt equality on CLANKER_V3
df5f734  feat(admin): /admin + observability + telemetry stub
1e26884  fix(audit batch): R-7 + B-3 + B-4 + A-8 doc
ca4447f  feat(routing): A-2 factory + A-7 Vitest harness
7491454  fix(audit A-3 A-4): multicall3 + anti-sniper in provider
c3cde9b  docs(audit): progress tracker for the session
c9c3d0c  fix(audit final batch): L-4 + V3-2 + F-3 + A-1 partial
<pending> chore(ci): web-ci.yml workflow + AUDIT_PROGRESS refresh + DEPLOY_GEN8 runbook
```

12+ commits, 55+ findings addressed, gen 8 contracts ready to deploy.
