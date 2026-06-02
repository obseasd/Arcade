# Hats Finance Vault Submission Helper

Copy-paste-ready content for the Hats Finance vault submission form at
**app.hats.finance/vaults/submit-project**.

Estimated setup time: under 1 hour. No KYC, no platform fee, pseudonymous-friendly.

---

## Form fields

### Project name
```
Arcade
```

### One-line description
```
USDC-native AMM and fair-launch tokenization engine on Arc, Circle's EVM L1.
```

### Project type
```
DeFi / DEX / Token Launchpad
```

### Chain(s) covered
```
Arc testnet (chainId 5042002).
Will extend to Arc mainnet at launch.
```

### Project website
```
https://arcade.trading
```

### GitHub / source code
```
https://github.com/[YOUR-HANDLE]/arcade
```

### Documentation
```
https://arcade.trading/docs
```

### Twitter / X
```
https://x.com/[YOUR-HANDLE]
```

### Communication channel
```
Telegram: @[YOUR-HANDLE]
Discord: [YOUR-HANDLE]#[code]
Email: [your-pseudo]@protonmail.com
```

---

## Contract addresses in scope (Arc testnet, Generation 4)

Verify these against current `web/.env.local` before submitting. Contracts that
hold user funds or process EIP-712 signatures are the highest priority.

```
V2 DEX (Uniswap V2 fork)
  ArcadeV2Factory:        0x289b18cBFD9f2a2657c021F80423137Af6233332
  ArcadeV2Router:         0x529d7250652aAaA11b4E2407e8b49fa9ae0E5041
  ArcadeMultiSwap:        0x019e2e4F3858c470aFFf54B82Ce3E6b6e391cfA5

Bonding-curve launchpad
  ArcadeLaunchpad:        0x073a4869219D19843b57ab4CeF3AfAf24D499a56
  ArcadeTokenVault:       0x4fE2A2EeB955bbA0A94D3b23970279d13F6CeE14

Locked single-sided V3 LP (Clanker-style)
  ArcadeV3Factory:        0xB9339dE1eeC40d4f513aBD567DAb6837fc7D63D6
  ArcadeV3Locker:         0x60b23CEeA70c3846AC5f9b32E1f8598136E3E569
  ArcadeV3Router:         0xE4CaD091D2be82332688bCab444C1e394fD13Fb4
  ArcadeV3Quoter:         0xca7f8700F032eF1Cdd0708bBAcDB23cDE43bd4c7

Twitter handle reward escrow (EIP-712)
  ArcadeTwitterEscrowV3:  [FILL FROM YOUR DEPLOYMENT]

V4 launchpad prototype (in active development)
  ArcadeV4Launchpad:      [FILL IF DEPLOYED, else mark "pre-deployment"]
  ArcadeAntiSniperHook:   [FILL IF DEPLOYED]

Reference: USDC on Arc:  0x3600000000000000000000000000000000000000
```

---

## Severity tiers (recommended)

Hats lets you define payout amounts per severity. The pool you fund determines
the maximum payout. Recommended distribution for a $0 vault that may grow with
grant funding or community deposits:

```
Critical (loss of user funds, drain of LP, signature forgery):
  Up to 80% of vault balance, capped at $25,000 USDC equivalent

High (locked funds, unauthorized state changes, escrow bypass):
  Up to 40% of vault balance, capped at $10,000 USDC equivalent

Medium (DoS that requires admin intervention, fee calculation bug
without direct fund loss):
  Up to 15% of vault balance, capped at $3,000 USDC equivalent

Low (informational, gas optimization, off-by-one without fund impact):
  Up to 5% of vault balance, capped at $1,000 USDC equivalent
```

When the vault is unfunded the absolute caps apply with the % of whatever is in
the vault. Hats does not advance funds.

---

## Detailed scope (paste into Hats "scope" field)

