import Image from "next/image";
import { cn } from "@/lib/utils";
import { SOLANA_BRIDGE_ID } from "@/lib/cctp";

/** Known PNG logos shipped with the app, keyed by EVM chain ID. */
const CHAIN_LOGOS: Record<number, string> = {
  11_155_111: "/eth.png",
  84_532: "/base.png",
  421_614: "/arbitrum.png",
  11_155_420: "/optimism.png",
  43_113: "/avalanche.png",
  5_042_002: "/arc.jpg",
  [SOLANA_BRIDGE_ID]: "/solana.png",
};

/** Fallback styled badge for chains without a PNG. */
interface FallbackStyle {
  bg: string;
  fg: string;
  label: string;
}
const FALLBACK_STYLES: Record<number, FallbackStyle> = {
  31_337: { bg: "#222222", fg: "#FFFFFF", label: "L" },
};
const DEFAULT_FALLBACK: FallbackStyle = { bg: "#3A3A3A", fg: "#FFFFFF", label: "?" };

interface Props {
  chainId: number;
  size?: number;
  className?: string;
}

export function ChainIcon({ chainId, size = 24, className }: Props) {
  const logo = CHAIN_LOGOS[chainId];
  if (logo) {
    return (
      <Image
        src={logo}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  const fb = FALLBACK_STYLES[chainId] ?? DEFAULT_FALLBACK;
  return (
    <div
      style={{
        width: size,
        height: size,
        backgroundColor: fb.bg,
        color: fb.fg,
        fontSize: size * 0.55,
        lineHeight: 1,
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none",
        className,
      )}
      aria-hidden
    >
      <span>{fb.label}</span>
    </div>
  );
}
