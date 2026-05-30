# Arcade Pre-Mainnet Security Audit

**Status:** Internal pre-audit pass (not a financial-grade external audit). Run on 2026-05-30 against `main` at commit `667bd44`.

**Scope:** in-house launchpad, per-launch ERC20, vest vault, Twitter EIP-712 escrow, multi-swap aggregator, V3 single-sided locker, and V3 price math. The Uniswap V2 fork in `contracts/src/dex/` was inspected only for non-trivial modifications (none found beyond the rename and 0.8 Solidity port, so not included).

**Result:** 0 Critical, 4 High, 7 Medium, 6 Low, 5 Informational.

Most pressing for mainnet:

1. `marketCap()` calls the V2-pair `getReserves()` ABI on a V3 pool address for CLANKER_V3 tokens — guaranteed revert / broken view.
2. `ArcadeMultiSwap` routes CLANKER_V3 tokens via the V2-only `swapMigratedRoute` path because `isMigrated()` is true for them; no V2 pair exists, so the swap hard-reverts.
3. USDC freeze-list (or any reverting/blacklisting ERC20) on a single creator, platform, or locker-recipient address can permanently DoS the bonding-curve `buy`/`sell`, the post-migration royalty path, and the entire `collectFees` call for a locked V3 position.
4. The `setV3Locker` back-compat shim permanently bricks the launchpad's CLANKER_V3 vault + router wiring if it is ever called by mistake because `setV3Infra` checks `v3Locker == 0`.

---

## High

### [High] `marketCap()` calls V2 pair API on a V3 pool address for CLANKER_V3 tokens
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:913-926`
**Category:** state assumptions / dead-end view

For CLANKER_V3 launches the launchpad stores the V3 pool address in `s.v2Pair` (`_launchClankerV3` at line 860) and flags the token as migrated at birth. `marketCap()` then unconditionally invokes `IArcadeV2Pair(s.v2Pair).getReserves()` and `.token0()` on that V3 pool. Uniswap V3 pools have neither a `getReserves()` returning `(uint112,uint112,uint32)` nor a matching ABI for the V2 pair interface, so this call reverts (or, at best, decodes garbage from a same-selector collision).

**Impact:** all on-chain market-cap reads for CLANKER_V3 tokens fail. Any contract that integrates this view (frontend reads, future routers, indexers that call on-chain) sees a hard revert. Any aggregator that batches `marketCap` for many tokens reverts atomically once a CLANKER_V3 token is included.

**Recommendation:** branch on `s.mode == LaunchMode.CLANKER_V3` and read `slot0()` from the V3 pool, then compute price from `sqrtPriceX96` (see `ArcadeV3PriceMath.encodeSqrtPriceX96` for the inverse). Price should use FDV against `TOTAL_SUPPLY` regardless of vault size, consistent with the launch math.

### [High] `ArcadeMultiSwap` routes CLANKER_V3 tokens into a non-existent V2 path
**File:** `contracts/src/swap/ArcadeMultiSwap.sol:123-141`
**Category:** routing / availability

`isMigrated(tokenAddr)` returns true for CLANKER_V3 tokens because `_launchClankerV3` sets `s.migrated = true` (`ArcadeLaunchpad.sol:858`). `_routeOne` first tries `_swapV2` when a V2 pair exists, then falls through to `launchpad.swapMigratedRoute` whenever either side is migrated. `swapMigratedRoute` (`ArcadeLaunchpad.sol:676-684`) attempts `IArcadeV2Router.swapExactTokensForTokens` on the V2 path `tokenIn -> USDC` — but no V2 pair exists for CLANKER_V3 tokens.

**Impact:** any multi-swap involving a CLANKER_V3 token as input or output hard-reverts inside V2. The launchpad's most-marketed launch mode is silently incompatible with the public aggregator.

**Recommendation:** either (a) introduce a separate marker (`isV3Migrated`) so MultiSwap can route CLANKER_V3 tokens through `ArcadeV3SwapRouter.exactInputSingle` / `exactInputThroughUsdc`, or (b) make `swapMigratedRoute` itself detect a missing V2 pair and forward to the V3 router. Either way, `isMigrated` overloads two very different post-migration shapes.

### [High] Single blacklisted / reverting recipient permanently DoSes curve trades and locker fee collection
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:402-435` (curve fees) and `contracts/v3src/ArcadeV3Locker.sol:416-440, 468-471` (locker pot distribution)
**Category:** push-payment DoS / griefing

