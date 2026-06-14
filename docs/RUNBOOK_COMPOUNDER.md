# Compounder incident runbook

Audit H4 fix — operational playbook for the ArcadeAutoCompounder V3 LP
auto-management service. Every scenario below is a 3am, on-call, "I am
the only person at a keyboard" decision tree. Run the **Diagnosis**
step first, decide which scenario applies, then execute the steps in
order.

Last reviewed: 2026-06-13. Re-review before every mainnet deploy.

---

## Contact + authority matrix

| Role | Identity | Reachable via | Authority |
|---|---|---|---|
| Compounder owner | TBD multisig (mainnet) / `0x3a0D…324A` (testnet) | Signal: @arcade-ops | setPaused / setOperator / setProtocolFeeBps / setFeeRecipient / transferOwnership |
| Compounder operator | Hot wallet `0x3a0D…324A` (testnet) | n/a (programmatic) | Submits compound/pushFees txs |
| Fee recipient | Treasury multisig (mainnet) / owner (testnet) | n/a (passive) | Receives protocol fee transfers |
| Vercel project | `arcade` | dashboard | Holds COMPOUNDER_OPERATOR_PRIVATE_KEY + COMPOUNDER_CRON_SECRET |
| GitHub repo | `obseasd/Arcade` | dashboard | Holds COMPOUNDER_CRON_URL + COMPOUNDER_CRON_SECRET |
| Neon Postgres | `arcade-stats` | dashboard | Stores compounder_positions / _events / _actions |

---

## Diagnosis (run first, every incident)

1. Open the Vercel deployment dashboard. Is the project healthy?
2. Open `Actions → compounder scan`. Are the last 3 runs ✅ or ❌?
3. Query the contract directly:
   ```bash
   cast call --rpc-url $ARC_RPC $COMPOUNDER 'paused()(bool)'
   cast call --rpc-url $ARC_RPC $COMPOUNDER 'operator()(address)'
   cast call --rpc-url $ARC_RPC $COMPOUNDER 'feeRecipient()(address)'
   cast call --rpc-url $ARC_RPC $COMPOUNDER 'protocolFeeBps()(uint16)'
   cast balance --rpc-url $ARC_RPC $OPERATOR_ADDR
   ```
4. Query Postgres:
   ```sql
   SELECT COUNT(*) FROM compounder_positions WHERE withdrawn_at IS NULL;
   SELECT MAX(block_at) FROM compounder_events;
   SELECT COUNT(*) FROM compounder_actions WHERE status = 'pending';
   ```
5. Match the symptoms to one of the scenarios below.

---

## Scenario 1 — Need to pause the entire service NOW

**Trigger**: critical bug discovered, ongoing exploit, mass user
complaint about lost fees.

**Comms first** (before pause):
- Draft a tweet: `Arcade auto-compounder paused while we investigate
  [issue]. User funds are safe — withdraw is still live. Updates here.`
- Post in #incidents Discord channel before pausing.

**Pause checklist**:
1. Confirm you have the owner private key / multisig access. If
   multisig: queue the tx, get the required signatures, execute.
2. Etherscan: `setPaused(true)`
   ```bash
   cast send --rpc-url $ARC_RPC --private-key $OWNER_KEY $COMPOUNDER \
     'setPaused(bool)' true
   ```
3. Confirm: `cast call $COMPOUNDER 'paused()(bool)'` returns `true`.
4. Disable the GH Actions cron to stop wasted runs:
   ```bash
   gh workflow disable compounder-scan
   ```
5. Send the comms tweet + Discord update.

**Important invariant**: withdrawPosition stays live under pause. This
is intentional — users can always escape custody even mid-incident.
If you need to block withdraws too, that requires a contract upgrade,
NOT a pause.

**Resume** (after fix):
1. Re-enable the cron: `gh workflow enable compounder-scan`
2. `setPaused(false)` via the same path.
3. Trigger one manual cron run and verify the operator tx succeeds.
4. Send the "resumed" comms.

