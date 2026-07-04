# Agent demo video script (Ignyte Track 4)

Target length: 2 to 3 minutes. The story: an autonomous AI agent, funded only
with USDC, discovers a market on Arcade, prices it, and settles a trade on Arc
by signing with its OWN Circle Wallet. Arcade never holds a key.

## Setup before recording (once)

1. Terminal ready in `agent-mcp/` with the env exported:
   ```bash
   export CIRCLE_API_KEY=...            # your Circle test key
   export CIRCLE_ENTITY_SECRET="$(cat .circle-entity-secret)"
   export CIRCLE_WALLET_ID=83d2d56b-ec88-5f9f-b731-d4729cb54352
   ```
2. The demo agent is **Claude Code** (or any agent that has BOTH the Arcade MCP
   and a shell tool), so it can call Arcade tools AND run circle-execute.mjs
   itself. Add the MCP:
   ```json
   { "mcpServers": { "arcade": { "command": "npx", "args": ["-y", "arcade-agent-mcp"],
     "env": { "ARCADE_API_BASE": "https://www.arcade.trading" } } } }
   ```
3. Two browser tabs open: https://www.arcade.trading/agents and
   https://testnet.arcscan.app (for the Circle wallet address).
4. Screen recorder on. Have the Circle wallet address handy:
   `0x67fd714c87b95ac6d2ae5a3d59308f0e9873e610`.

## Shot 1 - The hook (15s)

On camera: the /agents page.

Narration: "This is Arcade, a USDC-native DEX and launchpad on Arc, Circle's L1.
What makes it different: any AI agent can use it as an execution venue. The
agent brings its own Circle Wallet, and because USDC is the gas token on Arc, it
needs exactly one asset to both pay and trade. Let me show you an agent do it,
live."

## Shot 2 - The agent discovers + prices (30s)

Type to the agent (one prompt):

> "Using the Arcade MCP, find a trending token on Arc and quote buying it with 1
> USDC. Warn me if the price looks off."

On camera: the agent calls `arcade_trending`, picks a token, calls
`arcade_quote` / builds the buy, and shows the expected tokens out. If it hits
the price-impact warning, read that line aloud.

Narration: "The agent discovered the market and priced it through Arcade's API.
Notice it even gets a price-impact warning, so an agent can refuse a bad fill.
Nothing has been signed yet: Arcade only returns a ready-to-sign descriptor."

## Shot 3 - The agent executes with its Circle Wallet (45s)

Type:

> "Build the buy descriptor for 1 USDC into that token with my Circle wallet as
> recipient, then execute it with circle-execute.mjs."

On camera: the agent fetches the descriptor (approve + buy), then runs:
```bash
node circle-execute.mjs '<the calls[] JSON>'
```
It prints the two txHashes.

Narration: "Here is the key moment. Arcade handed back two contract-call
descriptors: approve, then buy. The agent signs and broadcasts them with its OWN
Circle developer-controlled wallet, through createContractExecutionTransaction.
Arcade never saw a private key. This is non-custodial by construction."

## Shot 4 - Real settlement on Arc (30s)

On camera: open the buy txHash on testnet.arcscan.app; then show the Circle
wallet address holding the new token balance (or ask the agent to read the
balance back).

Narration: "And it settled. Real USDC in, tokens out, on Arc L1, finalized. The
agent paid gas in the same USDC it traded with. One asset, one wallet,
end to end, autonomously."

## Shot 5 - Close (20s)

On camera: back to /agents, or the OpenAPI / MCP listing.

Narration: "Everything an agent needs is discoverable from the domain: a REST
API, an MCP server on npm, an OpenAPI spec, and an ai-plugin manifest. Arcade is
the execution layer the agentic economy plugs into on Arc. Thanks for watching."

## Backup / gotchas

- Use a token from `arcade_trending` that trades on the curve (tradeVia =
  launchpad) or a migrated Arcade pair, NOT the thin/mispriced Synthra USDC/USDT
  pool. The launchpad buy is a clean one-step approve + buy.
- If a tx shows state SENT rather than COMPLETE, it still landed; confirm by
  reading the token balance (as the live test did: the wallet received the
  tokens).
- Keep the API key OFF camera. Only the wallet address and txHashes are public.
