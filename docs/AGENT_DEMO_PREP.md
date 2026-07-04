# Agent demo prep (Ignyte Track 4)

Everything needed to record the live agent demo: an AI agent that, over MCP,
discovers a market on Arcade, quotes it, and executes a USDC-settled swap on
Arc by signing with its OWN Circle Wallet. Arcade is non-custodial: it only
returns ready-to-sign descriptors; Circle does the signing.

## The three pieces

1. **The agent + MCP** (LIVE, no setup on our side)
   - `arcade-agent-mcp` is published on npm, and the live API is up
     (`/api/agent/*` return 200, discovery files served).
2. **A Circle Wallet on ARC-TESTNET, funded with USDC** (you create this)
   - The wallet the agent signs with. It needs a little testnet USDC (which is
     also the gas token on Arc).
3. **The execution bridge** (`agent-mcp/circle-execute.mjs`, in this repo)
   - Turns a descriptor into an on-chain tx via Circle
     `createContractExecutionTransaction`. This is what makes the loop
     autonomous in the video.

## Step 1 - Configure the MCP client

In Claude Desktop (or Cursor), add to the MCP config:

```json
{
  "mcpServers": {
    "arcade": {
      "command": "npx",
      "args": ["-y", "arcade-agent-mcp"],
      "env": { "ARCADE_API_BASE": "https://www.arcade.trading" }
    }
  }
}
```

Restart the client. The agent now has the Arcade tools (quote, swap-descriptor,
launchpad, portfolio, etc.).

## Step 2 - Create + fund the Circle Wallet

1. Circle console (https://console.circle.com): create an **API key**.
2. One-shot setup (generates + registers the entity secret, creates the
   ARC-TESTNET wallet). Secrets are saved to gitignored local files and never
   printed:

   ```bash
   cd agent-mcp
   npm install
   export CIRCLE_API_KEY=...
   node setup-circle.mjs      # prints walletId + address
   export CIRCLE_ENTITY_SECRET="$(cat .circle-entity-secret)"
   export CIRCLE_WALLET_ID=<printed id>
   ```

   (If you already registered an entity secret, skip setup-circle.mjs, set
   CIRCLE_ENTITY_SECRET yourself, and run `node create-wallet.mjs` instead.)

3. Fund the printed address with testnet USDC. Easiest: from the treasury
   wallet `0x3a0Dd90212838f32a953Acd4B32596b62859324A` (holds test USDC), send
   a few USDC to the Circle wallet address. USDC is the gas token, so this also
   covers gas.

> PROVEN end to end (2026-07-04): an agent fetched a launchpad buy descriptor
> from the live API, and circle-execute.mjs ran the approve + buy through a
> Circle Wallet on Arc; the wallet received the tokens. So the full loop works
> before you even record.

## Step 3 - Wire the execution bridge

```bash
cd agent-mcp
npm install @circle-fin/developer-controlled-wallets
export CIRCLE_API_KEY=...        # from Circle console
export CIRCLE_ENTITY_SECRET=...  # your 32-byte hex entity secret
export CIRCLE_WALLET_ID=...      # the ARC-TESTNET wallet id
```

Smoke-test with a trivial call (reads nothing on-chain, just proves signing):

```bash
# Approve 1 USDC to the Arcade V2 router (harmless, sets an allowance)
node circle-execute.mjs '{"contractAddress":"0x3600000000000000000000000000000000000000","abiFunctionSignature":"approve(address,uint256)","abiParameters":["0x58b32D5fBCBf25Db5B08AAF04301E04c32670969","1000000"]}'
```

You should get back a `txHash`. If so, the agent can execute end to end.

## Step 4 - The demo flow (what to show on camera)

1. **Discover** - ask the agent: "What can I trade on Arcade on Arc?" It calls
   the MCP `arcade_markets` / `arcade_trending` tool and lists real pairs.
2. **Quote** - "Quote 5 USDC into <token>." The agent calls `arcade_quote` and
   shows the amount out + the built-in price-impact warning (a nice honesty
   beat: the agent can decide NOT to execute a bad fill).
3. **Build** - the agent calls the swap tool and gets the descriptor(s):
   `{ contractAddress, abiFunctionSignature, abiParameters }` (approve, then
   swap).
4. **Execute** - the agent runs `circle-execute.mjs` with those descriptors;
   the Circle Wallet signs and broadcasts. Show the returned `txHash`.
5. **Settle** - open the tx on https://testnet.arcscan.app to show real USDC
   settlement on Arc L1. Show the agent wallet's new balance.

Narration beat: "one asset, USDC, pays the gas AND settles the trade; the agent
signs with its own Circle Wallet; Arcade never touched a key."

## Checklist before recording

- [ ] Repo is PUBLIC (judges must open it).
- [ ] MCP config added + client restarted; `arcade_*` tools visible.
- [ ] Circle Wallet created on ARC-TESTNET + funded with USDC.
- [ ] `circle-execute.mjs` smoke-test returns a txHash.
- [ ] A token with real liquidity chosen for the demo (avoid the thin/mispriced
      testnet USDC/USDT pool; use a launchpad token or an Arcade V2/V3 pair with
      seeded liquidity).
- [ ] Screen recorder + the Arcscan tab ready.

## Optional: USYC beat

If you want to show USYC (Track 4 treasury-yield angle): on `/earn` the agent
(or you) deposits idle USDC into USYC and redeems it, all in USDC. NOTE: the
Teller is entitlement-gated; the demo wallet must be the whitelisted address.
The 1 USDC test from the treasury reverted, so confirm which exact address
Circle/Hashnote whitelisted before showing this live.
