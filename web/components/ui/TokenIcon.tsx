import { cn } from "@/lib/utils";
import { TokenLogo } from "./TokenLogo";

/**
 * Known well-known tokens that ship with a real logo file in /public.
 * Symbols are matched case-insensitively. Any token whose symbol isn't in
 * this map falls back to a gradient-initial circle (`TokenLogo`).
 */
const PNG_LOGOS: Record<string, string> = {
  USDC: "/usdc.png",
  WUSDC: "/usdc.png",
  ETH: "/eth.png",
  WETH: "/eth.png",
  BTC: "/btc.png",
  WBTC: "/btc.png",
  USDT: "/usdt.png",
};

interface Props {
  symbol?: string | null;
  size?: number;
  className?: string;
}

export function TokenIcon({ symbol, size = 32, className }: Props) {
  const knownLogo = symbol ? PNG_LOGOS[symbol.toUpperCase()] : undefined;
  if (knownLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={knownLogo}
        alt={symbol ?? "token"}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-contain", className)}
      />
    );
  }
  return <TokenLogo symbol={symbol ?? "?"} size={size} className={className} />;
}
