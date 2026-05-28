"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ChevronDown, Copy, ExternalLink, LogOut, Rocket } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { erc20Abi } from "viem";
import { useAccount, useDisconnect, useReadContract } from "wagmi";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { cn, formatUSDC } from "@/lib/utils";
import { TokenIcon } from "@/components/ui/TokenIcon";

/**
 * Combined header widget: USDC balance on the left, vertical separator, wallet
 * info on the right (connector logo + name + shortened address). Clicking the
 * wallet button opens a custom dropdown with My Tokens, Copy address, View
 * account (RainbowKit modal), and Disconnect.
 */
export function HeaderWalletWidget() {
  const { address, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the menu when clicking outside.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const balanceQ = useReadContract({
    address: ADDRESSES.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const raw = (balanceQ.data as bigint | undefined) ?? 0n;
  const amountWhole = formatUSDC(raw, USDC_DECIMALS, 0);
  const usdValue = formatUSDC(raw, USDC_DECIMALS, 2);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      pushToast({ kind: "info", title: "Address copied" });
    } catch {
      pushToast({ kind: "error", title: "Couldn't copy" });
    }
    setMenuOpen(false);
  };

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
          <div ref={menuRef} className="relative font-sans">
            <div
              style={{ height: "52px", minHeight: "52px" }}
              className="flex items-stretch overflow-hidden rounded-2xl border border-arc-gray/20 bg-black/15 backdrop-blur-xl"
            >
              <div className="flex items-center gap-2 px-3">
                <TokenIcon symbol="USDC" size={22} />
                <div className="flex flex-col leading-tight">
                  <span className="text-xs font-semibold text-arc-text">{amountWhole}</span>
                  <span className="text-[9px] text-arc-text-muted">${usdValue}</span>
                </div>
              </div>

              <div className="my-2 w-0.5 rounded-full bg-arc-gray/60" />

              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-2 px-3 transition-colors hover:bg-white/5"
              >
                <WalletIcon icon={walletIcon} name={walletName} />
                <div className="flex flex-col items-start leading-tight">
                  <span className="text-[9px] text-arc-text-muted">{walletName}</span>
                  <span className="text-xs font-semibold text-arc-text">{short}</span>
                </div>
                <ChevronDown
                  className={cn(
                    "h-3 w-3 text-arc-text-muted transition-transform",
                    menuOpen && "rotate-180",
                  )}
                />
              </button>
            </div>

            {menuOpen && (
              <div className="absolute right-0 top-[58px] z-50 w-60 overflow-hidden rounded-2xl border border-arc-gray/30 bg-black/85 backdrop-blur-xl shadow-arc-card">
                <div className="border-b border-arc-border px-4 py-3">
                  <div className="text-[10px] uppercase tracking-wider text-arc-text-faint">
                    Connected
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-arc-text">{address}</div>
                </div>
                <MenuItem
                  icon={<Rocket className="h-3.5 w-3.5" />}
                  href="/my-tokens"
                  onClick={() => setMenuOpen(false)}
                >
                  My tokens
                </MenuItem>
                <MenuItem
                  icon={<Copy className="h-3.5 w-3.5" />}
                  onClick={copyAddress}
                >
                  Copy address
                </MenuItem>
                <MenuItem
                  icon={<ExternalLink className="h-3.5 w-3.5" />}
                  onClick={() => {
                    openAccountModal();
                    setMenuOpen(false);
                  }}
                >
                  View account
                </MenuItem>
                <MenuItem
                  icon={<LogOut className="h-3.5 w-3.5" />}
                  onClick={() => {
                    disconnect();
                    setMenuOpen(false);
                  }}
                  variant="danger"
                >
                  Disconnect
                </MenuItem>
              </div>
            )}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function MenuItem({
  icon,
  href,
  onClick,
  children,
  variant,
}: {
  icon: React.ReactNode;
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  variant?: "default" | "danger";
}) {
  const className = cn(
    "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs transition-colors",
    variant === "danger"
      ? "text-arc-danger hover:bg-arc-danger/10"
      : "text-arc-text hover:bg-white/5",
  );
  if (href) {
    return (
      <Link href={href} onClick={onClick} className={className}>
        <span className="text-arc-text-muted">{icon}</span>
        {children}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={className}>
      <span className="text-arc-text-muted">{icon}</span>
      {children}
    </button>
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

function formatShortAddress(addr?: string): string {
  if (!addr || addr.length < 8) return addr ?? "";
  return `${addr.slice(0, 4)}...${addr.slice(-2)}`;
}
