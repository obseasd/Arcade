# V4 ArcadeHook sunset plan (audit A-8)

> Strategy doc — pre-mainnet artifact. Owned by the protocol lead.
> Updated 2026-06-10 alongside the gen 8 audit batch.

## Why this doc exists

The V4 ArcadeHook (1147 LoC, partially complete in `contracts/v4src/`)
subsumes the launchpad bonding-curve, the V2 migration path, the V3
locker fee-split, and the Twitter escrow attribution into a single
hook contract on top of Uniswap V4's PoolManager. Without an explicit
sunset plan, V4 lands next to the V2 / V3 stack and the protocol ends
up maintaining two parallel fee accounting paths, two locker
contracts, two escrow integrations, and double audit cost forever.

This doc decides when each V2 / V3 surface stops accepting NEW
liquidity and how the existing positions wind down.

## Timeline (target windows)

```
T = 0          V4 mainnet deployment + external audit publication
T + 7 days     V4 user-facing launch ("ArcadeHook" branding live)
T + 30 days    Marketing push exclusively on V4. /launchpad/create UI
               shows V4 by default; V2/V3 paths still selectable but
               labelled "legacy".
T + 60 days    /launchpad/create UI HIDES V2 + V3 launch paths from the
               default mode. Power users can still hit /launchpad/v2 or
               /launchpad/v3 directly but the surface is unlinked.
T + 90 days    ArcadeLaunchpad.createToken() reverts ("V2_LAUNCH_CLOSED").
               Existing V2 tokens keep trading via the curve until their
               own graduation; the new-launch path is closed.
T + 90 days    ArcadeLaunchpad.createClankerV3() reverts ("V3_LAUNCH_CLOSED").
               Existing CLANKER_V3 positions continue fee accrual; no
               new V3 positions can be opened through the launchpad.
T + 180 days   V3 Locker frozen: positions remain claimable, but the
               admin-rescue path is disabled by sending the owner role
               to address(0xdead). Recipient rotation still works for
               existing positions; no new lockSingleSided calls.
T + 365 days   Sunset audit pass over what remains live (V4 hook +
               twitter escrow + V4 locked-vault). External auditor
               re-confirms no unintended surface remains exposed.
```

## What each surface does during sunset

### V2 launchpad (ArcadeLaunchpad.sol PUMP + CLANKER modes)

- **T+0 to T+90**: createToken / buy / sell / migrate continue working.
  Migrated V2 tokens trade on Uniswap V2 forks normally.
- **T+90 onward**: createToken reverts. Existing un-graduated curves
  continue to accept buy() / sell() until the next migrate() lands
  organically. swapMigratedRoute keeps charging the 30 bps royalty.

### V3 launchpad (ArcadeLaunchpad.sol CLANKER_V3 mode)

- **T+0 to T+90**: createClankerV3 + creator-buys + creatorBuyUsdc all
  active. Single-sided liquidity locks normally.
- **T+90 onward**: createClankerV3 reverts. Existing positions stay
  locked under the V3 Locker indefinitely; `claimFees` flows on the
  existing recipient rotation schedule.

### V3 Locker

- **T+0 to T+180**: unchanged. Recipients claim fees per position.
- **T+180 onward**: owner role transferred to `0xdead`. adminRescue
  becomes unreachable (the canonical owner check fails). collectFees,
  updateRecipient, withdrawPending all stay live because they don't
  gate on owner.

### Twitter Escrow V3

- **Stays live indefinitely**: V4 ArcadeHook calls the same escrow's
  creditSlot for its launchToken-attributed fees. No migration needed.
- **L-3 signer timelock (24 h)** applies before any signer rotation,
  so an emergency rotation lands cleanly.

### V4 ArcadeHook + V4 Locked Vault

- **Becomes the canonical stack from T+0**. All new launches route here.
- Audited separately under the "V4 launch" external audit window.

## What V4 does NOT take over

- **CCTP bridge (BridgeCard)** — independent of the launchpad stack.
  Stays as-is; affected only by Circle's own CCTP upgrades.
