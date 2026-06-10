# Arcade V4 Migration Scoping

> Working document. Founder-level scoping for collapsing the Arcade V2/V3 stack onto Uniswap V4 hooks on Arc testnet (chainId 5042002) and then Arc mainnet. Generated 2026-05-31.

## Executive Summary

Arcade today is a Uniswap V2 fork plus a pump.fun-style bonding-curve launchpad plus a Clanker-style locked single-sided V3 LP variant plus an EIP-712 Twitter reward escrow, totalling roughly 2,500 lines of Solidity across about eight production contracts. Uniswap V4 plus Arc's confirmed EIP-1153 transient storage support unlocks a structurally cleaner design: one `ArcadeHook` contract per protocol, bound to one canonical `PoolManager` singleton, where the bonding curve, anti-sniper tax, graduation, post-graduation royalty, and LP locking all live behind the same `PoolKey`. Net LoC delta is modest (about ~310 LoC saved), but the qualitative wins are large: one pool from launch through steady state, universal anti-sniper enforcement no aggregator can bypass, atomic graduation inside the user's swap, and ERC-6909 claim tokens that replace the entire V3 NFT-locker layer.

The migration is constrained by reality: solo founder, no audit budget at present, and a V2 day-1 mainnet ship targeted for Summer 2026. V4 is therefore positioned as a post-mainnet workstream (4-8 weeks behind stabilization, realistically 6 calendar months end to end). V2 contracts stay live on-chain forever; the only thing we ever pause is `createToken` on the V2 launchpad. There is no forced LP migration. New launches go to V4; legacy launches keep their pools, fees, and creator dashboards in perpetuity.

The riskiest novelty is graduation-in-place inside a `beforeSwap` callback. Both the $11M Cork and $8.4M Bunni exploits in 2025 were on audited V4 hooks; the failure modes (missing `msg.sender` check, rounding-direction in custom curve math) map directly to defenses Arcade must build. Without a paid audit, confidence in shipping V4 safely is MEDIUM-LOW. With a Builders Fund grant funding a Tier-2 firm engagement (Pashov / Zealynx / Cantina) plus a Hats Finance vault on testnet, confidence rises to MEDIUM-HIGH.

## Current Stack (5 contracts ~2500 LoC)

```
contracts/src/dex/                       Uniswap V2 fork
  ArcadeV2Factory.sol           ~58 LoC      CREATE2 deployer of pairs
  ArcadeV2Pair.sol              ~218 LoC     xy=k AMM, LP shares, TWAP
  ArcadeV2Router.sol            ~187 LoC     EOA-facing swap entrypoint
  ArcadeV2ERC20.sol             ~80 LoC      LP token base
  libraries/ArcadeV2Library.sol

contracts/src/launchpad/
  ArcadeLaunchpad.sol           ~1205 LoC    bonding curve + graduation + royalty + pull-payment
  ArcadeLaunchToken.sol         ~18 LoC      1B fixed-supply ERC20
  ArcadeTokenVault.sol          ~151 LoC     vested team allocations
  ArcadeTwitterEscrowV3.sol     ~639 LoC     EIP-712 Twitter reward escrow

contracts/src/v3/             Clanker-style locked single-sided V3 LP
  ArcadeV3PriceMath.sol         ~60 LoC      TickMath / SqrtPriceMath helpers
  ArcadeV3Locker (via getCode)  ~700 LoC     V3 NFT-position locker + multi-recipient fee split

contracts/src/swap/
  ArcadeMultiSwap.sol           ~467 LoC     USDC-pivoted V2+V3+curve aggregator
```

`ArcadeLaunchpad.sol` is the giant. It does bonding-curve issuance (PUMP/CLANKER 800M curve / 200M LP migration at 20k USDC raised), direct Clanker-V3 locked-LP launches, migration to V2/V3 pools, post-migration royalty routing (`buyMigrated` / `sellMigrated` / `swapMigratedRoute`), comments, creation fee accounting, anti-sniper config storage, and a pull-payment USDC escrow for blacklisted recipients. Everything else orbits this contract.

Existing V4 prototype lives in `contracts/v4src/`:

