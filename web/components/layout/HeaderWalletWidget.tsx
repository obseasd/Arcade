"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ChevronDown } from "lucide-react";
import { erc20Abi } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { formatUSDC } from "@/lib/utils";
import { TokenIcon } from "@/components/ui/TokenIcon";

/**
 * Combined header widget: USDC balance on the left, vertical separator, wallet
 * info on the right (connector logo + name + shortened address). Falls back
 * to a single Connect button when disconnected.
 */
export function HeaderWalletWidget() {
  const { address, connector } = useAccount();

  const balanceQ = useReadContract({
    address: ADDRESSES.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const raw = (balanceQ.data as bigint | undefined) ?? 0n;
  // Whole-number formatted balance (no decimals)
  const amountWhole = formatUSDC(raw, USDC_DECIMALS, 0);
  // USD value with decimals
  const usdValue = formatUSDC(raw, USDC_DECIMALS, 2);

  return (
    <ConnectButton.Custom>
      {({ account, openAccountModal, openConnectModal, openChainModal, chain, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain && !!address;

        if (!connected) {
          return (
            <button onClick={openConnectModal} className="arc-button-primary px-4 py-2 text-sm">
              Connect Wallet
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button
              onClick={openChainModal}
              className="rounded-xl border border-arc-danger/40 bg-arc-danger/10 px-3 py-2 text-sm font-medium text-arc-danger"
            >
              Wrong network
            </button>
          );
        }

        const short = formatShortAddress(address);
        const walletName = connector?.name ?? "Wallet";
        const walletIcon = (connector as any)?.icon as string | undefined;

        return (
          <div
            style={{ height: "52px", minHeight: "52px" }}
            className="flex items-stretch overflow-hidden rounded-2xl border border-arc-gray/20 bg-black/15 backdrop-blur-xl font-sans"
          >
            {/* Left: USDC balance */}
            <div className="flex items-center gap-2 px-3">
              <TokenIcon symbol="USDC" size={22} />
              <div className="flex flex-col leading-tight">
                <span className="text-xs font-semibold text-arc-text">{amountWhole}</span>
                <span className="text-[9px] text-arc-text-muted">${usdValue}</span>
              </div>
            </div>

            {/* Separator - 2px gray */}
            <div className="my-2 w-0.5 rounded-full bg-arc-gray/60" />

            {/* Right: wallet */}
            <button
              onClick={openAccountModal}
              className="flex items-center gap-2 px-3 transition-colors hover:bg-white/5"
            >
              <WalletIcon icon={walletIcon} name={walletName} />
              <div className="flex flex-col items-start leading-tight">
                <span className="text-[9px] text-arc-text-muted">{walletName}</span>
                <span className="text-xs font-semibold text-arc-text">{short}</span>
              </div>
              <ChevronDown className="h-3 w-3 text-arc-text-muted" />
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function WalletIcon({ icon, name }: { icon?: string; name: string }) {
  if (icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} alt={name} className="h-6 w-6 rounded-md" />;
  }
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-arc-primary to-arc-cta text-[10px] font-bold text-white">
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/**
 * "0xXXXX...XX" - 4 prefix chars (including 0x → so 0x + 2 hex chars), `...`, 2 last chars.
 */
function formatShortAddress(addr?: string): string {
  if (!addr || addr.length < 8) return addr ?? "";
  return `${addr.slice(0, 4)}...${addr.slice(-2)}`;
}
