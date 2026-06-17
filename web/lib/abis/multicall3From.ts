/**
 * Multicall3From — Arc's sender-preserving batch contract.
 *
 * Address: 0x522fAf9A91c41c443c66765030741e4AaCe147D0 (Arc Testnet,
 * canonical for the network — see reference_arc_v0_7_2_primitives memo).
 *
 * Unlike the standard Multicall3, every subcall here runs through the
 * Arc `callFrom` precompile (0x18...03) so the target sees the
 * original EOA as `msg.sender` instead of the multicall contract.
 * This is what lets us bundle operations across contracts that each
 * gate on owner/depositor/approval checks (the Compounder's
 * `onlyDepositor`, the NPM's `_isApprovedOrOwner`) inside a single
 * user signature.
 *
 * Important constraints:
 *   - EOA-only. Contract callers revert at the precompile sender
 *     check, so you cannot batch via Multicall3From from a forwarder.
 *   - No value forwarding. The precompile doesn't support attached
 *     ETH/USDC value, so `aggregate3Value` is intentionally omitted.
 *     For value-bearing calls (rare in our stack) use the canonical
 *     Multicall3 path instead.
 */

export const MULTICALL3_FROM_ADDRESS =
    "0x522fAf9A91c41c443c66765030741e4AaCe147D0" as const;

export const MULTICALL3_FROM_ABI = [
    {
        type: "function",
        name: "aggregate3",
        stateMutability: "nonpayable",
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