- `ArcadeV4Launchpad.sol` (~450 LoC): deploys `ArcadeLaunchToken`, charges flat 3 USDC creation fee, stores snipe config, single-sided pool init through `unlock` -> `modifyLiquidity` -> `sync(token)` -> `safeTransfer(supply)` -> `settle`, one-shot `setHook` to break the CREATE2 mutual-dependency on the hook.
- `ArcadeAntiSniperHook.sol` (~294 LoC): BEFORE_SWAP + AFTER_SWAP with both RETURNS_DELTA flags, exact-input branch in beforeSwap, exact-output branch in afterSwap, immutable treasury (audit fix from V2 pass commit 16afe44).
- `ArcadeV4SwapRouter.sol` (~209 LoC): IUnlockCallback router, exactInputSingle / exactOutputSingle, sync + transferFrom + settle for input + take for output inside the callback.

The prototype proves the deploy ceremony works. It does not yet implement the bonding curve, graduation, multi-recipient royalty, ERC-6909 locked LP, or Twitter-escrow integration. Estimated additional work to feature-parity: 1,500-2,500 LoC of hook + launchpad refactor, dominated by curve-NoOp implementation and migration state machine.

## Target Architecture (V4 hook + minimal periphery)

```
                         (EOA)
                           |
                           v
              +------------------------+        +-----------------------+
              |   ArcadeV4SwapRouter   |        |   ArcadeHook (NEW)    |
              |   ~210 LoC (proto)     |        |   ~1100 LoC           |
              |   exactInput/Output    |        |   - bonding curve     |
              +------------+-----------+        |   - graduation        |
                           |                    |   - anti-sniper       |
                           v                    |   - LP lock           |
              +------------------------+        |   - royalty           |
              |  PoolManager singleton |<------>|   - admin             |
              |   (canonical v4-core)  |   IHooks callbacks             |
              +------------+-----------+        +-----------+-----------+
                           |                                |
                           v                                v
              +------------------------+        +-----------------------+
              |  ArcadeLaunchToken     |        |  ArcadeTokenVault     |
              |  ~60 LoC unchanged     |        |  ~180 LoC unchanged   |
              +------------------------+        +-----------------------+
                           |
                           v
              +------------------------+
              |  ArcadeTwitterEscrowV3 |
              |  ~640 LoC, locker      |
              |  field -> hook addr    |
              +------------------------+
```

One ArcadeHook contract is CREATE2-mined at an address whose low 14 bits encode the 10 permission flags it needs: `BEFORE_INITIALIZE`, `AFTER_INITIALIZE`, `BEFORE_ADD_LIQUIDITY`, `AFTER_ADD_LIQUIDITY`, `BEFORE_REMOVE_LIQUIDITY`, `BEFORE_SWAP`, `AFTER_SWAP`, plus the three RETURNS_DELTA variants for `BEFORE_SWAP`, `AFTER_SWAP`, and `AFTER_ADD_LIQUIDITY`. `BEFORE_DONATE` and `AFTER_DONATE` bits stay zero. The hook is the launchpad: pool creation goes through `hook.createLaunch(...)` which deploys `ArcadeLaunchToken`, calls `pm.initialize(poolKey, sqrtPriceX96)`, then runs `pm.unlock` to seed single-sided liquidity.

Per-pool state lives in the hook keyed by `PoolId`:

```solidity
struct CurveState {
    uint128 virtualUsdcReserve;   // 5_000e6 USDC at init
    uint128 realUsdcReserve;      // climbs to 20_000e6 at graduation
    uint128 tokensSold;           // climbs to 800_000_000e18 (CURVE_SUPPLY)
    uint8   mode;                 // PUMP | CLANKER | CLANKER_V3
    bool    graduated;
    address creator;
    address creator2;
    uint16  creator2Bps;
}
mapping(PoolId => CurveState) curveStates;
mapping(PoolId => FeeOwner)   feeOwners;
mapping(bytes32 => PositionInfo) positions;  // locked LP bookkeeping
```

## Hook Callback Design

### beforeInitialize

