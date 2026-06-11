# Deploy gen 9 — runbook

> Last verified 2026-06-11. Builds on `DEPLOY_GEN8.md`. Use this checklist
> top-to-bottom — every step has a rollback note in case something goes
> sideways mid-deploy.

## What's in gen 9

Audit follow-up redeploy on top of gen 8. Changed contracts:

- **ArcadeLaunchpad** — `swapMigratedRoute` revert `MidSlippage` (audit
  contract #10); migrated route now takes a `usdcMidMin` parameter.
  Custom error swap saves ~80 bytes vs the prior `require` string.
- **ArcadeV3SwapRouter** — `exactInputThroughUsdc` applies the sell-side
  anti-sniper skim on leg 1 (audit CONTRACT-1 / V3-3 multi-hop bypass).
- **ArcadeV3Locker** — new `rotateSlot(positionId, index, newRecipient,
  newAdmin)` atomic setter (audit CONTRACT-2 / L-4 deadlock fix).
- **ArcadeTwitterEscrowV3** — `claimByTwitter` calls `rotateSlot` BEFORE
  the safeTransfers (audit v2 G9-4 anti-reentrancy on ERC-777 tokens);
  `forfeitStaleClaim` pull-payment ledger via `pendingForfeit` + new
  `withdrawForfeitFailure(token)` recovery function (audit v2 G9-3
  double-pay window).
- **ArcadeMultiSwap** — threads a real `usdcMidMin` floor into the
  migrated route via inline `quoteSwapMigratedRoute` (audit v2 G9-1
  bypass); BAL_DRIFT check uses `>=` instead of `==` (audit v2 G9-2
  1-wei grief-DoS).

Unchanged (no redeploy needed): V2 Factory, V2 Router, Token Vault, V3
Factory, V3 NPM, V3 Quoter, V3 Position Descriptor.

## Pre-flight (do once)

```bash
cd contracts
forge build --sizes 2>&1 | grep -E "Arcade(Launchpad|TwitterEscrow|V3Locker|V3SwapRouter|MultiSwap)"
```

Expect every contract under EIP-170. ArcadeLaunchpad should land at
**24,482 / 24,576** locally (~94 B margin). CI forge nightly produces
~33 B larger bytecode (~61 B margin). If you see > 24,576 with `--sizes`,
STOP — drop a feature or extract a helper.

```bash
forge test --no-match-path "*v4*"
```

Expect **120 / 120 pass** including the new `MockLocker.rotateSlot`
exercising the canonical claim success path (was running through the
catch branch pre-CRIT-1 fix).

If either fails: STOP. Open `AUDIT_PROGRESS.md`, find the divergence,
fix or revert before proceeding.

## Step 1 — Set env vars locally

```bash
export PRIVATE_KEY=<deployer hex key, 0x-prefixed>
export ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
export ARC_WETH_ADDRESS=0x9570EBA9eE39Aa4933f64d6add280faAB289a847
export TREASURY_ADDRESS=0x3a0Dd90212838f32a953Acd4B32596b62859324A
# Twitter escrow optional; pass 0 to skip the integration
export TWITTER_ESCROW_ADDRESS=0x0000000000000000000000000000000000000000
```

Verify the deployer has enough Arc testnet USDC for gas (~5 USDC covers
a full redeploy):

```bash
cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url arc
```

## Step 2 — Build V3 profile artifacts

```bash
FOUNDRY_PROFILE=v3 forge build
```

V3 contracts compile with their own profile (solc 0.7.6) and land in
`out-v3/`. The deploy script reads from there via
`vm.getCode("out-v3/X.sol/X.json")`.

## Step 3 — Patch v3-periphery init hash

Before any forge create that compiles `ArcadeV3PositionManager`:

```bash
bash scripts/patch-v3-periphery.sh
```

Idempotent — re-running is a no-op. Required because Forge's
`bytecode_hash=none` setting produces a different runtime hash than
Hardhat's default (memory reference: `project_arcade_v3_init_hash`).

## Step 4 — Deploy

```bash
forge script script/DeploySecurityV3.s.sol \
  --rpc-url arc \
  --broadcast \
  --private-key $PRIVATE_KEY \
  2>&1 | tee deploy_log_gen9.txt
```

`deploy_log_*.txt` is in `.gitignore` (audit C-1).

The script prints every address as it goes. Save the output for the
records.

## Step 5 — Manual deploys (NPM + Zap + Descriptor)

The deploy script DOES NOT deploy these three because they have custom
constructors that depend on previous deployments. Same flow as gen 8:

```bash
# 1. Descriptor (no constructor args)
FOUNDRY_PROFILE=v3 forge create \
  v3src/ArcadeV3PositionDescriptor.sol:ArcadeV3PositionDescriptor \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY --broadcast
# Note `Deployed to:` => $V3_DESCRIPTOR

# 2. NPM (factory, WETH, descriptor)
FOUNDRY_PROFILE=v3 forge create \
  v3src/ArcadeV3PositionManager.sol:ArcadeV3PositionManager \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY --broadcast \
  --constructor-args $V3_FACTORY $ARC_WETH_ADDRESS $V3_DESCRIPTOR
# Note `Deployed to:` => $V3_NPM

# 3. Zap (factory, NPM)
FOUNDRY_PROFILE=v3 forge create \
  v3src/ArcadeV3Zap.sol:ArcadeV3Zap \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY --broadcast \
  --constructor-args $V3_FACTORY $V3_NPM
# Note `Deployed to:` => $V3_ZAP
```

## Step 6 — Wire optional infra

The deploy script handles `setV3Infra` + V3 fee tier enable + `setFeeTo`
automatically. Verify with:

```bash
cast call <launchpad-addr> "v3Locker()(address)" --rpc-url arc
cast call <launchpad-addr> "v3Router()(address)" --rpc-url arc
cast call <launchpad-addr> "tokenVault()(address)" --rpc-url arc
```

All three should return non-zero.

## Step 7 — Smoke tests (manual)

Run each in order. If any fails, the deploy is bad and gen 9 must NOT
replace gen 8 in Vercel env.

### Test 1 — CONTRACT-1: V3 multi-hop sell-tax bypass

```bash
# 1. Create a CLANKER_V3 launch with snipeStartBps > 0.
# 2. From a separate wallet, execute exactInputThroughUsdc on the V3
#    router with tokenIn = launchToken, tokenOut = some other launchToken.
# 3. Inspect treasury USDC + launchToken balance. Treasury MUST receive
#    the sell-side skim on leg 1 (the prior gen 8 router skipped it).
cast call $TREASURY "balanceOf(address)(uint256)" --rpc-url arc
```

PASS: treasury delta == amountIn * currentSnipeBps(tokenIn) / 10000.
FAIL: treasury unchanged.

### Test 2 — CONTRACT-2: L-4 deadlock resolved

```bash
# 1. Run a full claimByTwitter flow end-to-end (authorize + wait
#    timelock + claim).
# 2. Inspect the locker's recipient + admin for the claimed slot.
cast call $V3_LOCKER "getRecipients(uint256)((address,address,uint256,uint8)[])" $POSITION_ID --rpc-url arc
```

PASS: slot.recipient == user, slot.admin == user (both flipped from
escrow). FAIL: slot still shows (escrow, escrow) — old gen 8 bug.

### Test 3 — Contract #10: MidSlippage enforced

```bash
# Call swapMigratedRoute with usdcMidMin = MAX_UINT256.
# Expect: tx reverts with MidSlippage() (custom error, not "MID_SLIPPAGE"
# string from gen 8).
cast send $LAUNCHPAD \
  "swapMigratedRoute(address,address,uint256,uint256,uint256,uint256)" \
  $TOKEN_A $TOKEN_B 1000000000 0 $(cast --to-uint256 max) \
  $(cast --max-uint) \
  --rpc-url arc --private-key $PRIVATE_KEY
```

### Test 4 — G9-3: forfeit pull-payment recovery

```bash
# 1. Set up a forfeit scenario where one of the safeTransfers reverts
#    (use a paused or blacklisting token).
# 2. Run forfeitStaleClaim.
# 3. Read pendingForfeit[token][to] — should equal the un-paid amount.
# 4. Call withdrawForfeitFailure(token) from `to`.
cast call $ESCROW "pendingForfeit(address,address)(uint256)" $TOKEN $TO --rpc-url arc
```

### Test 5 — G9-2: BAL_DRIFT no longer 1-wei griefable

```bash
# 1. Transfer 1 wei USDC TO the MultiSwap address.
# 2. Call MultiSwap's swap routing through a migrated leg.
# Should NOT revert with BAL_DRIFT now (>= not ==).
```

## Step 8 — Update Vercel env vars

In Vercel project → Settings → Environment Variables, update with the
new addresses from `deploy_log_gen9.txt`:

```
NEXT_PUBLIC_LAUNCHPAD_ADDRESS
NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS
NEXT_PUBLIC_V3_LOCKER_ADDRESS
NEXT_PUBLIC_V3_ROUTER_ADDRESS
NEXT_PUBLIC_V3_NPM_ADDRESS
NEXT_PUBLIC_V3_ZAP_ADDRESS
NEXT_PUBLIC_MULTISWAP_ADDRESS
```

Vercel rebuilds automatically. Don't update the V2 Factory / V2 Router
/ Token Vault — they don't change in gen 9.

## Step 9 — Post-deploy verification

After Vercel rebuilds (~2 min):

- `/admin` confirms connected wallet shows OWNER for the escrow.
- `/admin/observability` Sentry stub renders.
- Run a swap USDC → EURC via Synthra.
- Run a swap with a CLANKER_V3 token to verify the anti-sniper banner
  appears within the window.
- Run a sell on a CLANKER_V3 token via exactInputThroughUsdc to verify
  the gen 9 sell-side skim (CONTRACT-1) fires.
- Confirm Bridge resume from history flows correctly (B-1/B-2/B-3 still
  live).

## Rollback

If a critical issue surfaces post-deploy:

1. Revert Vercel env vars to gen 8 addresses (gen 8 contracts stay live
   — separate addresses, not upgrades).
2. Frontend resumes routing to gen 8 within ~2 min of the env var save.
3. File an incident note in `docs/incidents/<date>.md` with what broke
   and what the gen 9 fix that caused it was.
4. Don't redeploy gen 9 until the issue is reproduced and patched.

## Snapshot — gen 8 addresses (pre-deploy reference)

```
USDC          0x3600000000000000000000000000000000000000  (unchanged)
WETH          0x9570EBA9eE39Aa4933f64d6add280faAB289a847  (unchanged)
Treasury      0x3a0Dd90212838f32a953Acd4B32596b62859324A
V2 Factory    0xbF8E53206682C95D43CA35B3739A1D737067611a  (unchanged in gen 9)
V2 Router     0xe74dc7988b5FB9151f0fd388a4C30EbD0e58A694  (unchanged in gen 9)
V3 Factory    0x4774F5C79201A4f5b62a0d23064233a8b6382581  (unchanged in gen 9)
V3 NPM        0x7dfd779d77843Ef781b5346Aa86B985dCdF9757b  (CHANGES in gen 9)
V3 Zap        0x4Ad8cEC259671903dEfcE38518FCc905B773e73e  (CHANGES in gen 9)
V3 Locker     0x0C0a9c3B994dD87203c7e24c8e141f8F87945eE2  (CHANGES in gen 9)
V3 Router     0xb7D8795FbAC9CA2AE8067f876d3633bc96d86477  (CHANGES in gen 9)
V3 Quoter     0x55ff22A36Cb8f42F3efeFB26E30E5b0876FD4587  (unchanged — view-only)
Launchpad     0xD863e3475E00550FBe0Abf4F1127B673E65C86a4  (CHANGES in gen 9)
MultiSwap     0x54bd5d413709575C54E3E4D6E4aFAB97837fce51  (CHANGES in gen 9)
TwitterEscrow 0xc7321283D18C4cABcD5Eda4489845336A9F5c3ed  (CHANGES in gen 9)
Token Vault   0xe34d782C375969B2976E37061605ef98550C046f  (unchanged in gen 9)
```

After deploy, update `memory/project_arcade_deployments.md` with the
gen 9 addresses + bump the generation marker.
