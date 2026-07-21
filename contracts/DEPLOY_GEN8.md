# Deploy gen 8 — runbook

> ⚠️ SUPERSEDED (historical). Superseded by the 2026-07-16 Safe-governed
> generation. Every address/step below is stale. Per RULE 1,
> `web/public/deployments.json` is the ONLY source of truth for live addresses.
> Kept for the deploy *method*; do not follow the addresses.

> Last verified 2026-06-10. Use this checklist top-to-bottom — every
> step has a rollback note in case something goes sideways mid-deploy.

## What's in gen 8

Audit-fix redeploy. Changed contracts:

- ArcadeLaunchpad (L-1 V2 pre-mint defense + L-2 V3 sqrt grief defense)
- ArcadeTwitterEscrowV3 (L-3 24h timelock signer rotation + L-6 third-token revert)
- ArcadeV3Locker (L-4 escrow-pair invariant + V3-1 init guard + V3-6 O(1) rescue)
- ArcadeV3SwapRouter (V3-3 sell-side anti-sniper)
- ArcadeV3Zap (V3-2 zapOut floor + V3-4 sqrt cap)

Unchanged (no redeploy needed unless paired): V2 Factory, V2 Router, Token Vault, MultiSwap, V3 Factory, V3 NPM, V3 Quoter, V3 Position Descriptor.

## Pre-flight (do once)

```bash
cd contracts
forge build --sizes 2>&1 | grep -E "Arcade(Launchpad|TwitterEscrow|V3Locker|V3Zap|V3SwapRouter)"
```

Expect every contract under the EIP-170 24,576-byte ceiling. ArcadeLaunchpad should land at **24,532/24,576** (44 byte margin).

```bash
forge test --no-match-path "*v4*"
```

Expect **120/120 pass**.

If either fails: STOP. Open `AUDIT_PROGRESS.md`, find the divergence, fix or revert before proceeding.

## Step 1 — Set env vars locally

```bash
export PRIVATE_KEY=<deployer hex key, 0x-prefixed>
export ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
export ARC_WETH_ADDRESS=0x9570EBA9eE39Aa4933f64d6add280faAB289a847
export TREASURY_ADDRESS=0x3a0Dd90212838f32a953Acd4B32596b62859324A
# Twitter escrow optional; pass 0 to skip the integration
export TWITTER_ESCROW_ADDRESS=0x0000000000000000000000000000000000000000
```

Verify the deployer has enough Arc testnet USDC for gas (~5 USDC covers a full redeploy).

```bash
cast balance $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url arc
```

If balance < 5e6 (5 USDC at 6 dp): top up from `https://faucet.circle.com/` or your reserve before proceeding.

## Step 2 — Build V3 profile artifacts

```bash
FOUNDRY_PROFILE=v3 forge build
```

V3 contracts compile with their own profile (solc 0.7.6) and land in `out-v3/`. The deploy script reads from there via `vm.getCode("out-v3/X.sol/X.json")`.

## Step 3 — Deploy

```bash
forge script script/DeploySecurityV3.s.sol \
  --rpc-url arc \
  --broadcast \
  --private-key $PRIVATE_KEY
```

The script prints every address as it goes. Save the output to `deploy_log_gen8.txt` for the records:

```bash
forge script script/DeploySecurityV3.s.sol --rpc-url arc --broadcast --private-key $PRIVATE_KEY 2>&1 | tee deploy_log_gen8.txt
```

`deploy_log_*.txt` is in `.gitignore` (audit C-1).

## Step 4 — Wire optional infra

The deploy script handles `setV3Infra` + V3 fee tier enable + `setFeeTo` automatically. Manually verify with:

```bash
cast call <launchpad-addr> "v3Locker()(address)" --rpc-url arc
cast call <launchpad-addr> "v3Router()(address)" --rpc-url arc
cast call <launchpad-addr> "tokenVault()(address)" --rpc-url arc
```

All three should return non-zero. If any is zero, the script's `setV3Infra` call failed silently — run it manually with `cast send`.

## Step 5 — Smoke tests (manual)

Run each in order. If any fails, the deploy is bad and gen 8 must NOT replace gen 7 in Vercel env.

### Test 1 — L-1 V2 pre-mint defense (audit critical)

```bash
# 1. Manually create the pair before any launch graduates
cast send $(cast call <v2-factory> "createPair(address,address)(address)" \
    $ARC_USDC_ADDRESS <some-test-token-addr> --rpc-url arc) \
  "mint(address)(uint256)" $(cast wallet address --private-key $PRIVATE_KEY) \
  --rpc-url arc --private-key $PRIVATE_KEY

# Above is a contrived example — actual flow: create a launchpad token,
# buy enough to approach graduation, then have a second wallet do the
# pair.mint() pre-emption before the curve crosses the migration threshold.
# When graduation triggers, launchpad._migrate calls
# IArcadeV2Pair(pair).totalSupply() via the assembly check; with totalSupply
# != 0 it reverts InvalidRoute().
```

PASS: graduation tx reverts with `InvalidRoute()`. FAIL: tx succeeds and pair holds attacker LP.

### Test 2 — L-2 V3 pre-init grief (audit critical)

```bash
# Pre-initialize a V3 pool at an arbitrary sqrt before a CLANKER_V3 launch.
# launchpad._launchClankerV3 should accept the on-chain sqrt and continue,
# rather than reverting on the strict equality check.
```

PASS: CLANKER_V3 launch succeeds, position mints at the pre-init sqrt. FAIL: launch reverts on the L-2 path.

### Test 3 — L-3 signer timelock

