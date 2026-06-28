# Arcade Agent MCP

Lets any MCP-capable AI agent (Claude Desktop, Claude Code, etc.) use **Arcade**
— a USDC-native DEX + bonding-curve launchpad on Circle's **Arc** L1.

The agent discovers markets, gets best-execution quotes, and receives
**ready-to-sign contract-call descriptors**. The agent signs them with its
**own wallet** (e.g. a Circle developer-controlled wallet via
`createContractExecutionTransaction`). This server never holds keys.

## Install

```bash
cd agent-mcp
npm install
```

## Configure (Claude Desktop / Claude Code)

Add to your MCP config:

```json
{
  "mcpServers": {
    "arcade": {
      "command": "node",
      "args": ["/absolute/path/to/agent-mcp/index.mjs"],
      "env": { "ARCADE_API_BASE": "https://www.arcade.trading" }
    }
  }
}
```

`ARCADE_API_BASE` defaults to `https://www.arcade.trading`; point it at
`http://localhost:3000` for local dev.

## Tools

| Tool | What it does |
|------|--------------|
| `arcade_markets` | reference tradeable tokens on Arc |
| `arcade_trending` | launchpad tokens by market cap |
| `arcade_portfolio` | known-token balances for a wallet |
| `arcade_quote` | best-execution price quote (read-only) |
| `arcade_swap` | build approve + swap descriptors to sign |
| `arcade_launchpad` | build bonding-curve buy/sell or create-token descriptors |
| `arcade_multiswap` | build a basket-converge swap (aggregator) |

## How an agent executes a build result

Every build tool returns `{ ok, executable, calls: [...] }` where each call is:

```json
{
  "contractAddress": "0x...",
  "abiFunctionSignature": "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "abiParameters": ["1000000", "990000", ["0x...","0x..."], "0xAGENT", "1750000000"]
}
```

Feed each call, in order, to Circle's
`createContractExecutionTransaction` (blockchain `ARC-TESTNET`, your agent
wallet). Run the `approve` call first, then the action call.

See `../docs/AGENT_API.md` for the full architecture and a worked example.
