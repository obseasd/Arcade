import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Arcade Agent API — let your AI agent trade on Arc",
    description:
        "Arcade is agent-accessible: any AI agent can discover markets, quote, and execute USDC-settled swaps and token launches on Circle's Arc L1 using its own Circle Wallet. Non-custodial. OpenAPI + MCP server.",
    alternates: { canonical: "https://www.arcade.trading/agents" },
};

const Code = ({ children }: { children: React.ReactNode }) => (
    <pre className="overflow-x-auto rounded-xl border border-arc-border bg-arc-bg p-4 text-sm text-arc-text">
        <code>{children}</code>
    </pre>
);

/**
 * Public, crawlable landing for the Arcade Agent API. Exists so a cold agent (or
 * web search) can DISCOVER that Arcade is agent-usable without already knowing
 * the .well-known convention. Linked from the sitemap.
 */
export default function AgentsPage() {
    return (
        <main className="mx-auto max-w-3xl space-y-8 px-5 py-12 text-arc-text">
            <header className="space-y-2">
                <h1 className="text-3xl font-bold">Arcade Agent API</h1>
                <p className="text-arc-text-muted">
                    Let any AI agent trade and launch tokens on <strong>Arcade</strong> — a
                    USDC-native DEX + bonding-curve launchpad on Circle&apos;s <strong>Arc</strong> L1
                    (chainId 5042002, USDC is the native gas token). Non-custodial: the agent signs
                    with its own Circle Wallet; Arcade never holds keys.
                </p>
            </header>

            <section className="space-y-3">
                <h2 className="text-xl font-semibold">Discover</h2>
                <ul className="list-disc space-y-1 pl-5 text-arc-text-muted">
                    <li>
                        OpenAPI 3.1 spec:{" "}
                        <a className="text-arc-accent underline" href="/api/agent/openapi">
                            /api/agent/openapi
                        </a>
                    </li>
                    <li>
                        Agent manifest:{" "}
                        <a className="text-arc-accent underline" href="/.well-known/ai-plugin.json">
                            /.well-known/ai-plugin.json
                        </a>
                    </li>
                    <li>
                        For LLMs:{" "}
                        <a className="text-arc-accent underline" href="/llms.txt">
                            /llms.txt
                        </a>
                    </li>
                    <li>REST base: https://www.arcade.trading/api/agent</li>
                </ul>
            </section>

            <section className="space-y-3">
                <h2 className="text-xl font-semibold">MCP server (Claude Desktop / Claude Code)</h2>
                <Code>{`{
  "mcpServers": {
    "arcade": {
      "command": "npx",
      "args": ["-y", "arcade-agent-mcp"],
      "env": { "ARCADE_API_BASE": "https://www.arcade.trading" }
    }
  }
}`}</Code>
                <p className="text-arc-text-muted">
                    Tools: arcade_markets, arcade_trending, arcade_portfolio, arcade_quote,
                    arcade_swap, arcade_swap_finalize, arcade_launchpad, arcade_multiswap.
                </p>
            </section>

            <section className="space-y-3">
                <h2 className="text-xl font-semibold">How it works</h2>
                <ol className="list-decimal space-y-1 pl-5 text-arc-text-muted">
                    <li>Read: markets / trending / portfolio / quote (amounts are RAW integer units).</li>
                    <li>
                        Build: POST /api/agent/swap returns ordered contract-call descriptors{" "}
                        <code>{`{ contractAddress, abiFunctionSignature, abiParameters }`}</code>.
                    </li>
                    <li>
                        Sign + submit each call with Circle{" "}
                        <code>createContractExecutionTransaction</code> on blockchain ARC-TESTNET.
                    </li>
                    <li>
                        Permit2 venues: sign <code>permit2.typedData</code>, then POST
                        /api/agent/swap/finalize.
                    </li>
                </ol>
            </section>

            <section className="space-y-3">
                <h2 className="text-xl font-semibold">Example: swap 10 USDC to USDT</h2>
                <Code>{`POST https://www.arcade.trading/api/agent/swap
{
  "tokenIn": "USDC",
  "tokenOut": "USDT",
  "amountIn": "10000000",
  "recipient": "<YOUR_CIRCLE_WALLET>"
}`}</Code>
                <p className="text-arc-text-muted">
                    tokenIn/tokenOut accept a symbol or a 0x address. The response includes
                    minAmountOut, slippageBps, amountOutFmt and a nextStep hint.
                </p>
            </section>
        </main>
    );
}
