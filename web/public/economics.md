# Arcade — Economic models

Source of truth for Arcade's fees and economics (DEX, launchpad, LP, bridge).
Keep in sync with the contracts. All splits are of the fee, not the trade size,
unless stated. Quote asset on Arc is **USDC** (the native gas token); there is
no native ETH.

---

## 1. Swap / DEX (`ArcadeV2`)

A faithful Uniswap V2 fork.

- **Swap fee:** 0.30% of the input, paid to LPs (`997/1000`).
- **Protocol fee:** when `feeTo` is set (it is, = treasury), 1/6 of the LP fee
  growth mints to the treasury — i.e. **0.05% of volume** to the platform,
  **0.25%** net to LPs.
- **Quote asset:** USDC.

**Inspiration:** Uniswap V2 (identical model, USDC-quoted).

---

## 2. Launchpad — bonding curve (**PUMP**, ArcadeHook V4)

The current launch path (`/launchpad/v4hook/create` → `ArcadeHook`
`0x6f107380`). Fixed 1B supply. Trades on a constant-product curve vs virtual
reserves, then GRADUATES into a locked full-range Uniswap **V4** pool (LP locked
forever — un-ruggable; the hook captures fees perpetually in before/afterSwap).

- **Creation fee:** 3 USDC (treasury).
- **Curve trade fee:** 1% of every curve swap, in USDC. **80% creator / 20%
  treasury** (optional 2nd creator address for reply-to-launch 50/50 splits).
- **Curve:** virtual reserves **5,800 USDC / 1.135B tokens**, 806M sold on the
  curve. Graduates at **~14,209 USDC raised (≈ $60k FDV)** with price continuity
  (no cliff — pump.fun method) → seeds the locked V4 LP with the raised USDC +
  the unsold remainder.
- **Post-graduation fee:** captured in USDC by the hook, **DYNAMIC** — starts at
  **1%** at graduation and decays **linearly in log-market-cap to 0.30%** as the
  mcap grows (manipulation-resistant mcap-tick EMA). Split **80% creator / 20%
  treasury** (`POST_GRAD_CREATOR_BPS = 8000`).
- **Anti-sniper:** a launch auction whose proceeds go to the creator.

**Inspiration:** pump.fun. Differences: the creator keeps **80%** of a dynamic
fee, and the graduated venue is a locked V4 LP with perpetual in-hook fee
capture (not a burned V2 pool). *(The legacy V2 curve — 50/50 Pump / 70/30
"Arcade", ~20k V2 migration — is deprecated; `/launchpad/create` is the old
path.)*

---

## 3. Launchpad — **Clanker** mode (locked single-sided LP)

> The DEFAULT Clanker today is on the **ArcadeHook V4** (`mode 1`, `Type: Direct
> (V4)`): a locked single-sided full-range V4 LP, tradeable from launch, with a
> **static 1%/2%/3% fee tier** and the same **80% creator / 20% treasury** split.
> The **V3** mechanics below describe the legacy **CLANKER_V3** (`mode 2`, via
> `ArcadeV3Locker`), still reachable but not the default create path.

No bonding curve. The full LP supply is locked single-sided in a Uniswap V3
pool at creation; the token is tradeable instantly and the **principal is
locked forever** (un-ruggable — only fees can be collected).

- **Creation fee:** 3 USDC (treasury).
- **Swap fee tier:** 1% / 2% / 3% (creator picks).
- **Fee split (LP swap fees):** the platform **always keeps 20%**; the creator
  side gets **80%**.
  - **Default** (simple launch): creator 80% / treasury 20%.
  - **Custom** (`createClankerV3`): up to **3 recipients** with admin + reward
    preference (Both / USDC-only / Token-only) split the **80%** creator share
    (their bps sum to 100% of that share); the contract rescales them to 80% and
    appends the treasury at 20% (so up to 4 on-chain recipients).