```
IN SCOPE. Smart contract vulnerabilities on the deployed Arc testnet
contracts listed above, including:

1. Signature forgery or replay against ArcadeTwitterEscrowV3 EIP-712
   typehashes. The contract uses cached domain separator + chainId +
   per-slot accounting; reproducible attacks against any of these earn
   the appropriate severity payout.

2. Drain or unauthorized transfer of escrowed Clanker LP fees attributed
   to a Twitter handle (any path that bypasses the trusted signer flow,
   the timelock, or the forfeit window).

3. Bonding-curve math exploits on ArcadeLaunchpad. The curve uses virtual
   reserves (5,000 USDC + 1B token) targeting 20,000 USDC raise + 2,500
   USDC migration fee. Any exploit that lets a user extract more than
   their fair share, mint phantom tokens, or migrate without paying the
   2,500 USDC fee qualifies.

4. V2 swap path issues on ArcadeV2Router and ArcadeV2Pair. The fork
   preserves the 997/1000 fee structure; any deviation (different fee,
   incorrect reserve update, k-invariant breach) qualifies.

5. Locked-LP fee distribution bugs on ArcadeV3Locker (recipient slots,
   admin slots, the rotation flow). The locker has try-catch around
   recipient updates to ensure users always get tokens; a bypass of
   this guarantee qualifies.

6. Reentrancy paths in any non-trivially-guarded contract. All public
   state-changing entrypoints use OpenZeppelin ReentrancyGuard where
   applicable; bypasses qualify.

7. Allowance-griefing or denial-of-fill on ArcadeMultiSwap.

8. Migration race conditions: any exploit that lets a user front-run
   a launchpad migration to V2 to extract value.

9. Slot index 0-3 accounting bugs in ArcadeTwitterEscrowV3 (the per-slot
   creditedTotal / pending balance bookkeeping; double-credit, missing
   credit, replay across slots).

10. ArcadeAntiSniperHook anti-sniper logic on the V4 prototype (once
    deployed): any exploit that lets a sniper buy tokens at sub-tax
    price within the protected window.

OUT OF SCOPE:

- Mock contracts (MockUSDC, MockWETH) used only in tests.
- Frontend bugs at arcade.trading. Report separately at
  github.com/[handle]/arcade/issues.
- Denial-of-service against the public RPC. Arc's RPC limits are
  documented in our running-quirks log.
- Rate-limiting issues, captcha bypasses, web infra.
- Centralization risks already documented in our internal audit
  (H-02 multisig migration, H-07 V4 API change). See SECURITY.md.
- Bugs in dependencies (OpenZeppelin v5, Uniswap V2-core, V3-core,
  V4-core, Permit2). Report upstream.
- Issues that require Circle to act (USDC reserves, USDC blacklisting,
  Arc validator behavior). These are upstream of Arcade.
- Theoretical attacks requiring fundamentally broken cryptographic
  primitives (secp256k1 break, keccak256 collision).
```

---

## Audit history (paste into "audit history" field)

```
INTERNAL MULTI-AGENT AUDIT (completed June 2026)

A multi-agent internal audit pass was conducted in May-June 2026 across
the full contract surface. Findings tracker:

  HIGH severity:        7 of 8 closed (committed in 16afe44)
  MEDIUM severity:      11 of 14 closed
  LOW severity:         documented, accepted, or mitigated
  
Deferred items:

  H-02 (multisig migration): tracked, scheduled for pre-mainnet.
  H-07 (V4 API change): scoped, scheduled with V4 production migration.

SECURITY.md: https://github.com/[YOUR-HANDLE]/arcade/blob/main/SECURITY.md

Public audit reports: none yet (external audit gated on grant funding).

Bug bounty: this Hats Finance vault.
```

---

## Notes for the founder

1. **Stand up the vault first, fund later.** A $0 vault is publicly visible and lets you say "we have a live bug bounty" in grant applications.
2. **Publish a SECURITY.md** at the root of the GitHub repo before submitting. Documents the internal audit, the H-02 / H-07 deferred items, and points to the Hats vault.
3. **List the vault URL in:**
   - Repo README
   - arcade.trading/docs (new section "Security")
   - arcade.trading footer
   - Grant applications (grant-applications.md placeholders)
4. **Add to weekly /stats tweet:** "Live bug bounty: [Hats URL]" so researchers see it.
5. **If/when grant funded, seed the vault** with a portion of the audit budget. Even $5k attracts researchers. The Hats Points / APY boost kicks in at $10k+.
6. **Communication SLA:** the Hats form asks for response time commitments. Recommend "Critical: 24h, High: 72h, Medium: 5 days, Low: 14 days."
7. **Disclosure policy:** standard 90-day coordinated disclosure with the researcher. Hats handles the mediation channel.
8. **Don't accept submissions outside Hats.** Direct emails / DMs claiming bugs go through the vault or they don't qualify. Protects you legally and avoids extortion.
