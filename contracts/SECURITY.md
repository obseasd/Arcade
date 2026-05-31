# Arcade Protocol — Internal Security Audit

**Status**: Internal review, NOT a substitute for external audit
**Reviewer**: Claude Opus 4.7 multi-agent audit, six parallel reviewers
**Date**: 2026-05-31
**Commit at review time**: `2a89973`
**Scope**: V2/V3 launchpad stack, V3 locker, Twitter escrow, V4 MultiSwap routing
**Out of scope**: V2 DEX core (`src/dex/*`), V4 PoolManager/router/hooks (planned for separate review)

---

## Executive Summary

| Severity | Count | Action required |
|---|---|---|
| HIGH | **8** | Fix before mainnet, several before re-enabling V4_ENABLED |
| MEDIUM | **14** | Fix in next contract pass |
| LOW | **17** | Address opportunistically |
| INFO | **23** | Document or accept |
| **Total** | **62** | |

**Headline risks**

1. **Twitter escrow has architecturally fragile slot accounting** (4 HIGH). The `claimed[positionId][slotIndex]` flag is permanent and one-shot, creating three independent stranding paths: zero-amount claims, fees credited during the authorize → claim timelock window, and post-claim fees routed by the locker. None are exploitable for profit, but all permanently lock user funds.

2. **The documented migration economic model does not match the code** (1 HIGH). The team communicates "200M tokens + 17,500 USDC LP seed after a 2,500 USDC platform fee", but `_migrate` transfers the full ~20,000 USDC. Either docs are stale or the fee is missing. Mainnet block.

3. **The V4 MultiSwap path trusts the launchpad-returned PoolKey hooks address without verification** (2 HIGH). Today the launchpad pins it to `ArcadeAntiSniperHook`; any future launchpad upgrade letting creators choose hooks would let arbitrary code run with `BEFORE_SWAP_RETURNS_DELTA` permission. Per-leg `minAmountOut=0` makes single-input draining undetectable.

4. **`renounceOwnership` is not overridden** (1 HIGH-tier risk). Combined with a hot owner wallet, accidental or forced renounce permanently disables veto, pause, and trustedSigner rotation — the only defenses against a compromised backend signing key.

5. **No path to recover `pendingWithdrawals[token][escrow]`** (1 HIGH). The locker credits the escrow's address in its pull-payment ledger when a direct transfer fails, but the escrow contract has no function to call `locker.withdrawPending`. Tokens are permanently stuck if the direct transfer ever fails.

---

## Methodology

Six parallel reviewer agents covered:

| Dimension | Surface |
|---|---|
| 1. Reentrancy + external call ordering | 7 contracts, 3379 LOC |
| 2. Access control + ownership | 5 contracts, 2767 LOC |
| 3. Curve math + accounting invariants | Launchpad + V3PriceMath, 1129+ LOC |
| 4. EIP-712 + signature replay | Escrow V3 + backend `route.ts` cross-check |
| 5+6. Cross-contract trust + pull payments | Locker ↔ Escrow ↔ Launchpad ↔ Vault integration |
| 7. V4 MultiSwap routing extension | ArcadeMultiSwap V4 paths, hook trust |

No static analysis tools available on the review machine (slither/aderyn not installed). All findings are from manual review.

---

## HIGH severity (8)

### H-01 — `claimTimelock` defaults to 0, eliminating the F-1/F-8 veto window until manual setter call
**File**: `contracts/src/launchpad/ArcadeTwitterEscrowV3.sol:91, 273, 383-387`

`claimTimelock` is uint64 storage defaulting to 0. The constructor does not set a floor. The veto window is the contract's documented primary defense against a compromised trustedSigner — with timelock=0, `authorize()` and `claimByTwitter()` can be batched in the same block.

**Fix**: Initialize in the constructor (e.g., `claimTimelock = 1 hours;`) AND add a `MIN_TIMELOCK` constant rejecting `setClaimTimelock(< MIN_TIMELOCK)`. Add a deployment-script assertion that `escrow.claimTimelock() > 0` post-deploy.