Validates that the pool being initialized is a USDC-quote pool registered in the launchpad's `launches[]` mapping and that `msg.sender == address(this)` (only the hook's own `createLaunch` path can spawn pools with this hook attached). This is the Cork defense: every `IHooks` callback enforces `msg.sender == address(POOL_MANAGER)` AND `beforeInitialize` additionally enforces `sender == address(this)`. Without this, an attacker can create a fake pool pointing at the deployed Arcade hook and use it to corrupt cross-pool accounting.

```solidity
function beforeInitialize(address sender, PoolKey calldata key, uint160) external returns (bytes4) {
    require(msg.sender == address(POOL_MANAGER), "NotPoolManager");
    require(sender == address(this), "OnlyLaunchpad");
    require(_isRegisteredLaunch(_launchTokenOf(key)), "NotRegistered");
    require(_isUsdcPair(key), "NotUsdcPair");
    return IHooks.beforeInitialize.selector;
}
```

### beforeSwap (bonding curve + anti-sniper)

The core dispatcher. Branches on `curveStates[poolId].graduated`:

- `graduated == false`: run the bonding-curve `_computeBuy` / `_computeSell` math against `virtualUsdcReserve + realUsdcReserve` and `tokensSold`, take USDC from the user via `pm.sync(USDC) + pm.settle`, deliver tokens via `pm.take(token, user, amountOut)`, and return a `BeforeSwapDelta` that fully neutralizes the canonical x*y=k path. The dynamic fee return value carries the curve-phase 1% fee with `LPFeeLibrary.OVERRIDE_FEE_FLAG` set.
- `graduated == false AND threshold crossed mid-swap`: flip state to `GraduationStarted`, take the 2,500 USDC migration fee, donate the 200M reserved tokens + 17,500 USDC into the same `PoolKey` as a full-range concentrated-liquidity position locked via `afterAddLiquidity`, flip state to `GraduationCompleted`, then return `ZERO_DELTA` so the rest of the swap runs against the canonical AMM with the now-live liquidity. The intermediate `GraduationStarted` state rejects all swaps to prevent concurrent reentry.
- `graduated == true`: compute current anti-sniper bps via `currentSnipeBps(token)`, skim on exact-input buys via `pm.take(USDC, treasury, skim)`, return positive specified-delta, and return the post-graduation dynamic fee with override flag set.

```solidity
if (state.graduated == false) {
    (int128 spec, int128 unspec) = _curveSwap(state, params);
    pm.sync(USDC);
    // ... settle/take ...
    return (selector, toBeforeSwapDelta(spec, unspec), CURVE_FEE | OVERRIDE_FEE_FLAG);
} else {
    uint24 dynFee = _computeDynamicFee(state);
    if (isBuyExactInput) {
        uint256 skim = (amountIn * currentSnipeBps(token)) / 10_000;
        pm.take(USDC, treasury, skim);
        return (selector, toBeforeSwapDelta(int128(int256(skim)), 0), dynFee | OVERRIDE_FEE_FLAG);
    }
    return (selector, ZERO_DELTA, dynFee | OVERRIDE_FEE_FLAG);
}
```

### afterSwap (royalty + analytics)

Two responsibilities post-graduation:

1. Tax exact-output snipe buys (mirror the existing `ArcadeAntiSniperHook.afterSwap` logic, return positive `int128` on the unspecified USDC side).
2. Route the 0.30% creator/platform royalty: read the realized USDC leg from `BalanceDelta`, compute royalty splits (PUMP 50/50 creator/treasury or CLANKER 70/30 per the FeeOwner registry), call `pm.take(USDC, creator, royaltyCreator)` + `pm.take(USDC, treasury, royaltyPlatform)`, return the sum as positive `int128` so the user pays the skim.
3. If `FeeOwner.twitterEscrow != address(0)`, route the creator share to `ArcadeTwitterEscrowV3.creditSlot(...)` instead of direct transfer. Wrap in `try/catch` so a paused escrow does not revert every swap.

During the curving phase, returns `0` (curve fee was already taken in beforeSwap).

### afterAddLiquidity (LP locking)

