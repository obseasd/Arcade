"use client";

import { useCallback } from "react";
import { Address, erc20Abi } from "viem";

/** Buffer added on top of the exact trade amount when approving, in bps.
 *  Absorbs fee-on-transfer / rounding so the follow-up call does not
 *  false-revert on a hair-short allowance. */
const APPROVE_BUFFER_BPS = 200n; // 2%
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
      // Approve the EXACT trade amount plus a small buffer instead of
      // maxUint256. Unlimited approvals are what turned the V3-router callback
      // bug into a full-wallet drain; an exact+buffer approval caps a
      // compromised spender's reach to this trade's size. Cost: an approve per
      // trade (the standard serious-DEX default).
      const approveAmount = amount + (amount * APPROVE_BUFFER_BPS) / 10_000n;
      const hash = await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, approveAmount],
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
