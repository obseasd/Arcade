# Arcade - Ignyte Stablecoin Commerce Stack Challenge Submission

> Export this file to PDF/DOCX and upload it as the "Submission Document".
> The GitHub link and Video link go in their own fields on the form.
> Fields in [brackets] are for you to fill before submitting.

---

## 1. Project Title

**Arcade: the agent-native execution layer for USDC-settled trading on Arc**

## 2. Short Description

Arcade is a USDC-native DEX and bonding-curve launchpad on Arc that any AI
agent can use as an execution venue. An agent brings its own Circle Wallet,
asks Arcade for a best-execution quote, and receives a ready-to-sign
contract-call descriptor that maps 1:1 onto Circle's
`createContractExecutionTransaction`. Because USDC is the native gas token on
Arc, an agent funded with USDC alone can both pay for gas and settle the trade,
end to end, non-custodially.

## 3. Track

**Track 4 - Best Agentic Economy Experience on Arc**

## 4. Circle Developer Account Email

[your Circle console email, e.g. from https://console.circle.com]

## 5. Circle Products Used on Arc

- **USDC** - the settlement rail AND the gas token for every agent-executed
  transaction on Arc.
- **Circle Wallets** - agents sign with their own developer-controlled Circle
  Wallet on `ARC-TESTNET`; Arcade never custodies keys.
- **CCTP / Bridge Kit** - cross-chain USDC in/out so an agent can fund itself
  on Arc from another chain.
- **USYC** - idle-treasury yield: an agent (or the protocol treasury) can park
  unused USDC in USYC (Hashnote tokenized T-Bills) via the Teller and redeem on
  demand.
- (Roadmap) **Nanopayments** - per-inference / streaming agent payment metering.

## 6. Description (full)

The agentic economy needs venues that agents can actually transact against,
not just read. Arcade makes a full DEX + launchpad **agent-accessible**:

- A public agent **REST API**: discover markets, trending launchpad tokens,
  quote, swap, launchpad buy/sell/create, multi-input converge swap, and
  portfolio.
- An **MCP server** (`arcade-agent-mcp`) for Claude-style agents, plus an
  **HTTP MCP** endpoint at `/api/agent/mcp` for install-free use.
- A **non-custodial descriptor model**: every write returns
  `{ contractAddress, abiFunctionSignature, abiParameters }`, which maps 1:1
  onto Circle's `createContractExecutionTransaction`. The agent signs with its
  own Circle Wallet; Arcade only computes best execution and hands back the
  call to sign.
- **Permit2 support** end to end: for venues that need it, the agent signs an
  EIP-712 permit via Circle `sign/typedData`, then a `finalize` call injects
  the signature, so every route is agent-executable.
- **Auto-discovery** so an agent framework can bootstrap from just the domain:
  a crawlable `/agents` page, `.well-known/ai-plugin.json`, `llms.txt`, and an
  OpenAPI 3.1 spec.

Why Arc: USDC is the native gas token, so an agent needs a single asset to both
pay and settle. That removes the biggest friction in autonomous on-chain
commerce (holding and managing a separate gas token). Every agent-built
transaction is real USDC settlement on Arc L1.

USYC ties in as the treasury layer: idle USDC (the agent's float, or the
protocol's) rotates into yield-bearing USYC via the Hashnote Teller and redeems
atomically when the agent needs to trade.

## 7. Working MVP

- **Live app:** https://www.arcade.trading
- **Agents landing:** https://www.arcade.trading/agents
- **Agent API base:** https://www.arcade.trading/api/agent (OpenAPI at
  `/api/agent/openapi`)
- **MCP:** `arcade-agent-mcp` (npm) and HTTP MCP at
  https://www.arcade.trading/api/agent/mcp
- **USYC earn surface:** https://www.arcade.trading/earn (deposit USDC to USYC
  and redeem via the Hashnote Teller on Arc testnet)

