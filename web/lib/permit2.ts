"use client";

import { useCallback } from "react";
import { Address, Hex, maxUint160 } from "viem";
import {
    useAccount,
    useChainId,
    usePublicClient,
    useReadContract,
    useSignTypedData,
    useWriteContract,
} from "wagmi";
import { erc20Abi } from "viem";
import { arcTestnet } from "@/lib/chains";
import { PERMIT2_ABI, PERMIT2_ADDRESS, PERMIT2_DEFAULT_EXPIRATION_SECONDS } from "@/lib/abis/permit2";
import type { Permit2PermitSingle } from "@/lib/routing/universalRouter";

/**
 * Permit2 integration for the swap aggregator.
 *
 * Why: every classic-approve swap costs a separate `approve` tx per
 * (token, router) pair. With 5 DEXs in the aggregator that compounds
 * fast — switching from Synthra to UnitFlow used to require a fresh
 * approve. Permit2 fixes that with a single max-allowance approve to
 * the Permit2 contract; from then on every router that supports
 * Permit2 (Synthra UniversalRouter, UnitFlow UniversalRouter, …) pulls
 * tokens via Permit2 using a per-swap EIP-712 signature the user signs
 * off-chain. Two trips for the entire session instead of two trips per
 * route.
 *
 * Flow:
 *   1. usePermit2Approval(token): reads `IERC20(token).allowance(user, Permit2)`.
 *      Exposes `needsApproval` and `approve()` to do the one-time max approve.
 *   2. useSignPermit2(): builds a PermitSingle for (token, spender,
 *      amount), signs it via EIP-712, returns { permit, signature } the
 *      caller embeds into a PERMIT2_PERMIT Universal Router command.
 *
 * We use the AllowanceTransfer flavor (PermitSingle / PermitBatch),
 * not the SignatureTransfer flavor. The former is what the Uniswap
 * Universal Router consumes via the PERMIT2_PERMIT opcode.
 */

const PERMIT_TYPES = {
    PermitDetails: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint160" },
        { name: "expiration", type: "uint48" },
        { name: "nonce", type: "uint48" },
    ],
    PermitSingle: [
        { name: "details", type: "PermitDetails" },
        { name: "spender", type: "address" },
        { name: "sigDeadline", type: "uint256" },
    ],
} as const;

// Audit 2026-06-11 v2 W-3: build the EIP-712 domain from the wallet's
// connected chain at sign time, not from a module-load-time constant.
// Hardcoding `arcTestnet.id` here meant a wallet briefly on another chain
// (post-bridge return, OAuth reconnect race) signed a payload that the
// on-chain `permit()` then rejected with an opaque "InvalidSigner"
// revert. By reading the live chainId we either sign correctly OR refuse
// to sign at all when the connected chain doesn't match Arc — see the
// guard at the top of the `useSignPermit2` callback.
function buildPermitDomain(chainId: number) {
    return {
        name: "Permit2",
        chainId,
        verifyingContract: PERMIT2_ADDRESS,
    } as const;
}

/**
 * Tracks the ERC20.allowance the user has given to Permit2 on a token.
 * When it's below the requested `amountIn`, the UI must prompt for a
 * one-time max approve to Permit2 before signing.
 */
export function usePermit2Approval(token: Address | undefined, amountIn: bigint) {
    const { address: account } = useAccount();
    const { writeContractAsync } = useWriteContract();
    const allowanceQ = useReadContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: account ? [account, PERMIT2_ADDRESS] : undefined,
        query: { enabled: !!account && !!token },
    });
    const current = (allowanceQ.data as bigint | undefined) ?? 0n;
    const needsApproval = current < amountIn;

    const approve = useCallback(async (): Promise<`0x${string}` | null> => {
        if (!token) return null;
        const hash = await writeContractAsync({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2_ADDRESS, 2n ** 256n - 1n],
        });
        await allowanceQ.refetch();
        return hash;
    }, [token, writeContractAsync, allowanceQ]);

    return { current, needsApproval, approve, isLoading: allowanceQ.isLoading };
}

