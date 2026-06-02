# Arcade V4 Hook Specification

> Design freeze for the unified `ArcadeHook` contract that subsumes the
> Arcade V2 stack (Factory + Pair + Router + Launchpad + V3 Locker) into a
> single Uniswap V4 hook. Generated as Phase 0 of the V4 migration plan
> (see `v4-migration-scoping.md`). Implementations of `ArcadeHook.sol` MUST
> follow this spec verbatim. Curve math MUST replicate
> `contracts/test/fixtures/curve-vectors.json` bit-identically.
>
> Status: design freeze. No production Solidity is written against this
> spec until V2 mainnet has stabilised (per Phase 0 of the migration plan).

## 1. Scope

`ArcadeHook` is a single Solidity contract bound to one canonical
`PoolManager` singleton on Arc, implementing 10 V4 hook callbacks. It
absorbs every responsibility the V2 stack currently splits across 5
contracts:

| V2/V3 contract        | V4 fate              | Where the logic moves                         |
|-----------------------|----------------------|-----------------------------------------------|
| ArcadeV2Factory       | Deprecated           | PoolManager replaces it entirely              |
| ArcadeV2Pair          | Deprecated           | Pool state in PoolManager + curve in hook     |
| ArcadeV2ERC20         | Deprecated           | ERC-6909 claim tokens replace LP shares       |
| ArcadeV2Router        | Kept (peripheral)    | ArcadeV4SwapRouter (existing prototype)       |
| ArcadeLaunchpad       | Collapsed into hook  | beforeSwap + afterSwap + custom curve         |
| ArcadeLaunchToken     | Kept (unchanged)     | Still the 1B-supply ERC20                     |
| ArcadeTokenVault      | Kept (unchanged)     | Vested team allocations                       |
| ArcadeTwitterEscrowV3 | Kept (unchanged)     | Locker field re-points at hook address        |
| ArcadeV3Locker        | Deprecated           | ERC-6909 + LOCKED_VAULT replace the NFT lock  |
| ArcadeMultiSwap       | Optional             | V4 Universal Router + path multi-hop covers   |

Target line count: ~1,100 LoC of new hook code. ~210 LoC reused from the
existing `ArcadeV4SwapRouter.sol` prototype.

## 2. State layout (frozen)

```solidity
struct CurveState {
    uint128 virtualUsdcReserve;      // 5_000e6 USDC at init, immutable per-pool
    uint128 realUsdcReserve;         // climbs to 20_000e6 at graduation
    uint128 tokensSold;              // climbs to CURVE_SUPPLY (8e26)
    uint8   mode;                    // 0=PUMP, 1=CLANKER, 2=CLANKER_V3
    uint8   status;                  // 0=Curving, 1=GraduationStarted, 2=Graduated
    address creator;                 // primary fee recipient
    address creator2;                // optional secondary recipient (CLANKER mode)
    uint16  creator2Bps;             // share of creator fee that routes to creator2
}

struct FeeOwner {
    address creator;
    address creator2;
    uint16  creator2Bps;
    address twitterEscrow;           // zero address = direct transfer, non-zero = creditSlot
    uint8   slotIndex;               // 0..3, used when twitterEscrow != address(0)
}

struct PositionInfo {
    address owner;                   // for unlocked positions, the LP. for locked positions, the LOCKED_VAULT.
    uint128 liquidity;
    bool    locked;
}

mapping(PoolId => CurveState)   public curveStates;
mapping(PoolId => FeeOwner)     public feeOwners;
mapping(bytes32 => PositionInfo) public positions;     // keccak(PoolId, tickLower, tickUpper, salt)
mapping(address => bool)         public registeredLaunches;
address public immutable POOL_MANAGER;
address public immutable USDC;
address public immutable LOCKED_VAULT;                 // immutable receipient for locked LP claim tokens
address public immutable TREASURY;
address public twitterEscrow;                          // owner-mutable for migration flexibility
address public owner;                                  // Ownable2Step
```