Mints a non-transferable ERC-6909 claim token (the V4-native equivalent of the V3 locker NFT) to a designated `LOCKED_VAULT` address. The 6909 has `transferFrom` disabled at the LOCKED_VAULT level (or the hook simply never exposes a transfer path), making the position effectively locked. Fee collection still works because the hook itself can call `pm.modifyLiquidity` with `liquidityDelta=0` to harvest fees in afterSwap.

```solidity
bytes32 positionKey = keccak256(abi.encode(key.toId(), params.tickLower, params.tickUpper, params.salt));
positions[positionKey] = PositionInfo({owner: feeOwner, locked: true, liquidity: uint128(params.liquidityDelta)});
_mint6909(LOCKED_VAULT, uint256(positionKey), uint128(params.liquidityDelta));
return (selector, BalanceDeltaLibrary.ZERO_DELTA);
```

### beforeAddLiquidity

Reverts unless `sender == address(this)` (the hook is the only authorized LP) AND state allows. While curving: revert. While graduated + CLANKER_V3 mode: revert unconditionally (single-sided LP, locked forever). While graduated + PUMP/CLANKER mode: allow only the hook itself to add at graduation time.

### beforeRemoveLiquidity

Order of checks matters:

1. If `liquidityDelta == 0` AND `sender == address(this)`, allow (fee harvest).
2. If position is locked, revert.
3. For non-locked positions, apply normal rules.

This precise ordering is what prevents the LP-locking bypass: returning early on the first matching condition means an external caller with `liquidityDelta=0` cannot trigger fee-harvest accounting on locked positions.

### beforeDonate / afterDonate

Not used. Reverts (`HookNotImplemented`). The mined hook address MUST have zero bits for `BEFORE_DONATE_FLAG` and `AFTER_DONATE_FLAG` so the callbacks are unreachable in practice. Defense against the dust-donate DoS class.

## Bonding Curve Math in V4

Production `ArcadeLaunchpad` uses virtual reserves: 5,000 USDC virtual + 1B virtual tokens, `K = 5_000e6 * 1_000_000_000e18 = 5e36`. Curve sells from `tokensSold = 0` up to `CURVE_SUPPLY = 800_000_000e18`, accumulating `realUsdcReserve` from 0 up to the 20,000 USDC graduation threshold.

`_computeBuy(amountInUsdc)`:

```
effectiveUsdcReserve = virtualUsdcReserve + realUsdcReserve
effectiveTokenReserve = TOTAL_TOKENS - tokensSold     // virtual 1B - sold
amountOutTokens = (effectiveTokenReserve * amountInUsdc) / (effectiveUsdcReserve + amountInUsdc)
```

`_computeSell(amountInTokens)`:

```
amountOutUsdc = (effectiveUsdcReserve * amountInTokens) / (effectiveTokenReserve + amountInTokens)
```

Rounding policy in V4: round amountOut DOWN on buys AND on sells. This favors the protocol asymmetrically (curve always accrues across round-trips). Invariant test that must hold:

```
After any sequence of buys + sells totalling zero net token movement,
the curve's USDC balance is >= the starting USDC balance.
```

This is the Bunni-defense invariant: rounding-down in the wrong direction is what let attackers drain Bunni's LDF curves through 44 micro-swaps.

The curve runs inside `beforeSwap` returning a `BeforeSwapDelta` that fully replaces the canonical x*y=k. Sign convention is the highest-bug-probability surface in the entire migration; copy the official BeforeSwapDelta convention tables verbatim into code comments.

## Graduation Flow V4-Native

Atomic graduation inside the user's swap that crosses 20,000 USDC `realUsdcReserve`. The state machine has 5 invariants that must all hold across the boundary:

1. `tokensSold == CURVE_SUPPLY` (800M)
2. `realUsdcReserve == GRADUATION_THRESHOLD` (20,000 USDC)
3. Virtual reserves cleared
4. Seeded LP position minted to `LOCKED_VAULT` with `locked=true`
5. `graduated` flag flipped

The hook uses an explicit three-state enum (`Curving`, `GraduationStarted`, `Graduated`) rather than a single boolean, so the `GraduationStarted` window can revert all concurrent swaps to prevent reentry. If the seed-LP `modifyLiquidity` call reverts, the whole tx reverts and the curve stays in `Curving` state for retry on the next swap that crosses the threshold.

