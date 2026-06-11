# Incident response runbook

> Per-CRIT-class playbook. Operator (or whoever holds the on-call
> phone) follows this top-to-bottom when one of the documented threat
> scenarios fires. Update after every drill and every real incident.

Last updated: 2026-06-11.

## Pre-incident: communications scaffolding

Set these up BEFORE going live on mainnet:

- **Status page** — `status.arcade.trading` (Vercel-hosted static
  Markdown, edits via PR + auto-deploy). Document any unscheduled
  downtime here within 15 min of detection.
- **Discord #incidents** — operator + on-call + at least two community
  moderators. Pinned message: link to this runbook + this status page.
- **Twitter / X account** — `@arcadetrading`. Authorize at minimum
  two people. Pre-write templates for common scenarios (drafts in
  `docs/incident-templates/`).
- **Treasury multisig signers list** — physical contact (Signal /
  phone) for each signer. Stored offline.
- **External lawyer on retainer** — for regulatory or LE escalation.

## Severity classification

- **SEV-1** — funds at risk, active exploit, or chain-state corruption
  imminent. Treasury multisig MUST be involved within 30 min.
- **SEV-2** — UI broken, users cannot transact, or significant data
  integrity issue. Fix within 4 h.
- **SEV-3** — degraded experience (slow quotes, intermittent errors).
  Fix within 24 h.

---

## Scenario 1 — Trusted signer compromise

**Indicator**: unauthorized `Authorized` events on the escrow contract
that don't match a real OAuth flow on our backend. Or: the Vercel env
var has been read by a leak (CI scrape, repo audit, etc.).

### SEV-1 immediate actions (first 30 min)

1. **Owner calls `pause()`** on the escrow (`cast send <escrow>
   "pause()" --private-key <owner>` — owner is currently EOA, will be
   Gnosis Safe at mainnet). This blocks new `authorize` calls AND new
   `claimByTwitter` calls; vetoes and creditSlot remain enabled.
2. **Owner reads the pending claims queue** via the contract events
   `Authorized` since the suspected compromise time:
   ```bash
   cast logs --address <escrow> --from-block <suspect> \
     "Authorized(uint256,uint256,address,address,uint256,address,uint256,bytes32,uint256)"
   ```
3. **For each pending claim that looks fraudulent**: call
   `veto(nonce)`. The veto window is 24 h after `authorize`; missing
   the window means the claim auto-executes regardless of the pause
   state if `nonReentrant` lets it through. Don't be late.
4. **Rotate the signer**: call
   `requestTrustedSignerRotation(newSigner)`. This starts a 24 h
   timelock. Communicate to users that claims are paused for 24 h.
5. **Generate fresh signer key** in AWS KMS (if KMS is wired) or
   `openssl rand -hex 32` for the legacy EOA path. Get the address
   that derives from it.
6. **Update Vercel env** `ARCADE_BACKEND_PRIVATE_KEY` with the new
   key. Redeploy.
7. After 24 h timelock elapses: `finalizeTrustedSignerRotation()`.
8. `unpause()` and resume normal operations.

### Communications

- **t+15 min**: status page note. Generic — "investigating unusual
  escrow activity, all claims paused."
- **t+1 h**: Discord update with confirmed scope (which slots affected,
  which were vetoed in time, which were not).
- **t+24 h**: full post-mortem.

---

## Scenario 2 — Treasury / owner compromise (EOA pre-multisig)

**Indicator**: `setTrustedSigner`, `pause`, `rotateLockerRecipient`,
`forfeitStaleClaim`, or `rescue` called from an unexpected tx.

This is **catastrophic before multisig migration**. There is no
on-chain undo because `treasury` is immutable.

### SEV-1 actions

1. **Owner cannot recover** — the attacker now controls the same
   powers. Whoever signs FIRST wins.
2. If we still hold the owner key: **transfer ownership** to a fresh
   Gnosis Safe (deploy on Arc first, this is the post-mainnet design
   regardless). `transferOwnership` is two-step; the new Safe must
   `acceptOwnership()`.