End-to-end verified: an agent resolves a token by symbol, gets a real on-chain
quote with a price-impact warning, receives an executable descriptor, signs it
with a Circle Wallet, and the transaction settles in USDC on Arc.

## 8. Architecture Diagram

See `docs/AGENT_ARCHITECTURE.md` in the repo (Mermaid). Summary flow:

```
AI agent (own Circle Wallet)
        |  1. discover / quote (REST or MCP)
        v
Arcade Agent API  --- best-execution over the aggregator (Arcade V2/V3/V4,
        |                Synthra, UnitFlow, Xylonet) + launchpad + multiswap
        |  2. returns { contractAddress, abiFunctionSignature, abiParameters }
        v
Circle Wallets  --- createContractExecutionTransaction (agent signs)
        |  3. (if needed) sign/typedData -> Permit2 -> /swap/finalize
        v
Arc L1  --- USDC settlement + USDC gas, deterministic finality
```

## 9. Video Demo

[paste your video link here - also goes in the form's "Product Demo Video Link"
field]

The video shows a live agent, over MCP, discovering a market on Arcade,
quoting, and executing a USDC-settled swap on Arc by signing with a Circle
Wallet.

## 10. Documentation

- Repository: [your public GitHub URL] (setup + Circle integration in
  `docs/AGENT_API.md`)
- Agent API architecture: `docs/AGENT_ARCHITECTURE.md`
- MCP publishing: `agent-mcp/README.md`

## 11. Circle Product Feedback

**Why we chose these products.** Arc's USDC-as-gas model is the unlock for
agentic commerce: an agent needs exactly one asset to pay and settle, so the
whole "fund the gas token" problem disappears. Circle Wallets'
`createContractExecutionTransaction` + `sign/typedData` map cleanly onto a
non-custodial descriptor model, which is the right trust boundary for an agent
using a third-party venue. CCTP brings USDC in from any chain; USYC turns idle
USDC into yield without changing any user-facing flow.

**What worked well.**
- Circle developer-controlled wallets support `ARC-TESTNET` and run arbitrary
  contract calls, so our `{contractAddress, abiFunctionSignature, abiParameters}`
  descriptors executed with no glue code.
- USDC-as-gas made the "agent needs only USDC" story real end to end.
- `sign/typedData` handled the EIP-712 Permit2 flow so Permit2-gated venues are
  agent-executable via a two-step swap -> sign -> finalize.

**What could be improved.**
- **A canonical Arc testnet registry** (contract addresses + token decimals)
  would remove real foot-guns. Two we hit: the community USDT on Arc testnet
  uses 18 decimals (not the canonical 6), and some testnet pools are thin /
  mispriced, which produces bad fills in demos. A published registry an agent
  can trust would prevent both.
- **USYC on Arc was hard to wire from Circle's docs alone.** The Teller
  function signatures and the Arc testnet Teller/oracle addresses were not in
  Circle's `llms.txt` or the main USYC developer overview; we found them in the
  Hashnote docs and verified on-chain. A Circle-hosted "USYC on Arc" quickstart
  with addresses and `buy`/`sell` snippets would save integrators hours.
- **Sender-preserving batching was unstable on testnet.** The `callFrom`
  precompile (and the Multicall3From wrapper) reverted at times, so we fell back
  to sequential direct transactions for multi-step flows (claim, cancel-all,
  managed position close). Native, reliable EOA batching (or documented
  EIP-7702 support) would let agents do "approve + execute" in one signature.

**Recommendations.**
- Ship an official Arc testnet address + token-decimals registry (JSON) and a
  Circle-hosted USYC-on-Arc quickstart.
- Provide an Arc/Circle MCP registry or a "make your dapp agent-usable" guide so
  agent-accessible venues like Arcade are discoverable by name, not by blind
  probing of `.well-known`.
- A reference "agentic dapp" template (descriptor model + Circle Wallet signing
  + Permit2 finalize) would accelerate this whole track.
