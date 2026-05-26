"use client";

import { Droplet } from "lucide-react";
import { useState } from "react";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";
import { ERC20_ABI } from "@/lib/abis/erc20";
import { ADDRESSES } from "@/lib/constants";

/**
 * Visible only on the local Anvil chain. Calls MockUSDC.faucet() to drop
 * 10k test USDC into the user's wallet.
 */
export function FaucetButton() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [loading, setLoading] = useState(false);

  if (chainId !== 31337 || !address) return null;

  const onClick = async () => {
    setLoading(true);
    try {
      const hash = await writeContractAsync({
        address: ADDRESSES.usdc,
        abi: ERC20_ABI,
        functionName: "faucet",
        args: [],
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="inline-flex items-center gap-1.5 rounded-lg border border-arc-border bg-arc-surface px-3 py-1.5 text-xs font-medium text-arc-text-muted hover:bg-arc-surface-2 hover:text-arc-text disabled:opacity-50"
      title="Mint 10,000 mock USDC for local testing"
    >
      <Droplet className="h-3.5 w-3.5" />
      {loading ? "Minting…" : "Test USDC"}
    </button>
  );
}
