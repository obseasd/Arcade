/**
 * Server-side helpers for `generateMetadata` on token detail pages. Fetches
 * minimal on-chain info (name, symbol, market cap) and builds OpenGraph +
 * Twitter card metadata that drives rich previews when users share token
 * URLs on X, Discord, Telegram, etc.
 *
 * All reads use a dedicated server-side `viem` public client so we never
 * touch the wagmi browser hooks (which can't run during server rendering).
 */

import { Address, createPublicClient, erc20Abi, formatUnits, http, isAddress } from "viem";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";
import { V4_LAUNCHPAD_ABI } from "@/lib/abis/v4Launchpad";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { arcTestnet } from "@/lib/chains";
import { fetchMetadata, resolveIpfs } from "@/lib/metadata";

const serverClient = createPublicClient({
    chain: arcTestnet,
    transport: http(arcTestnet.rpcUrls.default.http[0]),
});

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
        const [nameRes, symbolRes, mcapRes, stateRes] = await Promise.allSettled([
            serverClient.readContract({
                address: tokenAddr,
                abi: erc20Abi,
                functionName: "name",
            }) as Promise<string>,
            serverClient.readContract({
                address: tokenAddr,
                abi: erc20Abi,
                functionName: "symbol",
            }) as Promise<string>,
            serverClient.readContract({
                address: ADDRESSES.launchpad,
                abi: LAUNCHPAD_ABI,
                functionName: "marketCap",
                args: [tokenAddr],
            }) as Promise<bigint>,
            serverClient.readContract({
                address: ADDRESSES.launchpad,
                abi: LAUNCHPAD_ABI,
                functionName: "getTokenState",
                args: [tokenAddr],
            }) as Promise<unknown>,
        ]);

        const name = nameRes.status === "fulfilled" ? nameRes.value : "Arcade Token";
        const symbol = symbolRes.status === "fulfilled" ? symbolRes.value : "TKN";

        let marketCapFormatted: string | undefined;
        if (mcapRes.status === "fulfilled") {
            const mcap = Number(formatUnits(mcapRes.value, USDC_DECIMALS));
            if (mcap > 0) {
                marketCapFormatted = mcap.toLocaleString(undefined, { maximumFractionDigits: 0 });
            }
        }

        // metadataURI comes from the TokenState struct. We resolve it via the
        // same path the UI uses so creator-supplied images come through.
        let imageUrl: string | undefined;
        let creatorHandle: string | undefined;
        if (stateRes.status === "fulfilled") {
            const state = stateRes.value as { metadataURI?: string };
            // fetchMetadata supports both inline data: and ipfs:// URIs;
            // parseInlineMetadata used to be inline-only and silently
            // dropped image + creator info from any Pinata-uploaded launch.
            const meta = await fetchMetadata(state?.metadataURI ?? "");
            if (meta?.image) imageUrl = resolveIpfs(meta.image);
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
 * Build SEO data for a V4 launchpad token. Same shape as V2/V3 but reads
 * from the V4 launchpad's `getLaunch(token)`.
 */
export async function fetchV4TokenSeo(token: string): Promise<TokenSeoData | null> {
    if (!isAddress(token)) return null;
    if (ADDRESSES.v4Launchpad === "0x0000000000000000000000000000000000000000") return null;
    const tokenAddr = token as Address;
    try {
        const [nameRes, symbolRes, launchRes] = await Promise.allSettled([
            serverClient.readContract({
                address: tokenAddr,
                abi: erc20Abi,
                functionName: "name",
            }) as Promise<string>,
            serverClient.readContract({
                address: tokenAddr,
                abi: erc20Abi,
                functionName: "symbol",
            }) as Promise<string>,
            serverClient.readContract({
                address: ADDRESSES.v4Launchpad,
                abi: V4_LAUNCHPAD_ABI,
                functionName: "getLaunch",
                args: [tokenAddr],
            }) as Promise<unknown>,
        ]);

        const name = nameRes.status === "fulfilled" ? nameRes.value : "V4 Launch";
        const symbol = symbolRes.status === "fulfilled" ? symbolRes.value : "V4";

        let imageUrl: string | undefined;
        let creatorHandle: string | undefined;
        if (launchRes.status === "fulfilled") {
            // V4 launches don't carry metadataURI on the struct - only on the
            // event. For SEO we accept the empty image case and fall back to
            // the symbol initial in the OG renderer.
            void launchRes;
        }

        return { name, symbol, imageUrl, creatorHandle, variant: "v4" };
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
