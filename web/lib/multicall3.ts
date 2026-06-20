/**
 * Canonical Multicall3 (0xcA11…CA11) — standard, NOT sender-preserving.
 *
 * Used by the operator keeper crons to bundle many permissionless writes
 * (compound / pushFees / claimByTwitter) into ONE transaction: one base
 * fee + one nonce instead of N. These target functions don't gate on
 * msg.sender (the subcall sender becomes the Multicall3 contract, which is
 * fine), so the standard Multicall3 is correct here — Multicall3From
 * (sender-preserving) is only needed when a callee checks msg.sender.
 *
 * Use `allowFailure: true` per call so one item's revert (a tick moved, a
 * nonce already consumed) doesn't roll back every other item in the batch.
 */

export const MULTICALL3_ADDRESS =
    "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const MULTICALL3_AGGREGATE3_ABI = [
    {
        type: "function",
        name: "aggregate3",
        stateMutability: "payable",
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
