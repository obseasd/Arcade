# Orbs TWAP / dLIMIT Deployment on Arc Testnet

Step-by-step to deploy the vendored orbs-network/twap (`contracts/orbs/`) on
Arc testnet (chainId 5042002). All commands run from `contracts/`.

## What we deploy

1. **ExchangeV2** (orbs adapter wrapping our V2 router). Takers route their
   fill swaps through this contract, which then calls ArcadeV2Router under
   the hood.
2. **TWAP** (main settlement contract). Holds the order book. Immutable after
   deploy. No owner, no admin, no admin keys.
3. **Lens** (read-only helper for the frontend). Optional but recommended.

## Prerequisites

- Arc testnet RPC reachable (`arc_testnet` profile in foundry.toml works).
- Your deployer wallet funded with at least a few USDC for gas. Gas budget
  is small (TWAP + Lens together is well under 5M gas).
- Keeper address(es) decided. Initially this is just your own EOA. If Orbs L3
  later extends to Arc, you can deploy a second ExchangeV2 with their keeper
  in the allowlist, or extend this one (the `allowed` mapping is set in
  constructor and not modifiable, so you would need to redeploy ExchangeV2;
  TWAP itself stays).

## Step 1: Deploy ExchangeV2

ExchangeV2 takes two constructor args: the V2 router and a comma-separated
allowlist of taker (keeper) addresses.

```bash
export ROUTER=0x529d7250652aAaA11b4E2407e8b49fa9ae0E5041
export ALLOWED=0xYOUR_KEEPER_ADDRESS_HERE
export PRIVATE_KEY=0x...

forge script orbs/script/DeployExchange.s.sol \
  --profile orbs \
  --rpc-url arc_testnet \
  --broadcast \
  --private-key $PRIVATE_KEY \
  --legacy
```

`--legacy` is required because Arc currently rejects EIP-1559 transactions
on the testnet RPC for script broadcasts (matches our other deploy scripts).
The deployed address is printed by forge and also saved to
`broadcast/DeployExchange.s.sol/5042002/run-latest.json`.

Save the address.

## Step 2: Deploy TWAP + Lens

TWAP takes one constructor arg: an iweth address. On Arc, USDC is the native
gas token so there is no native ETH and no canonical WETH9 deployment. We
pass our existing MockWETH (which behaves like a WETH9 wrapper) as a
sentinel. The unwrap path in TWAP.sol L244-247 is only reached when a maker
sets `dstToken == address(0)`, and our frontend gates that out, so this
address is never actually called.

```bash
export WETH=0x9570EBA9eE39Aa4933f64d6add280faAB289a847

forge script orbs/script/DeployTWAP.s.sol \
  --profile orbs \
  --rpc-url arc_testnet \
  --broadcast \
  --private-key $PRIVATE_KEY \
  --legacy
```

Output: TWAP and Lens addresses. Save both.

## Step 3: Wire to the frontend

Add these to `web/.env.local` (and to Vercel env for staging/prod):

```
NEXT_PUBLIC_ORBS_TWAP_ADDRESS=0x...
NEXT_PUBLIC_ORBS_LENS_ADDRESS=0x...
NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS=0x...
```

The frontend Limit tab reads these to know where to send signed orders and
where to read the order book. The exchange address is passed as part of the
order data so TWAP knows which exchange to route the fill through.

## Important: dstToken UI gate

When the frontend builds the order EIP-712 struct, it MUST set
`order.ask.dstToken` to a real ERC20 address (USDC, a launchpad token, etc).
NEVER set it to `address(0)`. If `dstToken == address(0)`, TWAP's
`performFill` at L244-247 tries to unwrap WETH and send native, which on
Arc would either revert or send to a wallet address with zero native
balance. Easy to gate at the input layer.

Specifically: the Limit tab token picker should never offer the zero
address as an output. The dropdown is sourced from our token list, which
contains only real ERC20s by construction, so this is naturally enforced.

## Verifying the deploy

Quick sanity:

```bash
cast call $TWAP "VERSION()(uint8)" --rpc-url arc_testnet
# expect: 4

cast call $TWAP "iweth()(address)" --rpc-url arc_testnet
# expect: the WETH address we passed

cast call $EXCHANGE_V2 "router()(address)" --rpc-url arc_testnet
# expect: ArcadeV2Router
```

If all three return the expected values, the deploy is good.

## Cost estimate

On Arc testnet at typical gas prices: less than 0.10 USDC total for the
three deploys (TWAP is ~3M gas, ExchangeV2 ~500k, Lens ~1M). Below the cost
of a coffee, even on busy days.

## What this does NOT include

- The keeper / taker bot. That is a separate Node.js service that you
  either run yourself (Week 4-6 of the plan) or rely on Orbs L3 to provide
  (gated on their BD response).
- The frontend Limit tab. That is Week 2-3 of the plan, lives under
  `web/components/swap/LimitCard.tsx` (to be written).
- The Postgres order book. Orbs reads orders from the on-chain `book`
  array; for indexing UX we may add a thin off-chain mirror in Week 4 but
  it is not required for ship.
