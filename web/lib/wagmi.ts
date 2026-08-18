import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, fallback } from "wagmi";
import { mainnet } from "wagmi/chains";
import {
  arcTestnet,
  anvilLocal,
  cctpSourceChains,
} from "./chains";

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "00000000000000000000000000000000";

const defaultChain = process.env.NEXT_PUBLIC_DEFAULT_CHAIN === "arc" ? arcTestnet : anvilLocal;

// Arc/Anvil first (depending on env), then the CCTP source chains so users can
// bridge USDC in from Ethereum L1, Base, Arbitrum, Optimism, Avalanche.
// mainnet is included read-only so wagmi's useEnsAddress / useEnsName can
// resolve `name.eth` recipients in the Send modal - those hooks REQUIRE
// the chain to be configured in wagmi, even if the user never switches to it.
const allChains = [arcTestnet, anvilLocal, ...cctpSourceChains, mainnet] as const;
const chains = defaultChain.id === arcTestnet.id
  ? ([arcTestnet, ...allChains.filter((c) => c.id !== arcTestnet.id)] as const)
  : ([anvilLocal, ...allChains.filter((c) => c.id !== anvilLocal.id)] as const);

export const wagmiConfig = getDefaultConfig({
  appName: "Arcade",
  projectId: WALLETCONNECT_PROJECT_ID,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chains: chains as any,
  transports: {
    // Arc transport with JSON-RPC batching enabled. Without batching,
    // every wagmi useReadContracts on /launchpad / /positions fans out
    // into N parallel HTTP POSTs to Arc RPC. With many tokens that
    // hits Arc's per-IP rate limit and the public RPC returns 429.
    // batch: true tells viem to coalesce eth_calls happening within a
    // ~16ms window into a single HTTP POST containing N JSON-RPC items
    // - same call count seen by the node but 1 HTTP request instead of
    // N. This is NOT the same as multicall3 batching (which we can't
    // use - see chains.ts) - it's protocol-level batching, supported
    // by every standard JSON-RPC node.
    //
    // Endpoint resolution:
    //   NEXT_PUBLIC_ARC_RPC_URL = priority override. Set this to a
    //   dedicated provider (Alchemy, thirdweb client-id URL, custom
    //   node) when public-RPC 429s start surfacing on /launchpad /
    //   /swap reads. Validated against http(s) so a hostile env value
    //   can't redirect wallet calls to an attacker-controlled host.
    //   Falls back to arcTestnet.rpcUrls.default.http[0] (the public
    //   rpc.testnet.arc.network) when unset or malformed.
    // batch wait bumped 16 → 50 ms after the Alchemy switch revealed
    // that bursty useReadContracts fan-outs still hit the 300 CU/s
    // free-tier ceiling. 50 ms is below human perception (the UI feels
    // identical) and packs noticeably more eth_calls into each batched
    // JSON-RPC array, dropping the per-second HTTP request count.
    // Multi-transport fallback:
    //   1. Alchemy (NEXT_PUBLIC_ARC_RPC_URL) - high throughput for
    //      eth_call / eth_getBalance / multicall reads.
    //   2. Arc public RPC - takes over the moment Alchemy returns
    //      InvalidRequestRpcError (Alchemy free tier on Arc testnet
    //      caps eth_getLogs at 10 BLOCKS per call, which makes any
    //      meaningful event scan impossible; the public RPC accepts
    //      multi-thousand-block ranges).
    //   3. thirdweb proxy - third fallback for cumulative outages.
    //
    // viem's fallback() rotates on any RPC error from the higher-
    // priority transport, so a single call that Alchemy refuses
    // (10-block cap on getLogs) automatically retries on Arc public
    // without the user seeing anything. This is the ONLY way to keep
    // launchpad image metadata scanning while staying on Alchemy for
    // the cheap reads. retryCount: 0 on each leg so we don't multiply
    // out the failure latency before rotating.
    // 2026-06-17 Arc v0.7.2 hardfork (active 06-18 12:00 UTC) introduces a
    // 100-entry cap per JSON-RPC batch (--arc.rpc.max-batch-entries).
    // Larger batches return -32600 BEFORE processing. viem's batch.batchSize
    // defaults to 1000, so without an explicit cap our useReadContracts on
    // /launchpad / /positions would silently start failing the moment the
    // hardfork lands. Pin to 90 (small safety margin) so we never trip the
    // node-side cap even if it's tightened further later.
    [arcTestnet.id]: fallback(arcTransports(), { rank: false }),
    [anvilLocal.id]: http(anvilLocal.rpcUrls.default.http[0]),
    ...Object.fromEntries(cctpSourceChains.map((c) => [c.id, http()])),
    // Explicit public RPC for mainnet ENS reads. See safeMainnetRpc()
    // below for the full story - tl;dr: llamarpc.com is on every major
    // ad-blocker's privacy filter list and a blocked mainnet transport
    // hangs the entire wagmi onMount/connect chain, freezing all Arc
    // reads. publicnode.com is the same shape used by Rabby/RainbowKit
    // defaults and is not on standard block lists. The env override is
    // gated on https scheme so a mis-set / hostile vendor value
    // (javascript:, http:, custom proto) can never silently leak the
    // user's address to an attacker-controlled endpoint - audit
    // finding UI-C-1.
    [mainnet.id]: http(safeMainnetRpc()),
  },
  ssr: true,
});