### H-02 — `trustedSigner` blast radius is the entire credited balance (no per-handle binding on chain)
**File**: `contracts/src/launchpad/ArcadeTwitterEscrowV3.sol:86, 241-291`

The EIP-712 type hash binds `recipient` but NOT a Twitter handle. A compromised Vercel backend key can sign claims with attacker-controlled recipients for ANY credited (positionId, slot). The F-3 per-slot accounting prevents over-attestation, not wrong-recipient attestation.

**Fix**: (1) Set claimTimelock ≥ a few hours operationally; (2) consider 2-of-N signing scheme before mainnet; (3) document the runbook `pause → veto pending → setTrustedSigner`; (4) consider a per-block outflow cap as circuit breaker.

### H-03 — Post-claim fee residue permanently stranded (claimed flag is one-shot)
**File**: `contracts/src/launchpad/ArcadeTwitterEscrowV3.sol:107, 218-228, 255`

`claimed[positionId][slotIndex]` is permanently true after claim. `creditSlot` has NO claimed-guard. If `updateRecipient` rotation in claimByTwitter's try/catch fails, locker keeps routing fees to the escrow → balances accumulate → no future authorize possible → `rescue` blocked by F-4. Tokens bricked.

**Fix**: In `creditSlot`, revert when `claimed[positionId][slotIndex] == true`. Caller (locker) try/catch then routes to its own `pendingWithdrawals` (but see H-07). Alternatively, allow rescue to subtract claimed-slot balances from creditedTotal.

### H-04 — Fees credited between authorize and claim are stranded (claim semantic = snapshot, not sweep)
**File**: `contracts/src/launchpad/ArcadeTwitterEscrowV3.sol:241-291, 301-358`

`authorize` snapshots the backend-signed amount. `claimByTwitter` debits exactly that amount and sets `claimed=true`. `collectFees` on the locker is permissionless and can be spammed during the 7-day timelock window to inflate `balances[slot][token]` above the signed amount. Residue stranded.

**Fix**: In `claimByTwitter`, sweep the FULL `balances[positionId][slotIndex][token]` instead of the snapshotted amount (signed amounts become minimums). OR allow `authorize` to replace a prior pending so backend can re-sign updated amounts before claim.

### H-05 — Documented 2,500 USDC migration fee NOT implemented; LP seeded with 20k not 17.5k
**File**: `contracts/src/launchpad/ArcadeLaunchpad.sol:817-838`

Project memory + comms say "200M tokens + 17,500 USDC after a 2,500 USDC platform fee". No `MIGRATION_FEE` constant exists. `_migrate` transfers the full `s.realUsdcReserve` (~20,000 USDC) to the V2 pair.

**Fix**: Confirm intended economics. If 2,500 fee required, add the constant + skim before mint. Otherwise update all docs (MEMORY, indexer roadmap, marketing) to reflect 20,000 USDC LP seed.

### H-06 — MultiSwap forwards arbitrary `PoolKey.hooks` from `v4Launchpad.getLaunch()` without whitelist
**File**: `contracts/src/swap/ArcadeMultiSwap.sol:303-320, 215-222`

Today `ArcadeV4Launchpad.initializePool` pins `hooks = HOOK` (the immutable AntiSniper hook), so safe under current code. But MultiSwap encodes no expectation. A future launchpad version letting creators choose hooks would let arbitrary code run with `BEFORE_SWAP_RETURNS_DELTA` + `AFTER_SWAP_RETURNS_DELTA` permissions during user swaps.

**Fix**: Add `if (l.poolKey.hooks != EXPECTED_HOOK) revert UnknownHook();` in `_swapV4Single`. OR re-derive PoolKey on the spot from `(token, USDC, POOL_FEE, TICK_SPACING, EXPECTED_HOOK)` ignoring the launchpad-supplied hooks field entirely.

