"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/chains";
import { pushToast } from "@/lib/toast";
import { Modal } from "@/components/ui/Modal";

/**
 * Global chain guard. Surfaces a blocking modal when the connected wallet is
 * not on Arc. wagmi's `switchChain` first tries `wallet_switchEthereumChain`;
 * if the wallet doesn't have Arc configured, it auto-falls back to
 * `wallet_addEthereumChain` using the params we set in `chains.ts`. So the
 * user just clicks "Switch" or "Add" once, depending on their wallet state.
 *
 * Mount once at the layout level.
 */
export function ChainGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();
  const [dismissed, setDismissed] = useState(false);
  const pathname = usePathname();

  // The /bridge page legitimately needs the wallet on a non-Arc source chain
  // (Eth Sepolia, Base, etc.) while CCTP burns. Suppress the guard there so
  // the user can complete the burn without being nagged to switch back.
  const onBridgePage = pathname?.startsWith("/bridge") ?? false;

  const wrongChain = isConnected && chainId !== arcTestnet.id && !onBridgePage;

  // Reset dismissed state if the user disconnects or moves back to Arc.
  useEffect(() => {
    if (!wrongChain) setDismissed(false);
  }, [wrongChain]);

  if (!wrongChain || dismissed) return null;

  const handleSwitch = () => {
    switchChain(
      { chainId: arcTestnet.id },
      {
        onError: (err) => {
          pushToast({
            kind: "error",
            title: "Switch failed",
            message: err.message?.slice(0, 120),
          });
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={() => setDismissed(true)}
      closeOnBackdrop={false}
      widthClassName="max-w-md"
    >
      <div className="space-y-4 p-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-arc-warn/15 text-arc-warn">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Wrong network</h3>
            <p className="mt-1 text-sm text-arc-text-muted">
              Arcade runs on Arc Testnet (chainId {arcTestnet.id}). Your wallet is
              currently on a different network. Click below to switch. If Arc is
              not yet in your wallet, the same button adds it.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-arc-border bg-arc-bg-elevated p-3 text-xs">
          <div className="grid grid-cols-2 gap-1.5">
            <span className="text-arc-text-muted">Chain</span>
            <span className="tabular-nums text-arc-text">Arc Testnet</span>
            <span className="text-arc-text-muted">Chain ID</span>
            <span className="tabular-nums text-arc-text">{arcTestnet.id}</span>
            <span className="text-arc-text-muted">Native gas token</span>
            <span className="text-arc-text">USDC</span>
            <span className="text-arc-text-muted">RPC</span>
            <span className="break-all text-arc-text">{arcTestnet.rpcUrls.default.http[0]}</span>
            <span className="text-arc-text-muted">Explorer</span>
            <span className="break-all text-arc-text">{arcTestnet.blockExplorers?.default.url}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button type="button"
            onClick={() => setDismissed(true)}
            className="arc-button-secondary flex-1 py-2.5 text-sm"
          >
            Continue anyway
          </button>
          <button type="button"
            onClick={handleSwitch}
            disabled={isPending}
            className="arc-button-primary flex-1 py-2.5 text-sm"
          >
            {isPending ? "Waiting on wallet…" : "Switch to Arc"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
