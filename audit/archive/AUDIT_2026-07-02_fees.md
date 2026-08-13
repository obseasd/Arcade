# Arcade Fee-System Audit (2026-07-02)

Multi-agent audit of the entire fee surface: launchpad splits, migration
royalty, V3 locker, DEX/protocol fees, referral (attribution + payout), and
off-chain fee accounting. 6 parallel finders, each finding adversarially
verified by 3 skeptics (survives only on >=2/3 confirmation).

Raw findings: 16. Confirmed: 7 (1 HIGH, 1 MEDIUM, 5 LOW). Refuted: 9 (see the
referral cluster note below: several are refuted only because Phase 2 payout is
DISABLED, and become live the moment it is enabled).

Workflow: wf_b4c94585-09f. 54 agents, ~1.76M tokens.

---

## HIGH-1: MultiSwap bypasses the perpetual migration royalty on every USDC-side migrated trade

- File: `contracts/src/swap/ArcadeMultiSwap.sol:293` (`_routeOne`)
- Verified: 3/3 skeptics HIGH, and re-confirmed manually against source.

In `_routeOne` the direct-V2 branch (step 2, line 293) is evaluated BEFORE the
migrated-royalty branch (step 3, line 300):

```solidity
// 2) Direct V2 path
bool oneSideUsdc = tokenIn == address(USDC) || tokenOut == address(USDC);
if (oneSideUsdc || v2Factory.getPair(tokenIn, tokenOut) != address(0)) {
    return _swapV2(tokenIn, tokenOut, amountIn, /*viaUsdc=*/ false, ...); // NO royalty
}
// 3) migrated-royalty branch (swapMigratedRoute) -- unreachable for token<->USDC
```

A curve-migrated launchpad token trades on a real USDC V2 pair (`_migrate`
seeds `getPair(USDC, token)`), so `_isV3LaunchToken` is false and, for the
common buy (USDC->token) / sell (token->USDC) direction, `oneSideUsdc` is true.
The leg executes as a plain V2 swap and the launchpad's post-migration royalty
(`MIGRATED_ROYALTY_BPS = 0.30%` = 0.20% platform + 0.10% creator, charged only
inside `buyMigrated` / `sellMigrated` / `swapMigratedRoute`) is never taken.

`swapToSingle` is `external nonReentrant` with no access control, so anyone can
trade migrated tokens royalty-free, and the frontend/agent aggregator routes
through MultiSwap by design. This permanently diverts the launchpad's
advertised perpetual creator + platform royalty on all USDC-side migrated
volume routed through MultiSwap. It redirects a protocol/creator fee (does not
steal user principal), which caps it below CRITICAL.

Fix: check migration status BEFORE the direct-V2 branch. When
`launchpad.isMigrated(tokenIn) || isMigrated(tokenOut)` is true and the token
is V2-migrated (has a USDC pair), route the leg through the launchpad's migrated
functions so the royalty is charged, including the single-hop token<->USDC case
(`buyMigrated` for USDC->token, `sellMigrated` for token->USDC, `swapMigratedRoute`
for token->token). Only fall through to plain `_swapV2` for genuinely
non-migrated pairs. Requires a MultiSwap redeploy.

---

## MEDIUM-1: reconcile/backfill events count $0 toward "Total claimed" USD forever

- File: `web/app/api/compounder/reconcile/route.ts:403` (also backfill-tx route)
- Verified: 2/3 (one MEDIUM, one LOW).

`reconcileCompounded` / `reconcileFeesPushed` and the backfill-tx route call
`insertEvent` WITHOUT `usdValueMicros`, which defaults to `'0'`. The user-facing
"Total claimed" USD headline is `SUM(usd_value_micros)`. When the reconcile row
lands FIRST (the exact crash-before-insertEvent case the reconciler exists to
heal), the row has real nonzero `amount0/amount1` but `usd_value_micros = 0`. A
later cron `insertEvent` for the same `(tx_hash, token_id)` hits the heal
predicate `ON CONFLICT ... WHERE amount0 = 0 AND amount1 = 0`, which is now false
(amounts are nonzero), so the correct USD is never written. Raw token amounts
display correctly; the USD headline silently and permanently undercounts.

Fix: compute + pass `usdValueMicros` in reconcile/backfill (they have the client,
token addresses, and fee amounts), OR extend the heal predicate to also refresh
`usd_value_micros` when the existing row has `usd_value_micros = 0`.

---

## LOW findings (off-chain / display, no redeploy)