State size budget: each CurveState is 5 storage slots, each FeeOwner is 3,
each PositionInfo is 2. At 1000 launches: ~10kSSTORE on init, dominated by
CurveState writes.

## 3. Hook permission flags (frozen)

Address bit pattern (the CREATE2 salt mines for these exact bits):

| Bit | Flag                                | Set? | Rationale                                      |
|-----|-------------------------------------|------|------------------------------------------------|
| 13  | BEFORE_INITIALIZE_FLAG              | YES  | Validate launch is registered, USDC pair      |
| 12  | AFTER_INITIALIZE_FLAG               | YES  | Emit launch event, set immutable fee config   |
| 11  | BEFORE_ADD_LIQUIDITY_FLAG           | YES  | Reject all add-liquidity except from self     |
| 10  | AFTER_ADD_LIQUIDITY_FLAG            | YES  | Mint ERC-6909 to LOCKED_VAULT for clanker LP  |
| 9   | BEFORE_REMOVE_LIQUIDITY_FLAG        | YES  | Block remove on locked positions              |
| 8   | AFTER_REMOVE_LIQUIDITY_FLAG         | NO   | Not needed                                    |
| 7   | BEFORE_SWAP_FLAG                    | YES  | Run bonding curve + graduation + anti-sniper  |
| 6   | AFTER_SWAP_FLAG                     | YES  | Royalty split + Twitter escrow credit         |
| 5   | BEFORE_DONATE_FLAG                  | NO   | Defense against dust-donate DoS               |
| 4   | AFTER_DONATE_FLAG                   | NO   | Defense against dust-donate DoS               |
| 3   | BEFORE_SWAP_RETURNS_DELTA_FLAG      | YES  | Custom curve returns BeforeSwapDelta          |
| 2   | AFTER_SWAP_RETURNS_DELTA_FLAG       | YES  | Royalty take returns delta on unspec side     |
| 1   | AFTER_ADD_LIQUIDITY_RETURNS_DELTA   | YES  | Used for V4-native fee skim during grad seed  |
| 0   | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA| NO   | Not needed                                    |

Bitmap value: `0b11_1110_1110_1100` = `0x3EEC` = decimal 16108.

The mined address MUST satisfy:
```
uint160(address(arcadeHook)) & 0x3FFF == 0x3EEC
```

Mining strategy: CREATE2 salt search until the lowest 14 bits match the
bitmap. Approximately `2^14 / 2 = 8192` iterations on average; trivial on
commodity hardware (~seconds). The deploy ceremony asserts the match at
constructor time and reverts if the mine missed.

## 4. Curve math (frozen)

Constants (replicated from `contracts/src/launchpad/ArcadeLaunchpad.sol`):

```solidity
uint256 public constant VIRTUAL_USDC_RESERVE  = 5_000e6;
uint256 public constant VIRTUAL_TOKEN_RESERVE = 1_000_000_000e18;
uint256 public constant CURVE_SUPPLY          = 800_000_000e18;
uint256 public constant TOTAL_SUPPLY          = 1_000_000_000e18;
uint256 public constant MIGRATION_LP_TOKENS   = 200_000_000e18;
uint256 public constant K_CONSTANT            = 5_000_000_000_000_000_000_000_000_000_000_000_000; // 5e36
uint256 public constant TRADE_FEE_BPS         = 100;     // 1%
uint256 public constant FEE_DENOMINATOR       = 10_000;
uint256 public constant MIGRATION_FEE         = 2_500e6; // 2,500 USDC
uint256 public constant GRADUATION_USDC       = 20_000e6;
```

### 4.1 Buy (exact-input USDC -> token)

