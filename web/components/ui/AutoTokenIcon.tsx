"use client";

import { Address } from "viem";
import { useTokenMetadataURI } from "@/lib/hooks/useTokenMetadataURI";
import { getImageUrl } from "@/lib/metadata";
import { TokenIcon } from "./TokenIcon";

/**
 * Drop-in replacement for `TokenIcon` that auto-resolves the uploaded logo for
 * launchpad tokens. For well-known tokens (USDC, WETH, etc) the symbol lookup
 * inside TokenIcon kicks in instantly; for launchpad tokens we read the
 * on-chain `metadataURI` via the indexed-arg getLogs hook (module-level cache,
 * ~100ms on cache miss, instant on hit) and pass the parsed image URL through.
 *
 * Use this anywhere a launchpad token might appear (swap select modal, swap
 * confirm modal, token boxes, toaster). Falls back to the gradient placeholder
 * if the token has no image or hasn't been launched via the launchpad.
 */
interface Props {
  address?: Address;
  symbol?: string | null;
  size?: number;
  className?: string;
}

export function AutoTokenIcon({ address, symbol, size = 32, className }: Props) {
  const { metadataURI } = useTokenMetadataURI(address);
  const image = metadataURI ? getImageUrl(metadataURI) : undefined;
  return <TokenIcon symbol={symbol} image={image} size={size} className={className} />;
}