### H-07 — Per-hop V4 `minAmountOut=0` allows single-input draining when aggregate clears `minTotalOut`
**File**: `contracts/src/swap/ArcadeMultiSwap.sol:303-320, 339-341, 348-355`

Every V4 / V2-multihop / V3 leg in `_routeOne` and `_swapV4Path` passes 0 for per-leg minOut. Only the final `if (totalOut < minTotalOut)` protects the user. With N inputs all routed to the same tokenOut, a hostile pool among them can drain ONE input to near-zero output if the others over-deliver enough to clear the aggregate.

**Fix**: Accept `minOut[]` array per input, OR document explicitly that any single hostile pool can extract up to `sum(inputs) - minTotalOut`. Option 1 strongly preferred for an aggregator.

### H-08 — Locker `pendingWithdrawals[token][escrow]` is unrecoverable
**File**: `contracts/v3src/ArcadeV3Locker.sol:523-538`

If locker's inline `token.transfer(escrow)` returns false or reverts, `_payOrCredit` credits `pendingWithdrawals[token][escrow]`. `withdrawPending` requires `msg.sender == to`. The escrow contract has NO function calling `locker.withdrawPending(token)`. Tokens permanently stuck, with no creditSlot record either.

**Fix**: Add an `owner`-only `pullFromLocker(address token)` on the escrow that calls `locker.withdrawPending(token)`. The retrieved tokens land in the escrow's free bucket (no per-slot record), then owner manually credits via a new operator-callable `creditSlotAdmin`.

---

## MEDIUM severity (14)

