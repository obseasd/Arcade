/**
 * Arc Memo contract — wraps the `callFrom` precompile to emit a memo
 * event alongside any external call.
 *
 * Address: 0x5294E9927c3306DcBaDb03fe70b92e01cCede505 (Arc Testnet,
 * canonical for the network).
 *
 * Use case for Arcade: attach off-chain context (referrer wallet,
 * Twitter handle, campaign id, invoice/refund id) directly to the
 * on-chain trade that materialises it, so reconciliation and
 * attribution work without a separate off-chain index.
 *
 * Constraints:
 *   - EOA-only. Contract callers revert at the precompile sender
 *     check.
 *   - The wrapped subcall is non-payable in the public API; for
 *     value-bearing calls we'd need a separate wrapper.
 */

export const MEMO_ADDRESS =
    "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as const;

export const MEMO_ABI = [
    {
        type: "function",
        name: "memo",
        stateMutability: "nonpayable",
        inputs: [
            { name: "target", type: "address" },
            { name: "data", type: "bytes" },
            { name: "memoId", type: "bytes32" },
            { name: "memoData", type: "bytes" },
        ],
        outputs: [],
    },
    {
        type: "function",
        name: "memoIndex",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
    },
    {
        type: "event",
        name: "Memo",
        inputs: [
            { name: "sender", type: "address", indexed: true },
            { name: "target", type: "address", indexed: true },
            { name: "callDataHash", type: "bytes32", indexed: false },
            { name: "memoId", type: "bytes32", indexed: true },
            { name: "memo", type: "bytes", indexed: false },
            { name: "memoIndex", type: "uint256", indexed: false },
        ],
    },
] as const;