```bash
# Old direct setter is permanently disabled.
cast send <escrow-addr> "setTrustedSigner(address)" $(cast wallet address --private-key $PRIVATE_KEY) \
  --rpc-url arc --private-key $PRIVATE_KEY
# Expect revert: USE_TIMELOCK_ROTATION

# New 2-step path: queue, wait 24h, finalize.
cast send <escrow-addr> "requestTrustedSignerRotation(address)" $(cast wallet address --private-key $PRIVATE_KEY) \
  --rpc-url arc --private-key $PRIVATE_KEY
# Wait 24h.
cast send <escrow-addr> "finalizeTrustedSignerRotation()" \
  --rpc-url arc --private-key $PRIVATE_KEY
# Then verify:
cast call <escrow-addr> "trustedSigner()(address)" --rpc-url arc
```

### Test 4 — L-4 locker escrow-pair invariant

```bash
# Try to set a slot's recipient to the escrow address without admin == escrow.
cast send <locker-addr> "updateRecipient(uint256,uint256,address)" 1 0 <escrow-addr> \
  --rpc-url arc --private-key $PRIVATE_KEY
# Expect revert: ESCROW_PAIR
```

### Test 5 — V3-2 zap floor

```bash
# Call zapOut with amountOtherMinSwap=0 on a position that has a swap leg.
# Expect revert: NO_SWAP_FLOOR
```

### Test 6 — V3-3 sell-side anti-sniper

```bash
# Within the launch window of a fresh CLANKER_V3 launch:
# 1. Buy via USDC -> token (existing flow). Confirm skim happens.
# 2. Sell via token -> USDC. NEW: skim should also occur on the input side.
# Check treasury balance delta between before and after the sell.
cast call <token-addr> "balanceOf(address)(uint256)" <treasury-addr> --rpc-url arc
# Run the sell.
cast call <token-addr> "balanceOf(address)(uint256)" <treasury-addr> --rpc-url arc
# Delta should match (sell amount × currentSnipeBps).
```

## Step 6 — Update Vercel env vars

In Vercel project → Settings → Environment Variables, update the following with the new addresses from `deploy_log_gen8.txt`:

```
NEXT_PUBLIC_LAUNCHPAD_ADDRESS
NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS
NEXT_PUBLIC_V3_LOCKER_ADDRESS
NEXT_PUBLIC_V3_ROUTER_ADDRESS
NEXT_PUBLIC_V3_QUOTER_ADDRESS
NEXT_PUBLIC_V3_ZAP_ADDRESS
NEXT_PUBLIC_TOKEN_VAULT_ADDRESS
NEXT_PUBLIC_MULTISWAP_ADDRESS
```

Vercel rebuilds automatically. Don't update the V2 Factory / V2 Router — they don't change in gen 8.

## Step 7 — Post-deploy verification

After Vercel rebuilds (~2 min):

- Open `/admin` and confirm the connected wallet shows OWNER for the escrow.
- Open `/admin/observability` — the Sentry stub should render even without DSN.
- Run a swap USDC → EURC via Synthra — Permit2 popup, then swap.
- Run a swap with a CLANKER_V3 token to verify the anti-sniper banner appears within the window.
- Confirm Bridge resume from history flows correctly (B-1 / B-2 / B-3 patches live).

## Rollback

If a critical issue surfaces post-deploy:

1. Revert the Vercel env vars to gen 7 addresses (the gen 7 contracts are still live — they're separate addresses, not upgrades).
2. Frontend will resume routing to gen 7 within ~2 min of the env var save.
3. File an incident note in `docs/incidents/` (create the dir if needed) with date, what broke, and what the gen 8 fix that caused it was.
4. Don't redeploy gen 8 until the issue is reproduced and patched.

## Snapshot — addresses pre-deploy reference

For comparison post-deploy, the gen 7 stack lives at (per memory):

```
USDC          0x3600000000000000000000000000000000000000  (unchanged)
WETH          0x9570EBA9eE39Aa4933f64d6add280faAB289a847  (unchanged)
Treasury      0x3a0Dd90212838f32a953Acd4B32596b62859324A
V2 Factory    0x8afb163909BC0C96eD77D5dB3f01840B9227CA39  (unchanged in gen 8)
V2 Router     0xD63609d130698489603AC07dFDa338D958765808  (unchanged in gen 8)
V3 Factory    0x89dEC3D04828Be00719e8833d4807E07cf539fbe  (unchanged in gen 8)
V3 NPM        0xed513880aA883BE4FC3897127eB733b3240F4CeA  (unchanged in gen 8)
V3 Zap        0x440E5D3CEd1af585748dCdcF59D1e8B699b383e1  (CHANGES in gen 8)
V3 Locker     0x4dddAdA3Cc38D331897C5F74F955A1194F5A8C64  (CHANGES in gen 8)
V3 Router     0xB501C21cE40b7559e33be0e9FBcD94D86Ece2c26  (CHANGES in gen 8)
V3 Quoter     0x344A507A2b8d185D82aeD010c66F55ade662BA64  (unchanged — view-only)
Launchpad     0x62aC6A355D092267a93a1Ffb13B7D1c121A5c0e8  (CHANGES in gen 8)
MultiSwap     0xBD13aB926DE7c82BA56727ea34F11FC4420A09E4  (CHANGES in gen 8 if launchpad changes)
TwitterEscrow 0x5950b3B54C8e81F1d94e92BDEc5F3C73Ea59156a  (CHANGES in gen 8)
Token Vault   0x8bE45CF7e5fEE5bf3388B5B95Ff944cbb6F8c82A  (unchanged in gen 8)
```

After deploy, update the table in `memory/project_arcade_deployments.md` with the gen 8 addresses + bump the generation marker.