Every fee path in the launchpad and locker is push-payment with no try/catch:
- `_distributeFee` → `_payCreatorShare` `safeTransfer`s to `s.creator` / `s.creator2` / `treasury` on every `buy`, `sell`, `buyMigrated`, `sellMigrated`, and both legs of `swapMigratedRoute`.
- `ArcadeV3Locker._distributePot` calls `_pay` to every eligible recipient sequentially; one failing transfer reverts the whole `collectFees`.

USDC has a Circle-controlled blacklist that returns failure on transfers to/from blacklisted addresses. If a creator, `creator2`, treasury, or any locker recipient becomes blacklisted (or is a smart contract that reverts on receive), the corresponding fee distribution path bricks.

**Impact:**
- Curve mode: `buy` and `sell` bricked for the token forever. `buyMigrated`, `sellMigrated`, `swapMigratedRoute` also bricked, but underlying liquidity remains accessible by going to the V2 router directly (losing the royalty path, not funds).
- CLANKER_V3 locker: `collectFees(positionId)` reverts globally for that position. Every recipient — including innocent platform and other creators sharing the slot — loses access to all accrued LP fees. Principal is locked forever, so the fees compound and cannot ever be redeemed unless the bad recipient rotates via `updateRecipient`. If the bad recipient's admin is the same compromised address, nothing rotates it.

**Recommendation:** wrap each `safeTransfer` / `_pay` in a try/catch (locker) and an internal credit-then-withdraw "pull" pattern (launchpad). For the locker, on a failed `_pay`, credit the share to a `pendingWithdrawals[token][recipient]` ledger that the recipient withdraws separately, so one failure can't poison the loop. For curve fees, escrow failed shares into a per-token bucket and expose a `claimStuckFees(token, recipient)` view.

### [High] `ArcadeV3SwapRouter.exactInputThroughUsdc` bypasses the anti-sniper tax
**File:** `contracts/v3src/ArcadeV3SwapRouter.sol:58-67, 91-114`
**Category:** access control / bypass

`_snipeSkim` is only invoked from `exactInputSingle`, not from `exactInputThroughUsdc`. The two-hop path (`tokenIn -> USDC -> tokenOut`) buys `tokenOut` with USDC in leg 2 — exactly the scenario the snipe tax is meant to cover — but the skim helper is never called.

**Impact:** snipers can avoid the launch-window tax entirely on any of the four pool types by routing through `exactInputThroughUsdc` with any non-USDC asset (e.g. WETH -> USDC -> token). The router's own self-described "soft" protection is bypassed inside the same router. With a configured `snipeStartBps` up to 50%, this is meaningful for creator economics.

**Recommendation:** call `_snipeSkim(USDC, tokenOut, usdcMid, address(this))` between leg 1 and leg 2 of `exactInputThroughUsdc`, paying from the router's own USDC mid-balance (`transfer`, not `transferFrom`).

---

## Medium

### [Medium] `setV3Locker` back-compat shim permanently bricks `setV3Infra`
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:206-219`
**Category:** initialization / ops footgun

Both `setV3Infra` and `setV3Locker` are deployer-one-shot, gated by the same `v3Locker != address(0)` check. If `setV3Locker` is called first, `v3Locker` is set but `v3Router` and `tokenVault` remain `address(0)` — and `setV3Infra` can never be called afterwards.

**Impact:** all CLANKER_V3 launches with `creatorBuyUsdc > 0` revert (`NoRouter`); all launches with `vaultPct > 0` revert (`BadVault`). The default `createToken` CLANKER_V3 path still works (it uses neither), but the full Clanker feature surface is bricked. Recovery requires redeploying the launchpad.

**Recommendation:** delete `setV3Locker` outright, or have `setV3Infra` ignore `v3Locker != 0` once and merely complete the missing fields when `v3Router == 0`.

### [Medium] `_computeBuy` cap-fill rounding can underflow `refund`, blocking the migration trigger
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:508-522, 977-986`
**Category:** integer arithmetic / curve math

The cap path rounds `capUsdcReserve` up by 1 and `actualGross = ceil(actualNet * 10000 / 9900)`. Then `refund = (netIn + fee) - actualGross`. For small `amountUsdcIn` (where `fee = floor(amountUsdcIn / 100)` rounds to 0), the ceiling can push `actualGross` to `amountUsdcIn + 1` or `+ 2`, making `refund` underflow and reverting the entire `buy`.