```solidity
if (newRealUsdc >= GRADUATION_THRESHOLD && state.status == Status.Curving) {
    state.status = Status.GraduationStarted;
    pm.take(USDC, treasury, MIGRATION_FEE);                    // 2,500 USDC
    _seedGraduationLiquidity(key, RESERVED_TOKENS, RESERVED_USDC); // 200M + 17,500 USDC
    state.status = Status.Graduated;                            // atomic flip
    // continue with remainder of swap on canonical AMM
}
```

Gas budget concern: this path could approach Arc's 15M per-tx ceiling when combined with multi-recipient royalty distribution and Twitter-escrow credit. Profile against forked Arc testnet in Phase 1.

## LP Locking via ERC-6909 / claim tokens

V4 ERC-6909 claim tokens replace the V3 NFT-position locker entirely. Two flows:

1. Curve-phase liquidity: hook is the sole LP, single-sided position seeded at init. No 6909 minted, position lives in PoolManager keyed by `(hook, tickLower, tickUpper, salt=0)`, the hook IS the position owner.
2. Graduated-phase + CLANKER_V3 locked LP: hook calls `pm.modifyLiquidity`, then `afterAddLiquidity` mints a 6909 with `tokenId = uint256(keccak256(PoolId || tickLower || tickUpper || salt))` to `LOCKED_VAULT`. The 6909 is a bookkeeping receipt; `beforeRemoveLiquidity` enforces immutability. Fee harvesting bypasses 6909 entirely: hook calls `pm.modifyLiquidity(liquidityDelta=0)` from afterSwap or a permissioned `harvest()`.

`LOCKED_VAULT` is immutable on the hook constructor (audit-fix pattern from V3 locker) so a compromised hook owner cannot redirect locked positions to a malicious recipient.

## Anti-Sniper Hook (carried forward from V4 prototype)

The existing `ArcadeAntiSniperHook.sol` (~294 LoC) is well-commented for the narrow sniper-tax scope and has audit fixes from commit 16afe44 already applied. Its logic ports verbatim into the unified `ArcadeHook`:

- `beforeSwap` exact-input: `skim = (amountIn * currentSnipeBps(token)) / 10_000`, `pm.take(USDC, treasury, skim)`, return positive `int128` on specified.
- `afterSwap` exact-output: same math but on the realized USDC leg, return positive `int128` on unspecified.
- `currentSnipeBps(token)` reads `snipeStartBps, snipeDecaySeconds, launchedAt` from the per-launch struct and linearly decays.

The V4 improvement: V2 router-based bypass closes. Every swap routes through PoolManager which dispatches to the hook, so aggregators, MEV bots, and direct router calls all pay the tax.

## Migration Phases

### Phase 1: Contract dev (6-10 weeks)

Write `contracts/v4src/ArcadeHook.sol` (~1,100 LoC). Port curve math 1:1 from `ArcadeLaunchpad._computeBuy / _computeSell` and verify against JSON fixtures extracted in Phase 0. Implement graduation routine, dynamic-fee override, ERC-6909 locked-position bookkeeping, FeeOwner registry, Twitter-escrow shim. Mine hook salt for 10-flag bitmap (hours of compute on commodity hardware; ~14 bits of address entropy). Foundry test suite at >=90% line coverage with sign-convention property tests as the FIRST tests written.

### Phase 2: Testnet deploy (2-3 weeks)

Deploy `ArcadeHook` to Arc testnet (chainId 5042002) via the mined CREATE2 salt. End-to-end PUMP launch: 20 curve buys, graduation tx, 10 post-graduation swaps, royalty paid, Twitter-escrow credit verified. Internal multi-agent audit pass mirroring the methodology of commit 16afe44. Gas profiling target: curve buy <= 200k, graduation-crossing swap <= 500k, steady-state swap <= 250k.

### Phase 3: Frontend integration (4-6 weeks, parallel)

Add V4 module to `web/` behind `NEXT_PUBLIC_ENABLE_V4` feature flag. Token detail page version-detects per token (V2 pair address vs V4 PoolId) and routes to the correct ABI. Comments table moves to off-chain Vercel KV. Soft banner: factual, no urgency words. Indexer unions V2 + V4 events into one feed.