---

## Scenario 2 — Operator key compromise

**Trigger**: leaked private key, suspicious tx from the operator
wallet, a dev member offboarded, scheduled rotation.

**Procedure** (zero-downtime, ~10 min):

1. Generate the new key OFF-CHAIN, on a clean machine. Cast it
   to an address: `cast wallet address $NEW_KEY`.
2. Fund the new address with ~5 USDC of Arc native gas.
3. As owner, rotate the operator slot on-chain FIRST so the
   permissionless-callable functions reject anyone who tries to drain
   value via the old key:
   ```bash
   cast send --rpc-url $ARC_RPC --private-key $OWNER_KEY $COMPOUNDER \
     'setOperator(address)' $NEW_OPERATOR_ADDR
   ```
4. Update Vercel env `COMPOUNDER_OPERATOR_PRIVATE_KEY` to the new
   value. Save. Redeploy the project from the dashboard (no code
   change needed — the env var is read at runtime).
5. Wait for Vercel to report ✅ Ready.
6. Manually trigger the cron via GH Actions. Verify the new operator
   submits a tx and it confirms.
7. Drain whatever USDC remains on the OLD operator back to the
   treasury:
   ```bash
   cast send --rpc-url $ARC_RPC --private-key $OLD_KEY $USDC \
     'transfer(address,uint256)' $TREASURY $REMAINING_BAL
   ```
8. Burn the old key (write it to nowhere, scrub from password
   managers).

**Failure mode if you skip step 3**: the old key still signs valid
compound() / pushFees() txs (those are permissionless). The
`operator` storage field is informational; it does not gate any
state-changing path. So the rotation MUST happen at the
COMPOUNDER_OPERATOR_PRIVATE_KEY env var level (Vercel) and the old
key burning step.

---

## Scenario 3 — Cron is silently failing

**Symptoms**: GH Actions runs return ✅ but `compounder_events` has
no new rows for >1 hour. Or: GH runs return ❌ with curl exit 22.

**Triage**:

| Symptom | Probable cause | Fix |
|---|---|---|
| GH ❌ exit 22, response 401 | COMPOUNDER_CRON_SECRET mismatch | Re-paste secret on both sides |
| GH ❌ exit 6, "Could not resolve host" | Stale COMPOUNDER_CRON_URL after domain change | Update repo secret |
| GH ✅ but `ran:false` in response | Vercel env missing | Check NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS / COMPOUNDER_OPERATOR_PRIVATE_KEY / DATABASE_URL |
| GH ✅, `scanned:N triggered:0` indefinitely | All positions below threshold OR cooldown active OR pool gate failing | Query `cast call $COMPOUNDER 'pendingFees(uint256)' $TOKEN_ID` |
| GH ✅, `triggered>0` but no events row | Audit I10 race — pre-migration database with retries double-counting | Run migration 003 |
| GH ✅, txCount > 0 but `Total claimed` stays $0 | Audit H2 — usd_value quoter found no route at any tier | Verify quoter address points at the right gen's V3 quoter |
| GH ✅, all positions skipped with `reason=sim-failed-or-timed-out` | Audit H1 — TWAP gate rejecting because pool moved in the last 60s | Wait 5 min, retry; if persistent, check `cast call $POOL 'slot0()'` for sane sqrtPriceX96 |

---

## Scenario 4 — Fee recipient bricked

**Trigger**: `setFeeRecipient` pointed at a contract that reverts on
plain ERC-20 receive, OR a multisig that has no signers configured.

**Symptom**: every compound and every pushFees reverts with
`PF0_FAIL` / `PF1_FAIL` at the protocol fee step. The Compounder is
effectively bricked until the recipient is rotated.

**Detection**: cron's output shows `failed:N` for every position with
the same revert reason.

