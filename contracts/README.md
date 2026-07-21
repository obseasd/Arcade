# Arcade contracts

Foundry workspace for the Arcade DEX + launchpad on Circle's Arc L1 (USDC-native).

> **Source of truth for deployed addresses is `web/public/deployments.json`, not
> this repo or any doc under `contracts/`.** The `DEPLOY_GEN*.md` / `REDEPLOY_*.md`
> runbooks are historical (see their banners). Verify on-chain before trusting any
> address written in a comment or doc.

## Layout

- `v4src/` — the production Uniswap V4 stack: `ArcadeHook.sol` (bonding-curve +
  graduation + post-grad fee capture + anti-sniper, all in one hook),
  `ArcadeV4SwapRouter.sol`, `LockedVault.sol`, plus lenses. The hook's permission
  bits are mined into its CREATE2 address (`v4script/MineHookSalt.s.sol`) and the
  deploy asserts `address & PERM_MASK == getHookPermissions()`.
- `src/launchpad/` — the V2 bonding-curve launchpad (`ArcadeLaunchpad.sol`), the
  Twitter fee-escrows (`ArcadeTwitterEscrowV3/V4.sol`), locker, etc.
- `v3src/` — our own Uniswap V3 fork contracts (0.7.6).
- `orbs/` — TWAP / limit-order + DCA exchange.
- `test/`, `v4test/` — Foundry tests (the v4 hook suite: `FOUNDRY_PROFILE=v4 forge test`).
- `v4script/`, `script/` — deploy + salt-mining scripts.
- `V4_HOOK_SPEC.md` — the design reference the shipped hook implements.

## Build / test per profile

The repo is split across solc versions via Foundry profiles (see `foundry.toml`):

```shell
forge test                        # default profile (0.8.24, via_ir) — most contracts
FOUNDRY_PROFILE=v4  forge test     # the V4 hook stack (v4src / v4test)
FOUNDRY_PROFILE=v3  forge test     # the 0.7.6 V3 layer
FOUNDRY_PROFILE=orbs forge test    # TWAP / DCA
```

## Gotcha: v3-periphery init-code-hash patch

`lib/v3-periphery/contracts/libraries/PoolAddress.sol` carries an **intentional local
patch** to `POOL_INIT_CODE_HASH` (our V3 factory deploys different pool bytecode).
It must be re-applied after any `forge install` that resets the submodule; the bare
upstream value breaks every NPM mint. This shows as a modified submodule in
`git status` and is expected.

## Deploy

Deploys are Safe-governed (owner = the 2-of-3 Safe). The hook stack is deployed via
`v4script/DeployV4.s.sol` after mining a valid-flag salt with `MineHookSalt.s.sol`.
Follow the current runbook, not the superseded `DEPLOY_GEN*.md` files, and write the
resulting addresses into `web/public/deployments.json`.
