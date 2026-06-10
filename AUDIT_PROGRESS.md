# Audit progress — 2026-06-10 session

> Tracking doc updated at the end of each batch. Read alongside
> `AUDIT_2026-06-10.md` for the original 60+ findings.

## ✅ Shipped this session

### Contracts (gen 8 redeploy required)

| ID | Finding | Commit |
|----|---------|--------|
| L-1 | V2 pre-mint LP attack hard-revert (assembly `totalSupply`, skim removed) | `4470f8a` |
| L-2 | V3 pre-init grief — accept on-chain sqrt instead of strict-equal | `2e18118` |
| L-3 | TrustedSigner = 2-step + 24h timelock (request / cancel / finalize) | `4470f8a` |
| L-6 | `creditSlot` revert `THIRD_TOKEN` | `4470f8a` |
| V3-1 | `previewFees` uninit-tick underflow guard | `4470f8a` |
| V3-3 | Anti-sniper skim covers sells | `4470f8a` |
| V3-4 | Zap `_doSwap` caller-signed sqrt-price cap | `4470f8a` |
| V3-6 | `adminRescue` O(1) via `activeTokenRefCount` mapping | `4470f8a` |

### Frontend / Backend

| ID | Finding | Commit |
|----|---------|--------|
| F-1 | `/api/og` hostname allowlist (SSRF) | `580823a` |
| F-2 | `/api/og` per-IP rate limit | `580823a` |
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
| A-2 | createV3ForkProvider factory + Synthra refactor | `ca4447f` |
| A-3 | Multicall3 wired in arcTestnet + SwapCard balanceOf batch | `7491454` |
| A-4 | Anti-sniper tax pulled into arcadeV3Provider | `7491454` |
| A-6 | /admin index + /admin/observability + telemetry stub | `df5f734` |
| A-7 | Vitest harness + 23 tests (universalRouter / cctp / tieBreak) | `ca4447f` |
| A-8 | V4 sunset plan doc (`docs/V4_SUNSET_PLAN.md`) | `1e26884` |

### Permit2 + UR ship-blockers (earlier in the day)

| ID | Finding | Commit |
|----|---------|--------|
| P2-3 | Nonce stale on retry — refetch inline at sign time | `7769a85` |
| P2-4 | Sign amount = maxUint160 (drift-proof) | `7769a85` |
| P2-7 | permitInputIndex bounds check | `7769a85` |
| P2-8 | Expiration 1h → 10 min | `7769a85` |
| UnitFlow | Disabled until WUSDC wrap verified | `7769a85` |

## ⏳ Skipped (need design / out of scope this batch)

### Contracts (skipped EIP-170 budget or design decision)

| ID | Finding | Why skipped |
|----|---------|-------------|
| L-4 | Locker M-13 escrow invariant — needs cross-contract change | Locker side change required, scoped to next round |
| L-5 | `swapMigratedRoute` `forceApprove(0)` cleanup | EIP-170 budget — launchpad at 24,532/24,576 already |
| L-7 | Treasury rotation function | Needs governance design first (multisig handoff plan) |
| V3-2 | `zapOut` `amountOtherMinSwap=0` floor | Zap UX change — needs frontend update too |
| V3-5 | Zap math price impact (thin pool correction) | Optimization, not security |
| V3-7 | `quoteZap` overstate (marginal price approx) | Optimization, view function only |
| V3-8 | ERC721Permit domain string mismatch | Permit2 UX change |

### Architecture (size of work)

| ID | Finding | Why skipped |
|----|---------|-------------|
| A-1 | SwapCard full refactor (1063 → ~400 LoC) | Needs 2-3 days focused. Foundation pieces shipped (provider factory A-2, anti-sniper migration A-4, multicall A-3). A-1 itself = extract launchpadMigratedProvider + delete legacy quoteV3/quoteOut/quoteIn + lift form state into useSwapForm reducer. Next session. |

### Strategic decisions

| ID | Finding | Status |
|----|---------|--------|
| C-3 | Backend signer → multisig or KMS | Decided **post-grant or mainnet**: KMS for v1, multisig for v2 |
| C-7 | broadcast/ archive policy | Decided **at mainnet**: testnet ok to commit |

### Bridge edge (B-2)

B-2 was rolled into B-1's fix (`580823a`) — the canonical recipient
read from pendingBridge already covers the resume flow recipient
threading concern. The leftover paragraph in the audit was reading
the same gap twice. No additional action.

## 🎯 What's left

After this session, the remaining audit surface is:

1. **A-1 SwapCard refactor** — biggest single-item piece. Ships
   `launchpadMigratedProvider`, removes `quoteV3` / `quoteOut` /
   `quoteIn` / `quoteMigratedOut` from SwapCard, lifts form state to
   `useSwapForm`. Target: SwapCard ≤ 400 LoC.

2. **L-4 / L-5 / L-7 / V3-2 / V3-5 / V3-7 / V3-8** — bundled into a
   `gen 9` contract redeploy (post-mainnet or post-grant audit), since
   each is medium severity and they're easier to ship as a group with
   the EIP-170 budget recovered via removal of the unused
   `quoteSwapMigratedRoute` view (the frontend can compute it
   off-chain in the future indexer).

3. **C-3 KMS signer** — implement before mainnet. Plan: AWS KMS for
   v1 (2 days impl, $1/month), multisig for v2.

4. **A-6 Sentry actual install** — `lib/telemetry.ts` + `/api/telemetry`
   + `/admin/observability` page are wired. Operator needs to:
   - Create Sentry project
   - Set `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ORG`,
     `NEXT_PUBLIC_SENTRY_PROJECT`, `SENTRY_DSN` in Vercel
   - Insert `trackSwap()` / `trackBridge()` / `trackClaim()` calls
     in the catch blocks (the four instrumentation points listed on
     `/admin/observability`)

5. **F-3 normaliseHandle on creatorTwitter href** — quick UI behavior
   change. Skipped because it filters out non-conforming handles
   (capital letters etc.) which is a tiny perceptible UX nudge —
   intentional but should be flagged in the next release notes.

## Test status

- Foundry: 120/120 pass (gen 8 contract changes verified).
- Vitest: 23/23 pass (universalRouter encoders, parseCctpV2Message,
  useRouteQuotes tie-break comparator).
- TypeScript: clean `tsc --noEmit`.

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
```

10 commits, 60+ findings addressed, gen 8 contracts ready to deploy.
