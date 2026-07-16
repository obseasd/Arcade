# Unified keeper — setup & ops

One self-hosted process (`/api/keeper/cron`) settles three features that
otherwise never complete without a keeper:

- **Leg A — Orbs TWAP**: bids + fills open **limit orders** and **DCA**
  schedules (a DCA order is just a multi-chunk TWAP order; same code path).
- **Leg B — CCTP bridge-and-buy**: relays `receiveAndBuy` /
  `receiveAndForward` once Circle Iris attests, so the buy auto-completes
  on Arc without the user returning to click "claim".

Signs with a **dedicated keeper wallet** (`KEEPER_OPERATOR_PRIVATE_KEY`),
separate from the compounder operator so the two crons never collide on a
shared nonce. Auth reuses `COMPOUNDER_CRON_SECRET` (same shared-bearer
precedent the twitter cron uses).

## ✅ DONE (Arc testnet, 2026-07-16)
- Dedicated keeper wallet: `0xC3D6ED473B2D22908d1CBc45e74ABa1133BD4107` (fund with USDC for gas).
- **ExchangeV2 redeployed + keeper allowlisted: `0x15E0E4C47ca822A5b7Fa02a7A2591072Bb87ddE5`**
  (set `NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS` to this). Deployed via
  `FOUNDRY_PROFILE=orbs forge create` (a forge SCRIPT reverts StackUnderflow on Arc simulation).
- REMAINING: fund the keeper wallet, set the two Vercel envs, apply `010_keeper.sql`, wire cron-job.org.

## Why leg A needs a contract redeploy

Orbs `ExchangeV2` gates every fill on `allowed[taker]`, and that allowlist
is set **once in the constructor with no setter** (`ExchangeV2.sol`). The
currently-deployed adapter allowlists the deployer EOA only. A dedicated
keeper wallet is therefore NOT allowed, so `ExchangeV2` must be redeployed
with the keeper wallet baked into `ALLOWED`. It is a stateless adapter, so
the redeploy is cheap and safe (no state to migrate; no live orders on
testnet reference the old adapter).

## One-time setup

1. **Create + fund the dedicated keeper wallet.**
   ```sh
   cast wallet new           # keep the private key OFFLINE; it goes to Vercel only
   # fund the address with a little USDC on Arc for gas
   ```
   The keeper only pays gas (Arc's native token is USDC); it never fronts
   trade capital (the Orbs swap pulls the maker's chunk atomically).

2. **Redeploy `ExchangeV2` with the keeper allowlisted.**
   ```sh
   cd contracts/orbs
   ROUTER=<NEXT_PUBLIC_V2_ROUTER_ADDRESS> \
   ALLOWED=<KEEPER_ADDRESS>,<0x3a0Dd9 deployer fallback> \
   forge script script/DeployExchange.s.sol:DeployExchange \
     --rpc-url https://rpc.testnet.arc.network --broadcast --slow
   ```
   Note the new adapter address. (Include the deployer as a second
   allowlisted taker so manual fills still work if the keeper is down.)

3. **Apply the DB migrations** (Neon SQL editor or the migrate route):
   `web/db/migrations/010_keeper.sql` then `web/db/migrations/011_bridge_amount.sql`
   (011 adds the `usdc_amount` column the /stats per-route bridged breakdown
   sums; it is a no-op backfill on an already-populated table).

4. **Set Vercel envs** (Production):
   - `NEXT_PUBLIC_ORBS_EXCHANGE_V2_ADDRESS` = the **new** adapter from step 2
   - `KEEPER_OPERATOR_PRIVATE_KEY` = the keeper key from step 1
   - `COMPOUNDER_CRON_SECRET` = existing shared bearer (already set)
   - `DATABASE_URL` = existing Neon (already set)
   - (already set for the app) `NEXT_PUBLIC_ORBS_TWAP_ADDRESS`,
     `NEXT_PUBLIC_V2_ROUTER_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`,
     `NEXT_PUBLIC_CCTP_BUY_RECEIVER`
   Redeploy the frontend so the new ExchangeV2 address ships to the client
   (new limit/DCA orders will encode `exchange = the new adapter`).

5. **Wire the trigger.** On cron-job.org, add a job that POSTs
   `https://<prod>/api/keeper/cron` every ~2 minutes with header
   `Authorization: Bearer <COMPOUNDER_CRON_SECRET>`. The GitHub workflow
   `keeper-scan.yml` is the manual fallback (needs repo secrets
   `KEEPER_CRON_URL` + `COMPOUNDER_CRON_SECRET`).

## Safety rails (built into the route)

- **Low-balance breaker**: below 1 USDC gas the run returns 503 so the
  alarm surfaces instead of half-finishing.
- **Gas cap**: 100 gwei max fee per tx; the tick skips rather than overpay.
- **Per-run caps**: at most 8 Orbs actions + 5 CCTP relays per tick (each
  is a direct sequential tx; bids/fills cannot batch through Multicall3
  because the taker identity must be the allowlisted keeper wallet).
- **No fund custody**: leg A pulls the maker's chunk atomically inside
  the fill; leg B's receiver derives the beneficiary from the attested
  message, so relaying from the keeper can never redirect funds.
- **Single-run lease**: a DB time-lease (`keeper_lock`) makes overlapping
  cron triggers skip, so two runs never race the shared wallet's nonce or
  double-relay the same intent. It self-expires if a run crashes.
- **Leg-B idempotency**: before relaying, the keeper checks
  `MessageTransmitter.usedNonces` and skips an already-consumed message, so
  a completed bridge (relayed on a prior timed-out tick or claimed manually)
  is never re-tried or mis-reported as failed.

## Known limits (testnet scope)

- **V2 pairs only** (Orbs `ExchangeV2` routes the V2 router). CLANKER_V3 /
  curve tokens are the phase-2 DCA-vault's job.
- **DCA floor is fixed at creation** (inherent to Orbs-as-DCA): a strongly
  trending price can pause fills until it re-enters the per-buy price band.
  The band defaults to 2% (floored above the keeper's 0.5% fill haircut so
  chunks clear at a flat price) and the schedule is blocked past 90 days.
  The phase-2 vault (on-chain per-chunk quote) removes the fixed-floor limit.
- **Full-book discovery** each tick is capped at 200 orders; a cursor +
  the indexer replaces it at mainnet scale.
- **Bridge-intent recording is unauthenticated** (a bridge has no session).
  A spammed burn hash can never move funds (known-receiver guard +
  beneficiary-from-attested-message) and is bounded: a completed non-receiver
  burn is expired on sight, a never-attesting one is age-expired after 3h,
  and the intent API refuses new rows past a 500-pending backlog.