```
fee = (grossIn * TRADE_FEE_BPS) / FEE_DENOMINATOR           # floor
netIn = grossIn - fee
currentUsdc = VIRTUAL_USDC_RESERVE + state.realUsdcReserve
currentTokens = VIRTUAL_TOKEN_RESERVE - state.tokensSold

newUsdcReserve = currentUsdc + netIn
newTokenReserve = K_CONSTANT / newUsdcReserve              # floor
desiredOut = currentTokens - newTokenReserve

maxOut = CURVE_SUPPLY - state.tokensSold

if desiredOut <= maxOut:
    tokensOut = desiredOut
    actualGross = grossIn
    refund = 0
else:
    tokensOut = maxOut
    capTokenReserve = currentTokens - maxOut
    capUsdcReserve = K_CONSTANT / capTokenReserve           # floor
    if K_CONSTANT % capTokenReserve != 0:
        capUsdcReserve += 1                                 # ceil
    actualNet = capUsdcReserve - currentUsdc
    actualGross = ceil(actualNet * FEE_DENOMINATOR /
                       (FEE_DENOMINATOR - TRADE_FEE_BPS))
    if actualGross > grossIn:
        actualGross = grossIn
    refund = grossIn - actualGross
```

State updates after a buy:

```
state.tokensSold += tokensOut
state.realUsdcReserve += (actualGross - fee)
```

### 4.2 Sell (exact-input token -> USDC)

```
currentUsdc = VIRTUAL_USDC_RESERVE + state.realUsdcReserve
currentTokens = VIRTUAL_TOKEN_RESERVE - state.tokensSold
newTokenReserve = currentTokens + tokensIn
newUsdcReserve = K_CONSTANT / newTokenReserve              # floor
grossOut = currentUsdc - newUsdcReserve
if grossOut > state.realUsdcReserve:
    grossOut = state.realUsdcReserve                       # dust safeguard

fee = (grossOut * TRADE_FEE_BPS) / FEE_DENOMINATOR
usdcOut = grossOut - fee
```

State updates:

```
state.tokensSold -= tokensIn
state.realUsdcReserve -= grossOut
```

### 4.3 Rounding policy (frozen)

- All `K_CONSTANT / x` divisions floor.
- The cap-path `capUsdcReserve` rounds UP when the modulus is non-zero so
  the cap is reachable.
- The cap-path `actualGross` rounds UP via ceil division so the user
  always covers the cap.
- The round-trip invariant MUST hold: a buy of X USDC followed by a sell of
  the same token amount produces strictly less than X USDC back to the
  user. Tested as `roundTripVectors` in `curve-vectors.json`.

### 4.4 Test vectors (frozen)

All curve cases that the V4 ArcadeHook implementation MUST match
bit-identically live in `contracts/test/fixtures/curve-vectors.json`.
Regenerate with `node contracts/test/fixtures/generate.mjs` if (and only if)
the V2 production curve math changes; otherwise treat as immutable.

## 5. Graduation state machine (frozen)

The CurveState `status` field is a 3-state enum:

```
0 = Curving           : pre-graduation. beforeSwap runs the curve.
1 = GraduationStarted : graduation tx is mid-flight. ALL swaps revert.
2 = Graduated         : post-graduation. beforeSwap runs the AMM + royalty.
```

Transition diagram:

```
                                                                
   Curving                                                          
                                                                
              first swap that crosses realUsdcReserve >=         
              GRADUATION_USDC (atomic, inside beforeSwap)        
                v                                                   
                                                                
   GraduationStarted    revert all concurrent swaps               
                                                                
              after seeding LP + taking MIGRATION_FEE             
                                                                
                v                                                   
                                                                
   Graduated                                                       
                                                                
```

`GraduationStarted` exists ONLY for the duration of the originating
transaction's unlock callback. No external state can ever observe this
status from outside the tx. Concurrent swaps that hit a pool mid-graduation
revert with `error GraduationInProgress()`.

Graduation routine (inside beforeSwap, when threshold crossed mid-swap):

