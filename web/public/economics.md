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

## 2. Launchpad — bonding curve (modes **Pump** & **Arcade**)

Fixed 1B supply. Trading on a constant-product curve vs virtual reserves;
migrates to a V2 pool when the curve fills, LP burned (un-ruggable).

- **Creation fee:** 3 USDC (treasury).
- **Trade fee:** 1% of every curve swap, in USDC. Split by mode:
  - **Pump:** 50% platform / 50% creator(s)
  - **Arcade:** 70% platform / 30% creator(s) (optional 2nd creator address)
- **Curve:** virtual reserves 5,000 USDC / 1B tokens; 800M sold on the curve;
  migration at ~20,000 USDC raised → seeds the V2 pool with the raised USDC +
  the remaining 200M tokens, then burns the LP to `0xdead`.
- **Post-migration royalty:** 0.30% on swaps routed through the launchpad
  (`buyMigrated`/`sellMigrated`/`swapMigratedRoute`) — **0.20% platform +
  0.10% creator(s)** — charged on top of the standard 0.30% V2 LP fee.

**Inspiration:** pump.fun. Differences: we share the 1% with the creator
(pump.fun historically kept it all) and add a perpetual post-migration royalty.

---

## 3. Launchpad — **Clanker** mode (locked single-sided V3 LP)

No bonding curve. The full LP supply is locked single-sided in a Uniswap V3
pool at creation; the token is tradeable instantly and the **principal is
locked forever** (un-ruggable — only fees can be collected).

- **Creation fee:** 3 USDC (treasury).
- **Swap fee tier:** 1% / 2% / 3% (creator picks).
- **Fee split (LP swap fees):**
  - **Default** (simple launch): creator **80%** / treasury **20%**.
  - **Custom** (`createClankerV3`): up to **3 recipients** with admin + reward
    preference (Both / USDC-only / Token-only). ⚠️ **Currently the custom
    recipients' bps must sum to 100% and they receive 100% of the LP fees —
    there is no forced platform cut in the custom path.** (Open decision: enforce
    a mandatory 20% platform cut so custom recipients split only the 80%; this
    needs a contract change — `MAX_RECIPIENTS` 3 → 4 — and a redeploy.)
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

- **V2 (Pump/Arcade after migration):** standard 0.30% fee to LPs; LP tokens
  burned at migration so the launch liquidity can never be pulled.
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
  - **Circle:** ≤ 0.01% (`maxFee = amount / 10,000`, upper bound; Iris usually
    charges less).
  - **Arcade:** 0.05% (`ARCADE_BRIDGE_FEE_BPS = 5`). ⚠️ **Preview-only today** —
    shown in the UI but **not yet charged on-chain**; it will be collected once
    the bridge fee router is deployed on every source chain (mainnet).
- Editable destination address; mid-bridge recovery on page refresh.

**Inspiration:** Circle CCTP fast transfers. Our take: standard stays free as a
loss-leader, fast is monetized (0.05%) once the fee router ships.

---

## Where the platform (treasury) earns

| Source | Platform revenue |
|--------|------------------|
| DEX V2 | 0.05% of volume (`feeTo`) |
| Pump curve | 0.5% of curve volume |
| Arcade curve | 0.7% of curve volume |
| Post-migration | 0.20% of routed volume |
| Clanker | 20% of LP fees in the default split (≈0.20% of volume on a 1% pool); 0% if a creator sets fully-custom recipients (see open decision) + anti-sniper skim |
| Fast bridge | 0.05% (once the fee router ships) |
| Creation | 3 USDC per token, all modes |