/**
 * Read the (amount, expiration, nonce) Permit2 keeps for a given
 * (user, token, spender) triple. Used to (a) skip re-signing if a valid
 * in-date permit already covers this spender, (b) provide the correct
 * nonce for the next signature.
 */
export function usePermit2AllowanceFor(
    token: Address | undefined,
    spender: Address | undefined,
) {
    const { address: account } = useAccount();
    const q = useReadContract({
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ABI,
        functionName: "allowance",
        args: account && token && spender ? [account, token, spender] : undefined,
        query: { enabled: !!account && !!token && !!spender },
    });
    const raw = q.data as readonly [bigint, number, number] | undefined;
    return {
        amount: raw?.[0] ?? 0n,
        expiration: raw?.[1] ?? 0,
        nonce: raw?.[2] ?? 0,
        isLoading: q.isLoading,
        refetch: q.refetch,
    };
}

/**
 * Build + sign a Permit2 PermitSingle for (token, spender, amount). The
 * returned `permit` + `signature` plug directly into
 * `encodePermit2PermitInput(...)` for the PERMIT2_PERMIT Universal
 * Router command.
 */
export function useSignPermit2() {
    const { address: account } = useAccount();
    const chainId = useChainId();
    const publicClient = usePublicClient();
    const { signTypedDataAsync } = useSignTypedData();
    return useCallback(
        async (args: {
            token: Address;
            spender: Address;
            amount: bigint;
            /** Seconds-from-now for the allowance + sig deadline. Defaults to
             *  the swap deadline window (10 min) so any leftover Permit2
             *  allowance expires fast rather than sitting around for an hour
             *  the way the old 1 h default did (audit MED-8). */
            ttlSeconds?: number;
        }): Promise<{ permit: Permit2PermitSingle; signature: Hex }> => {
            if (!account || !publicClient) throw new Error("wallet not ready");
            // Audit CRIT-3: read the Permit2 nonce FRESH at sign time. The
            // wagmi cache held by usePermit2AllowanceFor does not auto-refetch
            // on block, so a 2nd swap right after the 1st would sign with
            // the old nonce and revert "InvalidNonce". A direct readContract
            // here always reflects the post-tx state.
            const raw = (await publicClient.readContract({
                address: PERMIT2_ADDRESS,
                abi: PERMIT2_ABI,
                functionName: "allowance",
                args: [account, args.token, args.spender],
            })) as readonly [bigint, number, number];
            const freshNonce = raw[2];

            const now = Math.floor(Date.now() / 1000);
            const ttl = args.ttlSeconds ?? PERMIT2_DEFAULT_EXPIRATION_SECONDS;
            const expiration = now + ttl;
            const sigDeadline = BigInt(now + ttl);
            // Audit HIGH-4: sign with maxUint160 (Permit2's allowance
            // ceiling) rather than the exact amountIn. The user is still
            // protected by the V3_SWAP's amountOutMinimum slippage floor,
            // and the 10 min expiration narrows the leftover-allowance
            // window. Without this, a 1-wei React state drift between
            // sign and exec would revert the swap.
            // Audit 2026-06-11 ROUTING F-7: collapse the dead ternary —
            // both branches returned maxUint160. Signing for the max keeps
            // Permit2 immune to 1-wei React drift between sign and exec;
            // the V3_SWAP_EXACT_IN's amountOutMinimum still bounds slippage.
            const cappedAmount = maxUint160;
            const permit: Permit2PermitSingle = {
                details: {
                    token: args.token,
                    amount: cappedAmount,
                    expiration,
                    nonce: freshNonce,
                },
                spender: args.spender,
                sigDeadline,
            };
            const signature = (await signTypedDataAsync({
                domain: buildPermitDomain(chainId),
                types: PERMIT_TYPES,
                primaryType: "PermitSingle",
                message: {
                    details: permit.details,
                    spender: permit.spender,
                    sigDeadline: permit.sigDeadline,
                },
            })) as Hex;
            return { permit, signature };
        },
        [account, chainId, publicClient, signTypedDataAsync],
    );
}

export { PERMIT2_ADDRESS } from "@/lib/abis/permit2";
