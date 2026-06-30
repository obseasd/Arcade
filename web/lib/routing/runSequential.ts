import { Address } from "viem";

/**
 * Sequential write-call runner (Arc Multicall3From replacement).
 *
 * Arc's `callFrom` precompile (0x18..03) that `Multicall3From` routes
 * through is DEAD on the current testnet (codesize 1, every aggregate3
 * reverts with StackUnderflow), so the old "fold N ops into one
 * sender-preserving signature" batches all revert on-chain. This runner
 * executes the SAME ordered list of operations as N SEPARATE direct
 * transactions from the user's wallet. Because the user signs each tx,
 * `msg.sender` is the user for free with no precompile involved, so every
 * owner/approval/depositor-gated call settles exactly as the batch would
 * have. The only cost is N wallet confirmations instead of 1.
 *
 * Each call awaits its receipt before the next runs (the legs are
 * order-dependent: approve before swap, decrease before collect before
 * burn). A call may opt into `allowFailure` to mirror aggregate3's
 * allowFailure:true semantics (a revert on that leg is swallowed and the
 * run continues), used by claim-all / cancel-all flows where one stale
 * entry must not sink the rest.
 *
 * Re-batch into a single signature only once a working sender-preserving
 * multicall ships on Arc.
 */

/** One write call in a sequential run (wagmi writeContract shape). */
export interface SequentialCall {
    address: Address;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    abi: any;
    functionName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: readonly any[];
    /** Mirror aggregate3 allowFailure: swallow a revert and keep going. */
    allowFailure?: boolean;
    /** Optional per-call status message for the caller's progress UI. */
    label?: string;
}

export interface RunSequentialOptions {
    /** wagmi `writeContractAsync`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContractAsync: (args: any) => Promise<`0x${string}`>;
    /** viem public client for receipt waits (from wagmi `usePublicClient`). */
    publicClient: {
        waitForTransactionReceipt: (args: {
            hash: `0x${string}`;
        }) => Promise<{ status: "success" | "reverted" }>;
    } | undefined;
    /** Optional per-step progress callback (before each tx is signed). */
    onStep?: (index: number, call: SequentialCall) => void;
    /** Extra fields merged into every writeContract payload (e.g. chainId). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: Record<string, any>;
}

/**
 * Run `calls` one-by-one, awaiting each receipt. Returns the hash of the
 * last successfully mined call (undefined if every call was an
 * allowFailure leg that reverted). Throws on the first non-allowFailure
 * revert, surfacing the caller's existing error/toast handling.
 */
export async function runSequential(
    calls: SequentialCall[],
    opts: RunSequentialOptions,
): Promise<`0x${string}` | undefined> {
    const { writeContractAsync, publicClient, onStep, extra } = opts;
    let lastHash: `0x${string}` | undefined;
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        onStep?.(i, call);
        try {
            const hash = await writeContractAsync({
                address: call.address,
                abi: call.abi,
                functionName: call.functionName,
                args: call.args,
                ...extra,
            });
            if (publicClient) {
                const receipt = await publicClient.waitForTransactionReceipt({
                    hash,
                });
                if (receipt.status !== "success") {
                    if (call.allowFailure) continue;
                    throw new Error(
                        `Transaction reverted on-chain (tx ${hash.slice(0, 10)}…).`,
                    );
                }
            }
            lastHash = hash;
        } catch (e) {
            if (call.allowFailure) continue;
            throw e;
        }
    }
    return lastHash;
}