/** Validate + return the Arc RPC URL the wagmi transport should use. The
 *  env var NEXT_PUBLIC_ARC_RPC_URL takes priority when set and well-formed
 *  (https only - audit FSEC-005 stance: any other scheme would let a
 *  hostile config value leak wallet addresses to an attacker). On a
 *  missing or malformed value we fall back to the chain definition's
 *  public RPC so the app stays runnable in dev without the env var. */
function resolveArcRpc(): string {
  const fallback = arcTestnet.rpcUrls.default.http[0];
  const raw = process.env.NEXT_PUBLIC_ARC_RPC_URL;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

/** Ordered Arc testnet read transports for the wagmi fallback.
 *
 *  Benchmark (40 concurrent eth_getBalance, 2026-08-14):
 *    - drpc.org : 40/40 ok, 0 rate-limited, ~37ms  (NO json-rpc batch: 500s a batch)
 *    - arcscan  : 40/40 ok, 0 rate-limited, ~34ms  (batch capped at 5)
 *    - public arc.network : 26/40 ok, 14 rate-limited(429), ~44ms (batch ~25)
 *    - thirdweb : slow (~250ms) + broken getLogs -> excluded
 *
 *  So the reliable, no-429 endpoints (drpc, arcscan) go FIRST; the public RPC
 *  (the actual source of the /explore /positions rate-limit) drops to a backup.
 *  Per-leg batch config respects each endpoint's real limit. Arc's Multicall3
 *  (wired in chains.ts) already collapses useReadContracts fan-outs into one
 *  eth_call, so the no-batch primary legs still serve list reads in one request. */
function arcTransports() {
  const publicRpc = arcTestnet.rpcUrls.default.http[0];
  const dedicated = resolveArcRpc(); // NEXT_PUBLIC_ARC_RPC_URL override, else publicRpc
  // Same-origin proxy so the browser can use drpc (the fastest Arc RPC) even
  // though drpc.org sends NO CORS header -- a direct browser fetch to it is
  // blocked, which was the root cause of "tokens won't load" (the benchmark
  // below was run from a server, so it never hit the CORS wall). /api/rpc relays
  // server-side to drpc/arcscan/public; same-origin is always CORS-ok and shares
  // drpc's per-IP limit server-side instead of per-user.
  const sameOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const legs = [
    // Primary: the same-origin proxy (CORS-ok, drpc-backed on the server).
    http(`${sameOrigin}/api/rpc`, { retryCount: 0 }),
    // Direct browser fallbacks if the proxy itself is down. arcscan sends CORS
    // headers; the public RPC is last (it 429s under burst). drpc is NOT here:
    // it has no CORS and can only be reached via the proxy above.
    http("https://testnet.arcscan.app/api/eth-rpc", { batch: { batchSize: 5, wait: 50 }, retryCount: 0 }),
  ];
  // Optional dedicated override (Alchemy/thirdweb client-id/custom) above the
  // throttled public RPC when the operator has set one.
  if (dedicated !== publicRpc) {
    legs.push(http(dedicated, { batch: { batchSize: 90, wait: 50 }, retryCount: 0 }));
  }
  // Public RPC last: batched to minimise its 429s, but only reached if the
  // reliable legs above all error.
  legs.push(http(publicRpc, { batch: { batchSize: 90, wait: 50 }, retryCount: 0 }));
  return legs;
}

function safeMainnetRpc(): string {
  // Audit 2026-06-11 v4 - ROOT CAUSE of frozen wagmi reads:
  // eth.llamarpc.com is on the default block lists for Brave Shields,
  // uBlock Origin's privacy filter, AdGuard's tracking filter, and
  // similar ad-blockers (they classify llamarpc.com as wallet-tracking
  // infrastructure). When that mainnet RPC is blocked
  // (ERR_BLOCKED_BY_CLIENT), wagmi v2's WagmiProvider.onMount call
  // chain `connect -> getChainId` hangs waiting on the mainnet
  // transport, which transitively breaks the entire connector init,
  // leaving every useReadContract hook stuck in pending state. The
  // user sees zero RPC calls to Arc despite a healthy Arc transport,
  // a connected wallet, and correct chainId pins.
  //
  // ethereum-rpc.publicnode.com is not on the standard block lists,
  // has higher uptime than llamarpc, and is the same endpoint shape
  // Rabby + RainbowKit defaults use.
  const fallback = "https://ethereum-rpc.publicnode.com";
  const raw = process.env.NEXT_PUBLIC_MAINNET_RPC;
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return fallback;
    return raw;
  } catch {
    return fallback;
  }
}

export { defaultChain };
