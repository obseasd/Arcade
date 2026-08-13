# Arcade mainnet checklist

Consolidated, ordered path to Arc mainnet. Grouped by workstream, with what is
CODE-DONE vs USER-OPS, and dependencies. See the per-area runbooks:
`KEEPER_SETUP.md`, `INDEXER_SETUP.md`, `contracts/REDEPLOY_2026-06-29.md`.

Legend: ✅ code done · 🛠 user ops · 🔗 external dependency · 🟡 decision pending

---

## A. Activate what is already built (no code; do anytime)

- 🛠 **Keeper** (`KEEPER_SETUP.md`): create + fund the dedicated keeper wallet →
  `KEEPER_OPERATOR_PRIVATE_KEY` on Vercel; **redeploy ExchangeV2 allowlisting the
  keeper wallet** (its allowlist is constructor-only) → `NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS`;
  apply `web/db/migrations/010_keeper.sql`; wire cron-job.org → `/api/keeper/cron`.
- ✅ **Indexer**: SUPERSEDED by a managed **Goldsky subgraph** (`GOLDSKY_SETUP.md`);
  the self-hosted Ponder plan is dropped. For mainnet: push the Goldsky config
  pointed at the mainnet contracts + set `NEXT_PUBLIC_GOLDSKY_URL`. Powers charts,
  /stats, and referral volume.
- 🛠 **Compounder**: `NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS` on Vercel (done).

## B. Pre-mainnet code decisions (pending the founder)

- ✅ **H-02** (audit MEDIUM): escrow now ships with `claimTimelock =
  DEFAULT_TIMELOCK (1h)` + a `MIN_TIMELOCK (15min)` floor, instead of a silent 0
  that neutered the owner veto (a compromised signer could authorize+claim in one
  block). The claim signer reads `claimTimelock()` and sizes the deadline to it,
  so the owner can tune the window (down to 15min, or 0 to disable) WITHOUT
  bricking claims. Source-only; ships at the mainnet redeploy.
- ✅ **Escrow signer** (was "H-02 bis"): DECIDED → a **fresh dedicated key in
  Vercel Sensitive** (`0xd3e19E…`), not the personal wallet. Signing-only, holds
  no funds. A KMS-backed signer (`web/lib/kmsSigner.ts`) is coded + dormant if the
  escrow ever warrants a hardware vault (set `ARCADE_KMS_KEY_ID`); NOT needed at
  launch. See `P2_SECURITY.md`.

## C. Mainnet generation deploy (ONE fresh deploy, ordered)

Fresh deploy of the current Safe-governed code (testnet V3 positions are
non-migratable; nothing is carried over). **Deployer = a FRESH throwaway key**
(`cast wallet new`), NEVER the personal wallet `0x3a0Dd9`. `TREASURY_ADDRESS` and
`OWNER_ADDRESS` = the Safe `0x0bDE09e3` everywhere. Escrow signer = the fresh
dedicated key `0xd3e19E8464282fdA4Fd9Cd305C35690C57aC4f97` (Vercel Sensitive),
passed in the constructor. See `P2_SECURITY.md` for the fresh-key set.

Build every solc profile first:
`forge build && FOUNDRY_PROFILE=v3 forge build && FOUNDRY_PROFILE=v4 forge build && unset FOUNDRY_PROFILE`

✅ Every script already takes `OWNER`/`TREASURY` = Safe. Ordered sequence
(deployer key):
1. **V3 core + periphery** (`DeployV3.s.sol` → factory + NPM) unless reusing Arc's
   canonical Uniswap V3. Note the factory + NPM addresses for the next steps.
2. **DEX + launchpad chain** (`RedeployDexAndLaunchpad.s.sol`): `TREASURY=Safe`,
   `ARCADE_BACKEND_SIGNER=0xd3e19E…`, `V3_FACTORY`, `V3_NPM`. Deploys v2Factory/
   router, launchpad, escrow, locker (owner=Safe immutable), tokenVault, v3Router,
   multiSwap, migratedRouter, zaps, identityIssuer. Governance handover built in
   (feeTo/feeToSetter=Safe, `escrow.transferOwnership(Safe)` initiated).
3. **Fee manager** (`DeployFeeProtocolManager.s.sol`): `OWNER=Safe`,
   `TREASURY=Safe`, `V3_FACTORY`, `V3_LOCKER`, `HANDOVER=true` (deployer still
   owns the factory here) → manager owns the V3 factory; ordinary pools auto-earn
   the protocol fee, launch pools stay 0.
4. **V4 stack** (`v4script/DeployV4.s.sol`): `OWNER_ADDRESS=Safe`, `TREASURY=Safe`,
   `TWITTER_SIGNER=0xd3e19E…` → hook, poolManager, router, quoter, stateView,
   lockedVault, V4 escrow. With owner=Safe the escrow↔hook wiring is a separate
   Safe tx (the script prints it).
