"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
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

/** A gateway that has not delivered the image within this window is treated as
 *  too slow and we move to the next candidate. onError alone is not enough: a
 *  throttled public gateway often answers eventually (10-15s) rather than
 *  failing, which left the token logo blank for that whole time. */
const SLOW_GATEWAY_MS = 2_500;

export function TokenIcon({ symbol, image, size = 32, className, priority }: Props) {
  const candidates = useMemo(() => (image ? imageCandidates(image) : []), [image]);
  // Index into the gateway fallback list; advanced by onError OR by the
  // slow-gateway timeout below.
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // New token / new image: restart at the primary gateway.
  useEffect(() => {
    setIdx(0);
    setLoaded(false);
  }, [candidates]);

  // Slow-gateway timeout. Only armed while a NEXT candidate exists, so the last
  // gateway keeps unlimited time and we never drop an image that would have
  // loaded a bit later.
  useEffect(() => {
    if (loaded || idx >= candidates.length - 1) return;
    const t = setTimeout(() => setIdx((i) => (i === idx ? i + 1 : i)), SLOW_GATEWAY_MS);
    return () => clearTimeout(t);
  }, [idx, loaded, candidates.length]);

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
        onLoad={() => setLoaded(true)}
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
