import Image from "next/image";
import { cn } from "@/lib/utils";
import { TokenLogo } from "./TokenLogo";
import { resolveIpfs } from "@/lib/metadata";

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
  USDT: "/usdt.png",
};

interface Props {
  symbol?: string | null;
  /** Override URL (data: or http(s):) — takes precedence over the symbol-based lookup. */
  image?: string;
  size?: number;
  className?: string;
}

export function TokenIcon({ symbol, image, size = 32, className }: Props) {
  // Resolve ipfs:// to an HTTPS gateway since native <img> can't load the
  // ipfs:// protocol. Pass through http(s):// and data: URLs untouched.
  const rawImage = image ? resolveIpfs(image) : undefined;
  // Strip a leading "$" before looking up the symbol in PNG_LOGOS or
  // falling back to the gradient initial. Otherwise "$PUMP" looks up as
  // "$PUMP" (no match) and the placeholder shows "$" as the letter,
  // which is what users see when a token had no logo upload.
  const cleanSymbol = symbol?.replace(/^\$+/, "");
  const src = rawImage || (cleanSymbol ? PNG_LOGOS[cleanSymbol.toUpperCase()] : undefined);
  if (src) {
    return (
      <Image
        src={src}
        alt={symbol ?? "token"}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
        unoptimized
      />
    );
  }
  // Pass cleanSymbol so the initial is "P" for "$PUMP" rather than "$".
  return <TokenLogo symbol={cleanSymbol ?? "?"} size={size} className={className} />;
}