Concrete example: `tokensSold` close to `CURVE_SUPPLY` so `maxOut` is tiny. `actualNet = 127` microUSDC required to fill cap, user sends `amountUsdcIn = 128`, `fee = 1`, `netIn = 127`. Then `actualGross = ceil(127 * 10000 / 9900) = ceil(128.28) = 129`. `refund = 128 - 129` underflows → revert.

**Impact:** a buyer aiming the exact closing amount cannot fill the curve; they must overshoot. Not fund-loss, but a denial-of-completion if nobody is willing to send more than the cap needs, and a confusing UX edge.

**Recommendation:** clamp `actualGross = actualGross > (netIn + fee) ? (netIn + fee) : actualGross;` after the ceiling div. The 1-2 microUSDC accounting drift goes to the curve.

### [Medium] `ArcadeMultiSwap` cannot route non-migrated launchpad tokens
**File:** `contracts/src/swap/ArcadeMultiSwap.sol:123-141`
**Category:** routing

Non-migrated PUMP / Arcade tokens have no V2 pair and `isMigrated` returns false. `_routeOne` therefore falls into the `_swapV2(viaUsdc=true)` branch and reverts inside V2.

**Impact:** multi-swap silently fails for any input or output that is a live-curve token.

**Recommendation:** detect not-yet-migrated launchpad tokens (`tokens[t].token != 0 && !tokens[t].migrated`) and route them through `launchpad.buy` / `launchpad.sell`, or explicitly revert with a clearer error.

### [Medium] Twitter escrow has no recovery for tokens stuck on a vetoed authorization
**File:** `contracts/src/launchpad/ArcadeTwitterEscrow.sol:200-212, 219-225`
**Category:** stuck-funds

A `veto` marks a `PendingClaim` as vetoed but never returns the underlying funds anywhere. There is no admin function to sweep ERC20s mis-sent to the contract either.

**Impact:** vetoed funds are stranded. Misrouted tokens are stranded.

**Recommendation:** add an `owner`-only `rescue(address token, uint256 amount, address to)` (or restrict to `vetoed && nonceUsed`-tagged claims) so the multisig owner can return funds. Or have the trusted signer re-sign with a fresh nonce after a veto to retry.

### [Medium] `ArcadeTokenVault.createVest` allows zero-amount vest and unbounded vesting duration
**File:** `contracts/src/launchpad/ArcadeTokenVault.sol:70-97`
**Category:** input validation

`createVest` does not check `amount > 0`. It does not bound `vestingDuration`, which can be set to a value that overflows `lockupEnd + vestingDuration` (uint64) and reverts.

**Impact:** `createClankerV3` can be made to revert via pathological vesting params, wasting the user's signature in the mempool.

**Recommendation:** `if (amount == 0) revert ZeroAmount();` and clamp `vestingDuration` and `lockupDuration` to a sane upper bound (e.g. 10 years each).

### [Medium] `swapMigratedRoute` hard-codes 600s deadlines and ignores user input
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:597-599, 621-623, 682-684, 706-712`
**Category:** signature flow / MEV

`buyMigrated`, `sellMigrated`, and `swapMigratedRoute` hard-code `block.timestamp + 600` as the V2 router deadline. The user has no way to express "fail if my tx isn't included within X seconds". Combined with no per-leg slippage on the inner V2 routing, a long-stalled tx can land at a much worse price than the user expected.

**Recommendation:** add a `uint256 deadline` parameter and `if (block.timestamp > deadline) revert Expired();` upfront. Pass the user's deadline to the V2 router.

### [Medium] Pre-buy by creator vs snipe arming order
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:301-344, 864-870`
**Category:** front-running / documentation

`_launchClankerV3` performs the creator's optional opening buy before arming the snipe config (line 341). The comment says "so the creator's own launch buy isn't taxed by their own config." This is correct but the comment slightly misleads — any external buyer who lands in the same block after `_launchClankerV3` returns but before the next block is taxed normally. Net: no exploit, just clarify the docstring.

**Recommendation:** rewrite the comment to say "the creator's launch buy isn't taxed because the snipe config isn't yet armed within this tx".

---

## Low

### [Low] Twitter escrow `_settle` does not use `SafeERC20`
**File:** `contracts/src/launchpad/ArcadeTwitterEscrow.sol:282-292`

Uses raw `transfer` and reverts on `!transfer`. Tokens that don't return a bool (USDT-style) cause `_settle` to fail to decode. Latent — current tokens (USDC, WETH, clanker tokens) all return bool.

**Recommendation:** switch `_settle` to OZ `SafeERC20.safeTransfer`.

