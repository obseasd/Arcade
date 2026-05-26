"use client";

import { useCallback } from "react";
import { Address, erc20Abi, maxUint256 } from "viem";
import { useAccount, useReadContract, useWriteContract, usePublicClient } from "wagmi";

/**
 * Ensures the connected account has approved `spender` for at least `amount`
 * units of `token`. Returns a `(amount) => Promise<void>` runner that resolves
 * once the approval tx is confirmed (or immediately if allowance was enough).
 */
export function useApproveIfNeeded(token: Address | undefined, spender: Address | undefined) {
  const { address: owner } = useAccount();
  const publicClient = usePublicClient();

  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner && spender ? [owner, spender] : undefined,
    query: { enabled: !!owner && !!token && !!spender },
  });

  const { writeContractAsync } = useWriteContract();

  const ensureAllowance = useCallback(
    async (amount: bigint) => {
      if (!token || !spender || !owner) throw new Error("Missing token/spender/owner");
      const current = (allowance.data as bigint | undefined) ?? 0n;
      if (current >= amount) return;
      const hash = await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
      }
      await allowance.refetch();
    },
    [token, spender, owner, allowance, writeContractAsync, publicClient],
  );

  return { allowance: (allowance.data as bigint | undefined) ?? 0n, ensureAllowance };
}
