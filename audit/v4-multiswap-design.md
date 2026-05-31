# ArcadeMultiSwap V4 path — design

Status: **deferred** — frontend nudge ships now (V4RoutingNotice), contract
extension is a separate ~2-3 day work item.

## Why not yet

`ArcadeMultiSwap` currently routes through V2 + V3 pools (and through the
launchpad's `swapMigratedRoute` for migrated tokens that still carry creator
royalties on the V2 leg). Adding V4 means:

1. Recognising at call-time whether each input/output token is a V4 launch
   (= registered in `ArcadeV4Launchpad`).
2. Pulling the input from the user, sending it into `ArcadeV4SwapRouter`
   instead of the V2 router for that leg.
3. Handling the lock-and-call pattern: V4 swaps run inside
   `poolManager.unlock` and require the router contract (NOT the
   aggregator) to be the caller. So the aggregator either delegates each
   V4 leg to the V4 router, or implements its own `IUnlockCallback`.
4. Reconciling the resulting balances (V4 router takes output to a
   `recipient`, so the aggregator must set `recipient = address(this)` and
   then forward to the user after slippage checks).

These changes are atomic in scope and benefit from their own audit pass —
mixing them with the existing V2/V3 audit findings would be noisy.

## Proposed delta to `ArcadeMultiSwap`

```solidity
// New deps
ArcadeV4SwapRouter public immutable V4_ROUTER;
IArcadeV4Launchpad public immutable V4_LAUNCHPAD;

constructor(
    IERC20 usdc_,
    IArcadeV2Factory factory_,
    ArcadeV2Router router_,
    IArcadeLaunchpad launchpad_,
    IArcadeV3Router v3Router_,
    ArcadeV4SwapRouter v4Router_,      // NEW
    IArcadeV4Launchpad v4Launchpad_    // NEW
) { ... }

function _routeLeg(address tokenIn, address tokenOut, uint256 amountIn)
    internal returns (uint256 amountOut)
{
    // V4 takes priority when the token is registered in the V4 launchpad.
    // Otherwise fall back to the existing V2/V3 path.
    if (_isV4Token(tokenIn) || _isV4Token(tokenOut)) {
        return _swapV4(tokenIn, tokenOut, amountIn);
    }
    return _swapV2V3(tokenIn, tokenOut, amountIn);  // existing path
}

function _swapV4(address tokenIn, address tokenOut, uint256 amountIn)
    internal returns (uint256 amountOut)
{
    // Pull tokenIn into the aggregator, approve V4 router.
    IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
    IERC20(tokenIn).safeApprove(address(V4_ROUTER), amountIn);

    // Look up the launch's PoolKey from the V4 launchpad.
    ArcadeV4Launchpad.Launch memory l = V4_LAUNCHPAD.getLaunch(
        _isV4Token(tokenIn) ? tokenIn : tokenOut
    );
    bool tokenIsCurrency0 =
        Currency.unwrap(l.poolKey.currency0) == (_isV4Token(tokenIn) ? tokenIn : tokenOut);
    bool zeroForOne = _isV4Token(tokenIn) ? !tokenIsCurrency0 : tokenIsCurrency0;
    // Aggregator-internal slippage is 0; final slippage enforced at the
    // outer multi-leg level.
    amountOut = V4_ROUTER.exactInputSingle(
        l.poolKey, zeroForOne, amountIn, 0, address(this), 0
    );
}
```

## Steps

1. Add `V4_ROUTER` + `V4_LAUNCHPAD` to constructor; nullable to keep V4
   integration optional (mirrors the locker→escrow pattern).
2. Write `_isV4Token(addr)` view (a single `getLaunch(addr).token != 0`
   probe — no per-call gas hit beyond the SLOAD).
3. Add `_swapV4` and dispatch from `_routeLeg`.
4. Tests:
   - Single V4 leg (USDC → V4 token, V4 token → USDC).
   - Cross-version: V2 leg + V4 leg in the same multi-input swap.
   - V4 token not registered → falls back to V2 (or reverts cleanly).
5. Deploy script: `DeployTestnet.s.sol` needs to pass the V4 router +
   launchpad addresses to `new ArcadeMultiSwap(...)`.

## Test strategy

- New file `contracts/test/MultiSwapV4Integration.t.sol` reusing the
  `LockerEscrowIntegration.t.sol` setup pattern: deploys the full
  launchpad/locker/router stack PLUS the V4 PoolManager via the v4-core
  bytecode, and a fresh `ArcadeMultiSwap` wired to both. Tests run against
  a real V4 swap (not a mock).
- Reuse the existing V4 swap router tests for the leg-level guarantees;
  this suite focuses on the **aggregator-level** invariants (slippage,
  refund of leftover input, recipient enforcement).

## Effort

~2 days dev + 1 day tests + 0.5 day audit-pass. Pre-mainnet only.

## Frontend nudge that ships now

`web/components/swap/V4RoutingNotice.tsx` renders inside the swap card
whenever either token is a V4 launch and links the user to the dedicated
`/launchpad/v4/[address]` swap panel. No silent failures and no degraded
routes.