- **Aggregator routing (lib/routing)** — provider abstraction stays.
  When the V4 launchToken needs its own provider, `v4Hook` joins as a
  5th RouteProvider in the same list.
- **ENS / Send modal** — wallet utilities, unrelated to V4.

## Open questions to resolve before T = 0

1. **External audit scope of V4**: full pass on ArcadeHook +
   AntiSniperHook + V4Launchpad + the hook permissions, or just the
   delta from V3? Recommend full pass — the contract is large enough
   that a delta-only audit misses interaction risks with V4 core.

2. **Migration tool for V3 NPM positions**: do we want a one-click
   "convert your V3 single-sided lock into a V4 position with the
   same recipient + bps split"? The economics are similar but not
   identical (V4's hook-managed liquidity has different fee accrual
   timing). Default decision: NO migration tool, positions stay on V3
   forever. Re-evaluate if power users request it.

3. **Pricing of legacy V2 + V3 tokens**: the V4 swap aggregator should
   continue to route through Arcade V2 + V3 indefinitely so existing
   tokens stay tradeable. Confirm the provider for each stays wired
   regardless of the launchpad-create surface being closed.

4. **Owner transfer ceremony for V3 Locker**: at T+180, the owner role
   moves to `0xdead`. Decide whether a final adminRescue sweep happens
   first (to a multisig) for any tokens caught between launches.

## Triggers that DELAY the sunset

The timeline above assumes V4 mainnet ships cleanly + the audit comes
back without HIGH findings. Triggers that PUSH the sunset back:

- HIGH finding in V4 ArcadeHook audit (push T+90 by audit-fix +
  re-audit cycle, typically 4 - 6 weeks).
- Circle CCTP V3 transition during the sunset window (de-prioritize
  hook sunset, focus on bridge upgrade).
- Significant V2 / V3 trading volume that would lose if creators can't
  open new launches (re-evaluate the T+90 hard cut — perhaps gate
  behind a separate governance vote).

## Triggers that ACCELERATE the sunset

- Critical bug in V2 / V3 launchpad that V4 doesn't share. Close the
  affected surface immediately, leave the other open.
- Indexer ships (per project_arcade_indexer_roadmap) and surfaces
  the V2 / V3 fee history in a unified V4 dashboard — accelerate UI
  sunset because the legacy surfaces become decorative.

## Operator checklist at each milestone

```
T + 30 days    [ ] Marketing post: V4 is now the recommended path.
                [ ] Update /launchpad/create UI default to V4.
                [ ] Open Discord thread for power-user V2/V3 retention.

T + 60 days    [ ] Hide V2 + V3 launchpad UI links from main nav.
                [ ] Send notification email to known V2/V3 creators.
                [ ] Update SECURITY.md with V4-as-canonical statement.

T + 90 days    [ ] Deploy ArcadeLaunchpad contract upgrade that
                    reverts createToken + createClankerV3.
                [ ] Verify swap aggregator still routes legacy tokens.
                [ ] Update /docs to reflect launch-create-closed.

T + 180 days   [ ] Final adminRescue sweep on V3 Locker (multisig dest).
                [ ] Transfer V3 Locker owner role to 0xdead.
                [ ] Post audit refresh delta to V3 stack.

T + 365 days   [ ] External audit pass on V4 + escrow + locked vault.
                [ ] Publish sunset retrospective.
```

## Failure modes the plan guards against

- **Two parallel fee accounting paths**: closed by sunset of V2/V3
  launchpad-create at T+90. swapMigratedRoute + V2 trading volume
  decays naturally as existing tokens migrate or stagnate.
- **Audit cost doubling**: T+365 audit covers only V4 + escrow, not
  V2/V3 surfaces that have been closed.
- **UX confusion**: marketing copy at T+30 onwards points to V4 as
  canonical. Users who hit a closed V2/V3 surface get a clear
  "this launch path is closed, use /launchpad/create" error.

## Out of scope for this doc

- V4 hook design decisions (covered in `V4_HOOK_SPEC.md`).
- Indexer migration (covered in `project_arcade_indexer_roadmap`).
- Multisig design for the operator (covered in audit C-3).

This is purely the deprecation calendar.