### [Low] `ArcadeLaunchToken` stores `_customName` and `_customSymbol` but never uses them
**File:** `contracts/src/launchpad/ArcadeLaunchToken.sol:10-17`

Dead state. ~10k gas per launch wasted.

**Recommendation:** delete.

### [Low] `MIGRATION_USDC_TARGET` is dead state
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:55`

Declared `public constant`, never read on-chain.

**Recommendation:** remove or convert to a test-only assertion.

### [Low] Curve fee dust always rounds to creator instead of platform
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:404-409, 419-422`

`platformFee = (feeIn * platformBps) / 10000` floors. For `feeIn = 1` (microUSDC), platform gets 0, creator gets 1. Negligible per-trade revenue leak biased toward creator.

**Recommendation:** alternate the dust receiver, or accept and document.

### [Low] `ArcadeMultiSwap._swapV2` re-approves on every call
**File:** `contracts/src/swap/ArcadeMultiSwap.sol:148`

`forceApprove(v2Router, amountIn)` on each leg adds ~5k gas; 8 inputs = ~40k gas per multi-swap.

**Recommendation:** permanently approve `type(uint256).max` once at construction.

### [Low] Snipe tax bypass via direct pool swap (acknowledged in comment but not in marketing copy)
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:162-166`

Code comment says "Soft protection — a direct pool swap bypasses it." Public-facing docs should match.

**Recommendation:** add UI warning or NatSpec note.

---

## Informational

### [Informational] Domain separator does not rebind on chainId change
**File:** `contracts/src/launchpad/ArcadeTwitterEscrow.sol:114-122`

`DOMAIN_SEPARATOR` is immutable at construction. Standard EIP-712 fork-replay concern.

**Recommendation:** recompute dynamically when `block.chainid` differs from cached.

### [Informational] `authorize` with two nonces for the same slot leaves zombie pendingClaims
**File:** `contracts/src/launchpad/ArcadeTwitterEscrow.sol:157-195`

Only storage waste; no exploit. Block when an existing pending claim is in-flight for the same slot, or have the owner veto periodically.

### [Informational] `_validateRecipients` invariant always passes through treasury fallback
**File:** `contracts/v3src/ArcadeV3Locker.sol:198-213`; `contracts/src/launchpad/ArcadeLaunchpad.sol:349-382`

Creators picking all `Paired`-only recipients hand the entire clanker-side fee stream to the platform. Front-end warning recommended.

### [Informational] `quoteBuy` discards `actualGross`
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:934-946`

API ergonomics — the frontend can derive it but exposing it helps UX.

### [Informational] `swapMigratedRoute` `UnknownToken()` is misleading for same-token / USDC short-circuits
**File:** `contracts/src/launchpad/ArcadeLaunchpad.sol:663-668`

Add a dedicated `InvalidRoute()` error.

---

## Manual checks recommended

- **Trusted backend signer (Twitter escrow).** The `TRUSTED_SIGNER` is immutable and fully controls amounts, recipients, and tokens. Compromise = total escrow drain. The 7-day max timelock plus owner veto is the only mitigation. Confirm production signer is held in a hardware-isolated environment and `owner` is a real multisig before mainnet.
- **Deployer one-shot wiring.** `setV3Infra` and `setV3Locker` are guarded by `msg.sender == deployer` and the `v3Locker == address(0)` flag. Confirm the deployer EOA is burned (or rotated to a discarded key) after deployment and the deploy script never calls `setV3Locker`.
- **Locker recipient admin invariant for Twitter-attributed slots.** `ArcadeTwitterEscrow._settle` requires the escrow to be the slot's `admin` at claim time. Confirm the launch flow sets `admin = ArcadeTwitterEscrow` for Twitter-attributed slots.
- **V3 fee tier whitelisting.** `createClankerV3` allows fee tiers `10000 / 20000 / 30000`. Confirm `enableFeeAmount` was called for each tier on Arc at deploy.
- **Pool type initial price vs vault size.** For CLANKER_V3 with `vaultPct > 0`, the start price is FDV-based on `TOTAL_SUPPLY` but the LP receives less. First buyer moves the price faster than mental-model expects. Surface in creator-facing docs.
- **`block.timestamp + 600` deadline assumption.** Confirm Arc block production (~1-5s) makes 600s deadlines generous and not gameable.
- **USDC native gas token interaction.** USDC is Arc's gas token. Confirm `safeTransferFrom` / `safeTransfer` behave as a normal ERC20 (no special gas debits during transfer) and that the V2 pair's invariant check handles the gas-token semantics correctly.
