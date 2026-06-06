/**
 * Minimal ABI for the Orbs TWAP / dLIMIT contract vendored at
 * contracts/orbs/src/TWAP.sol. We do not import the full Orbs ABI because
 * we only need the writes and reads the maker UI touches.
 *
 * Maker flow:
 *   1. Approve TWAP_ADDRESS to spend srcToken (one-time per token).
 *   2. Call ask(Ask) to register the order on-chain. Returns the order id.
 *   3. Read orderIdsByMaker(account) + order(id) to render Open Orders.
 *   4. Call cancel(id) to revoke any unfilled order.
 *
 * Taker / keeper flow (NOT in scope for this file, lives in keeper bot):
 *   - bid(id, exchange, dstFee, slippagePercent, data)
 *   - fill(id)
 *
 * The Ask + Order + Bid structs are mirrored verbatim from
 * contracts/orbs/src/OrderLib.sol.
 */
export const ORBS_TWAP_ABI = [
    // ============ writes ============
    {
        type: "function",
        stateMutability: "nonpayable",
        name: "ask",
        inputs: [
            {
                name: "_ask",
                type: "tuple",
                components: [
                    { name: "exchange", type: "address" },
                    { name: "srcToken", type: "address" },
                    { name: "dstToken", type: "address" },
                    { name: "srcAmount", type: "uint256" },
                    { name: "srcBidAmount", type: "uint256" },
                    { name: "dstMinAmount", type: "uint256" },
                    { name: "deadline", type: "uint32" },
                    { name: "bidDelay", type: "uint32" },
                    { name: "fillDelay", type: "uint32" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        outputs: [{ name: "id", type: "uint64" }],
    },
    {
        type: "function",
        stateMutability: "nonpayable",
        name: "cancel",
        inputs: [{ name: "id", type: "uint64" }],
        outputs: [],
    },

    // ============ reads ============
    {
        type: "function",
        stateMutability: "view",
        name: "length",
        inputs: [],
        outputs: [{ name: "", type: "uint64" }],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "orderIdsByMaker",
        inputs: [{ name: "maker", type: "address" }],
        outputs: [{ name: "", type: "uint64[]" }],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "order",
        inputs: [{ name: "id", type: "uint64" }],
        outputs: [
            {
                type: "tuple",
                components: [
                    { name: "id", type: "uint64" },
                    { name: "status", type: "uint32" },
                    { name: "time", type: "uint32" },
                    { name: "filledTime", type: "uint32" },
                    { name: "srcFilledAmount", type: "uint256" },
                    { name: "maker", type: "address" },
                    {
                        name: "ask",
                        type: "tuple",
                        components: [
                            { name: "exchange", type: "address" },
                            { name: "srcToken", type: "address" },
                            { name: "dstToken", type: "address" },
                            { name: "srcAmount", type: "uint256" },
                            { name: "srcBidAmount", type: "uint256" },
                            { name: "dstMinAmount", type: "uint256" },
                            { name: "deadline", type: "uint32" },
                            { name: "bidDelay", type: "uint32" },
                            { name: "fillDelay", type: "uint32" },
                            { name: "data", type: "bytes" },
                        ],
                    },
                    {
                        name: "bid",
                        type: "tuple",
                        components: [
                            { name: "time", type: "uint32" },
                            { name: "taker", type: "address" },
                            { name: "exchange", type: "address" },
                            { name: "dstAmount", type: "uint256" },
                            { name: "dstFee", type: "uint256" },
                            { name: "data", type: "bytes" },
                        ],
                    },
                ],
            },
        ],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "status",
        inputs: [{ name: "", type: "uint256" }],
        outputs: [{ name: "", type: "uint32" }],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "iweth",
        inputs: [],
        outputs: [{ name: "", type: "address" }],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "VERSION",
        inputs: [],
        outputs: [{ name: "", type: "uint8" }],
    },
    {
        type: "function",
        stateMutability: "view",
        name: "MIN_BID_DELAY_SECONDS",
        inputs: [],
        outputs: [{ name: "", type: "uint32" }],
    },

    // ============ events ============
    {
        type: "event",
        name: "OrderCreated",
        inputs: [
            { name: "id", type: "uint64", indexed: true },
            { name: "maker", type: "address", indexed: true },
            { name: "exchange", type: "address", indexed: true },
            {
                name: "ask",
                type: "tuple",
                indexed: false,
                components: [
                    { name: "exchange", type: "address" },
                    { name: "srcToken", type: "address" },
                    { name: "dstToken", type: "address" },
                    { name: "srcAmount", type: "uint256" },
                    { name: "srcBidAmount", type: "uint256" },
                    { name: "dstMinAmount", type: "uint256" },
                    { name: "deadline", type: "uint32" },
                    { name: "bidDelay", type: "uint32" },
                    { name: "fillDelay", type: "uint32" },
                    { name: "data", type: "bytes" },
                ],
            },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "OrderFilled",
        inputs: [
            { name: "id", type: "uint64", indexed: true },
            { name: "maker", type: "address", indexed: true },
            { name: "exchange", type: "address", indexed: true },
            { name: "taker", type: "address", indexed: false },
            { name: "srcAmountIn", type: "uint256", indexed: false },
            { name: "dstAmountOut", type: "uint256", indexed: false },
            { name: "dstFee", type: "uint256", indexed: false },
            { name: "srcFilledAmount", type: "uint256", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "OrderCompleted",
        inputs: [
            { name: "id", type: "uint64", indexed: true },
            { name: "maker", type: "address", indexed: true },
            { name: "exchange", type: "address", indexed: true },
            { name: "taker", type: "address", indexed: false },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "OrderCanceled",
        inputs: [
            { name: "id", type: "uint64", indexed: true },
            { name: "maker", type: "address", indexed: true },
            { name: "sender", type: "address", indexed: false },
        ],
        anonymous: false,
    },
] as const;

/**
 * The status field encodes 3 things:
 *   - 1 = STATUS_CANCELED
 *   - 2 = STATUS_COMPLETED
 *   - any other uint32 = the order's deadline (and order is open unless past)
 *
 * Returns a discriminated label for UI display.
 */
export function decodeOrderStatus(
    statusField: number,
    nowSeconds: number,
): "open" | "expired" | "cancelled" | "completed" {
    if (statusField === 1) return "cancelled";
    if (statusField === 2) return "completed";
    if (statusField > 2 && statusField <= nowSeconds) return "expired";
    return "open";
}
