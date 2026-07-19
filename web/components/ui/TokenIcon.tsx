"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { TokenLogo } from "./TokenLogo";
import { resolveIpfs, ipfsGatewayUrls } from "@/lib/metadata";

/**
 * Known well-known tokens that ship with a real logo file in /public.
 * Symbols are matched case-insensitively. Any token whose symbol isn't in
 * this map falls back to a gradient-initial circle (`TokenLogo`).
 */
const PNG_LOGOS: Record<string, string> = {
  USDC: "/usdc.png",
  WUSDC: "/usdc.png",
  EURC: "/eurc.png",
  ETH: "/eth.png",
  WETH: "/eth.png",
  BTC: "/btc.png",
  WBTC: "/btc.png",
  CIRBTC: "/cirbtc.png",
  USDT: "/usdt.png",
  USYC: "/usyc.svg",
};

interface Props {
  symbol?: string | null;
  /** Override URL (data: or http(s):) — takes precedence over the symbol-based lookup. */
  image?: string;
  size?: number;
  className?: string;
  priority?: boolean;
}

/** Candidate URLs for a user-supplied image. IPFS content (whether an ipfs://
 *  URI or an already-resolved /ipfs/<cid> gateway URL) yields the ordered
 *  gateway fallback list so a throttled primary gateway retries a public one;
 *  data: and plain http(s) URLs are single-candidate. */
function imageCandidates(image: string): string[] {
  if (image.startsWith("ipfs://")) return ipfsGatewayUrls(image);
  const m = image.match(/\/ipfs\/([A-Za-z0-9][\w./-]*)$/);
  if (m) return ipfsGatewayUrls(`ipfs://${m[1]}`);
  return [resolveIpfs(image)];
}

export function TokenIcon({ symbol, image, size = 32, className, priority }: Props) {
  const candidates = useMemo(() => (image ? imageCandidates(image) : []), [image]);
  // Index into the gateway fallback list; advanced by onError. Reset implicitly
  // when `candidates` identity changes (new token) via the key on <img>.
  const [idx, setIdx] = useState(0);

  const cleanSymbol = symbol?.replace(/^\$+/, "");
  const pngLogo = cleanSymbol ? PNG_LOGOS[cleanSymbol.toUpperCase()] : undefined;

  // User-supplied image (data:, http(s):, or IPFS gateway): render a plain
  // <img> so the browser fetches the bytes directly. Next/Image would route
  // IPFS gateway URLs through Vercel's server-side optimizer, whose shared
  // egress IPs get 429'd by the public Pinata gateway -> broken image with no
  // retry. A plain <img> + onError gateway-cycling is resilient instead.
  if (candidates.length > 0 && idx < candidates.length) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={candidates[0]}
        src={candidates[idx]}
        alt={symbol ?? "token"}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        loading={priority ? "eager" : "lazy"}
        onError={() => setIdx((i) => i + 1)}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  // First-party brand PNGs: keep Next/Image optimization (WebP/AVIF + lazy).
  if (pngLogo) {
    return (
      <Image
        src={pngLogo}
        alt={symbol ?? "token"}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
        priority={priority}
      />
    );
  }

  // No image + no known logo (or every IPFS gateway failed): gradient initial.
  return <TokenLogo symbol={cleanSymbol ?? "?"} size={size} className={className} />;
}