3. If we DON'T hold the owner key: the only path is **community
   coordination** to fork the launchpad to a new deployer. All credited
   balances on the old escrow stay claimable because the escrow's
   owner powers are bounded (`rescue` can't touch `creditedTotal`).
4. **Communicate** widely on every channel: any pending
   `requestTrustedSignerRotation` or `setClaimTimelock` must be
   considered hostile.

### Prevention

Run mainnet with a 3-of-5 Gnosis Safe from day 0. Documented in
`AUDITOR_ONBOARDING.md` and `.research/audit-2026-06-11-v2-mainnet-deep.md`.

---

## Scenario 3 — Critical contract bug discovered

**Indicator**: an external audit, a public bug bounty, or our own
review surfaces an active exploit path.

### SEV-1 actions

1. **Quantify exposure**: which functions, which roles can trigger,
   how much value is at risk per call.
2. **Pause what's pausable**: escrow has `pause()`. Launchpad does
   NOT — accept that creators may keep creating tokens during
   incident if the bug doesn't affect token creation. If it does,
   communicate explicitly: "do not create new tokens until further
   notice."
3. **Patch + redeploy**: gen N → gen N+1 redeploy via
   `DEPLOY_GEN9.md` (adapt for the new generation). New addresses;
   flip Vercel env vars; users migrate via UI prompts.
4. **Migration tool**: for high-blast-radius bugs, ship a one-shot
   `MigrationHelper` contract that lets users self-migrate their
   credited balances or locker positions to the new generation.

### Comms

- t+0: status page + Discord + Twitter all simultaneously. Be
  explicit about what users SHOULD and SHOULD NOT do.
- t+24 h: post-mortem and root-cause.
- t+7 d: refund or restitution plan if losses occurred.

---

## Scenario 4 — Arc RPC outage

**Indicator**: `arcade.trading` shows "RPC error" widely. Cast calls
timeout against `https://rpc.testnet.arc.network`.

### SEV-2 actions

1. Switch the Vercel env `NEXT_PUBLIC_ARC_RPC_URL` to a failover
   provider. Currently `rpc.testnet.arc.network` is the only known
   public endpoint — for mainnet, expect Alchemy/Infura/QuickNode
   options. Pre-register accounts now.
2. Pin `Cache-Control` longer on /stats and any read-heavy route so
   stale-data > no-data.
3. Communicate: status page only. Most users won't see this; the ones
   who do will refresh.

### Prevention

- Multiple RPC providers configured in Vercel with explicit failover.
- Indexer (Ponder) reading from a redundant set so stats keeps
  serving even when one RPC is down.

---

## Scenario 5 — Iris (CCTP V2 attestation) outage

**Indicator**: bridge UI stuck on "Waiting for Circle attestation…"
across multiple unrelated burns.

### SEV-2 actions

1. Confirm at `https://iris-api.circle.com/status` (or whatever the
   official Circle status URL is at the time).
2. Surface a banner in the BridgeCard: "Circle's attestation service
   is currently delayed; your burn will complete automatically when
   the service is back. No further action needed on your end."
3. The CCTP V2 burn is irrevocable once submitted — there's nothing
   to undo. Users just wait.
4. If Circle confirms a sustained outage > 24 h, escalate via the
   Circle support email (replace with real contact when known).

---

## Scenario 6 — Frontend XSS / supply-chain compromise

**Indicator**: a deploy ships with a malicious npm package, a hostile
PR slipped through, a CDN compromise.

### SEV-1 actions

1. **Roll Vercel deploy back** to the last known-good commit. Settings
   → Deployments → previous Production → "Promote to Production".
2. **Audit the deployed code**: which commit introduced the change,
   what's the blast radius (only display, or signing flows too).
3. If signing was at risk: assume any signature created during the
   compromise window is hostile. Revoke any Permit2 approvals from
   affected users (instructions: visit
   `https://app.uniswap.org/#/tokens` → revoke per-token, or use
   Permit2's `lockdown` function if we ship a one-shot revoke UI).
4. **Communicate** with extreme care: "Do not connect your wallet to
   arcade.trading until we confirm the fix. Revoke any Permit2
   approvals you granted in the last <window>."

### Prevention

- npm `audit fix` weekly; Dependabot enabled on critical deps.
- CSP `script-src` allowlist (current: `frame-ancestors 'none'` only —
  audit v2 flagged this gap). Tighten before mainnet.
- Vercel "Required Reviewers" on Production deploys.

---

## Scenario 7 — Stuck escrow slot (orphaned recipient)

**Indicator**: a user's claim succeeded but the locker's slot
recipient stayed as the escrow contract. Future `collectFees` keeps
routing into the escrow under an already-claimed slot.

This SHOULD NOT happen post-CONTRACT-2 (rotateSlot atomic). If it
does:

### SEV-3 actions

1. Owner calls `rotateLockerAdmin(positionId, slotIndex, user)` then
   `rotateLockerRecipient(positionId, slotIndex, user)` to unstick.
2. Any tokens accumulated in the escrow for that slot since the
   claim are recoverable via `pullFromLocker(token)` →
   `rescue(token, user, amount)`.

### Prevention

Tests verifying the gen 9 atomic rotateSlot success path (CRIT-1 fix:
MockLocker now has rotateSlot).

---

## Tabletop drill cadence

- **Quarterly** before mainnet: walk through ONE scenario end-to-end.
  Time-box (60 min). Document gaps in this file.
- **Annual** post-mainnet: full incident sim with treasury multisig
  signers.

---

## Recovery toolkit (memorise paths)

```bash
# Pause escrow
cast send <escrow> "pause()" --private-key <owner> --rpc-url <RPC>

# Veto a pending claim
cast send <escrow> "veto(bytes32)" <nonce> --private-key <owner> --rpc-url <RPC>

# Start signer rotation
cast send <escrow> "requestTrustedSignerRotation(address)" <newSigner> \
  --private-key <owner> --rpc-url <RPC>

# Finalize after 24 h
cast send <escrow> "finalizeTrustedSignerRotation()" \
  --private-key <owner> --rpc-url <RPC>

# Owner-side recovery for stranded locker recipients
cast send <escrow> "rotateLockerAdmin(uint256,uint256,address)" \
  <positionId> <slotIndex> <user> --private-key <owner> --rpc-url <RPC>

# Owner-side recovery for stuck pull-payment ledger entries
cast send <escrow> "pullFromLocker(address)" <token> \
  --private-key <owner> --rpc-url <RPC>
```

Document all incidents in `docs/incidents/<YYYY-MM-DD-<slug>>.md` so
future operators have searchable precedent.