### Phase 4: Mainnet ship (1-2 weeks, gated on audit)

Mine mainnet hook salt. Deploy `ArcadeHook` + `ArcadeV4SwapRouter` + redeploy or `updateLocker` on `ArcadeTwitterEscrowV3`. Backend `launchpad.defaultEngine` flips to `'v4'`. V2 `launchpad.createToken` paused via Ownable, all other V2 paths remain open forever. Multisig finalized for hook ownership.

### Phase 5: V2 sunset (optional, 3-6 months monitoring)

V2 keeps trading forever for all pre-V4 tokens. Optional voluntary creator-initiated V2-to-V4 migration tool for graduated V2 tokens (never for pre-graduation curve tokens). No forced migration. Frontend gradually de-emphasizes V2 launchpad creation flow but never removes V2 token pages.

## Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Callback access control bypass (Cork class) | HIGH | Every `IHooks` callback starts with `require(msg.sender == address(POOL_MANAGER))`. `beforeInitialize` additionally enforces `sender == address(this)`. |
| Unauthorized pool initialization with the Arcade hook | HIGH | `beforeInitialize` validates the pool is registered in `launches[]` and uses USDC. |
| BeforeSwapDelta sign-convention error (Bunni class) | HIGH | Sign-convention property test as the FIRST test in the suite, before production curve code is written. |
| Rounding-direction error in curve math (Bunni class) | HIGH | Round amountOut DOWN on buys AND sells. Invariant test: K never decreases on buy or sell; round-trip USDC balance only grows. |
| Hook permission flag mis-mining | HIGH | Constructor-time assertion `uint160(address(this)) & ALL_HOOK_MASK == PERMISSIONS`. Deploy ceremony verifies salt produces exact expected address before `setHook`. |
| Graduation state machine partial-failure bricks pool | HIGH | Three-state enum (`Curving` / `GraduationStarted` / `Graduated`). All concurrent swaps revert during `GraduationStarted`. |
| Reentrancy via hook external calls (Twitter escrow) | HIGH | Wrap `creditSlot` call in `try/catch`. Hook trusts only `PoolManager`; treats every other external as untrusted. |
| Solo founder + no audit budget + novel custom-curve hook | HIGH | Hats vault on testnet for 30 days with 50k USDC TVL cap per pool. V4 opt-in only until Tier-2 audit clears. V2 stays as rollback target. |
| LP-locking bypass via zero-liquidity-delta harvest | MEDIUM | `beforeRemoveLiquidity` orders checks: zero-delta-from-self first, then locked check. |
| Dust-donate DoS | MEDIUM | `beforeDonate` reverts unconditionally; address bits exclude DONATE flags. |
| Transient storage race / leak | MEDIUM | Hook does not use transient storage directly in V1. If added later, fuzz under chisel replay. |
| JIT MEV in graduation block | MEDIUM | Detect `block.timestamp == launchedAt + 0` swaps and apply max snipe tax. Optional: first-swap-allowlist for creator. |
| Dynamic-fee sentinel mis-set | MEDIUM | Unit test verifies third return value of `beforeSwap` has high bit set. Pool init asserts `PoolKey.fee` has dynamic-fee sentinel (0x800000). |
| Gas-out on graduation tx hitting Arc 15M ceiling | MEDIUM | Profile worst-case path on forked Arc testnet. Add hook-side circuit breaker: skip `creditSlot` if remaining gas < `CRITICAL_RESERVE`. |
| Arc sequencer transient-storage edge cases not battle-tested | MEDIUM | Stress test on Arc testnet with V4 deploy before mainnet. Log findings in `project_arc_chain_issues.md`. |
| Indexer schema rework (PoolManager singleton vs per-pair events) | LOW | Drafted in Phase 0, built when Ponder budget arrives. RPC scan stopgap works at launch scale. |
| via_ir stack-too-deep on unified hook | LOW | Split helper functions, use `vm.serialize*` rather than `string.concat`, refer to `reference_via_ir_stack_gotcha`. |

## Audit Strategy

