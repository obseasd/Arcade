# Arcade — Offensive (exploit-focused) audit, 2026-06-28

10 aggressive finders (one per attack surface) over the Arcade-authored contracts +
money-moving backends, each suspected exploit then adversarially re-verified against the
real code by an independent skeptic. **20 raw findings → 10 confirmed, 10 refuted.**

No CRITICAL (no direct theft / mint-from-nothing / lock of others' funds) survived
verification. The standout is a **permanent launchpad migration DoS (HIGH)** that is novel,
cheap to execute, and not covered by prior audits.

## Confirmed findings

### HIGH

**H-1 — Permanent migration DoS via pre-minted V2 pair** · `contracts/src/launchpad/ArcadeLaunchpad.sol:592-595, 908-941`
An attacker pre-creates the deterministic USDC/token V2 pair and mints dust LP to themselves
*before* the curve fills. `_migrate()` (run inline inside `buy()`) guards on
`pair.totalSupply() == 0` and reverts `InvalidRoute()` when it is non-zero. Since the pair now
has `totalSupply > 0` (owned by the attacker, not DEAD), every buy sized to complete the curve
reverts forever. The curve can never reach `CURVE_SUPPLY`, migration never happens, no LP seed,
creator/treasury never get the +2,500 USDC migration outcome, late buyers stranded. There is no
admin re-migrate / rescue / alternate-pair path. Cost to attacker: gas + dust.
The in-code comment (912-930) only reasoned about benign *donation* griefing and missed that an
attacker-*owned* mint sets `totalSupply != 0`.
**Fix:** don't gate migration on `totalSupply == 0`. Pre-create the canonical pair at
`createToken` time and burn the first `MINIMUM_LIQUIDITY` mint to DEAD (closes the front-run
window), OR make `_migrate` seed liquidity proportional to existing reserves so it always
completes, OR add a namespaced-salt fallback pair.

**H-2 — MultiSwap per-leg slippage unbounded (concentrated sandwich)** · `contracts/src/swap/ArcadeMultiSwap.sol:199-205,297,372,393,412,422,439,447`
Only one global `minTotalOut` guards the whole basket; every internal leg is called with
`minOut = 0` (and the V2-via-USDC mid is floored at 1 wei). A sandwicher front-runs only the
thinnest leg and concentrates the entire basket-wide slippage budget onto it (e.g. 0.5% of a
$10k basket = ~$51 extracted from a $200 leg ≈ 25% haircut) while the global check still passes.
This is the **H-07** item already tracked in memory (per-leg `minOut[]` deferred, contract not
yet redeployed).
**Fix:** per-input `minOut[]` threaded into each router call; caller-supplied `usdcMidMin` for
the V2-via-USDC hop; keep the global bound as an outer guard.

### MEDIUM

**M-1 — V4 anti-sniper tax inert during the curve phase** · `contracts/v4src/ArcadeHook.sol:648-692,776-796`
During `Curving`, all trades go through `hook.buy` (beforeSwap reverts), which never reads
`snipeConfigs` and applies no skim. The anti-sniper tax only fires in post-graduation
`afterSwap`, i.e. after the early-curve discount has already been sniped tax-free. The advertised
"tax on every swap into the pool" is false during the window it exists to protect. (V4 launchpad
not yet live → forward-looking.)
**Fix:** apply `_currentSnipeBps` skim inside `hook.buy`; anchor the decay clock to curving start
/ graduation rather than `launchedAt`.

**M-2 — fx/circle proxy has no CSRF/rate-limit guard** · `web/app/api/fx/circle/route.ts:19-73`
Unlike every other paid route (pin/*, telemetry, ens/*), this one calls neither
`rejectCrossOrigin` nor `rateLimit`. It injects the publishable Circle kit key server-side, so the
Console domain-allowlist (the key's only protection) is bypassed and the operator's Circle
quota/billing can be drained by anyone curling it. No on-chain theft (FX swap still needs the
user signature).
**Fix:** add `rejectCrossOrigin` + per-IP `rateLimit` + a global cap (mirror pin/json).

### LOW

- **L-1 — V2 Zap dust revert** (`ArcadeV2Zap.sol:144-180,420-424`): `_calcSwapAmount` rounds to 0 for dust `amountIn` → self-DoS only. Fix: explicit `AmountTooSmall` revert.
- **L-2 — V3 router stray-dust lock** (`ArcadeV3SwapRouter.sol:160-205`): no sweep path; stranded balances locked but **not** stealable (callback amount is pool-dictated + authenticated). Fix: optional owner rescue.
- **L-3 — Identity SAFE_COUNT_CAP truncation** (`ArcadeIdentityIssuer.sol:86-91,154-162`): once `allTokens.length > 2048`, legit creators at indices ≥2048 are under-counted → denied earned tier (no inflation possible). The justifying comment ("launchpad is owner-gated") is false. Fix: per-creator `migratedCountOf` counter, O(1).
- **L-4 — twitter-callback global cap keyed on random nonce** (`twitter-callback/route.ts:115-122`): the F-5 30/min (token,slot) cap buckets on the per-login random `state`, so it throttles nothing; only the per-IP 10/min remains. No theft (authorize binds recipient==msg.sender, amounts clamped on-chain). Fix: key the cap on `(token, slotIndex)` after decoding the signed cookie.
- **L-5 — referral track/register forgeable** (`web/app/api/referral/*`): unauthenticated, caller picks every field → attribution land-grab + fabricated dashboard numbers. **Display-only today** (payout stub returns 0, killswitch off). Already documented in the referral audit. Fix: EIP-712 consent on register, tx-hash dedup + rate-limit on track.
- **L-6 — ENS leaks transfer recipient to public RPCs** (`web/app/api/ens/*`): when `MAINNET_RPC` unset, recipient name/address is disclosed to 3 third-party RPCs. Privacy only. Fix: require a first-party RPC or skip resolution.

## Refuted (correctly, by adversarial verification)

- V2 first-depositor inflation — standard V2, MINIMUM_LIQUIDITY burned to DEAD + router min-amount guards; griefing not theft.
- V3 compounder oracle lazy-growth — `observe` reverts before any state change; withdraw has no oracle dependency, owner always recovers.
- V3 double-skim — intended two-leg anti-sniper fee, both skims go to immutable treasury; bps structurally ≤5000.
- Twitter IPFS quorum-off — content-addressing blocks byte substitution for an existing CID; needs an out-of-scope TLS/gateway compromise.
- MultiSwap fee-on-transfer over-count — reverts on the sweep (self-DoS); in-scope canonical tokens aren't fee-on-transfer.
- **V4 launchpad pre-init brick (claimed HIGH)** — real mechanic but in **dead prototype code**; production `DeployV4.s.sol` deploys only `ArcadeHook` (which sets BEFORE_INITIALIZE + gates on sender==self). Not deployed → INVALID.
- V4 sell tokensSold accounting — clamp path unreachable (ERC20 balance check reverts first).
- Identity metadata-URI forgery — Issuer mint path is dead (registry gates it); no on-chain consumer of the tier.
- Non-timing-safe cron secret compare — 256-bit secret + length pre-check + network jitter ⇒ remote timing recovery infeasible.
- Compounder COMPOUND-mode self-heal HTTP hop — public withdraw route requires depositor match for active positions; cron only hits the depositor==0 case.