**Fix**:
1. Generate or designate a safe EOA / known-good multisig as the
   recovery recipient.
2. As owner, rotate:
   ```bash
   cast send --rpc-url $ARC_RPC --private-key $OWNER_KEY $COMPOUNDER \
     'setFeeRecipient(address)' $NEW_RECIPIENT
   ```
3. Verify by reading back `feeRecipient()`.
4. Trigger one manual cron run and confirm `triggered > 0`.

**Pre-mainnet preflight** (every setFeeRecipient change): dry-run via
`cast call` first to confirm the new recipient accepts ERC-20
transfers without reverting:
```bash
cast call --rpc-url $ARC_RPC $USDC 'transfer(address,uint256)' \
  $NEW_RECIPIENT 1 --from $COMPOUNDER
```

---

## Scenario 5 — V3 NPM gets upgraded mid-flight

**Trigger**: the Arcade NPM (currently `0xB3FDAE…AabD`) gets a new
deployment for a security fix or feature.

**Impact**: positions deposited under the OLD NPM stay custodied in
the Compounder, but new V3 NFTs minted under the NEW NPM cannot be
deposited (the Compounder's NPM address is `immutable` in storage).

**Decision tree**:
- If old positions are being migrated to the new NPM by a separate
  process → the Compounder needs a new deployment that points at the
  new NPM. Plan:
  1. Mass `setMode(NORMAL)` on all positions (so the cron stops
     compounding) — but this requires each depositor to act.
  2. Easier: setPaused(true) on the OLD Compounder, send comms.
  3. Deploy NEW Compounder pointing at NEW NPM.
  4. Users withdraw from OLD, migrate position to NEW NPM (out of
     scope of this runbook), redeposit to NEW Compounder.
- If old positions stay under the OLD NPM forever → keep OLD
  Compounder running for them, deploy a parallel NEW Compounder for
  new positions. Update `NEXT_PUBLIC_AUTO_COMPOUNDER_ADDRESS` to the
  NEW one and rely on /positions/add to use it.

---

## Scenario 6 — Postgres outage

**Symptoms**: `/api/compounder/positions` GET returns 500 or empty
results. Cron returns `ran:false, reason: Postgres not configured`
(if env var dropped) OR `ran:true, scanned:0` (if connection ok but
the query is empty for an unrelated reason).

**Triage**:
1. Open the Neon dashboard. Is the project's compute status `idle`,
   `active`, or `error`?
2. If `error`: contact Neon support. The Compounder gracefully
   degrades — the contract is unaffected, only the dashboard goes
   blind.
3. If `idle` for too long: a paused Postgres connection is normal on
   Neon's auto-suspend tier; the next request wakes it up.
4. If `active` but queries failing: check Vercel function logs for
   the actual error. Most common: DATABASE_URL invalidated by a Neon
   credential rotation. Fix by re-pulling env vars from the Neon
   integration.

**Important**: the cron and the contract NEVER depend on Postgres
for correctness. The Postgres mirror is a UI accelerator, not a
source of truth. If Postgres is permanently lost, every position can
still be managed by reading the on-chain config and calling the
contract directly via Etherscan.

---

## Scenario 6.5 — COMPOUNDER_CRON_SECRET rotation

Audit I7 fix. Different from the operator key (Scenario 2) — this is
the Bearer token between GH Actions and the Vercel cron endpoint.
Compromise risk is moderate: a leaked secret lets an attacker submit
arbitrary cron triggers, but the route still runs against the
operator wallet's budget and against the keeper's own cooldown +
threshold logic, so the worst case is wasted gas on positions the
attacker chose to prioritise.

**Trigger**: scheduled rotation (every 90 days minimum), suspected
GH Actions secret leak (logs accidentally pasted in Discord, etc.),
team member offboarded.

**Procedure** (zero-downtime, ~5 min):

1. Generate a new 32-byte hex secret OFF-CHAIN:
   ```bash
   openssl rand -hex 32
   ```
2. **Vercel first** — update `COMPOUNDER_CRON_SECRET` to the new
   value (Settings → Environment Variables → edit → Save). Mark
   sensitive ON.
3. Redeploy Vercel from the dashboard so the new env reaches the
   live function instance.
4. Wait for Vercel to report ✅ Ready.
5. **GitHub second** — update the `COMPOUNDER_CRON_SECRET` repo
   secret to the same value. Settings → Secrets and variables →
   Actions → Update.
6. Trigger one manual cron run + one manual reconcile run via the
   Actions tab. Both should return ✅.

**Order rationale**: Vercel before GitHub. If GitHub had the new
secret first, GH Actions would post the new token to a Vercel
endpoint that still expects the old one and every workflow run
would fail with 401 until Vercel caught up. The reverse window
(Vercel knows the new token, GH still sends the old one) also
fails — 401 — but the failure is BOUNDED by the GH Actions
cadence (one missed tick per cron, vs. the indefinitely-failing
state if GH was updated first and an operator forgot to redeploy
Vercel).

**Important**: both `/api/compounder/cron` AND
`/api/compounder/reconcile` use this single secret. Update once;
both endpoints flip atomically because they read the same env.

**Failure mode**: if you skip the Vercel redeploy step, the new
env var sits in storage but the live function still has the old
one cached. Symptoms: GH Actions return 401 after the rotation
even though both sides "look" updated. Force a redeploy.

---

## Scenario 7 — Lost / fat-fingered transferOwnership

**Trigger**: owner sent `transferOwnership(WRONG_ADDR)`. Now the
contract has no recoverable admin.

**Impact**: the Compounder is permanently bricked for admin actions.
Specifically:
- setPaused unreachable → cannot pause during a future incident.
- setOperator unreachable → cannot rotate the operator key.
- setFeeRecipient unreachable → cannot rotate the treasury.
- setProtocolFeeBps unreachable → fee rate locked at current value.

**The escape that still works**: `withdrawPosition` is callable by
each depositor independently of admin. Users can recover their NFTs.

**Recovery procedure**: there is no recovery. Plan ahead:
1. **Pre-mainnet**: migrate to OpenZeppelin's Ownable2Step pattern
   so transferOwnership is two-phase (proposed → accepted).
2. **Until then**: the owner role should be a multisig with >= 2
   signers required for transferOwnership. A single signer fat-finger
   on a multisig stalls the queued tx; the other signer reviews
   before signing.
3. **Comms script** if it happens anyway: tell users to withdraw
   their positions immediately; the keeper service ends.

---

## Periodic review checklist

Run weekly during testnet, daily during the first 30 days post-mainnet:

- [ ] Vercel last 24h deployments — any failed builds?
- [ ] GH Actions compounder-scan success rate last 24h — should be > 95%.
- [ ] Operator wallet USDC balance — refill if < 3 days at current spend rate.
- [ ] `cast call $COMPOUNDER 'paused()(bool)'` should return false.
- [ ] Neon storage usage — alert at 80% of free tier.
- [ ] No `compounder_actions` rows in status='failed' older than 1 day.
- [ ] `SELECT COUNT(*) FROM compounder_positions WHERE withdrawn_at IS NULL`
      matches the expected active position count.

---

## Pre-mainnet tabletop (run once before launch)

A 90-minute walkthrough with two people. One reads the scenario
aloud, the other talks through their actions. Don't actually execute
on mainnet — testnet is the dry-run.

Scenarios to walk:
1. "We just discovered the keeper is being sandwiched. What do you do?"
2. "Our hot wallet leaked. What's your first action?"
3. "It's 3am Saturday, GH Actions are red, Discord is on fire. Walk me through your first 15 minutes."
4. "We need to upgrade the contract. How do users hear about it?"

Document everyone's answers. Patch the runbook where the
walkthroughs surface gaps.
