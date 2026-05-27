# Arcade Agent Skill

Deploy and trade tokens on **Arcade** — a USDC-native DEX + launchpad on **Arc**
(Circle's EVM L1). This skill lets an agent launch a token, trade it, and claim
creator fees programmatically with a funded wallet.

> **Chain:** Arc Testnet · chainId **5042002** · RPC `https://5042002.rpc.thirdweb.com`
> · explorer `https://testnet.arcscan.app` · gas + quote token is **USDC** (no WETH).
>
> **Addresses (source of truth):** fetch `https://arcade.trading/deployments.json`.
> Always read addresses from there — they change on redeploy. Below, `A.*` refers
> to `addresses.*` in that file (e.g. `A.launchpad`).

USDC has **6 decimals**; launch tokens have **18 decimals**. Total supply per
launch is fixed at **1,000,000,000**. Creation fee is **3 USDC** (`constants.creationFeeUsdc`),
pulled from the caller on every launch.

---

## Capabilities

1. **Launch a token** — three modes:
   - **Pump** — pump.fun bonding curve, 50/50 platform/creator, LP burned at migration.
   - **Arcade** — bonding curve, 70/30, optional secondary creator wallet.
   - **Clanker** — NO curve: full supply locked single-sided in a Uniswap-V3-style
     pool at launch, tradeable instantly, un-ruggable; swap fees flow to up to 3
     configurable recipients.
2. **Trade** — buy/sell on the bonding curve, or swap migrated/Clanker tokens via the
   V2 router (curve tokens) or V3 router (Clanker tokens). Quote first.
3. **Multi-token swap** — N inputs → 1 output, atomically.
4. **Claim creator fees** — collect a Clanker position's accrued LP fees (split per recipient).

---

## 1. Launch — Pump / Arcade (bonding curve)

`launchpad.createToken(name, symbol, metadataURI, mode, creator2, creator2ShareBps)`

| param | type | notes |
|---|---|---|
| `mode` | uint8 | `0` = Pump, `1` = Arcade. (Use `createClankerV3` for Clanker.) |
| `creator2` | address | Arcade only — optional 2nd fee receiver, else `address(0)` |
| `creator2ShareBps` | uint16 | share of the creator portion to `creator2` (0–10000) |

First approve `A.USDC` to `A.launchpad` for `constants.creationFeeUsdc`. Emits
`TokenCreated(token, ...)` — decode it for the new token address.

## 1b. Launch — Clanker (single-sided locked V3)

`launchpad.createClankerV3(name, symbol, metadataURI, recipients, fee, creatorBuyUsdc)`

| param | type | notes |
|---|---|---|
| `recipients` | tuple[] | up to **3**: `{ address recipient, address admin, uint16 bps, uint8 tokenPref }` |
| `fee` | uint24 | fee tier: `10000` (1%), `20000` (2%), or `30000` (3%) |
| `creatorBuyUsdc` | uint256 | optional USDC to buy your own token at launch (atomic) |

- `bps` must **sum to 10000**. `tokenPref`: `0` = Both, `1` = USDC-only (paired),
  `2` = token-only (clanker). At least one recipient must cover each side.
- Each recipient's `admin` can later call `locker.updateRecipient` / `updateAdmin`.
- Approve `A.USDC` to `A.launchpad` for `creationFeeUsdc + creatorBuyUsdc`.

## 2. Trade

- **Curve buy/sell** (Pump/Arcade, pre-migration): `launchpad.buy(token, usdcIn, minTokensOut)`
  / `launchpad.sell(token, tokensIn, minUsdcOut)`. Approve USDC/token to `A.launchpad`.
- **Clanker token swap** (V3): quote then swap.
  - Quote (eth_call): `quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn)`.
    `fee` = the token's pool tier (read `pool.fee()`; default 10000).
  - Swap: `router.exactInputSingle(tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, deadline)`.
    Approve `tokenIn` to `A.v3Router`. For token→token route, use
    `exactInputThroughUsdc(...)` (hops via USDC).
- **Migrated curve token swap** (V2): `v2Router.swapExactTokensForTokens(amountIn, minOut, path, to, deadline)`,
  `path = [tokenIn, USDC, tokenOut]` or direct. Approve to `A.v2Router`.

## 3. Multi-token swap

`multiSwap.swapToSingle(inputs, tokenOut, minTotalOut, deadline)` where `inputs`
is `{ address token, uint256 amount }[]` (≤8). Approve each input token to `A.multiSwap`.
Quote first with `quoteSwapToSingle(inputs, tokenOut)`.

## 4. Claim creator fees (Clanker)

- Find the position: `locker.positionIdByToken(token)`.
- Inspect recipients: `locker.getRecipients(positionId)` → `{recipient, admin, bps, tokenPref}[]`.
- Claim (permissionless; pays the registered recipients): `locker.collectFees(positionId)`
  → `(pairedAmount, clankerAmount)`. Split per-pot by bps + tokenPref.

---

## Example — launch a Clanker token (viem)

```ts
import { createWalletClient, http, parseUnits, getContract } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const cfg = await (await fetch("https://arcade.trading/deployments.json")).json();
const A = cfg.addresses;
const chain = { id: cfg.chain.chainId, name: cfg.chain.name,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [cfg.chain.rpcUrl] } } };

const account = privateKeyToAccount(process.env.PK as `0x${string}`);
const wallet = createWalletClient({ account, chain, transport: http(cfg.chain.rpcUrl) });

// 1) approve USDC creation fee to the launchpad
await wallet.writeContract({ address: A.USDC, abi: erc20Abi, functionName: "approve",
  args: [A.launchpad, BigInt(cfg.constants.creationFeeUsdc)] });

// 2) launch — 100% of fees to you, in Both tokens, 1% tier, no creator buy
await wallet.writeContract({
  address: A.launchpad,
  abi: LAUNCHPAD_ABI, // createClankerV3(string,string,string,(address,address,uint16,uint8)[],uint24,uint256)
  functionName: "createClankerV3",
  args: ["My Token", "MYT", "ipfs://...",
    [{ recipient: account.address, admin: account.address, bps: 10000, tokenPref: 0 }],
    10000, 0n],
});
```

The full ABIs are exported from the Arcade web app under `web/lib/abis/`
(`launchpad.ts`, `dex.ts`, `multiSwap.ts`, `v3.ts`). Function signatures above are
authoritative; encode against them.

## Safety notes for agents
- This is a **testnet**. Use a throwaway funded key; never reuse a mainnet key.
- Always `approve` the exact spender (launchpad / v2Router / v3Router / multiSwap)
  before a write that pulls tokens.
- Quote before swapping and pass a non-zero `amountOutMinimum` / `minOut` in production.
- Clanker LP is permanently locked — you can never withdraw the principal, only fees.
