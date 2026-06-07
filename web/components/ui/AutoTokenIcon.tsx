"use client";

import { Address } from "viem";
import { useTokenImage } from "@/lib/hooks/useTokenImage";
import { TokenIcon } from "./TokenIcon";

/**
 * Drop-in replacement for `TokenIcon` that auto-resolves the uploaded logo for
 * launchpad tokens. For well-known tokens (USDC, WETH, etc) the symbol lookup
 * inside TokenIcon kicks in instantly; for launchpad tokens we read the
 * on-chain `metadataURI` and, when the metadata sits behind an `ipfs://`
 * pointer, fetch the JSON through a public IPFS gateway to extract the image.
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
  const { image } = useTokenImage(address);
  // key={address} forces TokenIcon to remount on address change so any
  // <Image>-cached prior src is dropped from the DOM. Without this, when
  // the consumer's token switches A -> B and B has no image, the rendered
  // <img> can briefly keep A's src in memory until React reconciles a new
  // tree (visible as the "logo inherited from previously chosen token" bug).
  return (
    <TokenIcon
      key={address?.toLowerCase() ?? "none"}
      symbol={symbol}
      image={image}
      size={size}
      className={className}
    />
  );
}
