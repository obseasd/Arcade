# Arcade Agent API — make Arcade usable BY agents

Arcade is a USDC-native DEX + bonding-curve launchpad on Circle's **Arc** L1.
This layer turns Arcade into infrastructure that **any third-party AI agent can
plug into**: the agent brings its own wallet, Arcade provides best-execution and
ready-to-sign transactions. Arcade never custodies agent keys.

## Trust model

```
 Third-party AI agent (Claude / LangChain / custom)
   │  owns a Circle developer-controlled wallet (USDC on ARC-TESTNET)
   │
   ├─ 1. DISCOVER   GET  /api/agent/markets         reference tokens
   │                GET  /api/agent/trending        launchpad tokens by mcap
   │                GET  /api/agent/portfolio       its balances
   │
   ├─ 2. PRICE      POST /api/agent/quote           best execution, read-only
   │
   ├─ 3. BUILD      POST /api/agent/swap            ┐ return ordered
   │                POST /api/agent/launchpad       │ CONTRACT-CALL DESCRIPTORS
   │                POST /api/agent/multiswap       ┘ (no signing, no custody)
   │
   ├─ 4. SIGN       Circle createContractExecutionTransaction (agent's wallet)
   └─ 5. SUBMIT     tx lands on Arc, settled in USDC
```

Arcade = reads + best-execution + transaction description.
Agent = custody (its Circle Wallet) + signing + submission.

Because **USDC is the native gas token on Arc**, an agent only needs a single
asset (USDC) to both pay and transact. No gas-token juggling.

## The descriptor

Every build endpoint returns `{ ok, executable, provider, amountIn, amountOut, calls }`.
Each entry in `calls` maps 1:1 onto Circle's `createContractExecutionTransaction`:

```json
{
  "chain": "ARC-TESTNET",
  "contractAddress": "0xRouter",
  "abiFunctionSignature": "exactInputSingle(address,address,uint24,address,uint256,uint256,uint256)",
  "abiParameters": ["0xTokenIn","0xTokenOut",10000,"0xAGENT","1000000","990000","1750000000"],
  "description": "human-readable"
}
```

`calls` is ordered: run the `approve(address,uint256)` call first, then the
action call. `executable=false` means the best price is on an external Permit2
venue that needs an extra typed-data signature (informational quote only for
now; Arcade-native routes are always executable).

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/agent/markets` | reference tradeable tokens |
| GET  | `/api/agent/trending?limit=15` | launchpad tokens by market cap |
| GET  | `/api/agent/portfolio?wallet=0x` | known-token balances |
| POST | `/api/agent/quote` | best-execution price quote |
| POST | `/api/agent/swap` | build approve + swap |
| POST | `/api/agent/launchpad` | build curve buy/sell or create-token |
| POST | `/api/agent/multiswap` | build a basket-converge swap |
| GET  | `/api/agent/openapi` | OpenAPI 3.1 spec for auto-discovery |

MCP wrapper for Claude-style agents: see `agent-mcp/`.

## Worked example — an agent buys the top trending token

```
1. GET  /api/agent/trending?limit=5
        -> [{ token: "0xABC", symbol: "PEPE", marketCapUsdc: "...", curveProgressBps: 6200 }, ...]

2. POST /api/agent/launchpad { "action": "buy", "token": "0xABC", "amountUsdcIn": "5000000" }
        -> { ok: true, amountOut: "...", calls: [
             { contractAddress: "0xUSDC",       abiFunctionSignature: "approve(address,uint256)",        abiParameters: ["0xLaunchpad","5000000"] },
             { contractAddress: "0xLaunchpad",  abiFunctionSignature: "buy(address,uint256,uint256)",    abiParameters: ["0xABC","5000000","<minOut>"] }
           ] }

3. For each call, POST to Circle:
   createContractExecutionTransaction({
     walletId: <agent wallet>, blockchain: "ARC-TESTNET",
     contractAddress: call.contractAddress,
     abiFunctionSignature: call.abiFunctionSignature,
     abiParameters: call.abiParameters,
     fee: { type: "level", config: { feeLevel: "MEDIUM" } }
   })
   Run the approve tx first, then the buy tx.

4. The agent now holds PEPE, settled in USDC, on Arc. Spend limits are enforced
   by the agent's Circle Wallet policy.
```

## Circle products used

- **USDC** — settlement + native gas on Arc; the only asset an agent needs.
- **Circle Wallets** (developer-controlled) — the agent's key + spend policy;
  `createContractExecutionTransaction` executes every Arcade descriptor.
- **CCTP / Bridge Kit** — top up the agent's Arc USDC from another chain (roadmap helper).
- **Nanopayments** — meter agent API calls (pay-per-quote / pay-per-build) (roadmap).
- **USYC** — route the agent's idle USDC into yield between actions (gated; architecture-level).

## Circle Product Feedback

**Why these products.** Arc making USDC the native gas token is the unlock: an
agent funded with one asset can both pay fees and transact, which removes the
single biggest friction in autonomous on-chain commerce. Circle Wallets'
`createContractExecutionTransaction` is a clean fit because it takes exactly the
shape we already produce (contract + function signature + ordered args), so
Arcade can stay non-custodial while agents sign with their own keys.

**What worked well.** Dev-controlled wallets support `ARC-TESTNET` directly and
the contract-execution API needs no manual calldata encoding, which let us
expose every Arcade action (swap, curve trade, token launch, basket converge) as
a uniform descriptor with almost no glue code.

**What could improve.** (1) Typed-data (EIP-712) signing from dev-controlled
wallets would let agents use Permit2-based venues, which we currently mark
non-executable. (2) A batch/atomic "approve + action" execution primitive would
remove the two-step approve dance. (3) Clearer testnet docs on `ARC-TESTNET`
gas-fee fields (USDC-as-gas) would shorten integration.

**Recommendation.** Ship a first-class "agent session" concept: a scoped wallet
with a spend policy + an allow-list of contracts, provisioned in one call. That
single primitive would make Circle Wallets the default custody layer for every
agent-commerce app on Arc.
