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
- 🛠 **Indexer** (`INDEXER_SETUP.md`): host the Ponder process (Railway/Render/VM,
  not Vercel) + a SEPARATE Neon DB + a dedicated Arc RPC; set
  `NEXT_PUBLIC_INDEXER_URL`. Frontend falls back to the client scan until set.
- 🛠 **Compounder**: `NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS` on Vercel (done).

## B. Pre-mainnet code decisions (pending the founder)

- 🟡 **H-02**: escrow `MIN_TIMELOCK` / `DEFAULT_TIMELOCK` are 0 (testnet build);
  set to 1h for mainnet. A constant flip + redeploy. **Decision pending** — it
  changes the withdrawal-delay UX, so not flipped unilaterally.
- 🟡 **H-02 bis**: escrow trusted signer → 2-of-N instead of a single backend
  wallet. More involved (design + its own review). **Decision pending.**

## C. Mainnet generation deploy (ONE fresh deploy, not a retrofit)

The mainnet gen is a fresh deploy of the current Safe-governed code; existing
testnet V3 positions are non-migratable, so nothing is carried over.

- ✅ Deploy script parameterized: `TREASURY_ADDRESS=Safe` → treasury + feeTo =
  Safe; locker owner = Safe from construction; handover block sets factory
  fee-setter = Safe + `escrow.transferOwnership(Safe)`.
- 🛠 Broadcast the gen (deployer key), then the Safe `acceptOwnership()` on the
  escrow (2-of-3).
- 🛠 Re-point every `NEXT_PUBLIC_*` Vercel env to the mainnet addresses (incl.
  `NEXT_PUBLIC_MIGRATED_ROUTER_ADDRESS`), redeploy the frontend, re-seed test
  liquidity.
- ✅ **identityIssuer owner**: NO action needed. Its `owner` field is inert (no
  `onlyOwner` function exists on the issuer; `mint` is permissionless with
  on-chain tier verification). The earlier "deploy owner=Safe" note was cosmetic
  — a compromised deployer can do nothing via the issuer.
- ✅ The V3-router / locker / escrow / launchpad / POOL_WETH-snipe fixes are in
  the code, so deploying the current code IS the fix (they were source-only on
  the older LIVE gen; the current gen carries them).

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
- 🔗 **External audit**: hard gate before mainnet; the highest-leverage grant
  line item. Weeks of calendar time.

## F. Indexer-dependent (do after the indexer is hosted)

- ✅/🔗 **Charts**: complete history automatically once `NEXT_PUBLIC_INDEXER_URL`
  is set (already coded, fallback otherwise).
- **Referral Phase 2 payout**: the 2 stubs that block on-chain payout can now be
  filled from indexer queries; + the `REFERRAL_PAYOUT_PRIVATE_KEY` wallet.

## G. Deferred / post-mainnet

- **DCA vault** (V3/CLANKER/curve): a new custody contract → its own external
  audit. Only if DCA on non-V2 tokens becomes a firm requirement.
- **V4 migration**: one V4 pool replaces launchpad+locker+vault. Blocked on Arc
  Cancun/EIP-1153 maturity.
- **Trade copilot**: in-app NL chat over the MCP tools.

---

## Critical path (minimum to mainnet)

A (activate keeper + indexer) → B (decide H-02) → C (broadcast gen + wiring) →
D (CCTP + WalletConnect). E (grant) runs in parallel; the external audit in E is
the one hard gate that must clear before the C broadcast is considered final.
