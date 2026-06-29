# Arcade Agent Skill

Deploy and trade tokens on **Arcade** — a USDC-native DEX + launchpad on **Arc**
(Circle's EVM L1). This skill lets an agent launch a token, trade it, and claim
creator fees programmatically with a funded wallet.

> 🔀 **Two ways to use Arcade as an agent — pick one:**
> - **Non-custodial (recommended):** the **Arcade Agent API / MCP**. Arcade
>   returns ready-to-sign descriptors and you sign with your **own Circle
>   Wallet** (Arcade never sees your key). See
>   `https://www.arcade.trading/api/agent/openapi`, `https://www.arcade.trading/llms.txt`,
>   or run `npx -y arcade-agent-mcp`.
> - **This skill (raw key):** signs directly with a private key you supply. Only
>   for throwaway testnet keys. Continue below.

> ⚠️ **Security (Audit C-9):** Arc **Testnet only**. This skill signs
> transactions with the private key you supply — use a **throwaway,
> testnet-only key**, never one that holds mainnet funds or is reused on a
> production chain. Treat any key handed to an agent as disposable.

> **Chain:** Arc Testnet · chainId **5042002** · RPC `https://5042002.rpc.thirdweb.com`
> · explorer `https://testnet.arcscan.app` · gas + default quote token is **USDC**.
> A (non-official) **WETH** at `A.WETH` is also available as a Clanker pool pairing.
>
> **Addresses (source of truth):** fetch `https://www.arcade.trading/deployments.json`.
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

`launchpad.createClankerV3(name, symbol, metadataURI, recipients, optsData)`

| param | type | notes |
|---|---|---|
| `recipients` | tuple[] | up to **3**: `{ address recipient, address admin, uint16 bps, uint8 tokenPref }` |
| `optsData` | bytes | ABI-encoded `ClankerOptions` (see below) |

`optsData = abi.encode(ClankerOptions)` where the struct is, **in this exact order**:

```
(uint24 fee,              // 10000 (1%) / 20000 (2%) / 30000 (3%)
 uint256 creatorBuyUsdc,  // optional USDC self-buy at launch (USDC pools only; must be 0 for WETH)
 uint16 vaultPct,         // 0..9000 bps of supply to lock+vest (0 = none)
 uint64 vaultLockupDuration, uint64 vaultVestingDuration,  // seconds; lockup ≥ 7 days if vaultPct>0
 address vaultRecipient,
 uint16 snipeStartBps,    // 0..5000 anti-sniper tax, decays to 0 (router-enforced, soft)
 uint32 snipeDecaySeconds,
 uint8 poolType,          // 0 Standard(USDC 35k,3pos) · 1 Legacy(USDC custom,1pos) · 2 Deep(USDC 50k,3pos) · 3 WETH(10 ETH,3pos)
 uint256 legacyMcapUsdc)  // Legacy only: start mcap, 1e6..1_000_000e6 (1..1M USDC); 0 otherwise
```

- **Fee split:** the platform **always keeps 20%**; your `recipients` split the remaining **80%**
  (the contract rescales them and appends the treasury at 20%). `bps` must **sum to 10000**.
- `tokenPref`: `0` = Both, `1` = USDC-only (paired), `2` = token-only (clanker). You do NOT need to
  cover both sides — the platform recipient (Both) always does.
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

const cfg = await (await fetch("https://www.arcade.trading/deployments.json")).json();
const A = cfg.addresses;
const chain = { id: cfg.chain.chainId, name: cfg.chain.name,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [cfg.chain.rpcUrl] } } };

const account = privateKeyToAccount(process.env.PK as `0x${string}`);
const wallet = createWalletClient({ account, chain, transport: http(cfg.chain.rpcUrl) });

// 1) approve USDC creation fee to the launchpad
await wallet.writeContract({ address: A.USDC, abi: erc20Abi, functionName: "approve",
  args: [A.launchpad, BigInt(cfg.constants.creationFeeUsdc)] });

// 2) launch — your recipients split 80% (platform keeps 20%), Standard pool, 1% tier
import { encodeAbiParameters } from "viem";
const optsData = encodeAbiParameters(
  [{ type: "tuple", components: [
    { name: "fee", type: "uint24" }, { name: "creatorBuyUsdc", type: "uint256" },
    { name: "vaultPct", type: "uint16" }, { name: "vaultLockupDuration", type: "uint64" },
    { name: "vaultVestingDuration", type: "uint64" }, { name: "vaultRecipient", type: "address" },
    { name: "snipeStartBps", type: "uint16" }, { name: "snipeDecaySeconds", type: "uint32" },
    { name: "poolType", type: "uint8" }, { name: "legacyMcapUsdc", type: "uint256" },
  ]}],
  [{ fee: 10000, creatorBuyUsdc: 0n, vaultPct: 0, vaultLockupDuration: 0n, vaultVestingDuration: 0n,
     vaultRecipient: account.address, snipeStartBps: 0, snipeDecaySeconds: 0, poolType: 0, legacyMcapUsdc: 0n }],
);
await wallet.writeContract({
  address: A.launchpad,
  abi: LAUNCHPAD_ABI, // createClankerV3(string,string,string,(address,address,uint16,uint8)[],bytes)
  functionName: "createClankerV3",
  args: ["My Token", "MYT", "ipfs://...",
    [{ recipient: account.address, admin: account.address, bps: 10000, tokenPref: 0 }],
    optsData],
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
