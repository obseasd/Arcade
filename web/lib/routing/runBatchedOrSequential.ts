import { Address, encodeFunctionData } from "viem";
import { runSequential, type SequentialCall } from "./runSequential";

/**
 * Run an ordered list of write calls as ONE sender-preserving Multicall3From
 * signature when Arc's callFrom precompile is healthy, with an automatic
 * fallback to N sequential direct txs (runSequential).
 *
 * Multicall3From routes each subcall through the callFrom precompile so the
 * target sees the original EOA as msg.sender — which is what lets an ordered
 * bundle like withdrawPosition -> decreaseLiquidity -> collect -> burn (across
 * the AutoCompounder AND the NPM) settle in a single signature. That precompile
 * has flip-flopped on testnet (working 2026-06-19, StackUnderflow 2026-06-30,
 * re-confirmed working 2026-07-08), so we never hard-depend on it: every call
 * SIMULATES the batch first and, on any revert, transparently degrades to the
 * exact sequential path. Net: 1 signature when Arc is healthy, never worse than
 * N signatures otherwise.
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

export interface RunBatchedOrSequentialOptions {
    /** The user EOA (msg.sender the precompile must preserve). */
    account: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContractAsync: (args: any) => Promise<`0x${string}`>;
    publicClient: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        call: (args: any) => Promise<any>;
        waitForTransactionReceipt: (args: {
            hash: `0x${string}`;
        }) => Promise<{ status: "success" | "reverted" }>;
    };
    chainId?: number;
    onStep?: (index: number, call: SequentialCall) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: Record<string, any>;
    onMode?: (mode: "batched" | "sequential") => void;
}

export async function runBatchedOrSequential(
    calls: SequentialCall[],
    opts: RunBatchedOrSequentialOptions,
): Promise<{ hash: `0x${string}` | undefined; mode: "batched" | "sequential" }> {
    const aggCalls = calls.map((c) => ({
        target: c.address,
        allowFailure: c.allowFailure ?? false,
        callData: encodeFunctionData({
            abi: c.abi,
            functionName: c.functionName,
            args: c.args,
        }),
    }));

    let batchOk = false;
    try {
        const data = encodeFunctionData({
            abi: AGGREGATE3_ABI,
            functionName: "aggregate3",
            args: [aggCalls],
        });
        await opts.publicClient.call({
            account: opts.account,
            to: MULTICALL3_FROM,
            data,
        });
        batchOk = true;
    } catch {
        batchOk = false;
    }

    if (batchOk) {
        try {
            const hash = await opts.writeContractAsync({
                address: MULTICALL3_FROM,
                abi: AGGREGATE3_ABI,
                functionName: "aggregate3",
                args: [aggCalls],
                ...(opts.chainId ? { chainId: opts.chainId } : {}),
            });
            const rc = await opts.publicClient.waitForTransactionReceipt({ hash });
            if (rc.status !== "success") throw new Error("batch reverted on-chain");
            opts.onMode?.("batched");
            return { hash, mode: "batched" };
        } catch (e) {
            if (isUserRejection(e)) throw e;
            // fall through to the sequential path
        }
    }

    opts.onMode?.("sequential");
    const hash = await runSequential(calls, {
        writeContractAsync: opts.writeContractAsync,
        publicClient: opts.publicClient,
        onStep: opts.onStep,
        extra: opts.extra,
    });
    return { hash, mode: "sequential" };
}
