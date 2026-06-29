# Arcade Agent layer — architecture

How any third-party AI agent discovers and uses Arcade (USDC-native DEX +
bonding-curve launchpad on Circle's Arc L1). Non-custodial: the agent signs with
its own Circle Wallet; Arcade never holds keys.

```mermaid
flowchart TB
    subgraph Agent["AI Agent (Claude / LangChain / custom)"]
        A1["Reasoning loop"]
        CW["Circle Developer-Controlled Wallet<br/>USDC on ARC-TESTNET"]
    end

    subgraph Discover["1 - Discovery"]
        D1[".well-known/ai-plugin.json"]
        D2["llms.txt"]
        D3["OpenAPI 3.1<br/>/api/agent/openapi"]
        D4["MCP server<br/>npx arcade-agent-mcp"]
    end

    subgraph Arcade["Arcade Agent API (Next.js, non-custodial)"]
        direction TB
        R["READ<br/>markets / trending / portfolio / quote"]
        B["BUILD<br/>swap / launchpad / multiswap / swap-finalize"]
        RT["Best-execution router<br/>V2, V3, Synthra*, UnitFlow*, Xylonet<br/>* = Permit2"]
        DESC["Contract-call descriptors<br/>contractAddress, abiFunctionSignature, abiParameters, value"]
    end

    subgraph Circle["2 - Signing (Circle Wallets API)"]
        S1["createContractExecutionTransaction"]
        S2["sign/typedData (Permit2)"]
    end

    subgraph Arc["Arc L1 (chainId 5042002, USDC = gas)"]
        C1["DEX router V2 / V3"]
        C2["Launchpad (bonding curve)"]
        C3["MultiSwap aggregator"]
        C4["Universal Router (Permit2)"]
    end

    A1 -->|finds| Discover
    Discover -->|loads tools / spec| A1
    A1 -->|discover + price| R
    A1 -->|request a trade| B
    B --> RT --> DESC
    R --> A1
    DESC -->|returned to agent| A1
    A1 -->|sign each call| CW
    CW --> S1
    CW --> S2
    S1 -->|submit tx| C1
    S1 --> C2
    S1 --> C3
    S2 -->|signature injected via swap-finalize| C4
    C1 -->|USDC settlement| CW
    C2 --> CW
    C3 --> CW
    C4 --> CW
```

## Flow in words

1. **Discover** — an agent (or its operator) finds Arcade via the static
   `.well-known/ai-plugin.json` / `llms.txt`, the OpenAPI spec, or the
   `arcade-agent-mcp` server, and loads the tools.
2. **Read** — `markets`, `trending`, `portfolio`, `quote` give live,
   decision-grade data (prices, market caps, curve progress, `tradeVia`).
3. **Build** — `swap` / `launchpad` / `multiswap` run best-execution and return
   ordered **contract-call descriptors** (plus `minAmountOut`, `slippageBps`,
   `nextStep`). Arcade never signs.
4. **Sign** — the agent feeds each descriptor to Circle
   `createContractExecutionTransaction` with its own wallet. Permit2 venues add a
   `sign/typedData` step, then `swap/finalize` injects the signature.
5. **Settle** — the tx executes on Arc; everything settles in USDC (the native
   gas token), so the agent only ever needs USDC.