```
1. state.status = Status.GraduationStarted
2. pm.take(USDC, TREASURY, MIGRATION_FEE)                        // 2,500 USDC
3. _seedGraduationLiquidity(key, MIGRATION_LP_TOKENS, 17_500e6)  // seed LP
4. state.status = Status.Graduated
5. continue with the remainder of the user's swap against canonical AMM
```

If step 3 reverts, the whole tx reverts and `status` remains `Curving`.
Next user swap that crosses the threshold retries from scratch.

## 6. Hook callbacks (frozen signatures)

### 6.1 beforeInitialize

```solidity
function beforeInitialize(
    address sender,
    PoolKey calldata key,
    uint160 sqrtPriceX96
) external returns (bytes4)
```

Required checks:
1. `msg.sender == address(POOL_MANAGER)` (Cork defense)
2. `sender == address(this)` (only the hook's own createLaunch can spawn)
3. The launch token is in `registeredLaunches`
4. Exactly one currency is USDC

Returns `IHooks.beforeInitialize.selector`. Reverts otherwise.

### 6.2 beforeSwap

```solidity
function beforeSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    bytes calldata hookData
) external returns (bytes4, BeforeSwapDelta, uint24)
```

Branching:

| state.status     | Behaviour                                                  |
|------------------|------------------------------------------------------------|
| Curving          | Run curve math, return delta that neutralises canonical AMM|
| GraduationStarted| Revert with `GraduationInProgress()`                       |
| Graduated        | Apply anti-sniper tax if window active, otherwise zero delta|

The third return value (`uint24`) is the dynamic fee with
`LPFeeLibrary.OVERRIDE_FEE_FLAG` set. During curving, this carries
`TRADE_FEE_BPS` (100 bps = 1%). Post-graduation, it carries the dynamic
fee computed from anti-sniper decay (0 if outside window).

### 6.3 afterSwap

```solidity
function afterSwap(
    address sender,
    PoolKey calldata key,
    IPoolManager.SwapParams calldata params,
    BalanceDelta delta,
    bytes calldata hookData
) external returns (bytes4, int128)
```

Behaviour:

| state.status | Behaviour                                                                                  |
|--------------|--------------------------------------------------------------------------------------------|
| Curving      | Return `(selector, 0)`. Curve fee was already taken in beforeSwap.                         |
| Graduated    | Compute royalty split, take from PoolManager, return positive int128 on unspecified side.  |

Royalty split (frozen, see Section 8). Twitter escrow path wrapped in
`try/catch`; failures emit `EscrowCreditFailed(positionId, slot, amount)`
event and the tx succeeds (escrow downtime never breaks swaps).

### 6.4 beforeAddLiquidity

```solidity
function beforeAddLiquidity(
    address sender,
    PoolKey calldata key,
    IPoolManager.ModifyLiquidityParams calldata params,
    bytes calldata hookData
) external returns (bytes4)
```

Behaviour:

| state.status | mode      | sender         | Outcome                          |
|--------------|-----------|----------------|----------------------------------|
| Curving      | any       | any            | Revert. No LP during curving.    |
| Graduated    | PUMP/CLANK| address(this)  | Allow (graduation seed only).    |
| Graduated    | CLANKER_V3| any            | Revert. Single-sided LP locked.  |
| Graduated    | PUMP/CLANK| other          | Revert. LP for these pools is also locked. |

In practice the only valid call after graduation is the hook's own
graduation-seed call, plus optional fee-harvest with `liquidityDelta=0`.

### 6.5 afterAddLiquidity

```solidity
function afterAddLiquidity(
    address sender,
    PoolKey calldata key,
    IPoolManager.ModifyLiquidityParams calldata params,
    BalanceDelta delta,
    BalanceDelta feesAccrued,
    bytes calldata hookData
) external returns (bytes4, BalanceDelta)
```

Behaviour:

For graduation-seed and CLANKER_V3-init positions:
```
positionKey = keccak256(poolId, tickLower, tickUpper, salt)
positions[positionKey] = PositionInfo({
    owner: feeOwners[poolId].creator,   // for fee accounting only
    liquidity: uint128(params.liquidityDelta),
    locked: true
})
_mint6909(LOCKED_VAULT, uint256(positionKey), uint128(params.liquidityDelta))
return (selector, BalanceDeltaLibrary.ZERO_DELTA)
```

For non-locked positions (none in V1; reserved for future PUMP mode
post-graduation LP if added later):
```
positions[positionKey] = PositionInfo({
    owner: sender,
    liquidity: uint128(params.liquidityDelta),
    locked: false
})
return (selector, BalanceDeltaLibrary.ZERO_DELTA)
```

### 6.6 beforeRemoveLiquidity

```solidity
function beforeRemoveLiquidity(
    address sender,
    PoolKey calldata key,
    IPoolManager.ModifyLiquidityParams calldata params,
    bytes calldata hookData
) external returns (bytes4)
```

**Order of checks is load-bearing**:
1. If `params.liquidityDelta == 0 && sender == address(this)`: allow (fee
   harvest path).
2. Compute `positionKey`. If `positions[positionKey].locked == true`: revert
   `error LockedPosition()`.
3. Otherwise, allow.

Step 1 MUST come before step 2. Inverting them creates a fee-harvest bypass
on locked positions.

### 6.7 beforeDonate / afterDonate

Both reverted with `error HookNotImplemented()`. The mined hook address
MUST have zero bits at positions 5 and 4 of the address, making the
PoolManager skip these callbacks entirely. Belt-and-suspenders defense
against dust-donate DoS.

## 7. Dynamic-fee policy (frozen, Decision 3 = Option B explicit take)

Per the V4 scoping document, V1 uses **explicit afterSwap take** for the
post-graduation royalty, NOT dynamic-fee override on the LP fee.

Reason: explicit take is easier to invariant-test and easier to audit. The
dynamic-fee override path has a silent-failure mode (sentinel not set at
pool init = fees ignored) that we want to avoid in the audit-budget-zero
launch window.

Concretely, the third return value of `beforeSwap` is:

```
during Curving:    TRADE_FEE_BPS | LPFeeLibrary.OVERRIDE_FEE_FLAG    (curve fee 1%)
during Graduated:  0 | LPFeeLibrary.OVERRIDE_FEE_FLAG                (LP fee zero, royalty taken in afterSwap)
```

The `afterSwap` callback then explicitly calls `pm.take(USDC, recipient, X)`
for each royalty bucket. This makes every fee leg show up in the
BalanceDelta returned to the swapper, with no off-book accounting.

Post-audit revisit: V2 of the spec may switch to dynamic-fee override once
we have invariant test coverage on the override path. Until then, keep
explicit take.

## 8. Royalty distribution (frozen)

Per launch mode, post-graduation:

| Mode       | Creator   | Treasury  | Notes                                |
|------------|-----------|-----------|--------------------------------------|
| PUMP       | 50%       | 50%       | Default mode, balanced split         |
| CLANKER    | 70%       | 30%       | Higher creator share, V2 LP target   |
| CLANKER_V3 | 80%       | 20%       | Maximum creator share, V3 locked LP  |

The 0.30% post-graduation total royalty bps is applied to the USDC leg of
each swap. Computed in afterSwap:

```solidity
uint256 usdcLeg = uint256(int256(delta.amount0() < 0 ? -delta.amount0() : delta.amount1()));
uint256 totalRoyalty = (usdcLeg * 30) / 10_000;   // 0.30%
FeeOwner memory fo = feeOwners[key.toId()];
uint256 creatorCut = (totalRoyalty * MODE_CREATOR_BPS[mode]) / 10_000;
uint256 treasuryCut = totalRoyalty - creatorCut;

if (fo.creator2 != address(0) && fo.creator2Bps > 0) {
    uint256 creator2Cut = (creatorCut * fo.creator2Bps) / 10_000;
    creatorCut -= creator2Cut;
    pm.take(USDC, fo.creator2, creator2Cut);
}

if (fo.twitterEscrow != address(0)) {
    try IArcadeTwitterEscrow(fo.twitterEscrow).creditSlot(
        positionId, fo.slotIndex, USDC, creatorCut
    ) {
        pm.take(USDC, fo.twitterEscrow, creatorCut);
    } catch {
        // Twitter escrow paused or broken: route directly to creator
        pm.take(USDC, fo.creator, creatorCut);
        emit EscrowCreditFailed(positionId, fo.slotIndex, creatorCut);
    }
} else {
    pm.take(USDC, fo.creator, creatorCut);
}

pm.take(USDC, TREASURY, treasuryCut);
```

Return value of afterSwap is `int128(int256(totalRoyalty))` on the
unspecified side, so the user pays.

## 9. ERC-6909 locked claim tokens (frozen)

V4's native ERC-6909 multi-token claim represents LP positions. Arcade
locks them by:

1. Hook calls `pm.modifyLiquidity` to mint liquidity.
2. `afterAddLiquidity` mints a fresh 6909 with `tokenId = uint256(positionKey)`
   to `LOCKED_VAULT`.
3. `LOCKED_VAULT` is a separate immutable contract whose only purpose is
   to hold these tokens. It exposes no transfer function. Effectively burn.

`LOCKED_VAULT` is set at hook constructor and immutable. Audit-fix pattern:
prevents a compromised hook owner from redirecting locked positions.

Fee harvesting on locked positions:
- Hook calls `pm.modifyLiquidity(key, params with liquidityDelta=0, ...)`
- This routes through `beforeRemoveLiquidity` which allows when `liquidityDelta=0 && sender=self`
- Fees accrue to the hook, then split per Section 8

## 10. Anti-sniper tax (frozen, port from existing prototype)

Reuses semantics of `contracts/v4src/ArcadeAntiSniperHook.sol`:

```solidity
function currentSnipeBps(address token) internal view returns (uint16) {
    SnipeConfig memory cfg = snipeConfigs[token];
    if (cfg.startBps == 0) return 0;
    uint256 elapsed = block.timestamp - cfg.launchedAt;
    if (elapsed >= cfg.decaySeconds) return 0;
    return uint16((cfg.startBps * (cfg.decaySeconds - elapsed)) / cfg.decaySeconds);
}
```

The tax applies in beforeSwap (exact-input buys) and afterSwap (exact-output
buys) post-graduation:

```solidity
// in beforeSwap, post-graduation, exact-input buy
uint256 skim = (uint256(params.amountSpecified < 0 ? -params.amountSpecified : params.amountSpecified) * snipeBps) / 10_000;
pm.take(USDC, TREASURY, skim);
return (selector, toBeforeSwapDelta(int128(int256(skim)), 0), 0 | OVERRIDE_FEE_FLAG);

// in afterSwap, post-graduation, exact-output buy
uint256 usdcLeg = uint256(int256(delta.amount0() < 0 ? -delta.amount0() : delta.amount1()));
uint256 skim = (usdcLeg * snipeBps) / 10_000;
pm.take(USDC, TREASURY, skim);
return (selector, int128(int256(skim)));
```

## 11. Twitter escrow integration (frozen)

The escrow contract (`ArcadeTwitterEscrowV3`) stays unchanged. Its
`updateLocker(newLocker)` admin call gets pointed at the V4 hook address
during the Phase 4 mainnet ship. Or we extend the escrow's authorisation
to a `mapping(address => bool) authorised` so V3 locker AND V4 hook can
both credit.

Recommendation: extend to a mapping. Smaller migration risk; both stacks
can coexist forever for any pool that was already migrated.

Hook calls `escrow.creditSlot(positionId, slot, token, amount)` from the
afterSwap royalty path (Section 8). All calls wrapped in try/catch so a
paused escrow does not break swap UX.

## 12. Owner controls + pause

Inherits `Ownable2Step + Pausable + ReentrancyGuard` per the V2 audit
patterns. Owner powers (whitelisted, audited at Phase 4):

- `pause()` / `unpause()`: blocks `createLaunch` only. Does NOT block
  swaps on existing pools. Swaps stay live during incident response.
- `setTwitterEscrow(address)`: rotate the escrow target.
- `setTreasury(address)`: rotate fee recipient.
- `setSnipeConfig(token, startBps, decaySeconds)`: configure anti-sniper
  per token, settable at launch and immutable after the first launch buy.

Owner CANNOT:
- Reach into individual pools to drain liquidity.
- Modify locked positions.
- Modify graduation thresholds (per-pool, set at init).
- Change curve constants (compile-time constants).

Recommend multisig ownership from Day 1 (per migration plan Decision 2).

## 13. Error codes (frozen)

```solidity
error NotPoolManager();
error OnlyLaunchpad();                 // beforeInitialize sender check
error LaunchNotRegistered();
error NotUsdcPair();
error GraduationInProgress();          // reverts during status==1
error LockedPosition();                // remove-liquidity on locked
error LiquidityNotPermitted();         // add-liquidity when curving
error HookNotImplemented();            // donate callbacks
error ZeroAmount();
error InvalidMode();
error InvalidFeeOwner();
error InvariantBroken();               // catch-all for math sanity
```

## 14. Events (frozen)

```solidity
event LaunchCreated(PoolId indexed poolId, address indexed token, address creator, uint8 mode);
event CurveBuy(PoolId indexed poolId, address indexed buyer, uint256 grossUsdcIn, uint256 tokensOut);
event CurveSell(PoolId indexed poolId, address indexed seller, uint256 tokensIn, uint256 usdcOut);
event Graduated(PoolId indexed poolId, uint256 finalUsdcReserve, uint256 tokensInLP);
event RoyaltyPaid(PoolId indexed poolId, address indexed creator, uint256 creatorAmount, uint256 treasuryAmount);
event AntiSnipeApplied(PoolId indexed poolId, address indexed sniper, uint256 amount, uint16 bps);
event EscrowCreditFailed(uint256 indexed positionId, uint8 slot, uint256 amount);
event PositionLocked(bytes32 indexed positionKey, address indexed owner, uint128 liquidity);
event FeeHarvested(bytes32 indexed positionKey, uint256 amount0, uint256 amount1);
```

## 15. Open questions (deferred to Phase 1)

These are flagged in `v4-migration-scoping.md` and are not blocked by this
spec but inform implementation:

1. Canonical PoolManager on Arc, or self-deploy? Affects POOL_MANAGER
   immutable choice.
2. Arc sequencer transient-storage rollback under revert: empirically test
   on testnet before relying on transient storage at all.
3. Worst-case graduation tx gas budget vs Arc 15M ceiling.
4. Twitter escrow authorisation model (mapping vs parallel instance).
5. First-swap allowlist for JIT MEV residual.

## 16. References

- `contracts/src/launchpad/ArcadeLaunchpad.sol` (V2 curve math source)
- `contracts/test/fixtures/curve-vectors.json` (test vectors locked)
- `contracts/v4src/ArcadeV4Launchpad.sol` (prototype scaffold)
- `contracts/v4src/ArcadeAntiSniperHook.sol` (anti-sniper port source)
- `contracts/v4src/ArcadeV4SwapRouter.sol` (router reuse target)
- `v4-migration-scoping.md` (the phased migration plan)
- Cork Protocol post-mortem (callback access control)
- Bunni V2 post-mortem (rounding direction in custom curve)
- Uniswap V4 hook docs at `https://docs.uniswap.org/contracts/v4/concepts/hooks`
