import { TokenIcon } from "./TokenIcon";

/** Backwards-compatible alias: USDC always renders via TokenIcon with symbol "USDC". */
export function UsdcLogo({ size = 24, className }: { size?: number; className?: string }) {
  return <TokenIcon symbol="USDC" size={size} className={className} />;
}