Layered approach matching budget reality.

**Tier 0 ($0, do now, 4-6 weeks of solo work).** Internal multi-agent audit pass mirroring commit 16afe44 methodology with V4-specific focus: BeforeSwapDelta sign correctness, callback access control, hook-permission-flag bit verification at deploy time, graduation atomicity, dust-donate defense, reentrancy via escrow. Trail of Bits V4 invariant suite ported to Foundry + Echidna. Slither + Aderyn with V4-aware modules. Peer review swap with 2-3 other V4 hook builders from the Hookrank leaderboard or Uniswap Discord.

**Tier 1 (Hats Finance vault on testnet, $0 upfront).** Open a Hats vault on `ArcadeHook` + `ArcadeV4SwapRouter` only. 1-2% of token treasury as bounty, 30-day continuous audit. Run the V4 hook on Arc testnet for 4-6 weeks with hard-coded 50k USDC TVL cap per pool.

**Tier 2 (Builders Fund grant, $25k-$75k).** One firm engagement: Pashov ($25-40k, public V4 track record), Zealynx ($15-25k, V4 invariant testing harness deliverable), or Cantina solo ($10-20k). Cantina competition ($15-30k pot) as second wave for residual MEDIUMs.

**Tier 3 (post-revenue, $150k+).** Spearbit or OpenZeppelin on the full V4 stack including any V2-to-V4 migration path. Certora formal verification on the curve invariant and graduation state machine.

CRITICAL: do NOT skip Tier 0 even if Tier 2 budget arrives. Both Cork and Bunni shipped audited code; the bugs were in custom hook logic that auditors did not stress-test with adversarial fuzzing. Tier 0 fuzzing catches the class of bug that audits historically miss.

## Decision Log Scaffolding (top 5 decisions for the founder)

1. **Inline graduation vs separate graduation tx.** Recommend inline with three-state enum gating reentry.
2. **Hook ownership model at mainnet.** Recommend multisig from day-1, pull from C1 roadmap.
3. **Dynamic-fee override vs explicit afterSwap royalty take.** Recommend explicit take for V1, revisit override post-Tier-2 audit.
4. **ERC-6909 locked claim token recipient.** Recommend immutable `LOCKED_VAULT` address, not `address(0)`.
5. **Bonding curve in V4 vs CLANKER_V3-only V4 first ship.** Recommend full curve with `modeEnabled[PUMP]` feature flag so CLANKER_V3 can ship first and PUMP enables after 4-6 weeks of clean mainnet operation.

## Open Questions

- Canonical Uniswap PoolManager deployment on Arc, or self-deploy?
- Arc sequencer transient-storage rollback correctness under revert.
- Worst-case graduation tx gas budget vs Arc 15M ceiling.
- Twitter escrow locker authorization: mapping or parallel instance?
- Voluntary V2-to-V4 creator migration tool: ship in Phase 6.5 or never?
- Curve math as a separate library vs inline in hook bytecode?
- First-swap-allowlist for JIT MEV residual?

## References

- `contracts/src/launchpad/ArcadeLaunchpad.sol` (1205 LoC, source of curve math fixtures)
- `contracts/v4src/ArcadeV4Launchpad.sol` (450 LoC, prototype scaffold)
- `contracts/v4src/ArcadeAntiSniperHook.sol` (294 LoC, ports verbatim into unified hook)
- `contracts/v4src/ArcadeV4SwapRouter.sol` (209 LoC, reusable as-is for V1)
- `contracts/src/launchpad/ArcadeTwitterEscrowV3.sol` (639 LoC, unchanged in V4)
- Cyfrin Uniswap V4 deep-dive (callback access control, BeforeSwapDelta encoding)
- Trail of Bits PoolManager invariant suite (Echidna port targets)
- Cork Protocol post-mortem (May 2025, $11M, missing `msg.sender == PoolManager`)
- Bunni V2 post-mortem (September 2025, $8.4M, rounding direction in custom LDF)
- Hacken "Mastering Transient Storage in Uniswap V4"
- Project memory: `project_arcade_v4_analysis.md`, `project_arcade_security_audit.md`, `reference_via_ir_stack_gotcha.md`