- **LOW-1 `web/app/api/admin/fees/route.ts:84`** - any inbound transfer of
  exactly $3.000000 USDC is classified as a "Launchpad token creation fee" by
  amount alone (no `from` check), so trade proceeds / manual sends to the
  treasury EOA inflate the admin fee headline. Fix: match the creation fee to a
  same-tx `TokenCreated` event, not the bare amount.
- **LOW-2 `web/lib/hooks/useCreatorEarnings.ts:153`** - `pendingUsd` divides the
  paired-side fee by USDC decimals (1e6) unconditionally; for a WETH-paired pool
  the paired amount is 18-dec wei, overstating pending USD by ~1e12 (a few $ of
  fees shows as ~$1B). `CreatorFeesPanel` already resolves real decimals, so the
  two surfaces disagree. Fix: resolve paired-token decimals + price, or
  contribute 0 for non-USDC like the historical path does.
- **LOW-3 `web/app/api/compounder/cron/route.ts:657`** - COMPOUND-mode earnings
  are recorded at GROSS fees (pre protocol-fee skim) while FeesPushed records
  NET, so the two modes report on inconsistent bases and the compound USD
  headline overstates by up to the 5% protocol cut. Cron also omits
  `protocolFee0/1` for compound rows (reconcile writes them). Fix: record net
  (fee - protocolFee) for compound and pass the protocol-fee columns.
- **LOW-4 `web/app/admin/fees/page.tsx:301`** - `formatTwo` truncates (not
  rounds) to 2 decimals (`(frac + '00').slice(0,2)`), so 12.999999 renders
  $12.99. Display-only; underlying micros are exact. Fix: round to 2 dp.
- **LOW-5 `contracts/v3src/ArcadeV3Locker.sol:342`** - when `recipient[0]` is the
  Twitter escrow the launch-token mint dust sweep is skipped, and the comment
  claims it is recoverable later via `adminRescue`. It is not: `adminRescue`
  requires `activeTokenRefCount[token] == 0`, but that refcount is incremented on
  lock and NEVER decremented, so the dust is permanently locked. Dust-scale
  launch-token wei only. Fix: correct the comment, or route the skipped dust to a
  recoverable sink.

---

## Referral cluster (refuted-but-latent -- PRE-ENABLE BLOCKERS for Phase 2)

The following referral findings were REFUTED by the adversarial verifiers, but
the refutation rests on the fact that Phase 2 payout is currently DISABLED and
Phase 1 attribution is display-only (inflating a credit pays nobody yet). They
are NOT fixed; they become live money-losing bugs the moment payout is enabled.
Treat this whole list as the gate for turning Phase 2 on.

- `web/app/api/referral/claim/route.ts:50` - claim pays BEFORE recording, with no
  idempotency/lock -> concurrent + retry double-payout.
- `web/app/api/referral/claim/route.ts:51` - transfer-then-record: a successful
  USDC transfer with a failed `recordClaim` leaves the amount unrecorded and
  infinitely re-claimable.
- `web/app/api/referral/claim/route.ts:29` - no caller auth on the payout
  endpoint (missing EIP-712 / signer gate).
- `web/db/migrations/007_referral_claims.sql:5` - `referral_claims` has no
  UNIQUE/idempotency constraint, so the `ON CONFLICT` dedup used elsewhere cannot
  protect payouts.
- `web/lib/referralPayout.ts:40` - `getVerifiedEarningsUsdMicros` is a stub; a
  0/stale return is a payout-correctness single point of failure with no
  cross-check.
- `web/app/api/referral/track/route.ts:30` - unauthenticated `track` lets anyone
  inflate any wallet's accrued 10% credit; honest reports replay (no tx-hash
  dedup).
- `web/app/api/referral/register/route.ts:22` - unauthenticated `register`
  allows first-touch land-grab attribution of any wallet.
- `web/app/api/referral/track/route.ts:56` - referral volume is derived from
  client-supplied USD and includes full MultiSwap/launchpad legs, over-crediting
  the 10% share vs fees actually collected.

Also refuted (correctly, on the merits): the launchpad-splits finding claiming
`creator2` is honored in PUMP mode contradicts the NatSpec -- verifiers found the
code path does not actually mis-split, 0/3.

---

## Recommended actions

1. **HIGH-1** - fix `_routeOne` migration ordering + redeploy MultiSwap. This is
   the one on-chain revenue-correctness bug. Batch with the next redeploy.
2. **MEDIUM-1 + LOW-1..4** - off-chain accounting/display fixes, no redeploy;
   ship with the next frontend deploy.
3. **LOW-5** - one-line comment correction in the locker.
4. **Referral cluster** - do NOT enable Phase 2 payout until every item above is
   closed (auth on claim, DB UNIQUE constraint, record-before-pay + idempotency,
   server-side volume from real collected fees, the two indexer stubs filled).
