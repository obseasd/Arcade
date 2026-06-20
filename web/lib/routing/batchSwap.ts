import { Address, encodeFunctionData, erc20Abi, maxUint256 } from "viem";
import {
    MULTICALL3_FROM_ABI,
    MULTICALL3_FROM_ADDRESS,
} from "@/lib/abis/multicall3From";

/**
 * Arc batch-swap helper (Multicall3From).
 *
 * On Arc, `Multicall3From` (0x522fAf9A…) runs every subcall through the
 * `callFrom` precompile so the target sees the original EOA as
 * `msg.sender`. That lets us fold the one-time ERC20 `approve` and the
 * swap into a SINGLE user signature instead of the classic
 * approve-tx-then-swap-tx pair — the router's `transferFrom` still pulls
 * from the user because the precompile preserves the sender.
 *
 * Validated on-chain 2026-06-19: `aggregate3([approve, exactInputSingle])`
 * on the live USDC/SeedETH 0.3% pool returned status 1, the Approval
 * event owner was the EOA (not the multicall), and the swap credited the
 * EOA — proving the complex router leg survives the precompile path (the
 * concern that killed the Memo F1/F2/F6 wraps did not apply here). See
 * reference_arc_v0_7_2_primitives memo.
 *
 * Only used for the classic-approval Arcade routes (V2 / V3 / launchpad).
 * Permit2/UniversalRouter routes (Synthra, UnitFlow) already settle in a
 * single execute() call with an off-chain permit signature, so they never
 * hit this path. The precompile does not forward value, so value-bearing
 * variants (UnitFlow WRAP_ETH) are excluded by the caller.
 */

export interface BatchSwapCall {
    address: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: any;
    functionName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: readonly any[];
}

/** A pre-encoded subcall for a Multicall3From batch. */
export interface RawBatchCall {
    target: Address;
    callData: `0x${string}`;
    /** Default false: a sub-call revert reverts the whole batch (atomic). */
    allowFailure?: boolean;
}

/**
 * Fold a single ERC20 `approve(spender, max)` + an arbitrary contract call
 * into one sender-preserving signature. The generic building block behind
 * every "first interaction with token X" flow (curve/clanker trade, limit
 * order, etc.): the action's `transferFrom(msg.sender)` still pulls from
 * the user because Multicall3From preserves the sender. allowFailure stays
 * false so the batch is atomic.
 */
export function buildApproveAndCall(params: {
    /** ERC20 the action will pull. */
    token: Address;
    /** Contract that pulls `token` (the approve spender). */
    spender: Address;
    /** The action to run after the approve. */
    call: BatchSwapCall;
}) {
    const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [params.spender, maxUint256],
    });
    const callData = encodeFunctionData({
        abi: params.call.abi,
        functionName: params.call.functionName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: params.call.args as any,
    });
    return buildAggregate3([
        { target: params.token, callData: approveData },
        { target: params.call.address, callData },
    ]);
}

/**
 * Generic variadic Multicall3From batch: runs N pre-encoded calls in one
 * sender-preserving transaction. Use for flows that fold several approves
 * + an action into one signature (e.g. MultiSwap's N approvals + the
 * swapToSingle). Returns the writeContract payload.
 */
export function buildAggregate3(calls: RawBatchCall[]) {
    return {
        address: MULTICALL3_FROM_ADDRESS as Address,
        abi: MULTICALL3_FROM_ABI,
        functionName: "aggregate3" as const,
        args: [
            calls.map((c) => ({
                target: c.target,
                allowFailure: c.allowFailure ?? false,
                callData: c.callData,
            })),
        ] as const,
    };
}

/**
 * Build the `writeContract` payload for an atomic approve+swap through
 * Multicall3From. The approve is for `maxUint256` to match the existing
 * `useApproveIfNeeded` behaviour (so a user only ever batches on the
 * first swap of a token; later swaps skip approval and go direct).
 */
export function buildBatchedApproveAndSwap(params: {
    /** ERC20 the user is selling (the token to approve). */
    token: Address;
    /** Router that will pull `token` (the approve spender). */
    spender: Address;
    /** The pre-built swap call (router + fn + args). */
    swap: BatchSwapCall;
}) {
    const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [params.spender, maxUint256],
    });
    const swapData = encodeFunctionData({
        abi: params.swap.abi,
        functionName: params.swap.functionName,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: params.swap.args as any,
    });
    return {
        address: MULTICALL3_FROM_ADDRESS as Address,
        abi: MULTICALL3_FROM_ABI,
        functionName: "aggregate3" as const,
        args: [
            [
                { target: params.token, allowFailure: false, callData: approveData },
                {
                    target: params.swap.address,
                    allowFailure: false,
                    callData: swapData,
                },
            ],
        ] as const,
    };
}