- **Pool types** (liquidity shape & start mcap):
  | Type | Paired | Start mcap | Positions |
  |------|--------|-----------|-----------|
  | Standard | USDC | 35,000 USDC | 3 (40/35/25) |
  | Legacy | USDC | custom 1 – 1,000,000 USDC | 1 |
  | Deep | USDC | 50,000 USDC | 3 (40/35/25) |
  | WETH | WETH | 10 WETH | 3 (40/35/25) |
  3-position split concentrates supply near the start (~start → ~4x → ~25x → max).
- **Anti-sniper tax:** optional, up to 50% of a buy, decaying linearly to 0 over
  a configurable window. Enforced softly at the Arcade V3 router (a direct pool
  swap bypasses it); the skim goes to the treasury.
- **Team vault:** optional, up to 90% of supply locked (≥7-day lockup) then
  linearly vested to a recipient; remainder goes to the LP.

**Inspiration:** Clanker v4 (Base). We mirror the core (locked single-sided LP,
creator ~80%, multi-position pools, vault, anti-sniper) on Uniswap **V3** (not
V4): USDC-quoted by default, anti-sniper is router-level (not a V4 MEV hook), no
dynamic fees, no merkle airdrop / auto DevBuy extensions. Pool types map to
Clanker's Project 10 / Legacy / Project 20. WETH pairing exists but in-app WETH
trading is not wired yet.

---

## 4. LP economics

- **PUMP after graduation (V4):** the raised USDC + unsold remainder seed a
  locked full-range V4 pool held by the hook (LP locked forever — un-ruggable);
  trading fees are captured in USDC by the hook's before/afterSwap and split
  80/20 creator/treasury (see §2). *(The legacy V2-migration path burned the LP
  to `0xdead` instead — deprecated.)*
- **V3 (Clanker):** the launch position is held forever by `ArcadeV3Locker`
  (no `decreaseLiquidity`, only `burn(0)` to poke fees). Swap fees accrue in two
  pots (paired/USDC side + token side) and are distributed by bps weight,
  honoring each recipient's reward-token preference.

---

## 5. Fast Bridge (Circle CCTP v2)

Cross-chain USDC via Circle's Cross-Chain Transfer Protocol (burn + mint).

- **Standard Transfer:** full finality (~minutes). **Completely free** — no
  Arcade fee, no Circle fee (`maxFee = 0`).
- **Fast Transfer:** ~10-30s. Fees:
  - **Circle:** ≤ 0.02% (`maxFee = amount * 2 / 10,000`, the ceiling we
    authorise; Iris usually charges its published minimum, ~1.3bp on Base/Arb).
    This counts toward Arcade's 0.05% all-in, it is not on top of it.
  - **Arcade:** 0.05% **all-in**, on **Fast transfers only** — Standard is free.
    All-in means Circle's own fee counts toward the 0.05%: the receiver reads
    the attested `feeExecuted` and only tops up the difference, so the total you
    pay is 0.05% and never more, whatever Circle charged.
    Charged on-chain by `ArcadeCctpBuyReceiver`, which every Fast bridge to Arc
    routes through. It is avoidable only by bridging without naming the receiver
    (i.e. not using this UI).
- Editable destination address; mid-bridge recovery on page refresh.

**Inspiration:** Circle CCTP fast transfers. Our take: standard stays free as a
loss-leader, fast is monetized at 0.05% all-in, charged on-chain today by the
bridge receiver (not pending any "fee router").

---

## Where the platform (treasury) earns

| Source | Platform revenue |
|--------|------------------|
| DEX V2 | 0.05% of volume (`feeTo`) |
| PUMP curve (V4) | 20% of the 1% curve fee = **0.20% of curve volume** |
| PUMP post-graduation (V4) | 20% of the dynamic 1%→0.30% fee (≈0.06–0.20% of volume) |
| CLANKER (V4/V3) | 20% of LP fees, always (≈0.20% of volume on a 1% pool) + anti-sniper |
| Fast bridge | 0.05% all-in, charged on-chain (Standard free) |
| Creation | 3 USDC per token, all modes |

*(Legacy V2 curve: Pump 0.5% / "Arcade" 0.7% of curve volume, + 0.20% post-migration royalty — deprecated, see §2.)*
