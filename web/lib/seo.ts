/**
 * Server-side helpers for `generateMetadata` on token detail pages. Fetches
 * minimal on-chain info (name, symbol, market cap) and builds OpenGraph +
 * Twitter card metadata that drives rich previews when users share token
 * URLs on X, Discord, Telegram, etc.
 *
 * All reads use a dedicated server-side `viem` public client so we never
 * touch the wagmi browser hooks (which can't run during server rendering).
 */

import { Address, createPublicClient, erc20Abi, formatUnits, http, isAddress, parseAbiItem } from "viem";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { fetchMetadata, resolveIpfs } from "@/lib/metadata";

const serverClient = createPublicClient({
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
});

const TOKEN_CREATED_EVT = parseAbiItem(
    "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);

/**
 * Server-side scan for a token's metadataURI from the TokenCreated event.
 * The launchpad stopped storing metadataURI in its state struct (saves ~5M
 * gas at launch), so the URI now lives ONLY on the event. We chunk the
 * eth_getLogs query because Arc testnet's RPC caps the per-call block range
 * around 1k.
 *
 * Returns "" if the token isn't found in the scan window — safer than null
 * because the caller already treats empty as "no metadata".
 */
async function scanMetadataURI(token: Address): Promise<string> {
    const CHUNK = 1_000n;
    const MAX_BACK = 500_000n;
    try {
        const latest = await serverClient.getBlockNumber();
        let end = latest;
        let walked = 0n;
        while (walked < MAX_BACK) {
            const start = end > CHUNK - 1n ? end - (CHUNK - 1n) : 0n;
            try {
                const logs = await serverClient.getLogs({
                    address: ADDRESSES.launchpad,
                    event: TOKEN_CREATED_EVT,
                    args: { token },
                    fromBlock: start,
                    toBlock: end,
                });
                if (logs.length > 0) {
                    return (logs[0].args.metadataURI as string) ?? "";
                }
            } catch {
                break;
            }
            if (start === 0n) break;
            walked += end - start + 1n;
            end = start - 1n;
        }
    } catch {
        /* ignore */
    }
    return "";
}

export interface TokenSeoData {
    name: string;
    symbol: string;
    /** Resolved image URL ready to embed (http/https/data:). */
    imageUrl?: string;
    /** Formatted FDV / market cap, no $ sign (e.g. "42,500"). */
    marketCapFormatted?: string;
    /** Creator Twitter @handle without leading @, if present in metadata. */
    creatorHandle?: string;
    /** Used by the OG image generator to pick a branded variant. */
    variant: "v23" | "v4";
}

/**
 * Build SEO data for a V2/V3 launchpad token. Returns null if the token
 * isn't registered on the production launchpad (rendering will fall back
 * to default metadata).
 */
export async function fetchV23TokenSeo(token: string): Promise<TokenSeoData | null> {
    if (!isAddress(token)) return null;
    const tokenAddr = token as Address;
    try {
        const [nameRes, symbolRes, mcapRes, metadataURI] = await Promise.all([
            serverClient.readContract({
                address: tokenAddr,
                abi: erc20Abi,
                functionName: "name",
            }).catch(() => "Arcade Token") as Promise<string>,
            serverClient.readContract({
                address: tokenAddr,
                abi: erc20Abi,
                functionName: "symbol",
            }).catch(() => "TKN") as Promise<string>,
            serverClient.readContract({
                address: ADDRESSES.launchpad,
                abi: LAUNCHPAD_ABI,
                functionName: "marketCap",
                args: [tokenAddr],
            }).catch(() => 0n) as Promise<bigint>,
            // getTokenState no longer carries metadataURI (gas savings),
            // so we read it from the TokenCreated event instead.
            scanMetadataURI(tokenAddr),
        ]);

        const name = nameRes;
        const symbol = symbolRes;

        let marketCapFormatted: string | undefined;
        const mcap = Number(formatUnits(mcapRes, USDC_DECIMALS));
        if (mcap > 0) {
            marketCapFormatted = mcap.toLocaleString(undefined, { maximumFractionDigits: 0 });
        }

        // fetchMetadata handles both inline data: URIs and ipfs:// pointers.
        let imageUrl: string | undefined;
        let creatorHandle: string | undefined;
        if (metadataURI) {
            const meta = await fetchMetadata(metadataURI);
            if (meta?.image) {
                const resolved = resolveIpfs(meta.image);
                // Only forward http(s) image URLs to the OG renderer. data:
                // URLs would explode the query-string length and Satori
                // wouldn't fetch them anyway; the placeholder is cleaner.
                if (resolved.startsWith("http://") || resolved.startsWith("https://")) {
                    imageUrl = resolved;
                }
            }
            if (meta?.creatorTwitter) {
                creatorHandle = meta.creatorTwitter.replace(/^@/, "");
            }
        }

        return { name, symbol, imageUrl, marketCapFormatted, creatorHandle, variant: "v23" };
    } catch {
        return null;
    }
}


/**
 * Build the absolute OG image URL with query params encoded. Caller can
 * pass an explicit `siteUrl` if env happens not to be set.
 */
export function buildOgImageUrl(data: TokenSeoData, siteUrl?: string): string {
    // Resolution order: explicit caller-supplied URL, env var, Vercel
    // automatic env vars, then a hardcoded prod fallback. Localhost is
    // the LAST resort and only kicks in during local dev, never on a
    // deployed instance. Critical because Discord / X fetch this URL
    // server-side and a localhost link breaks every share preview.
    const base =
        siteUrl ??
        process.env.NEXT_PUBLIC_SITE_URL ??
        (process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : undefined) ??
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ??
        "https://arcade.trading";
    const origin = base.startsWith("http") ? base : `https://${base}`;
    const params = new URLSearchParams({
        name: data.name,
        symbol: data.symbol,
        variant: data.variant,
    });
    if (data.imageUrl) params.set("image", data.imageUrl);
    if (data.marketCapFormatted) params.set("fdv", data.marketCapFormatted);
    if (data.creatorHandle) params.set("creator", data.creatorHandle);
    return `${origin}/api/og?${params.toString()}`;
}