| ID | File:lines | Title |
|---|---|---|
| M-01 | `ArcadeTokenVault.sol:122-131` | Vault lacks `ReentrancyGuard`. CEI saves it today (only LaunchToken which is plain ERC20), but inconsistent with rest of protocol and unsafe for any future token with transfer hooks. **Fix**: add `ReentrancyGuard` + `nonReentrant` on `claim` + `updateRecipient`. |
| M-02 | `ArcadeTwitterEscrowV3.sol:181-186` | `setLocker` settable-once: a typo permanently bricks escrow. No recovery path. **Fix**: long timelock (7+ days) on re-wiring instead of hard one-shot; or self-check probes locker via a view. |
| M-03 | `ArcadeTwitterEscrowV3.sol` (inherited Ownable) | `renounceOwnership` not overridden. Hot owner + accidental/forced renounce = permanent loss of all safety controls. **Fix**: `function renounceOwnership() public override onlyOwner { revert(); }`. |
| M-04 | `ArcadeV3Locker.sol:40-594` | Locker has NO owner, NO admin, NO pause. Fee distribution bugs cannot be paused. Documented design choice but flagged for awareness. **Fix**: at minimum, a pause on NEW `lockSingleSided`, leaving `collectFees` permissionless. |
| M-05 | `ArcadeLaunchpad.sol:115, 212, 221-227` | `deployer` is hot wallet (msg.sender at construction), one-shot wiring of V3 infra. Pre-bootstrap compromise = full theft of every CLANKER_V3 LP. **Fix**: CREATE2 atomic deploy + setV3Infra in same tx; or Ownable2Step on deployer rotation; OR burn `deployer = address(0)` post-wire. |
| M-06 | `ArcadeV3Locker.sol:502-525` | Cross-contract reentrancy via malicious `paired` token. Currently blocked by launchpad-side `paired ∈ {USDC, WETH}` enforcement, NOT re-validated at the locker. Fragile boundary. **Fix**: re-validate at `lockSingleSided` time. |
| M-07 | `ArcadeMultiSwap.sol:369-426` | `quoteSwapToSingle` silently returns 0 for V4 legs (NatSpec only documents V3). UI cannot distinguish "off-by-design" from "no liquidity". **Fix**: short-circuit on `_isV4LaunchToken(tokenIn) \|\| _isV4LaunchToken(tokenOut)`. Update NatSpec. |
| M-08 | `ArcadeMultiSwap.sol:311-319, 327-341, 348-354` | Stale ERC20 approvals to v4Router/v3Router/v2Router after partial pulls (anti-sniper hook can reduce input consumed). Defense-in-depth concern. **Fix**: `forceApprove(target, 0)` after each external swap. |
| M-09 | `ArcadeLaunchpad.sol:817-838` | V2 pair USDC pre-donation grief. Attacker creates pair + donates USDC pre-migration → shifts initial post-migration price. Loss-only for attacker but skews launch. **Fix**: `pair.skim(treasury)` after `mint(DEAD)`. |
| M-10 | `ArcadeLaunchpad.sol:833-834` | `_migrate`'s `USDC.safeTransfer(pair, usdcForLP)` is not wrapped in try/catch. If USDC blacklists the pair address, the only buy that can migrate reverts forever — token stuck at `tokensSold == CURVE_SUPPLY`, never reaches V2. **Fix**: admin-callable `forceMigrate` fallback OR try/catch + manual pair funding path. |
| M-11 | `ArcadeTwitterEscrowV3.sol + route.ts` | Zero-amount claim bricks slot. Backend caps amounts to balance but doesn't reject (0, 0). User can claim a (0, 0) signature pre-fees → `claimed=true` → all future credits stranded. **Fix**: `if (pairedAmount == 0 && clankerAmount == 0) revert ZeroClaim();` in `authorize()`. Also reject server-side. |
| M-12 | `ArcadeTwitterEscrowV3.sol:346-355` | `updateAdmin` try/catch after claim can leave admin=escrow permanently. No rotation path on escrow contract. **Fix**: owner-only `rotateLockerAdmin(positionId, slot, newAdmin)` calling `locker.updateAdmin`. |
| M-13 | `ArcadeLaunchpad.sol:309-355, 360-393` | Creator can set `recipient=escrow, admin=creator-EOA` without on-chain check that `recipient==escrow ⇒ admin==escrow`. Fees credited to escrow but no backend Twitter handle association → permanently stuck (not exploitable for profit, just self-grief). **Fix**: `_withPlatformCut` enforces `if rs[i].recipient == twitterEscrow then admin must == twitterEscrow`. |
| M-14 | `ArcadeV3Locker.sol:504-505, 567-568` | `abi.decode(ret, (bool))` reverts on non-32-byte returns. Today safe (USDC/WETH/LaunchToken all return 32 bytes), but unsafe for any future non-standard token. **Fix**: `bool decoded = ret.length == 0 \|\| (ret.length >= 32 && abi.decode(ret, (bool)));`. |

---

## LOW severity (17)

Highlights (full list in detailed reports):

