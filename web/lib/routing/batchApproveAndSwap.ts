import { Address, encodeFunctionData } from "viem";

/**
 * Fold an ERC20 `approve` + the swap into ONE user signature via Arc's
 * sender-preserving `Multicall3From` (0x522fAf9A…), with an automatic
 * fallback to two sequential direct txs.
 *
 * Background: Multicall3From routes each subcall through Arc's `callFrom`
 * precompile (0x18..03) so the target sees the original EOA as `msg.sender`.
 * That precompile has flip-flopped on testnet — validated working 2026-06-19,
 * reverted with StackUnderflow 2026-06-30, re-confirmed working 2026-07-08
 * (a real `aggregate3([approve v2R, approve v3R])` tx set both
 * `allowance[EOA→router]` correctly). Because it has regressed once, we do
 * NOT hard-depend on it: every call SIMULATES the batch first and, on any
 * revert (precompile down again, or a complex swap leg the precompile can't
 * wrap), transparently falls back to the exact two-tx path we shipped as the
 * `runSequential` replacement. Net effect: 1 signature when Arc is healthy,
 * never worse than 2 signatures when it is not.
 *
 * Only sender-preserving, value-less calls belong here (the precompile does
 * not forward msg.value, so no `aggregate3Value`). Approve + ERC20-router
 * swap fits; a WRAP_ETH / msg.value swap does not (caller must not route
 * those through here).
 */

const MULTICALL3_FROM: Address = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";

const AGGREGATE3_ABI = [
    {
        name: "aggregate3",
        stateMutability: "payable",
        type: "function",
        inputs: [
            {
                name: "calls",
                type: "tuple[]",
                components: [
                    { name: "target", type: "address" },
                    { name: "allowFailure", type: "bool" },
                    { name: "callData", type: "bytes" },
                ],
            },
        ],
        outputs: [
            {
                name: "returnData",
                type: "tuple[]",
                components: [
                    { name: "success", type: "bool" },
                    { name: "returnData", type: "bytes" },
                ],
            },
        ],
    },
] as const;

/** One contract call (wagmi writeContract shape). */
export interface BatchCall {
    address: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: any;
    functionName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: readonly any[];
}

export interface BatchApproveAndSwapArgs {
    /** ERC20 approve leg (target = token, args = [spender, amount]). */
    approve: BatchCall;
    /** The swap leg (target = router, pulls tokenIn from msg.sender). */
    swap: BatchCall;
    /** The user EOA (msg.sender the precompile must preserve). */
    account: Address;
    /** wagmi `writeContractAsync`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContractAsync: (args: any) => Promise<`0x${string}`>;
    /** viem public client (from wagmi `usePublicClient`). */
    publicClient: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        call: (args: any) => Promise<any>;
        waitForTransactionReceipt: (args: {
            hash: `0x${string}`;
        }) => Promise<{ status: "success" | "reverted" }>;
    };
    chainId: number;
    /** Optional: notified with the path actually taken. */
    onMode?: (mode: "batched" | "sequential") => void;
}

/** True for a wallet "user rejected the request" error, which must bubble
 *  up instead of silently triggering the sequential fallback (otherwise a
 *  cancel would pop a second signature prompt). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUserRejection(e: any): boolean {
    const name = e?.name ?? e?.cause?.name ?? "";
    const msg = (e?.shortMessage ?? e?.message ?? "").toLowerCase();
    return (
        name === "UserRejectedRequestError" ||
        e?.code === 4001 ||
        msg.includes("user rejected") ||
        msg.includes("user denied") ||
        msg.includes("rejected the request")
    );
}

/**
 * Execute approve + swap. Returns the hash of the swap (batched: the single
 * aggregate3 tx; sequential: the second/swap tx) and which path ran.
 */
export async function batchApproveAndSwap({
    approve,
    swap,
    account,
    writeContractAsync,
    publicClient,
    chainId,
    onMode,
}: BatchApproveAndSwapArgs): Promise<{
    hash: `0x${string}`;
    mode: "batched" | "sequential";
}> {
    const calls = [approve, swap].map((c) => ({
        target: c.address,
        allowFailure: false,
        callData: encodeFunctionData({
            abi: c.abi,
            functionName: c.functionName,
            args: c.args,
        }),
    }));

    // Pre-flight: simulate the whole batch as the user. The approve leg sets
    // the allowance in the ephemeral eth_call state, so the swap leg's
    // transferFrom sees it — a truthful test of the exact on-chain sequence.
    // Any revert here (precompile regressed, unsupported complex leg) sends
    // us to the sequential fallback WITHOUT the user ever signing a doomed tx.
    let batchOk = false;
    try {
        const data = encodeFunctionData({
            abi: AGGREGATE3_ABI,
            functionName: "aggregate3",
            args: [calls],
        });
        await publicClient.call({ account, to: MULTICALL3_FROM, data });
        batchOk = true;
    } catch {
        batchOk = false;
    }

    if (batchOk) {
        try {
            const hash = await writeContractAsync({
                address: MULTICALL3_FROM,
                abi: AGGREGATE3_ABI,
                functionName: "aggregate3",
                args: [calls],
                chainId,
            });
            onMode?.("batched");
            return { hash, mode: "batched" };
        } catch (e) {
            // A rejection is intentional — do not fall back into a second prompt.
            if (isUserRejection(e)) throw e;
            // Otherwise (rare sim/send race) degrade to the sequential path.
        }
    }

    // Fallback: two direct txs. Signing each preserves msg.sender = user for
    // free, no precompile involved. Identical to the runSequential path.
    onMode?.("sequential");
    const approveHash = await writeContractAsync({
        address: approve.address,
        abi: approve.abi,
        functionName: approve.functionName,
        args: approve.args,
        chainId,
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({
        hash: approveHash,
    });
    if (approveReceipt.status !== "success") {
        throw new Error("Approve transaction reverted");
    }
    const swapHash = await writeContractAsync({
        address: swap.address,
        abi: swap.abi,
        functionName: swap.functionName,
        args: swap.args,
        chainId,
    });
    return { hash: swapHash, mode: "sequential" };
}