5. **V4 peripherals** (`v4script/DeployPeripherals.s.sol`): `OWNER=Safe`,
   `TREASURY=Safe`, `ARCADE_HOOK` → splitterFactory, airdropDistributor(owner=Safe),
   lockedVault.
6. **Auto-compounder** (`DeployArcadeAutoCompounder.s.sol`): `OWNER=Safe`,
   `FEE_RECIPIENT=Safe` → Safe-owned from construction.

Then finalize governance:
- 🛠 **Safe `acceptOwnership()`** on every Ownable2Step contract that was deployed
  owner=deployer then transferred (the escrow from step 2; anything in step 4 not
  deployed OWNER=Safe directly). A contract deployed OWNER=Safe is already
  Safe-owned (no accept).
- ✅ **`TransferOwnershipToSafe.s.sol`** = the safety-net / verifier. Run it
  (simulate first, `--broadcast` only if it must move anything): it transfers +
  ASSERTs every governed contract (v2Factory, v3Factory→manager, feeProtocolManager,
  autoCompounder, arcadeHook, escrow, airdropDistributor) is on the Safe, and its
  pre-flight `require()`s catch a wrong immutable ctor arg (v3Locker/launchpad)
  BEFORE any handoff. Ownerless/no-governance contracts (splitterFactory,
  lockedVault, tokenVault) are documented no-ops.
- 🛠 Re-point every `NEXT_PUBLIC_*` Vercel env to the mainnet addresses (incl.
  `NEXT_PUBLIC_MIGRATED_ROUTER_ADDRESS`) + rotate ALL service keys to fresh
  dedicated ones (P2), redeploy, re-seed test liquidity, update
  `web/public/deployments.json`.
- ✅ **identityIssuer owner** inert (no `onlyOwner` fn; `mint` is permissionless
  with on-chain tier verification) — nothing to hand over.

## D. External dependencies

- 🔗 **CCTP mainnet** (scaffolded in `web/lib/cctp.ts`): the network switch
  (`cctpNetwork()`), the mainnet TokenMessenger/MessageTransmitter pair, and the
  6-chain mainnet matrix are wired behind `NEXT_PUBLIC_CCTP_NETWORK=mainnet`
  (testnet default). REMAINING: (a) VERIFY the mainnet CCTP V2 contract pair +
  each chain's USDC/domain against Circle's docs; (b) fill the **Arc mainnet**
  row (Circle-assigned domain, mainnet USDC, RPC, explorer) — currently a marked
  placeholder; (c) set `NEXT_PUBLIC_CCTP_NETWORK=mainnet`.
- 🔗 **WalletConnect**: rotate the Project ID in the dashboard.
- 🔗 **USYC /earn**: rebuild after the treasury is KYC-approved (Teller-gated).

## E. Grant (parallel, not a mainnet blocker)

- ✅ **Grant package** (`circle-grant-application.md`): refreshed to the current
  state (keeper, indexer, Safe governance, pair-level fee, current addresses,
  M3 de-risked). REMAINING (founder-only): video, deck, hackathon name, live
  traction numbers, Pashov quote confirmation, COI answer.
- ❌ **External audit**: DROPPED (no budget, founder decision 2026-08-13). Coverage
  = the internal multi-agent audits (this session's 4-agent pass + the prior
  offensive audits). Accepted risk: no third-party sign-off before mainnet.

## F. Indexer-dependent (Goldsky subgraph)

- ✅ **Charts / stats / referral volume**: run on the Goldsky subgraph once
  `NEXT_PUBLIC_GOLDSKY_URL` points at the mainnet subgraph (already coded, client
  fallback otherwise).
- ✅ **Referral Phase 2 payout**: the 2 stubs are FILLED (fed by Goldsky
  `Trader.totalVolumeUsdc`); gated on `REFERRAL_PAYOUT_ENABLED` + the funded
  `REFERRAL_PAYOUT_PRIVATE_KEY` wallet (0xE68A6D4e, 200 USDC).

## G. Deferred / post-mainnet

- **DCA vault** (V3/CLANKER/curve): a new custody contract → its own external
  audit. Only if DCA on non-V2 tokens becomes a firm requirement.
- **V4 migration**: one V4 pool replaces launchpad+locker+vault. Blocked on Arc
  Cancun/EIP-1153 maturity.
- **Trade copilot**: in-app NL chat over the MCP tools.

---

## Critical path (minimum to mainnet)

A (activate keeper + indexer) → B (done) → C (broadcast gen + wiring) → D.
No external-audit gate (dropped). **The real launch blocker is getting USDC onto
Arc mainnet** (for gas + seed liquidity): CCTP/bridge is NOT live yet (Circle
does not attest Arc mainnet burns), so the DEX+launchpad can ship but the bridge
stays OFF and liquidity must be seeded via a non-bridge USDC path (Circle mint /
an exchange that delivers on Arc). Goldsky `arc-mainnet` is confirmed supported.
