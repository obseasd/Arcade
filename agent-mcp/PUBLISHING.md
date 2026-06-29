# Publishing `arcade-agent-mcp` (make agents able to find Arcade)

The discovery files (`.well-known/ai-plugin.json`, `llms.txt`, OpenAPI) are
already live, but they only make Arcade **usable once an agent knows the
domain**. To make agents **find** Arcade on their own, the MCP server must be
**published to npm** and **listed in MCP registries**. Do these once.

## 1. Publish to npm  (≈2 min, requires your npm login)

```bash
cd agent-mcp
npm login            # one-time: authorize this machine (the ENEEDAUTH fix)
npm publish          # package.json already has publishConfig.access=public
```

Verify:
```bash
npm view arcade-agent-mcp version          # -> 1.0.0
npx -y arcade-agent-mcp                     # should start (Ctrl+C to stop)
```

After this, the README config (`npx -y arcade-agent-mcp`) actually works for
any user.

## 2. Register in the official MCP Registry  (registry.modelcontextprotocol.io)

`server.json` is already prepared in this folder. Install the publisher and push:

```bash
# install the official publisher CLI (Go) — see modelcontextprotocol.io/registry
brew install mcp-publisher          # or: download from the registry repo releases
mcp-publisher login github          # auth via your GitHub (matches io.github.obseasd/*)
mcp-publisher publish               # reads ./server.json
```

Notes:
- The namespace `io.github.obseasd/arcade-agent-mcp` must match your GitHub
  account (obseasd). Change it if you publish under an org.
- Re-run `mcp-publisher publish` on each new version (bump both package.json and
  server.json `version`).

## 3. Community lists (free reach, do after npm publish)

- Open a PR adding Arcade to `modelcontextprotocol/servers` (the community
  "Third-Party Servers" section of the README).
- Add it to a popular `awesome-mcp-servers` list (PR).
- Optional: list on smithery.ai / mcp.so / glama.ai (web forms that ingest the
  npm package + server.json).

## 4. Make the OpenAPI auto-loadable for non-MCP agents

Already done: `/.well-known/ai-plugin.json` points at `/api/agent/openapi`, and
`llms.txt` advertises both. Frameworks that probe `.well-known` or accept an
OpenAPI URL can load Arcade with just the domain.

## Result

Once 1+2 are done, a user can add one line to their MCP config (or just install
the package) and then say *"swap 10 USDC to USDT on Arcade"* — the host loads the
tools and the agent does the rest.