- **L-01** `ArcadeLaunchpad.sol:495-516` — `buy()` distributes fees BEFORE updating curve state (CEI smell). Not exploitable with vanilla USDC. Fix: reorder.
- **L-02** `ArcadeLaunchpad.sol:896-930` — `s.migrated = true` set AFTER locker call → read-only reentrancy window where `isMigrated` returns false during locker's mint callback. Fix: set state before external call.
- **L-03** `ArcadeTwitterEscrowV3.sol:218-228` — `creditSlot` lacks `nonReentrant`. Safe today (no external calls), but future revision adding one becomes a vector. Fix: add for defense in depth.
- **L-04** `ArcadeV3Locker.sol:502-525` — Locker `_payOrCredit` → `escrow.creditSlot` try/catch leaves tokens uncredited on revert. No `creditSlotAdmin` recovery path. Fix: add owner-callable backfill on escrow.
- **L-05** `ArcadeMultiSwap.sol:227-355` — Residual forceApprove allowances to routers after swaps. No funds held cross-tx, minimal risk. Fix: reset to 0 after each call.
- **L-06** `ArcadeLaunchpad.sol:741-773` — `swapMigratedRoute` holds USDC mid-route. Safe under nonReentrant + standard ERC20. Future ERC777-style tokens would break this.
- **L-07** `ArcadeLaunchpad.sol:459-468` — `_safePayUsdc` 1/64 gas reserve could underflow if USDC ever adds fallback griefing on blacklist. Today safe.
- **L-08** `ArcadeMultiSwap.sol:26-32` — `V4PoolKey` hand-rolled struct, no compile-time check vs v4-core layout. Silent ABI break risk on upstream change. Fix: pin v4-core commit hash + add struct width assertion.
- **L-09** `ArcadeMultiSwap.sol:281-285` — V4↔V4 path with uninitialized pool produces opaque revert. Fix: check `currency0 != 0` in `_isV4LaunchToken`.
- **L-10** `ArcadeMultiSwap.sol:290-297` — V4-mixed-leg path recursive `_routeOne` re-runs `_isV4LaunchToken` SLOADs (~50k gas waste at 8 inputs). Fix: internal `_routeNonV4`.
- **L-11** `ArcadeTokenVault.sol:76-141` — Vault has no recovery if recipient loses key. Single-recipient design with no admin. Fix: document explicitly OR opt-in slow-path owner recovery with 30-day timelock.
- **L-12** `ArcadeLaunchpad.sol:221-227` — `setV3Infra` does not zero-check addresses. Subtle re-wire path exists when first call sets locker=0. Fix: `if (locker == 0 \|\| router == 0 \|\| vault == 0) revert ZeroAddress();`.
- **L-13** `ArcadeTwitterEscrowV3.sol:218-228, 301` — `pause` blocks claims but NOT `creditSlot`. Asymmetric: locker keeps depositing while users are frozen, attacker keeps accumulating signed claims for unpause window. Documented behavior, flag.
- **L-14** `ArcadeTwitterEscrowV3.sol:421-428` — `rescue` can sweep tokens delivered while escrow was paused (because `creditSlot` failed during pause = no creditedTotal increment = rescue bound doesn't protect). Fix: queue failed credits internally.
- **L-15** `ArcadeLaunchpad.sol:442-451` — `creator2ShareBps = 1` silently yields 0 on sub-3.33 USDC trades (floor division). Fix: minimum bps enforcement OR document.
- **L-16** `ArcadeLaunchpad.sol:497, 604` — Sub-100-wei trades pay zero fee (floor). Dust evasion, not profitable due to gas. Fix: minimum amount guard if desired.
- **L-17** `ArcadeLaunchpad.sol:555-574` — Capped-buy clamp drift (1-2 wei `realUsdcReserve` below K-cap target at migration). Documented dust. Fix only needed if downstream invariant requires exact 20k.

---

## INFO (23)

Informational findings confirm safe patterns OR document design decisions. Highlights:

- ✅ **EIP-712 domain separator** correctly includes chainId + verifyingContract; cached at construction + re-derived on fork. Cross-chain replay impossible.
- ✅ **Backend type hash matches contract type hash** for `Claim(...)` — full field/order/type cross-check in `route.ts:271-281` vs contract:74-76.
- ✅ **All state-mutating launchpad functions use `nonReentrant`** (buy, sell, buyMigrated, sellMigrated, swapMigratedRoute, createToken, createClankerV3, claimPendingUsdc).
- ✅ **F-3 per-slot accounting verified** — `creditSlot` correctly increments `balances[positionId][slot][token]` AND `creditedTotal[token]` by identical amount.
- ✅ **F-4 rescue bound verified** — `free = held > creditedTotal ? held - creditedTotal : 0` correctly handles fee-on-transfer underflow case.
- ✅ **F-9 deadline uint256** — no truncation, consistent across authorize + claim.
- ✅ **F-10 pairedToken != clankerToken** — prevents double-debit of same balance line.
- ✅ **V3 swap router callback authenticated** via `factory.getPool` — standard Uniswap V3 pattern.
- ✅ **V3 locker mint callback authenticated** via `_expectedPool` set+cleared inside `_mintAll` under lock.
- ✅ **Vault `claim` CEI correct**, `vestedAmount` linear math correct with safe denominator.
- ✅ **MultiSwap `_isV4LaunchToken` cannot be spoofed** — lookup is to immutable v4Launchpad, not caller-controlled.
- ✅ **MultiSwap dispatch priority V4 > V3 > V2** prevents address collision routing.
- ✅ **MultiSwap final aggregate slippage** check fires before transfer.
- ✅ **Locker `_distributePot` last-recipient absorbs dust** — `sum(shares) == amount` exactly, no fund leakage.
- ✅ **Pull-payment ledgers** (`pendingUsdcWithdrawals`, `pendingWithdrawals`, escrow `balances`) all pay only `msg.sender`, no delegate path.
- ⚠️ **MultiSwap has no `rescueToken`**; dust permanently stuck. Acceptable for stateless router but document that fee-on-transfer / rebasing tokens break the invariant.
- ⚠️ **Native USDC on Arc** — MultiSwap treats USDC purely as ERC20. Verify Arc precompile semantics for native wrap/unwrap edge cases.
- ⚠️ **`MAX_INPUTS=8` bounds gas** but not USDC-pivot pool depletion when all 8 inputs share the same direction.

---

## Privileged function inventory (post-deploy threat model)

What can each privileged role do at most?

| Role | Functions | Worst case if compromised |
|---|---|---|
| **escrow.owner** (hot wallet → multisig pending) | pause/unpause, setTrustedSigner, setClaimTimelock, transferOwnership, acceptOwnership, rescue, veto, setLocker (one-shot) | (a) Rotate signer → forge claims → drain credited balances (bounded by claimTimelock + own veto). (b) Renounce → permanently disable all defenses (see M-03). (c) Sweep uncredited balance (intended). Cannot touch credited balances (F-4). |
| **escrow.trustedSigner** (hot Vercel key) | Sign EIP-712 Claim for any (positionId, slot, recipient, token, amount) | Drain entire `creditedTotal[token]` for every credited slot, recipient = attacker. Blast bounded only by claimTimelock window. |
| **locker** (immutable address) | creditSlot on escrow, with arbitrary args | If LOCKER address ever wrong (typo brick, M-02), credits unreachable. If locker upgraded maliciously, inflates balances + drains via paired signer compromise. |
| **launchpad.deployer** (hot wallet, one-shot) | `setV3Infra` exactly once | Pre-bootstrap: wire malicious locker → full theft of every CLANKER_V3 LP. Post-bootstrap: zero. |
| **locker slot admin** (per-position-per-slot) | updateRecipient, updateAdmin on their slot | Redirect FUTURE fees of that slot only. Cannot touch already-credited escrow balances or other slots. |
| **vault.recipient** (per-vest) | updateRecipient on their vest | Rotate own payout. Cannot affect other vests. |
| **launchpad** (no owner post-bootstrap) | Permissionless after `setV3Infra` | No admin attack surface. |
| **V3 locker** (no admin) | No admin functions | Cannot pause, cannot rescue, cannot upgrade. (M-04 flags this.) |
| **MultiSwap** (no admin) | No admin functions | Stateless router. (No rescueToken; dust stuck.) |
| **Vault** (no admin) | No admin functions | Single-recipient design, recipient loss = lost vest. (L-11.) |

---

## Verified invariants (curve math)

12 of 13 audited accounting invariants verified with line citations:

| # | Invariant | Status |
|---|---|---|
| 1 | `tokensSold + launchpad balance == TOTAL_SUPPLY` pre-migration | ✅ Verified |
| 2 | `tokensSold ≤ CURVE_SUPPLY` always | ✅ Verified |
| 3 | `realUsdcReserve` after buy = prev + (usdc_in - fee_share) | ✅ Verified (uncapped exact, capped 1-2 wei drift documented) |
| 4 | `realUsdcReserve` after sell = prev - usdc_out | ✅ Verified |
| 5 | Migration triggers exactly once at threshold | ✅ Verified (K divisible by capTokenReserve = exact) |
| 6 | Buy with usdcIn > capacity refunds excess | ✅ Verified |
| 7 | Sell of tokensIn pool can't pay reverts | ✅ Verified |
| 8 | Fees: 1% = 0.5% creator + 0.5% platform exactly | ✅ Verified for amountUsdcIn ≥ 100 wei (sub-100 = 0 fee, L-16) |
| 9 | creator2 share split, no leakage | ✅ Verified (L-15 dust drift on sub-3 USDC trades) |
| 10 | Post-migration buy/sell on curve reverts | ✅ Verified |
| 11 | Migration: 200M tokens + ~USDC to V2 pair, burn LP | ⚠️ Partial — LP logic correct, but USDC amount = 20k not documented 17.5k (H-05) |
| 12 | Pending USDC withdrawals can't be claimed twice | ✅ Verified |
| 13 | quoteBuy/quoteSell match execution exactly | ✅ Verified |

---

## Recommendations priority

### Before mainnet (must-fix)

1. **H-05**: Resolve migration fee doc/code mismatch
2. **H-01**: Initialize claimTimelock in constructor + MIN_TIMELOCK floor
3. **H-03 + H-04**: Refactor escrow claim semantic to "sweep current balance" instead of "snapshot at authorize"
4. **H-08**: Add `pullFromLocker` on escrow
5. **M-03**: Override `renounceOwnership` to revert
6. **M-10**: try/catch in `_migrate` USDC transfer to pair OR `forceMigrate` admin fallback
7. **M-13**: Enforce `recipient==escrow ⇒ admin==escrow` in `_withPlatformCut`
8. **M-11**: Reject zero-amount claims in escrow

### Before re-enabling `V4_ENABLED` in prod

1. **H-06**: Whitelist or re-derive PoolKey hooks in MultiSwap
2. **H-07**: Per-input `minOut[]` array in MultiSwap
3. **M-07**: `_quoteOne` short-circuit V4 + update NatSpec
4. **M-08**: Reset allowances to 0 after V4 swaps

### Multisig migration prep

1. Apply M-03 (renounceOwnership revert) BEFORE handover
2. Apply H-01 (claimTimelock floor) with `setClaimTimelock(48h)` during multisig setup
3. Document pause + veto + setTrustedSigner runbook for the multisig signers

### Operationally accept

- L-13, L-14 (paused-state asymmetry) — document the runbook: pause halts claims, locker keeps depositing, owner must inspect new credits during pause
- L-11 (vault recipient loss) — document at vault creation that the recipient choice is permanent
- INFO MultiSwap residual / native USDC / pivot depletion — document for users + frontend warns when input sum > X% of USDC pivot depth

---

## Limitations

- **This is NOT a substitute for external audit.** Findings are from manual review by an AI agent ensemble. Subtle classes of bugs (cross-protocol MEV, economic flash-loan paths, specific Solidity compiler quirks) may be missed.
- **No fuzzing performed.** Recommended next step: write a Forge invariant suite (`contracts/test/invariants/`) covering the 12 verified invariants + targeting the bug classes from H-03/H-04 (slot stranding under racing credit/claim).
- **No static analysis run.** Recommend setting up slither + aderyn in CI before external audit.
- **Out of scope**: V2 DEX core (`src/dex/*` Uniswap V2 fork), V4 PoolManager/AntiSniperHook/Router/Quoter (planned separate review). Note: H-06 specifically depends on the AntiSniper hook being safe; that hook needs its own audit.
- **Backend code reviewed for type-hash matching only.** `web/app/api/twitter-callback/route.ts` and the Vercel deployment flow merit a separate review (OAuth state cookie tampering, signing key custody, rate limiting, etc.).
