import {
    encodeFunctionData,
    keccak256,
    stringToBytes,
    stringToHex,
    type Abi,
    type Address,
    type Hex,
} from "viem";
import { MEMO_ABI, MEMO_ADDRESS } from "@/lib/abis/memo";

/**
 * Encode a call to the Arc Memo contract that will (a) emit a
 * `Memo(sender, target, callDataHash, memoId, memoData, memoIndex)`
 * event and (b) forward the wrapped subcall to `target` via the
 * `callFrom` precompile so the target sees the user as msg.sender.
 *
 * Convenience wrappers below cover the common Arcade attribution
 * patterns (Twitter handle, referrer wallet, campaign id, free-form
 * memo). Pass the result to writeContract / sendTransaction with
 * `to: MEMO_ADDRESS, data: <encoded>`.
 */
export function encodeMemoCall(params: {
    target: Address;
    targetAbi: Abi;
    targetFunctionName: string;
    targetArgs: readonly unknown[];
    memoId: Hex; // 32-byte tag
    memoData?: Hex; // arbitrary payload
}): Hex {
    const data = encodeFunctionData({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abi: params.targetAbi as any,
        functionName: params.targetFunctionName,
        args: params.targetArgs,
    });
    return encodeFunctionData({
        abi: MEMO_ABI,
        functionName: "memo",
        args: [
            params.target,
            data,
            params.memoId,
            params.memoData ?? "0x",
        ],
    });
}

/** Produce the `memoId` (bytes32) for a referrer pattern. The
 *  off-chain indexer can subscribe to memoId topics directly. */
export function memoIdFor(kind: "ref" | "campaign" | "invoice" | "tw", value: string): Hex {
    return keccak256(stringToBytes(`${kind}:${value}`));
}

/** Encode the freeform `memoData` payload from a JS object. Keep it
 *  small — every byte costs calldata gas. */
export function encodeMemoData(payload: Record<string, string | number>): Hex {
    return stringToHex(JSON.stringify(payload));
}

export { MEMO_ABI, MEMO_ADDRESS };
